// The D1 projection of receipt accounting. See docs/receipt-accounting-v1.md, "D1 projection".
//
// The object's outbox holds one row per committed receipt revision, in commit order. Draining
// applies each to D1 in one atomic batch:
// - an idempotency marker for (receipt, revision), with the hash of exactly what is applied;
// - the receipt's newest projection, and the invoice's receipt-mode fence;
// - the change to the lifetime tally, its hourly figures, the handle totals and the private
//   account totals;
// - the tally's `last`, chosen again from what the batch leaves.
// Only then is the outbox row removed, with a durable note that pages need D1's current
// figures. A crash after the batch and before the removal finds the marker on the next drain,
// with the same hash, and removes the row without counting again.
//
// Counting follows each receipt: a receipt counts once while its credit stands, so partial and
// repeat payments are distinct donations; a reversal takes it back once, and a reconfirmation
// adds it again at the same frozen price. A revision that changes no credit changes no figure.
// An older revision arriving after a newer one is marked and skipped, never applied over it.
//
// A marker whose hash differs, a batch the legacy fence refuses, or a total that would leave
// the safe integer range or go negative, is a conflict: the work is kept, recorded for review,
// and draining stops, in order. Nothing is ever published rounded or negative. The range is
// checked inside the batch, against the values it leaves, because legacy deliveries move the
// same totals and may land while a drain waits on D1: a check read before the batch could be
// stale by the time it runs.
//
// Lifetime figures only. The remaining pile is its own journal in the object and is never
// touched here, and nothing spent from the wallet ever reaches these tables.

import { hashRequest } from "./receipts.mjs";

const HOUR = 3_600_000;

// The most outbox rows one drain applies, apart from the client-facing replay bound, which only
// sizes socket replay. D1 limits the queries one Worker invocation makes: 1,000 on the paid plan
// and 50 on the free plan, and a batch counts as one query
// (https://developers.cloudflare.com/d1/platform/limits/). A row costs at most three: its marker read, its
// previous-revision read and its batch. A row already applied costs one. After the drain, the
// publication reads the board and the tally, two queries each. A drain is shared while it runs,
// so one event starts at most one, and a full drain continues in a new alarm invocation. Ten
// rows is then at most 30 + 4 queries, which leaves the rest of the free plan's 50 for the event
// that started it: a legacy settlement makes about nine. The tests count queries through the D1
// stand-in; what a real invocation counts isn't measured.
export const PROJECTION_BATCH_MAX = 10;

// What a revision applies, in a fixed key order, so its hash is the same on every attempt.
const canonical = (r) => ({
  receipt: r.receipt, revision: r.revision, seq: r.seq, observed: r.observed, invoice: r.invoice, state: r.state, sats: r.sats,
  credit: r.credit, milli: r.milli, handle: r.handle, owner: r.owner, receivedAt: r.receivedAt,
});

// The tally's `last`: the sats of the newest valid donation, legacy or receipt, by when it was
// recorded (a legacy donation) or first observed (a receipt), so neither a correction's time nor
// processing order can move it, and a reversed receipt is never it. Receipts first observed in
// the same millisecond are told apart by their first observation's feed sequence, which never
// changes, whichever revision reached D1 first. At the same millisecond a receipt is newer than a
// legacy donation; legacy donations at the same millisecond keep their recorded order. The legacy
// insert trigger in migrations/0010_receipt_projection.sql chooses `last` with this same query.
export const LATEST = "(SELECT sats FROM (" +
  "SELECT sats, at AS t, 0 AS k, seq AS o FROM (SELECT sats, at, seq FROM donations ORDER BY at DESC, seq DESC LIMIT 1) " +
  "UNION ALL SELECT sats, received_at AS t, 1 AS k, observed_seq AS o FROM " +
  "(SELECT sats, received_at, observed_seq FROM receipt_projection WHERE credit > 0 ORDER BY received_at DESC, observed_seq DESC LIMIT 1)" +
  ") ORDER BY t DESC, k DESC, o DESC LIMIT 1)";
const LAST = `UPDATE tally SET last = ${LATEST} WHERE id = 1`;

// The last statement of every batch that moves a total: the guard's trigger reads the values the
// batch leaves, inside the same transaction, and aborts all of it if any is not an exact, safe,
// non-negative integer. It stores nothing. See migrations/0010_receipt_projection.sql.
const GUARD = "INSERT INTO receipt_projection_guard (hour, handle, owner) VALUES (?, ?, ?)";
// What a refused batch says: the guard, or a total's own CHECK.
const UNSAFE = /receipt projection: unsafe total|CHECK constraint failed/;
const LEGACY = /receipt projection: invoice is a legacy donation/;

// An error's message and those of the errors it wraps, a few levels deep: a platform may wrap
// the database's own error, leaving the trigger's message in `cause`. Only these exact trigger
// and constraint messages make a conflict; anything else is a failure, retried on the cadence.
function said(error, pattern) {
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    if (typeof e.message === "string" && pattern.test(e.message)) return true;
  }
  return false;
}

// Applies up to `limit` outbox rows to `db`, in order, one at a time. Returns applied and
// skipped counts, whether rows remain, and the conflict or failure that stopped it, if any. A D1
// failure leaves the row for a later drain.
export async function drainProjection({ ledger, db, now, limit }) {
  const work = ledger.projectionWork(limit);
  const result = { applied: 0, skipped: 0, more: false, conflict: null, failed: null };
  const conflict = (row, reason) => {
    ledger.recordProjectionConflict(row.id, row.receipt, row.revision, reason);
    result.conflict = reason;
    return result;
  };
  for (const row of work) {
    const hash = await hashRequest(JSON.stringify(canonical(row)));
    let statements;
    let moved = false;
    try {
      const marker = await db.prepare("SELECT hash FROM receipt_applied WHERE receipt = ? AND revision = ?").bind(row.receipt, row.revision).first();
      if (marker) {
        if (marker.hash !== hash) return conflict(row, "marker-mismatch");
        // Applied before, by an attempt that stopped before removing its row. Whether that
        // batch moved a figure isn't known here, so pages get D1's current figures again.
        ledger.projected(row.id, { publish: true });
        result.skipped += 1;
        continue;
      }
      const previous = await db.prepare("SELECT revision, credit, milli FROM receipt_projection WHERE receipt = ?").bind(row.receipt).first();
      statements = [db.prepare("INSERT INTO receipt_applied (receipt, revision, hash, applied_at) VALUES (?, ?, ?, ?)")
        .bind(row.receipt, row.revision, hash, now())];
      if (!previous || row.revision > previous.revision) {
        const sats = row.credit - (previous?.credit ?? 0);
        const milli = row.milli - (previous?.milli ?? 0);
        const count = (row.credit > 0 ? 1 : 0) - ((previous?.credit ?? 0) > 0 ? 1 : 0);
        // observed_seq is written once, with the receipt's first row, and never updated.
        statements.push(
          db.prepare(
            "INSERT INTO receipt_projection (receipt, invoice, revision, seq, observed_seq, state, sats, credit, milli, handle, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (receipt) DO UPDATE SET revision = excluded.revision, seq = excluded.seq, state = excluded.state, credit = excluded.credit, " +
            "milli = excluded.milli, handle = excluded.handle WHERE excluded.revision > receipt_projection.revision",
          ).bind(row.receipt, row.invoice, row.revision, row.seq, row.observed, row.state, row.sats, row.credit, row.milli, row.handle, row.receivedAt),
          db.prepare("INSERT INTO receipt_invoices (invoice) VALUES (?) ON CONFLICT (invoice) DO NOTHING").bind(row.invoice),
        );
        if (sats !== 0 || milli !== 0 || count !== 0) {
          if (![sats, milli, count].every(Number.isSafeInteger)) return conflict(row, "unsafe-total");
          moved = true;
          const hour = row.receivedAt - (row.receivedAt % HOUR);
          statements.push(
            db.prepare("UPDATE tally SET count = count + ?, sats = sats + ?, milli = milli + ? WHERE id = 1").bind(count, sats, milli),
            db.prepare("INSERT INTO tally_hours (hour, sats, milli) VALUES (?, ?, ?) ON CONFLICT (hour) DO UPDATE SET sats = sats + excluded.sats, milli = milli + excluded.milli")
              .bind(hour, sats, milli),
            db.prepare(LAST),
          );
          if (row.handle !== "") {
            statements.push(db.prepare(
              // A credit shows its own casing of the handle, as a legacy donation does (0005); a
              // reversal never changes how the handle is shown.
              "INSERT INTO handle_totals (handle, milli, sats, donations) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT (handle) DO UPDATE SET handle = CASE WHEN excluded.sats > 0 THEN excluded.handle ELSE handle_totals.handle END, " +
              "milli = milli + excluded.milli, sats = sats + excluded.sats, donations = donations + excluded.donations",
            ).bind(row.handle, milli, sats, count));
          }
          if (row.owner !== null) {
            // The row first, then the change: SQLite checks an upsert's candidate row against
            // the table's CHECKs before resolving the conflict, so a negative change can't ride it.
            statements.push(
              db.prepare("INSERT INTO receipt_account_totals (owner, sats, milli, donations) VALUES (?, 0, 0, 0) ON CONFLICT (owner) DO NOTHING").bind(row.owner),
              db.prepare("UPDATE receipt_account_totals SET sats = sats + ?, milli = milli + ?, donations = donations + ? WHERE owner = ?").bind(sats, milli, count, row.owner),
            );
          }
          // Last: every total moved above, as the batch leaves it, or none of it.
          statements.push(db.prepare(GUARD).bind(hour, row.handle === "" ? null : row.handle, row.owner));
        }
      }
    } catch (error) {
      result.failed = error.message;
      return result;
    }
    try {
      await db.batch(statements);
    } catch (error) {
      // Rolled back whole: no marker, no projection and no total changed, the row kept.
      if (said(error, LEGACY)) return conflict(row, "legacy-collision");
      if (said(error, UNSAFE)) return conflict(row, "unsafe-total");
      result.failed = error.message;
      return result;
    }
    // Only after the batch is durable, with the publication noted in the same step.
    ledger.projected(row.id, { publish: moved });
    result.applied += 1;
  }
  result.more = work.length === limit && ledger.hasPendingProjection();
  return result;
}

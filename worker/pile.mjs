// The global pile without decay. See docs/receipt-accounting-v1.md, "Lifetime donations, pile
// and decay".
//
// Nothing eats the pile any more, and nothing here works out how much was eaten. The saved
// pile row the old code kept is the saved checkpoint: it is never changed, never rebuilt from
// donations, and never published as a current balance by itself. Until one audited anchor
// says what the pile is, pages get a pending pile with no number.
//
// Every credit since this code started is a permanent delta, keyed by its source, so the same
// donation adds once however often it finishes and however long ago. Each delta also keeps the
// running total of every delta up to it, checked for overflow when it is written, so the pile
// is two row reads, however long the history. The anchor's boundary names the delta its
// reviewed value already includes; every later one is added on top.
//
// Donations the old code had already added to the checkpoint are fenced when this code first
// starts, from the finished marks still retained then, so they can never add again, even once
// those marks are purged. A settlement that finds a D1 row it can't prove it wrote itself (an
// older row, a manual import, or a write from before a crash under the old code) is never
// added: it is recorded as an exception, and the pile says it needs review.
//
// A level that would be negative or too large to represent is never published as a number or
// clamped: the pile reports review instead. Arithmetic stays signed and exact.
//
// The anchor is applied by an operator through storage, never through a request: nothing in
// the Worker or the object routes to applyPileAnchor. How an operator runs it is still open.

export const PILE_SCHEMA = `CREATE TABLE pile_deltas (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL UNIQUE,
    milli INTEGER NOT NULL,
    cumulative INTEGER,
    at INTEGER NOT NULL
  );
  CREATE TABLE pile_anchor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    anchor TEXT NOT NULL,
    expected TEXT NOT NULL,
    milli INTEGER NOT NULL CHECK (milli >= 0),
    boundary INTEGER NOT NULL CHECK (boundary >= 0),
    included INTEGER NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE pile_legacy (source TEXT PRIMARY KEY, reason TEXT NOT NULL);
  CREATE TABLE pile_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    milli INTEGER,
    at INTEGER NOT NULL,
    UNIQUE (source, reason)
  );
  INSERT INTO pile_legacy (source, reason) SELECT 'donation:' || invoice, 'in-checkpoint' FROM finished;`;

const ANCHOR_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SOURCE = /^[a-z]+:[A-Za-z0-9._:-]{1,96}$/;
const TEXT_MAX = 1000;

const rows = (sql, query, ...bindings) => sql.exec(query, ...bindings).toArray();
const row = (sql, query, ...bindings) => rows(sql, query, ...bindings)[0] ?? null;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;

// a + b, or null when the result can't be represented exactly.
function add(a, b) {
  if (a === null || b === null) return null;
  const sum = a + b;
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(sum) ? sum : null;
}

function bump(sql) {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('pile_revision', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1",
  );
}

export function pileRevision(sql) {
  return row(sql, "SELECT value FROM meta WHERE key = 'pile_revision'")?.value ?? 0;
}

// The checkpoint the old code saved, exactly as stored, or null if it never made one.
export function savedPileSnapshot(sql) {
  const saved = row(sql, "SELECT milli, at FROM pile WHERE id = 1");
  return saved ? { milli: saved.milli, at: saved.at } : null;
}

// An anomaly the pile can't settle by itself, kept for review. The pile reports review while
// any exists. Recording the same one again changes nothing. True if it was new.
export function recordPileException(sql, source, reason, milli, at) {
  const added = rows(sql,
    "INSERT INTO pile_exceptions (source, reason, milli, at) VALUES (?, ?, ?, ?) ON CONFLICT (source, reason) DO NOTHING RETURNING id",
    source, reason, milli, at);
  if (added.length) bump(sql);
  return added.length > 0;
}

// Records a credit once, for good, inside the caller's transaction. source names what it is,
// "donation:<invoice id>" for a legacy donation; milli may be negative for a correction. True
// if it was new. A source already in the checkpoint is never added. The same source again
// with the same amount changes nothing; with a different amount it is recorded as a
// conflict for review, and the first amount stands. A running total that would leave the
// safe range is kept as unknown, and blocks the pile.
export function recordPileDelta(sql, source, milli, at) {
  if (typeof source !== "string" || !SOURCE.test(source)) throw new Error("a pile delta needs its source");
  if (!Number.isSafeInteger(milli) || !isTime(at)) throw new RangeError("a pile delta outside the safe range");
  if (row(sql, "SELECT 1 FROM pile_legacy WHERE source = ?", source)) return false;
  const known = row(sql, "SELECT milli FROM pile_deltas WHERE source = ?", source);
  if (known) {
    // The same source and amount is a retry. A different amount is a conflict: the first
    // stays, and the pile reports review.
    if (known.milli !== milli) recordPileException(sql, source, "delta-conflict", milli, at);
    return false;
  }
  const last = row(sql, "SELECT cumulative FROM pile_deltas ORDER BY seq DESC LIMIT 1");
  const cumulative = add(last ? last.cumulative : 0, milli);
  sql.exec("INSERT INTO pile_deltas (source, milli, cumulative, at) VALUES (?, ?, ?, ?)", source, milli, cumulative, at);
  if (cumulative === null && (last === null || last.cumulative !== null)) recordPileException(sql, source, "unrepresentable-total", milli, at);
  else bump(sql);
  return true;
}

// Whether the pile already knows a source: credited, in the checkpoint, or held for review.
export function pileKnows(sql, source) {
  return row(sql, "SELECT 1 FROM pile_legacy WHERE source = ?", source) !== null ||
    row(sql, "SELECT 1 FROM pile_deltas WHERE source = ?", source) !== null ||
    row(sql, "SELECT 1 FROM pile_exceptions WHERE source = ?", source) !== null;
}

const review = (revision) => ({ type: "pile", bananas: null, at: null, eatPerHour: 0, revision, basis: "credits",
  cutover: "done", reconciliation: "review", uncertain: null });

// What every page is sent. Pending, with no number, until the anchor; then the anchor's
// reviewed value plus every delta after its boundary. Not a wallet balance: no spending is
// counted, and no starting inventory is assumed. A level that is negative or can't be
// represented reports review, with no number. It reads two rows, however long the history.
export function pileView(sql) {
  const revision = pileRevision(sql);
  const anchor = row(sql, "SELECT milli, boundary, included, applied_at FROM pile_anchor WHERE id = 1");
  if (!anchor) {
    return { type: "pile", bananas: null, at: null, eatPerHour: 0, revision, basis: "credits",
      cutover: "pending", reconciliation: "review", uncertain: null };
  }
  const last = row(sql, "SELECT seq, cumulative, at FROM pile_deltas ORDER BY seq DESC LIMIT 1");
  const total = last ? last.cumulative : 0;
  const level = add(anchor.milli, add(total, total === null ? null : -anchor.included));
  if (level === null || level < 0) return review(revision);
  const at = last && last.seq > anchor.boundary ? Math.max(anchor.applied_at, last.at) : anchor.applied_at;
  const exceptions = row(sql, "SELECT 1 FROM pile_exceptions") !== null;
  return { type: "pile", bananas: level / 1000, at, eatPerHour: 0, revision, basis: "credits",
    cutover: "done", reconciliation: exceptions ? "review" : "off", uncertain: { sats: 0, bananas: 0 } };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The one audited cutover. expected is the saved checkpoint the operator reviewed, { milli,
// at } or null when there was none; it must still be exactly what is stored. milli is the
// reviewed level, in thousandths, already including every delta up to and including boundary:
// 0 for none, or the seq of a delta that exists. now is when it is applied. Applying the same
// anchor again is a harmless duplicate; any other once one exists is refused. An anchor whose
// level couldn't be represented, or would be negative, is refused, never stored.
export function applyPileAnchor(storage, { anchor, expected, milli, boundary, reason, evidence }, now) {
  if (typeof anchor !== "string" || !ANCHOR_ID.test(anchor) || !isTime(now)) return { error: "invalid" };
  if (expected !== null && (expected === undefined || typeof expected !== "object" || Array.isArray(expected) ||
      Object.keys(expected).sort().join() !== "at,milli" || !Number.isSafeInteger(expected.milli) || !Number.isSafeInteger(expected.at))) {
    return { error: "invalid" };
  }
  if (!Number.isSafeInteger(milli) || milli < 0 || !Number.isSafeInteger(boundary) || boundary < 0) return { error: "invalid" };
  for (const text of [reason, evidence]) {
    if (typeof text !== "string" || !text.trim() || text.length > TEXT_MAX) return { error: "invalid" };
  }
  const sql = storage.sql;
  const reviewed = expected === null ? null : { milli: expected.milli, at: expected.at };
  const wanted = { anchor, expected: JSON.stringify(reviewed), milli, boundary, reason, evidence };
  return storage.transactionSync(() => {
    const existing = row(sql, "SELECT anchor, expected, milli, boundary, reason, evidence FROM pile_anchor WHERE id = 1");
    if (existing) return sameJson({ ...existing }, wanted) ? { ok: true, duplicate: true } : { error: "anchored" };
    if (!sameJson(savedPileSnapshot(sql), reviewed)) return { error: "stale" };
    let included = 0;
    if (boundary !== 0) {
      const at = row(sql, "SELECT cumulative FROM pile_deltas WHERE seq = ?", boundary);
      if (!at) return { error: "boundary" };
      included = at.cumulative;
    }
    const last = row(sql, "SELECT cumulative FROM pile_deltas ORDER BY seq DESC LIMIT 1");
    const total = last ? last.cumulative : 0;
    const level = add(milli, add(total, included === null || total === null ? null : -included));
    if (included === null || level === null || level < 0) return { error: "unrepresentable" };
    sql.exec(
      "INSERT INTO pile_anchor (id, anchor, expected, milli, boundary, included, reason, evidence, applied_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
      anchor, wanted.expected, milli, boundary, included, reason, evidence, now,
    );
    bump(sql);
    return { ok: true, duplicate: false };
  });
}

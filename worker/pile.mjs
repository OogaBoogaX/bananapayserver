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
//
// Receipt accounting feeds the same deltas. Each receipt ledger entry, a credit or a reversal,
// becomes one delta keyed by its permanent identity, "receipt:<receipt id>:<transition>", so it
// adds once, on whichever side of the anchor it falls, like any donation. An entry for an
// invoice the pile already knows as a legacy donation is never added: it is held for review, so
// one payment can't count both ways. The object bridges entries in order, from a durable mark,
// in the same transaction as each delta; see bridgeReceiptEntries.

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

// For a change the pile shows that no delta, exception or anchor made: the receipt side's
// health or uncertain amount. Pages deduplicate by revision, so the change needs a new one.
export const bumpPileRevision = bump;

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

// Receipt ledger entries into the pile, in ledger order, inside the caller's transaction.
// Each entry is { seq, receipt, transition, invoice, milli, at }. Returns the last seq handled.
// - retained: entries at or below this seq were in the receipt journal before the bridge first
//   ran. If an anchor already existed then, nobody can say whether its reviewed level included
//   them, so each is held for review ("receipt-before-bridge") and never added or guessed.
// - An invoice the pile knows as a legacy donation, or the old code finished, is held
//   ("legacy-and-receipt"): one payment never counts both ways.
// - An amount or time that can't be represented is held ("unrepresentable-entry").
// - Once any entry of a receipt is held, every later one of the same receipt is held too
//   ("receipt-lineage-held"): a reversal of a credit the pile never took would take away what
//   was never added, and a reconfirmation would add it without settling whether the anchor
//   already had it. The lineage waits for review as a whole; other receipts go on as usual.
// Everything else is one delta, keyed for good, so a retry or a restart adds nothing again.
export function bridgeReceiptEntries(sql, entries, { retained, anchoredBefore }) {
  let through = null;
  for (const e of entries) {
    const source = `receipt:${e.receipt}:${e.transition}`;
    if (!SOURCE.test(source)) throw new Error("a receipt entry without a usable identity");
    const milli = Number.isSafeInteger(e.milli) ? e.milli : null;
    const legacy = row(sql, "SELECT 1 FROM finished WHERE invoice = ?", e.invoice) !== null || pileKnows(sql, `donation:${e.invoice}`);
    // Any held entry of this receipt, by its sources' shared prefix, through the exceptions'
    // own (source, reason) index.
    const prefix = `receipt:${e.receipt}:`;
    const lineageHeld = row(sql, "SELECT 1 FROM pile_exceptions WHERE source >= ? AND source < ?", prefix, `receipt:${e.receipt};`) !== null;
    if (e.seq <= retained && anchoredBefore) recordPileException(sql, source, "receipt-before-bridge", milli, e.at);
    else if (lineageHeld) recordPileException(sql, source, "receipt-lineage-held", milli, e.at);
    else if (legacy) recordPileException(sql, source, "legacy-and-receipt", milli, e.at);
    else if (milli === null || !isTime(e.at)) recordPileException(sql, source, "unrepresentable-entry", milli, e.at);
    else recordPileDelta(sql, source, milli, e.at);
    through = e.seq;
  }
  return through;
}

const review = (revision) => ({ type: "pile", bananas: null, at: null, eatPerHour: 0, revision, basis: "credits",
  cutover: "done", reconciliation: "review", uncertain: null });

// What every page is sent. Pending, with no number, until the anchor; then the anchor's
// reviewed value plus every delta after its boundary. Not a wallet balance: no spending is
// counted, and no starting inventory is assumed. A level that is negative or can't be
// represented reports review, with no number. It reads two rows, however long the history.
//
// accounting is null while no receipt accounting feeds the pile: an anchored pile then says
// reconciliation "off", with nothing uncertain. Otherwise it is { reconciliation, uncertain }:
// the receipt side's own health ("behind", "review" or "current"), never better than the
// bridge itself, and what receipts held for review still credit, { sats, milli }, or null if
// that can't be represented, which reports review.
export function pileView(sql, accounting = null) {
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
  const exceptions = row(sql, "SELECT 1 FROM pile_exceptions LIMIT 1") !== null;
  if (accounting === null) {
    return { type: "pile", bananas: level / 1000, at, eatPerHour: 0, revision, basis: "credits",
      cutover: "done", reconciliation: exceptions ? "review" : "off", uncertain: { sats: 0, bananas: 0 } };
  }
  const { uncertain } = accounting;
  const reconciliation = exceptions || uncertain === null ? "review" : accounting.reconciliation;
  return { type: "pile", bananas: level / 1000, at, eatPerHour: 0, revision, basis: "credits", cutover: "done", reconciliation,
    uncertain: uncertain === null ? null : { sats: uncertain.sats, bananas: uncertain.milli / 1000 } };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Whether the receipt journal holds entries the bridge hasn't moved into the pile yet. Reads the
// receipt journal's high-water mark and the bridge's durable mark, two rows.
export function receiptBacklog(sql) {
  if (!row(sql, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ra_pile_deltas'")) return false;
  const high = row(sql, "SELECT max(ledger_seq) AS seq FROM ra_pile_deltas").seq ?? 0;
  if (high === 0) return false;
  const bridged = row(sql, "SELECT value FROM meta WHERE key = 'receipt_pile_bridged'")?.value ?? null;
  return bridged === null || bridged < high;
}

// The one audited cutover. expected is the saved checkpoint the operator reviewed, { milli,
// at } or null when there was none; it must still be exactly what is stored. milli is the
// reviewed level, in thousandths, already including every delta up to and including boundary:
// 0 for none, or the seq of a delta that exists. now is when it is applied. Applying the same
// anchor again is a harmless duplicate; any other once one exists is refused. An anchor whose
// level couldn't be represented, or would be negative, is refused, never stored, and so is one
// while receipt journal entries still wait for the bridge ("bridge").
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
    // A store with receipt accounting must have every receipt journal entry in the pile's deltas
    // first, so the boundary can name exactly what the reviewed level includes. Entries still
    // waiting for the bridge, or a journal the bridge has never started on, can't be placed on
    // either side of it: refused, never guessed. A store without receipt entries is unaffected.
    if (receiptBacklog(sql)) return { error: "bridge" };
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

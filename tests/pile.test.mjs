// The pile without decay, and its one audited cutover. Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject } from "../worker/object.mjs";
import { applyPileAnchor, pileView, recordPileDelta, savedPileSnapshot } from "../worker/pile.mjs";
import { hashRequest } from "../worker/receipts.mjs";
import { bolt11For } from "./helpers/values.mjs";
import { donor, EXPIRES, world } from "./helpers/world.mjs";

const HOUR = 3_600_000;
const typed = (page, type) => page.messages().filter((m) => m.type === type);
const PENDING = { bananas: null, at: null, eatPerHour: 0, basis: "credits", cutover: "pending", reconciliation: "review", uncertain: null };
const pick = ({ revision, ...rest }) => rest;

async function donate(w, relay, sats, invoice) {
  await w.invoice(relay, { sats }, () => ({ id: invoice, bolt11: bolt11For(sats), expires: EXPIRES }));
  await w.relaySays(relay, { type: "paid", invoice, sats, method: "lightning" });
}

const anchor = (w, fields) => applyPileAnchor(w.ctx.storage, {
  anchor: "cutover-1", expected: null, milli: 0, boundary: 0, reason: "synthetic review", evidence: "synthetic evidence", ...fields,
}, w.platform.now());

const deltas = (w) => w.ctx.storage.sql.exec("SELECT seq, source, milli FROM pile_deltas ORDER BY seq").toArray().map((r) => ({ ...r }));

// A saved checkpoint as the old code left it: a level after past eating, which no sum of the
// donations reproduces.
function savedCheckpoint(w, milli, at) {
  w.ctx.storage.sql.exec("INSERT INTO pile (id, milli, at, started) VALUES (1, ?, ?, ?)", milli, at, at - HOUR);
}

test("with no anchor the pile is pending, whether or not a saved checkpoint exists", async () => {
  for (const saved of [false, true]) {
    const w = await world();
    if (saved) savedCheckpoint(w, 4_321_000, w.platform.now() - HOUR);
    const page = await w.connectPage();
    assert.deepEqual(pick(typed(page, "pile")[0]), { type: "pile", ...PENDING }, "the checkpoint is never shown as current");
  }
});

test("credits while pending are kept, counted in lifetime figures, and never lost or doubled at the cutover", async () => {
  const w = await world();
  const at = w.platform.now() - HOUR;
  savedCheckpoint(w, 4_321_000, at);
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await donate(w, relay, 10_000, "QueuedAAA1");
  await donate(w, relay, 2_000, "QueuedBBB2");
  assert.equal(typed(page, "pile").at(-1).bananas, null);
  assert.deepEqual(typed(page, "tally").at(-1).sats, 12_000, "lifetime figures count them regardless of the pile");
  assert.deepEqual(deltas(w).map((d) => [d.seq, d.source, d.milli]), [[1, "donation:QueuedAAA1", 10_000], [2, "donation:QueuedBBB2", 2_000]]);
  // The operator reviewed a level that already includes the first credit, but not the second.
  assert.equal(anchor(w, { expected: { milli: 4_321_000, at }, milli: 4_331_000, boundary: 1 }).ok, true);
  const anchored = await w.connectPage();
  assert.equal(typed(anchored, "pile")[0].bananas, 4_333, "reviewed 4,331 plus the 2 after the boundary");
  await donate(w, relay, 5_000, "AfterCCCC3");
  assert.equal(typed(anchored, "pile").at(-1).bananas, 4_338, "a credit after the cutover adds on top");
  assert.deepEqual(typed(anchored, "pile").at(-1).cutover, "done");
  assert.deepEqual(savedPileSnapshot(w.ctx.storage.sql), { milli: 4_321_000, at }, "the checkpoint itself is never changed");
});

test("the anchor is a compare-and-set of the saved checkpoint, with an existing boundary", async () => {
  const w = await world();
  const at = w.platform.now() - HOUR;
  savedCheckpoint(w, 4_321_000, at);
  const relay = await w.connectRelay();
  await donate(w, relay, 1_000, "QueuedAAA1");
  for (const [fields, error] of [
    [{ expected: null }, "stale"],
    [{ expected: { milli: 4_321_001, at } }, "stale"],
    [{ expected: { milli: 4_321_000, at: at + 1 } }, "stale"],
    [{ expected: { milli: 4_321_000, at }, boundary: 2 }, "boundary"],
    [{ expected: { milli: 4_321_000, at }, milli: -1 }, "invalid"],
    [{ expected: { milli: 4_321_000, at }, milli: 1.5 }, "invalid"],
    [{ expected: { milli: 4_321_000 } }, "invalid"],
    [{ expected: { milli: 4_321_000, at }, reason: " " }, "invalid"],
    [{ expected: { milli: 4_321_000, at }, evidence: "" }, "invalid"],
    [{ expected: { milli: 4_321_000, at }, anchor: "has space" }, "invalid"],
  ]) {
    assert.deepEqual(anchor(w, fields), { error }, JSON.stringify(fields));
  }
  assert.equal(pileView(w.ctx.storage.sql).cutover, "pending", "nothing applied");
  // Key order in the reviewed snapshot doesn't matter; its values do.
  assert.deepEqual(anchor(w, { expected: { at, milli: 4_321_000 }, milli: 4_000_000, boundary: 1 }), { ok: true, duplicate: false });
  assert.deepEqual(anchor(w, { expected: { milli: 4_321_000, at }, milli: 4_000_000, boundary: 1 }), { ok: true, duplicate: true }, "the same anchor again");
  for (const fields of [{ milli: 4_000_001 }, { boundary: 0 }, { anchor: "cutover-2" }, { reason: "another reason" }]) {
    assert.deepEqual(anchor(w, { expected: { milli: 4_321_000, at }, milli: 4_000_000, boundary: 1, ...fields }), { error: "anchored" });
  }
  assert.equal(pileView(w.ctx.storage.sql).bananas, 4_000);
});

test("the cutover and the queued credits survive restarts", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await donate(w, relay, 3_000, "QueuedAAA1");
  const revision = pileView(w.ctx.storage.sql).revision;
  new DonationsObject(w.ctx, w.env, w.platform);
  assert.deepEqual(pick(pileView(w.ctx.storage.sql)), { type: "pile", ...PENDING });
  assert.equal(pileView(w.ctx.storage.sql).revision, revision);
  anchor(w, { boundary: 0 });
  const restarted = new DonationsObject(w.ctx, w.env, w.platform);
  assert.deepEqual([restarted.pileMessage().bananas, restarted.pileMessage().cutover], [3, "done"]);
  assert.ok(restarted.pileMessage().revision > revision);
});

test("a credit is permanent: it never repeats after the finished mark is purged", async () => {
  const w = await world();
  anchor(w, {});
  const at = w.platform.now();
  assert.notEqual(w.object.finish({ id: "OldInvoice1", milli: 7_000, at }), false);
  assert.equal(pileView(w.ctx.storage.sql).bananas, 7);
  // The retention purge removes finished marks; the credit's own key stays.
  w.ctx.storage.sql.exec("DELETE FROM finished");
  assert.equal(w.object.finish({ id: "OldInvoice1", milli: 7_000, at }), null, "no change to the pile");
  assert.equal(pileView(w.ctx.storage.sql).bananas, 7);
  assert.equal(deltas(w).length, 1);
  assert.equal(w.object.finish({ id: "OldInvoice1", milli: 7_000, at }), false, "already finished again");
});

test("the boundary must name a delta that exists, and the anchor's time must be valid", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  for (const id of ["DeltaAAAA1", "DeltaBBBB2", "DeltaCCCC3"]) await donate(w, relay, 1_000, id);
  // A hole in the sequence, as a deleted or rolled-back row would leave.
  w.ctx.storage.sql.exec("DELETE FROM pile_deltas WHERE seq = 2");
  assert.deepEqual(anchor(w, { boundary: 2, milli: 1_000 }), { error: "boundary" }, "below the maximum, but not there");
  assert.deepEqual(anchor(w, { boundary: 4, milli: 1_000 }), { error: "boundary" });
  for (const now of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.deepEqual(applyPileAnchor(w.ctx.storage, { anchor: "cutover-1", expected: null, milli: 0, boundary: 0, reason: "r", evidence: "e" }, now), { error: "invalid" });
  }
  assert.equal(pileView(w.ctx.storage.sql).cutover, "pending");
  assert.deepEqual(anchor(w, { boundary: 3, milli: 2_000 }), { ok: true, duplicate: false });
  assert.equal(pileView(w.ctx.storage.sql).bananas, 2);
});

test("a negative level is never clamped or published; it reports review until corrected", async () => {
  const w = await world();
  const sql = w.ctx.storage.sql;
  const delta = (source, milli) => w.ctx.storage.transactionSync(() => recordPileDelta(sql, source, milli, w.platform.now()));
  // Before the anchor: a correction that would make the reviewed level negative is refused.
  delta("donation:BeforeAAA1", 3_000);
  delta("correction:before-1", -5_000);
  assert.deepEqual(anchor(w, { boundary: 0, milli: 1_000 }), { error: "unrepresentable" });
  assert.equal(pileView(sql).cutover, "pending");
  assert.deepEqual(anchor(w, { boundary: 0, milli: 2_000 }), { ok: true, duplicate: false }, "2 + 3 - 5 = 0");
  assert.equal(pileView(sql).bananas, 0);
  // After it: a deficit shows as review, with no number, and a later credit restores it.
  delta("correction:after-1", -1_500);
  assert.deepEqual(pick(pileView(sql)), { type: "pile", bananas: null, at: null, eatPerHour: 0, basis: "credits", cutover: "done", reconciliation: "review", uncertain: null });
  delta("donation:AfterBBBB2", 4_000);
  assert.deepEqual([pileView(sql).bananas, pileView(sql).reconciliation], [2.5, "off"]);
  assert.deepEqual(sql.exec("SELECT sum(milli) AS s FROM pile_deltas").one().s, 500, "every signed delta kept exactly");
});

test("a total too large to represent blocks the pile, before or after its anchor, without crashing", async () => {
  for (const anchored of [false, true]) {
    const w = await world();
    const sql = w.ctx.storage.sql;
    const delta = (source, milli) => w.ctx.storage.transactionSync(() => recordPileDelta(sql, source, milli, w.platform.now()));
    if (anchored) anchor(w, {});
    delta("correction:huge-1", Number.MAX_SAFE_INTEGER - 10);
    assert.doesNotThrow(() => delta("correction:huge-2", 100));
    assert.equal(sql.exec("SELECT cumulative FROM pile_deltas WHERE source = 'correction:huge-2'").one().cumulative, null);
    assert.doesNotThrow(() => delta("donation:AfterAAAA1", 1_000), "later credits are still recorded");
    assert.equal(sql.exec("SELECT count(*) AS n FROM pile_exceptions WHERE reason = 'unrepresentable-total'").one().n, 1);
    const view = pileView(sql);
    assert.deepEqual([view.bananas, view.reconciliation], [null, "review"]);
    if (!anchored) {
      assert.equal(view.cutover, "pending");
      assert.deepEqual(anchor(w, { boundary: 2, milli: 0 }), { error: "unrepresentable" });
      assert.deepEqual(anchor(w, { boundary: 1, milli: 0 }), { error: "unrepresentable" }, "the total after it is unknown too");
    } else {
      assert.equal(view.cutover, "done");
    }
  }
});

test("donations already in the checkpoint are fenced at the cutover, and never add again", async () => {
  const w = await world();
  const sql = w.ctx.storage.sql;
  // The object as the old code left it: schema 8, a saved checkpoint, and finished marks.
  sql.exec("DROP TABLE pile_deltas; DROP TABLE pile_anchor; DROP TABLE pile_legacy; DROP TABLE pile_exceptions; ALTER TABLE pending DROP COLUMN d1_token; DROP TABLE quarantined;");
  sql.exec("UPDATE meta SET value = 8 WHERE key = 'schema'");
  savedCheckpoint(w, 9_000, w.platform.now() - HOUR);
  sql.exec("INSERT INTO finished (invoice, at) VALUES ('InCheckpt1', 1), ('InCheckpt2', 2)");
  const object = new DonationsObject(w.ctx, w.env, w.platform);
  assert.deepEqual(sql.exec("SELECT source, reason FROM pile_legacy ORDER BY source").toArray().map((r) => ({ ...r })), [
    { source: "donation:InCheckpt1", reason: "in-checkpoint" }, { source: "donation:InCheckpt2", reason: "in-checkpoint" },
  ]);
  // The retention purge removes their marks; finishing them again adds nothing.
  sql.exec("DELETE FROM finished");
  assert.equal(object.finish({ id: "InCheckpt1", milli: 5_000, at: w.platform.now() }), null);
  assert.equal(deltas(w).length, 0);
  // A donation D1 recorded but the old code never finished isn't in the checkpoint, so it counts.
  assert.notEqual(object.finish({ id: "UnfinishA1", milli: 2_000, at: w.platform.now() }), false);
  assert.deepEqual(deltas(w).map((d) => d.source), ["donation:UnfinishA1"]);
  assert.equal(anchor(w, { expected: { milli: 9_000, at: w.platform.now() - HOUR }, milli: 9_000 }).ok, true);
  assert.equal(pileView(sql).bananas, 11);
});

test("an invoice id the object already knows is refused before anything payable is shown", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  anchor(w, {});
  await donate(w, relay, 4_000, "ReusedAAA1");
  w.ctx.storage.sql.exec("DELETE FROM finished");
  w.platform.advance(HOUR);
  const { response } = await w.invoice(relay, { sats: 7_000 }, () => ({ id: "ReusedAAA1", bolt11: bolt11For(7_000), expires: EXPIRES }));
  assert.equal(response.status, 503, "closed, so no QR for a reused id");
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM pending").one().n, 0);
  assert.equal(deltas(w).length, 1);
  assert.equal(pileView(w.ctx.storage.sql).bananas, 4);
  assert.equal(w.env.DB.db.prepare("SELECT sats FROM donations WHERE id = 'ReusedAAA1'").get().sats, 4_000);
});

// A D1 row the settling request can't prove it wrote. Timestamps prove nothing: the import and
// the old code's write both come after the pending request was made.
for (const [name, prepare] of [
  ["a manual import into D1 and the checkpoint after the request was made", (w, invoice) => {
    w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES (?, 2000, 'imported', '', ?, 'onchain', 2000)")
      .run(invoice, w.platform.now());
    w.ctx.storage.sql.exec("UPDATE pile SET milli = milli + 2000");
  }],
  ["a write the old code made before a crash, with no token", (w, invoice) => {
    w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES (?, 2000, 'ooga-dev', '', ?, 'lightning', 2000)")
      .run(invoice, w.platform.now());
    w.ctx.storage.sql.exec("UPDATE pending SET settling = 1, d1_token = NULL WHERE invoice = ?", invoice);
  }],
]) {
  test(`${name} is held for review, never credited, and every page hears it`, async () => {
    const w = await world();
    const at = w.platform.now() - HOUR;
    savedCheckpoint(w, 9_000, at);
    const relay = await w.connectRelay();
    assert.equal(anchor(w, { expected: { milli: 9_000, at }, milli: 9_000 }).ok, true);
    const page = await w.connectPage();
    await w.invoice(relay, { sats: 2_000 }, () => ({ id: "UnprovenA1", bolt11: bolt11For(2_000), expires: EXPIRES }));
    w.platform.advance(1_000);
    prepare(w, "UnprovenA1");
    const lifetime = () => ({ ...w.env.DB.db.prepare("SELECT count, sats FROM tally WHERE id = 1").get() });
    const before = lifetime();
    const piles = typed(page, "pile").length;
    await w.relaySays(relay, { type: "paid", invoice: "UnprovenA1", sats: 2_000, method: "lightning" });
    assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: "UnprovenA1", result: "rejected" });
    assert.equal(typed(page, "donation").length, 0, "no donation event");
    assert.equal(deltas(w).length, 0, "no credit restored");
    assert.deepEqual(lifetime(), before, "lifetime figures untouched by the quarantine");
    const heard = typed(page, "pile");
    assert.equal(heard.length, piles + 1, "the review state is broadcast at once");
    assert.deepEqual([heard.at(-1).bananas, heard.at(-1).reconciliation], [9, "review"]);
    // A retry is idempotent: nothing new recorded, nothing credited.
    await w.relaySays(relay, { type: "paid", invoice: "UnprovenA1", sats: 2_000, method: "lightning" });
    assert.equal(JSON.parse(relay.sent.at(-1)).result, "duplicate");
    assert.deepEqual(w.ctx.storage.sql.exec("SELECT source, reason FROM pile_exceptions").toArray().map((r) => ({ ...r })),
      [{ source: "donation:UnprovenA1", reason: "unproven-existing-donation" }]);
    assert.equal(deltas(w).length, 0);
    // And the id is never offered again.
    const { response } = await w.invoice(relay, { sats: 2_000 }, () => ({ id: "UnprovenA1", bolt11: bolt11For(2_000), expires: EXPIRES }));
    assert.equal(response.status, 503);
  });
}

// A collision with a D1 row someone else's payment may own: the new settlement's own record.
async function quarantinedPayment() {
  const w = await world();
  const relay = await w.connectRelay();
  anchor(w, {});
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 2_000, handle: "chosen-name", message: "for the cave" },
    () => ({ id: "CollideAA1", bolt11: bolt11For(2_000), expires: EXPIRES }), { donor: donor("ooga-dev", 4242) });
  const pending = { ...w.ctx.storage.sql.exec("SELECT * FROM pending WHERE invoice = 'CollideAA1'").one() };
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli, github_id) VALUES ('CollideAA1', 9000, 'someone-else', 'older note', ?, 'onchain', 9000, 7)")
    .run(w.platform.now());
  const d1 = () => ({ ...w.env.DB.db.prepare("SELECT * FROM donations WHERE id = 'CollideAA1'").get() });
  const before = d1();
  await w.relaySays(relay, { type: "paid", invoice: "CollideAA1", sats: 2_000, method: "lightning" });
  const archive = () => w.ctx.storage.sql.exec("SELECT * FROM quarantined").toArray().map((r) => ({ ...r }));
  return { w, relay, page, pending, before, d1, archive };
}

test("a quarantined settlement keeps its own attribution, value and provenance, privately", async () => {
  const { w, relay, page, pending, before, d1, archive } = await quarantinedPayment();
  assert.deepEqual(JSON.parse(relay.sent.at(-1)).result, "rejected");
  const [kept] = archive();
  assert.deepEqual({
    invoice: kept.invoice, reason: kept.reason, method: kept.method, sats: kept.sats, handle: kept.handle, message: kept.message,
    github_id: kept.github_id, github_login: kept.github_login, milli: kept.milli, pricing: kept.pricing, created: kept.created,
  }, {
    invoice: "CollideAA1", reason: "unproven-existing-donation", method: "lightning", sats: 2_000, handle: "chosen-name",
    message: "for the cave", github_id: 4242, github_login: "ooga-dev", milli: 2_000, pricing: "receipt", created: pending.created,
  });
  assert.deepEqual([kept.price_cents, kept.price_stale], [10_000_000, 0], "the price frozen at receipt");
  assert.ok(Number.isSafeInteger(kept.price_at) && Number.isSafeInteger(kept.received_at));
  assert.match(kept.d1_token, /^[0-9a-f]+$/, "this settlement's own provenance");
  assert.deepEqual([kept.existing_seq, kept.existing_sats, kept.existing_provenance], [before.seq, 9_000, null], "what it found in D1");
  assert.equal(kept.request_hash, await hashRequest(pending.request), "the request token only as its hash");
  assert.equal(Object.values(kept).includes(pending.request), false, "never the raw token");
  assert.deepEqual(d1(), before, "D1 unchanged");
  assert.equal(deltas(w).length, 0, "no credit");
  assert.equal(typed(page, "donation").length, 0, "no donation event");
  const published = page.sent.join("\n");
  for (const secret of ["chosen-name", "for the cave", pending.request, kept.request_hash, kept.d1_token]) {
    assert.equal(published.includes(secret), false, "nothing archived reaches a page");
  }
});

test("the archive survives restarts and retention purges, and a retry never overwrites it", async () => {
  const { w, relay, archive } = await quarantinedPayment();
  const first = archive();
  assert.equal(first.length, 1);
  // A restart, then long past the retention period, then a purge.
  const object = new DonationsObject(w.ctx, w.env, w.platform);
  w.platform.advance(30 * 24 * HOUR);
  object.purge();
  assert.deepEqual(archive(), first);
  // A repeated notice, and two quarantines of the same request racing with different text:
  // the first record stands, and the pile records the exception once.
  await w.relaySays(relay, { type: "paid", invoice: "CollideAA1", sats: 2_000, method: "lightning" });
  const row = { ...first[0], request: "1".repeat(32), handle: "racing-a" };
  await Promise.all([
    object.quarantine("CollideAA1", row, "unproven-existing-donation"),
    object.quarantine("CollideAA1", { ...row, handle: "racing-b" }, "unproven-existing-donation"),
  ]);
  const after = archive();
  assert.deepEqual(after.filter((r) => r.request_hash === first[0].request_hash), first, "the original is never overwritten");
  // Which racer's hash resolves first isn't fixed, so either may win; exactly one is archived,
  // and the loser never overwrites it.
  const raced = after.filter((r) => r.request_hash !== first[0].request_hash);
  assert.equal(raced.length, 1, "racers write once");
  assert.ok(["racing-a", "racing-b"].includes(raced[0].handle));
  await object.quarantine("CollideAA1", { ...row, handle: "late-retry" }, "unproven-existing-donation");
  assert.deepEqual(archive().filter((r) => r.request_hash !== first[0].request_hash), raced, "a later retry changes nothing");
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM pile_exceptions").one().n, 1);
  assert.equal(deltas(w).length, 0);
});

test("the same delta source with another amount is a conflict for review, not a retry", async () => {
  const w = await world();
  const sql = w.ctx.storage.sql;
  anchor(w, {});
  const delta = (milli) => w.ctx.storage.transactionSync(() => recordPileDelta(sql, "donation:ConflictA1", milli, w.platform.now()));
  assert.equal(delta(3_000), true);
  const revision = pileView(sql).revision;
  assert.equal(delta(3_000), false, "the same amount again is a retry");
  assert.deepEqual([pileView(sql).revision, pileView(sql).reconciliation], [revision, "off"]);
  assert.equal(delta(4_000), false);
  assert.deepEqual([pileView(sql).bananas, pileView(sql).reconciliation], [3, "review"], "the first amount stands, and review shows");
  assert.deepEqual(sql.exec("SELECT source, reason, milli FROM pile_exceptions").toArray().map((r) => ({ ...r })),
    [{ source: "donation:ConflictA1", reason: "delta-conflict", milli: 4_000 }]);
  // Through the runtime: a finish whose mark was purged, with a different amount, sends the
  // pile's changed health.
  sql.exec("DELETE FROM finished");
  w.object.finish({ id: "RuntimeAA1", milli: 1_000, at: w.platform.now() });
  sql.exec("DELETE FROM finished");
  const changed = w.object.finish({ id: "RuntimeAA1", milli: 1_500, at: w.platform.now() });
  assert.deepEqual([changed?.bananas, changed?.reconciliation], [4, "review"]);
  sql.exec("DELETE FROM finished");
  assert.equal(w.object.finish({ id: "RuntimeAA1", milli: 1_000, at: w.platform.now() }), null, "an identical repeat stays silent");
});

test("a crash after this settlement's own D1 write is recovered by its token, once", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  anchor(w, {});
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 3_000 }, () => ({ id: "ProvenAAA1", bolt11: bolt11For(3_000), expires: EXPIRES }));
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("INSERT INTO donations")) return statement;
    return { bind: (...args) => ({ first: async () => { await statement.bind(...args).first(); throw new Error("stopped"); } }) };
  };
  await w.relaySays(relay, { type: "paid", invoice: "ProvenAAA1", sats: 3_000, method: "lightning" });
  w.env.DB.prepare = prepare;
  const token = w.ctx.storage.sql.exec("SELECT d1_token FROM pending WHERE invoice = 'ProvenAAA1'").one().d1_token;
  assert.match(token, /^[0-9a-f]+$/);
  assert.equal(w.env.DB.db.prepare("SELECT provenance FROM donations WHERE id = 'ProvenAAA1'").get().provenance, token);
  await w.relaySays(relay, { type: "paid", invoice: "ProvenAAA1", sats: 3_000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: "ProvenAAA1", result: "duplicate" });
  assert.deepEqual([typed(page, "donation").length, deltas(w).length, pileView(w.ctx.storage.sql).bananas], [1, 1, 3]);
  await w.relaySays(relay, { type: "paid", invoice: "ProvenAAA1", sats: 3_000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)).result, "duplicate");
  assert.deepEqual([typed(page, "donation").length, deltas(w).length], [1, 1], "after the ack, nothing repeats");
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM pile_exceptions").one().n, 0);
});

test("the pile reads a running total, not the whole history", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  for (const [i, sats] of [1_000, 2_000, 3_000].entries()) await donate(w, relay, sats, `RunningAA${i}`);
  assert.deepEqual(w.ctx.storage.sql.exec("SELECT seq, cumulative FROM pile_deltas ORDER BY seq").toArray().map((r) => [r.seq, r.cumulative]),
    [[1, 1_000], [2, 3_000], [3, 6_000]]);
  anchor(w, { boundary: 2, milli: 10_000 });
  assert.equal(w.ctx.storage.sql.exec("SELECT included FROM pile_anchor").one().included, 3_000);
  assert.equal(pileView(w.ctx.storage.sql).bananas, 13, "10 reviewed, plus the 3 after the boundary");
});

test("revisions only move forward, and only when the pile changes", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const seen = [pileView(w.ctx.storage.sql).revision];
  await donate(w, relay, 1_000, "QueuedAAA1");
  seen.push(pileView(w.ctx.storage.sql).revision);
  w.object.finish({ id: "QueuedAAA1", milli: 1_000, at: w.platform.now() });
  seen.push(pileView(w.ctx.storage.sql).revision);
  anchor(w, { boundary: 1, milli: 1_000 });
  seen.push(pileView(w.ctx.storage.sql).revision);
  anchor(w, { boundary: 1, milli: 1_000 });
  seen.push(pileView(w.ctx.storage.sql).revision);
  assert.deepEqual(seen, [0, 1, 1, 2, 2]);
});

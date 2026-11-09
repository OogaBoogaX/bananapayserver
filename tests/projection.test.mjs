// The D1 projection of receipt accounting, through the real object and the D1 stand-in.
// Mappings are seeded through the core, as provider ingestion (not built yet) would make them;
// issuance stays off. Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject, PRICE_FRESH_MS } from "../worker/object.mjs";
import { drainProjection, PROJECTION_BATCH_MAX } from "../worker/projection.mjs";
import { hashRequest } from "../worker/receipts.mjs";
import { pay, provider, read, READ, RECEIPT_SETTINGS as SETTINGS, seed, TOKEN } from "./helpers/receipt-seed.mjs";
import { syntheticAddress } from "./helpers/synthetic-address.mjs";
import { world } from "./helpers/world.mjs";

const HOUR = 3_600_000;
const d1 = (w, sql, ...args) => w.env.DB.db.prepare(sql).get(...args);
const all = (w, sql, ...args) => w.env.DB.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const tally = (w) => ({ ...d1(w, "SELECT count, sats, milli, last FROM tally WHERE id = 1") });
const row = (w, sql, ...args) => { const r = d1(w, sql, ...args); return r ? { ...r } : null; };
const handleTotal = (w, handle) => row(w, "SELECT milli, sats, donations FROM handle_totals WHERE handle = ?", handle);
const accountTotal = (w, owner) => row(w, "SELECT sats, milli, donations FROM receipt_account_totals WHERE owner = ?", owner);
const outbox = (w) => w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_outbox").one().n;
const markers = (w) => d1(w, "SELECT count(*) AS n FROM receipt_applied").n;
const receiptsOf = (w, invoice) => w.ctx.storage.sql.exec("SELECT * FROM ra_receipts WHERE invoice = ? ORDER BY ord", invoice).toArray().map((r) => ({ ...r }));
const typed = (page, type) => page.messages().filter((m) => m.type === type);
const pileJournals = (w) => [
  w.ctx.storage.sql.exec("SELECT count(*) AS n FROM pile_deltas").one().n,
  w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_pile_deltas").one().n,
];

// Counts relative to the tally a world starts with.
const since = (w, base) => { const t = tally(w); return [t.count - base.count, t.sats - base.sats, t.milli - base.milli]; };

test("a first credit reaches the lifetime figures once, after the batch is durable, and never touches donations", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const before = tally(w);
  read(w, ledger, invoice, [pay(1)]);
  const journals = pileJournals(w);
  const pending = outbox(w);
  assert.ok(pending >= 2, "the receipt's first observation and its credit");
  const result = await w.object.projectReceipts();
  assert.deepEqual([result.applied, result.conflict, result.failed], [pending, null, null]);
  assert.deepEqual([outbox(w), markers(w)], [0, pending]);
  assert.deepEqual(tally(w), { count: before.count + 1, sats: before.sats + 1000, milli: before.milli + 1000, last: 1000 });
  const [r] = receiptsOf(w, invoice);
  assert.deepEqual(row(w, "SELECT sats, milli FROM tally_hours WHERE hour = ?", r.created_at - (r.created_at % HOUR)), { sats: 1000, milli: 1000 });
  assert.deepEqual(handleTotal(w, "ooga-dev"), { milli: 1000, sats: 1000, donations: 1 });
  assert.deepEqual(accountTotal(w, 4242), { sats: 1000, milli: 1000, donations: 1 });
  assert.equal(d1(w, "SELECT count(*) AS n FROM donations").n, 0, "receipt credit never passes through legacy donations");
  assert.deepEqual(row(w, "SELECT revision, credit, milli, handle, state FROM receipt_projection WHERE receipt = ?", r.id),
    { revision: r.revision, credit: 1000, milli: 1000, handle: "ooga-dev", state: "credited" });
  assert.equal(w.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'projection_publish'").one().value, 0, "published, and noted as done");
  // Nothing private reaches the receipt projection, and the pile journals are untouched.
  const text = JSON.stringify([all(w, "SELECT * FROM receipt_projection"), all(w, "SELECT * FROM receipt_invoices")]);
  for (const secret of [syntheticAddress(1), "01".repeat(32), "btcpay", "store-a", "4242", TOKEN(0xa1)]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(pileJournals(w), journals, "no pile delta added by projection");
});

test("revisions that change no credit change no figure and need no publication", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const before = tally(w);
  read(w, ledger, invoice, [pay(1, "observed")]);
  const pending = outbox(w);
  const result = await w.object.projectReceipts();
  assert.deepEqual([result.applied, outbox(w)], [pending, 0]);
  assert.deepEqual(tally(w), before);
  assert.equal(handleTotal(w, "ooga-dev"), null);
  assert.equal(d1(w, "SELECT credit FROM receipt_projection").credit, 0);
  assert.equal(w.object.receipts.publicationPending(), false);
});

test("each credited receipt is its own donation: partial and repeat payments count separately, reversal and reconfirmation once", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const base = tally(w);
  const step = async () => { await w.object.projectReceipts(); return since(w, base); };
  read(w, ledger, invoice, [pay(1)]);
  assert.deepEqual(await step(), [1, 1000, 1000]);
  read(w, ledger, invoice, [pay(1), pay(2, "settled", 3000)]);
  assert.deepEqual(await step(), [2, 4000, 4000], "a repeat payment is a second donation");
  read(w, ledger, invoice, [pay(1, "invalid"), pay(2, "settled", 3000)]);
  assert.deepEqual(await step(), [2, 4000, 4000], "under review, the credit still stands");
  const [first] = receiptsOf(w, invoice);
  ledger.reverse(first.id, "synthetic double spend");
  assert.deepEqual(await step(), [1, 3000, 3000], "reversed once");
  assert.deepEqual(handleTotal(w, "ooga-dev"), { milli: 3000, sats: 3000, donations: 1 });
  read(w, ledger, invoice, [pay(1), pay(2, "settled", 3000)]);
  assert.deepEqual(await step(), [2, 4000, 4000], "reconfirmed once, at the same frozen price");
  assert.deepEqual(handleTotal(w, "ooga-dev"), { milli: 4000, sats: 4000, donations: 2 });
  assert.deepEqual(accountTotal(w, 4242), { sats: 4000, milli: 4000, donations: 2 });
  assert.equal(d1(w, "SELECT handle FROM receipt_projection WHERE receipt = ?", first.id).handle, "ooga-dev", "attribution kept throughout");
});

test("the tally's last is the newest valid donation by first observation, through reversals and older reconfirmations", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1, "settled", 1500)]);
  w.platform.advance(1_000);
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 2500, "the newer receipt");
  const [older, newer] = receiptsOf(w, invoice);
  // Reversing the newest receipt: last falls back to the newest still valid.
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "invalid", 2500)]);
  ledger.reverse(newer.id, "synthetic double spend");
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 1500, "a reversed receipt is never last");
  // Reconfirming it restores it; reversing and reconfirming the older one doesn't displace it.
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 2500);
  read(w, ledger, invoice, [pay(1, "invalid", 1500), pay(2, "settled", 2500)]);
  ledger.reverse(older.id, "synthetic double spend");
  await w.object.projectReceipts();
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 2500, "an older reconfirmation never overwrites a newer donation");
  // A legacy donation recorded after both is the newest, and stays so.
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES ('LegacyNew1', 700, 'legacy', '', ?, 'lightning', 700)")
    .run(w.platform.now() + 60_000);
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500), pay(3, "settled", 900)]);
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 700, "first observation, not processing order, decides");
});

test("account totals follow the saved stable id: same handle for two accounts, a renamed handle, anonymous and unpriced", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const a = await seed(w, ledger, { invoice: "AccountA01", token: TOKEN(0x501), owner: 4242, login: "ooga-dev", addresses: [1] });
  const b = await seed(w, ledger, { invoice: "AccountB01", token: TOKEN(0x502), owner: 777, login: "ooga-dev", addresses: [2] });
  const renamed = await seed(w, ledger, { invoice: "AccountA02", token: TOKEN(0x503), owner: 4242, login: "new-name", addresses: [3] });
  const guest = await seed(w, ledger, { invoice: "GuestInv01", token: TOKEN(0x504), owner: null, login: null, addresses: [4] });
  const unpriced = await seed(w, ledger, { invoice: "Unpriced01", token: TOKEN(0x505), owner: 4242, login: "ooga-dev", addresses: [5] });
  read(w, ledger, a.invoice, [pay(1)]);
  read(w, ledger, b.invoice, [{ ...pay(2), destination: syntheticAddress(2) }]);
  read(w, ledger, renamed.invoice, [{ ...pay(3, "settled", 2000), destination: syntheticAddress(3) }]);
  read(w, ledger, guest.invoice, [{ ...pay(4), destination: syntheticAddress(4) }]);
  // An unpriced receipt: sats count, no bananas.
  const { sequence } = ledger.beginRead(unpriced.invoice, { line: "line-1", generation: "0123456789abcdef" });
  const begin = { frame: "begin", status: "Processing", left: null, destination: null, provider: "btcpay", store: "store-a", observedAt: w.platform.now(),
    provenance: "sweep", policyVersion: "policy-1", capabilities: { complete: false, outpoints: true, lightningSuccess: true, remaining: true, destination: false } };
  const out = ledger.applySnapshot({ invoice: unpriced.invoice, line: "line-1", generation: "0123456789abcdef", sequence, candidate: null,
    frames: [begin, { frame: "payment", index: 0, payment: { ...pay(5, "settled", 500), destination: syntheticAddress(5) } }, { frame: "end", count: 1 }] });
  ledger.beginPricing(out.priced[0]);
  ledger.freezePrice(out.priced[0], null);
  const base = tally(w);
  await w.object.projectReceipts();
  assert.deepEqual(handleTotal(w, "ooga-dev"), { milli: 2000, sats: 2500, donations: 3 }, "one display handle, two accounts and an unpriced receipt");
  assert.deepEqual(handleTotal(w, "new-name"), { milli: 2000, sats: 2000, donations: 1 });
  assert.deepEqual(handleTotal(w, "anon"), { milli: 1000, sats: 1000, donations: 1 });
  assert.deepEqual(accountTotal(w, 4242), { sats: 3500, milli: 3000, donations: 3 }, "the account across its renamed handle, unpriced included");
  assert.deepEqual(accountTotal(w, 777), { sats: 1000, milli: 1000, donations: 1 }, "a different account under the same handle stays apart");
  assert.equal(d1(w, "SELECT count(*) AS n FROM receipt_account_totals").n, 2, "anonymous credit has no account");
  // Consistency: every credited sat appears once in the tally, and the named handles sum to it.
  const named = d1(w, "SELECT sum(sats) AS s FROM handle_totals").s;
  assert.equal(since(w, base)[1], named, "every credited sat once in the tally, and in exactly one handle");
  // The legacy account totals stay the history 0007 left them.
  assert.equal(d1(w, "SELECT count(*) AS n FROM totals").n, 0);
});

test("a crash after a credit-bearing batch, before its row is removed, publishes D1's figures on retry without a second count", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const page = await w.connectPage();
  await w.ctx.settle();
  read(w, ledger, invoice, [pay(1)]);
  const before = tally(w);
  const projected = w.object.receipts.projected.bind(w.object.receipts);
  // Stops exactly after the batch that moves the figures.
  w.object.receipts.projected = (id, options) => {
    if (options?.publish) throw new Error("stopped after the credit");
    return projected(id, options);
  };
  await assert.rejects(w.object.projectReceipts(), /stopped after the credit/);
  w.object.receipts.projected = projected;
  assert.deepEqual(since(w, before), [1, 1000, 1000], "D1 has the credit");
  assert.equal(outbox(w), 1, "its row is still there");
  const heard = page.messages().length;
  // A restart, with the page's socket still open: the marker matches, nothing is recounted, and
  // the page gets D1's current figures.
  w.object = new DonationsObject(w.ctx, w.env, w.platform);
  const result = await w.object.projectReceipts();
  assert.deepEqual([result.skipped, outbox(w)], [1, 0]);
  assert.deepEqual(since(w, before), [1, 1000, 1000]);
  const sent = page.messages().slice(heard);
  assert.equal(sent.find((m) => m.type === "tally")?.sats, before.sats + 1000, "the authoritative tally, after the restart");
  assert.ok(sent.some((m) => m.type === "board"));
  assert.equal(w.object.receipts.publicationPending(), false);
});

test("a failed fresh read after the batch keeps the publication durable; a cached board is never taken for success", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const page = await w.connectPage();
  await w.ctx.settle();
  read(w, ledger, invoice, [pay(1)]);
  const before = tally(w);
  const { prepare } = w.env.DB;
  w.env.DB.prepare = (sql) => (sql.includes("FROM handle_totals ORDER BY") || sql.includes("FROM handle_totals WHERE milli > 0")
    ? { bind: () => ({ all: async () => { throw new Error("D1 unavailable"); } }) } : prepare(sql));
  const heard = page.messages().length;
  await w.object.projectReceipts();
  w.env.DB.prepare = prepare;
  assert.deepEqual([outbox(w), since(w, before)], [0, [1, 1000, 1000]], "the credit is applied and its row removed");
  assert.equal(w.object.receipts.publicationPending(), true, "but the publication is still owed");
  assert.equal(page.messages().slice(heard).filter((m) => m.type === "tally").length, 0, "nothing sent from a failed read");
  // Retried only after the cadence, then sent from D1.
  assert.equal(await w.object.projectReceipts(), null, "not before the retry time");
  w.platform.advance(PRICE_FRESH_MS + 1);
  w.object = new DonationsObject(w.ctx, w.env, w.platform);
  await w.object.projectReceipts();
  assert.equal(w.object.receipts.publicationPending(), false);
  assert.equal(page.messages().slice(heard).find((m) => m.type === "tally")?.sats, before.sats + 1000);
  assert.deepEqual(since(w, before), [1, 1000, 1000], "never counted twice");
});

test("D1 failures apply nothing, keep the outbox, and are retried on the cadence, never in a tight loop", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { capabilities: { complete: true } });
  const pending = outbox(w);
  const before = tally(w);
  const { prepare, batch } = w.env.DB;
  for (const [name, broken] of [
    ["the marker read", { prepare: (sql) => (sql.startsWith("SELECT hash FROM receipt_applied") ? { bind: () => ({ first: async () => { throw new Error("D1 unavailable"); } }) } : prepare(sql)) }],
    ["the batch", { batch: async () => { throw new Error("D1 unavailable"); } }],
  ]) {
    Object.assign(w.env.DB, broken);
    // No page is open: the alarm alone drives it.
    await w.fireAlarm();
    Object.assign(w.env.DB, { prepare, batch });
    assert.deepEqual([outbox(w), markers(w), tally(w)], [pending, 0, before], name);
    assert.equal(w.object.accountingCapability().reconciliation, "behind", name);
    const alarm = await w.ctx.storage.getAlarm();
    assert.ok(alarm >= w.platform.now() + PRICE_FRESH_MS, `${name}: the retry waits the cadence`);
    // Firing early changes nothing and schedules no sooner.
    await w.fireAlarm();
    assert.equal(outbox(w), pending);
    assert.ok(await w.ctx.storage.getAlarm() > w.platform.now(), `${name}: never an immediate alarm`);
    // The retry time survives a restart.
    w.object = new DonationsObject(w.ctx, w.env, w.platform);
    assert.equal(await w.object.projectReceipts(), null);
    w.platform.advance(PRICE_FRESH_MS + 1);
  }
  await w.fireAlarm();
  assert.deepEqual([outbox(w), markers(w), since(w, before)], [0, pending, [1, 1000, 1000]]);
});

test("receipt deadlines with no page open never make the alarm immediate", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { left: 9000 });
  await w.object.projectReceipts();
  // Long after the remaining amount went stale, with nobody listening.
  w.platform.advance(10 * READ.freshnessMs);
  await w.fireAlarm();
  const alarm = await w.ctx.storage.getAlarm();
  assert.ok(alarm === null || alarm > w.platform.now(), "sleeps, or wakes later; never now");
  // Nobody is shown it, so the alarm leaves it for the next authorized read to commit (see the
  // no-page test in receipt-endpoints).
  assert.equal(w.ctx.storage.sql.exec("SELECT left_sats FROM ra_invoices WHERE invoice = ?", invoice).one().left_sats, 9000, "and changes no receipt evidence on its own");
});

test("a stalled D1 never delays withdrawing a stale remaining amount from open pages", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { left: 9000, destination: syntheticAddress(1), capabilities: { destination: true } });
  await w.object.projectReceipts();
  const page = await w.connectPage();
  await w.ctx.settle();
  // A new credit waiting, and every D1 call from now on hangs.
  read(w, ledger, invoice, [pay(1), pay(2)], { left: 8000, destination: syntheticAddress(1), capabilities: { destination: true } });
  const never = new Promise(() => {});
  const hang = { bind: () => hang, first: () => never, all: () => never, run: () => never };
  w.env.DB.prepare = () => hang;
  w.env.DB.batch = () => never;
  w.platform.advance(READ.freshnessMs + 1);
  // The alarm is left running, as it would be against a stalled D1.
  w.object.alarm();
  const withdrawn = typed(page, "invoiceStatus").filter((f) => f.replay === false && f.invoice.left === null);
  assert.equal(withdrawn.length, 1, "withdrawn at once, before anything waits on D1");
});

test("a conflict is never drained again and schedules nothing until reviewed", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES (?, 5000, 'legacy', '', 1, 'onchain', 5000)").run(invoice);
  const before = tally(w);
  read(w, ledger, invoice, [pay(1)]);
  const pending = outbox(w);
  const result = await w.object.projectReceipts();
  assert.equal(result.conflict, "legacy-collision");
  assert.deepEqual([outbox(w), tally(w), d1(w, "SELECT count(*) AS n FROM receipt_projection").n], [pending, before, 0], "rolled back whole");
  assert.equal(w.object.accountingCapability().reconciliation, "review");
  assert.equal(await w.object.projectReceipts(), null, "never drained again");
  assert.equal(w.object.projectionDue(), null);
  await w.ctx.storage.deleteAlarm();
  await w.fireAlarm();
  assert.equal(await w.ctx.storage.getAlarm(), null, "no alarm for a quarantined conflict");
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_projection_conflicts").one().n, 1);
  // And the other way round: a receipt-mode invoice already projected refuses a legacy insert.
  const w2 = await world(SETTINGS);
  const ledger2 = provider(w2);
  const other = await seed(w2, ledger2);
  read(w2, ledger2, other.invoice, [pay(1)]);
  await w2.object.projectReceipts();
  assert.throws(() => w2.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method) VALUES (?, 1, 'x', '', 1, 'onchain')").run(other.invoice), /receipt-mode/);
});

test("a total that would leave the safe range is held for review, not rounded or published", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  w.env.DB.db.prepare("UPDATE tally SET sats = ? WHERE id = 1").run(Number.MAX_SAFE_INTEGER - 10);
  const before = tally(w);
  read(w, ledger, invoice, [pay(1)]);
  const pending = outbox(w);
  const result = await w.object.projectReceipts();
  assert.equal(result.conflict, "unsafe-total");
  assert.deepEqual(tally(w), before, "nothing applied");
  assert.ok(outbox(w) >= 1 && outbox(w) <= pending, "the offending work is kept");
  assert.equal(w.object.accountingCapability().reconciliation, "review");
});

// Every aggregate a projection batch can touch, as exact text, so a value beyond a JavaScript
// number (or a REAL from an overflowing sum) is compared exactly rather than read lossily.
const aggregates = (w) => d1(w,
  "SELECT (SELECT group_concat(quote(count) || ',' || quote(sats) || ',' || quote(milli) || ',' || quote(last), ';') FROM tally) AS tally, " +
  "(SELECT group_concat(hour || ':' || quote(sats) || ',' || quote(milli), ';') FROM (SELECT * FROM tally_hours ORDER BY hour)) AS hours, " +
  "(SELECT group_concat(handle || ':' || quote(sats) || ',' || quote(milli) || ',' || quote(donations), ';') FROM (SELECT * FROM handle_totals ORDER BY handle)) AS handles, " +
  "(SELECT group_concat(owner || ':' || quote(sats) || ',' || quote(milli) || ',' || quote(donations), ';') FROM (SELECT * FROM receipt_account_totals ORDER BY owner)) AS accounts");
const snapshot = (w) => ({ ...aggregates(w) });

// Runs `write` against D1 exactly once, in the window between a drain's reads and its
// credit-bearing batch: where a legacy delivery can land while the drain awaits D1. `after` is
// every aggregate as the write left it, just before that batch runs.
function interleave(w, write) {
  const { batch } = w.env.DB;
  const seen = { landed: false, after: null };
  w.env.DB.batch = async (statements) => {
    if (!seen.landed && statements.some((s) => s.sql.startsWith("INSERT INTO receipt_projection_guard"))) {
      seen.landed = true;
      write(w.env.DB.db);
      seen.after = snapshot(w);
    }
    return batch.call(w.env.DB, statements);
  };
  return seen;
}

const legacyAt = (db, id, sats, at) =>
  db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES (?, ?, 'ooga-dev', '', ?, 'lightning', ?)").run(id, sats, at, sats);

test("a legacy credit landing between the drain's reads and its batch is checked inside the batch: never past the safe range", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  // Far enough from the bound that any check read before the batch would pass.
  w.env.DB.db.prepare("UPDATE tally SET sats = ? WHERE id = 1").run(Number.MAX_SAFE_INTEGER - 5000);
  read(w, ledger, invoice, [pay(1)]);
  // An otherwise valid legacy credit, near the bound, lands in the window.
  const seen = interleave(w, (db) => legacyAt(db, "LegacyMid1", 4500, w.platform.now()));
  const result = await w.object.projectReceipts();
  assert.equal(seen.landed, true, "the legacy write landed in the window");
  assert.equal(result.conflict, "unsafe-total");
  assert.deepEqual(snapshot(w), seen.after, "every aggregate exactly as the legacy write left it");
  assert.equal(d1(w, "SELECT sats FROM tally WHERE id = 1").sats, Number.MAX_SAFE_INTEGER - 500, "the legacy amount stands, unchanged");
  assert.equal(d1(w, "SELECT count(*) AS n FROM donations WHERE id = 'LegacyMid1'").n, 1);
  // The credit-bearing revision rolled back whole: no marker, no credited projection.
  const held = w.ctx.storage.sql.exec("SELECT outbox_id, receipt, revision, reason FROM ra_projection_conflicts").one();
  assert.equal(held.reason, "unsafe-total");
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_outbox WHERE id = ?", held.outbox_id).one().n, 1, "its outbox row is kept");
  assert.equal(d1(w, "SELECT count(*) AS n FROM receipt_applied WHERE receipt = ? AND revision = ?", held.receipt, held.revision).n, 0);
  assert.equal(d1(w, "SELECT count(*) AS n FROM receipt_projection WHERE credit > 0").n, 0);
  assert.equal(d1(w, "SELECT count(*) AS n FROM receipt_projection_guard").n, 0, "the guard never stores a row");
  assert.equal(w.object.accountingCapability().reconciliation, "review");
  assert.equal(await w.object.projectReceipts(), null, "held for review, never drained again");
});

test("a legacy credit in the window that leaves room exactly to the bound lets the receipt land on it", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  w.env.DB.db.prepare("UPDATE tally SET sats = ? WHERE id = 1").run(Number.MAX_SAFE_INTEGER - 5000);
  read(w, ledger, invoice, [pay(1)]);
  const seen = interleave(w, (db) => legacyAt(db, "LegacyMid2", 4000, w.platform.now()));
  const result = await w.object.projectReceipts();
  assert.deepEqual([seen.landed, result.conflict, result.failed], [true, null, null]);
  assert.equal(d1(w, "SELECT sats FROM tally WHERE id = 1").sats, Number.MAX_SAFE_INTEGER, "legacy and receipt both counted, exactly");
});

test("every total a batch touches is bounded inside it: each column near the bound, an overflow to REAL, and a negative", async () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // What lands in the window, against the receipt's own hour, handle and account rows.
  const cases = [
    ["tally.count", (db) => db.prepare("UPDATE tally SET count = ? WHERE id = 1").run(MAX)],
    ["tally.sats", (db) => db.prepare("UPDATE tally SET sats = ? WHERE id = 1").run(MAX - 500)],
    ["tally.milli", (db) => db.prepare("UPDATE tally SET milli = ? WHERE id = 1").run(MAX - 500)],
    ["tally_hours.sats", (db, hour) => db.prepare("INSERT INTO tally_hours (hour, sats, milli) VALUES (?, ?, 0) ON CONFLICT (hour) DO UPDATE SET sats = excluded.sats").run(hour, MAX - 500)],
    ["tally_hours.milli", (db, hour) => db.prepare("INSERT INTO tally_hours (hour, sats, milli) VALUES (?, 0, ?) ON CONFLICT (hour) DO UPDATE SET milli = excluded.milli").run(hour, MAX - 500)],
    ["handle_totals.sats", (db) => db.prepare("INSERT INTO handle_totals (handle, milli, sats, donations) VALUES ('ooga-dev', 0, ?, 0)").run(MAX - 500)],
    ["handle_totals.milli", (db) => db.prepare("INSERT INTO handle_totals (handle, milli, sats, donations) VALUES ('ooga-dev', ?, 0, 0)").run(MAX - 500)],
    ["handle_totals.donations", (db) => db.prepare("INSERT INTO handle_totals (handle, milli, sats, donations) VALUES ('ooga-dev', 0, 0, ?)").run(MAX)],
    ["account.sats", (db) => db.prepare("INSERT INTO receipt_account_totals (owner, sats, milli, donations) VALUES (4242, ?, 0, 0)").run(MAX - 500)],
    ["account.milli", (db) => db.prepare("INSERT INTO receipt_account_totals (owner, sats, milli, donations) VALUES (4242, 0, ?, 0)").run(MAX - 500)],
    ["account.donations", (db) => db.prepare("INSERT INTO receipt_account_totals (owner, sats, milli, donations) VALUES (4242, 0, 0, ?)").run(MAX)],
    // Past the 64-bit range, SQLite's sum becomes a REAL: never an exact total.
    ["int64 overflow", (db) => db.exec("UPDATE tally SET sats = 9223372036854775000 WHERE id = 1")],
  ];
  for (const [name, write] of cases) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    read(w, ledger, invoice, [pay(1)]);
    const [r] = receiptsOf(w, invoice);
    const hour = r.created_at - (r.created_at % HOUR);
    const seen = interleave(w, (db) => write(db, hour));
    const result = await w.object.projectReceipts();
    assert.equal(seen.landed, true, `${name}: written in the window`);
    assert.equal(result.conflict, "unsafe-total", name);
    assert.deepEqual(snapshot(w), seen.after, `${name}: every aggregate exactly as the concurrent write left it`);
    assert.equal(d1(w, "SELECT count(*) AS n FROM receipt_projection WHERE credit > 0").n, 0, `${name}: no credited projection`);
    assert.ok(outbox(w) >= 1, `${name}: the work is kept`);
  }
  // A reversal that would take a total below zero: held, nothing taken.
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  await w.object.projectReceipts();
  read(w, ledger, invoice, [pay(1, "invalid")]);
  ledger.reverse(receiptsOf(w, invoice)[0].id, "synthetic double spend");
  const seen = interleave(w, (db) => db.prepare("UPDATE handle_totals SET sats = 500 WHERE handle = 'ooga-dev'").run());
  const result = await w.object.projectReceipts();
  assert.deepEqual([seen.landed, result.conflict], [true, "unsafe-total"]);
  assert.deepEqual(snapshot(w), seen.after);
  assert.deepEqual(handleTotal(w, "ooga-dev"), { milli: 1000, sats: 500, donations: 1 }, "never negative, never partly taken");
  assert.equal(d1(w, "SELECT credit FROM receipt_projection").credit, 1000, "the reversal rolled back whole");
});

test("receipts first observed in the same millisecond keep their order through reversal, reconfirmation and unrelated recomputes", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const old = await seed(w, ledger, { invoice: "TieOlder01", token: TOKEN(0x601), addresses: [11] });
  const { invoice } = await seed(w, ledger);
  read(w, ledger, old.invoice, [{ ...pay(11, "settled", 700), destination: syntheticAddress(11) }]);
  w.platform.advance(1_000);
  // Two receipts first observed in one read, in the same millisecond.
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  await w.object.projectReceipts();
  const [first, second] = receiptsOf(w, invoice);
  assert.equal(first.created_at, second.created_at, "the same millisecond");
  const order = (id) => d1(w, "SELECT observed_seq AS o FROM receipt_projection WHERE receipt = ?", id).o;
  const firstFeed = (id) => w.ctx.storage.sql.exec("SELECT min(seq) AS s FROM ra_feed WHERE receipt = ?", id).one().s;
  assert.ok(order(first.id) < order(second.id), "the second observed is later");
  assert.deepEqual([order(first.id), order(second.id)], [firstFeed(first.id), firstFeed(second.id)]);
  assert.equal(tally(w).last, 2500);
  // The earlier receipt reversed and reconfirmed: its newer revisions never make it later.
  read(w, ledger, invoice, [pay(1, "invalid", 1500), pay(2, "settled", 2500)]);
  ledger.reverse(first.id, "synthetic double spend");
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 2500);
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  await w.object.projectReceipts();
  assert.ok(d1(w, "SELECT seq FROM receipt_projection WHERE receipt = ?", first.id).seq > d1(w, "SELECT seq FROM receipt_projection WHERE receipt = ?", second.id).seq,
    "the reconfirmed receipt's latest revision is newer in the feed");
  assert.equal(tally(w).last, 2500, "the later first-observed receipt is still the latest");
  // A revision that changes no credit, then an unrelated recompute from an older receipt.
  read(w, ledger, invoice, [pay(1, "invalid", 1500), pay(2, "settled", 2500)]);
  await w.object.projectReceipts();
  assert.equal(d1(w, "SELECT state FROM receipt_projection WHERE receipt = ?", first.id).state, "review", "a revision without a credit change");
  read(w, ledger, old.invoice, [{ ...pay(11, "invalid", 700), destination: syntheticAddress(11) }]);
  ledger.reverse(receiptsOf(w, old.invoice)[0].id, "synthetic double spend");
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 2500, "recomputed, the order still holds");
  assert.deepEqual([order(first.id), order(second.id)], [firstFeed(first.id), firstFeed(second.id)], "never rewritten");
  assert.equal(d1(w, "SELECT count(*) AS n FROM donations").n, 0, "legacy chronology untouched");
});

test("a newer revision reaching D1 before older ones keeps the receipt's first-observation order", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  read(w, ledger, invoice, [pay(1, "invalid", 1500), pay(2, "settled", 2500)]);
  const [first, second] = receiptsOf(w, invoice);
  ledger.reverse(first.id, "synthetic double spend");
  read(w, ledger, invoice, [pay(1, "settled", 1500), pay(2, "settled", 2500)]);
  const rows = w.object.receipts.projectionWork(100);
  assert.ok(rows.filter((r) => r.receipt === first.id).length >= 3, "the first receipt has several revisions");
  for (const r of rows) assert.equal(r.observed, rows.find((x) => x.receipt === r.receipt && x.revision === Math.min(...rows.filter((y) => y.receipt === r.receipt).map((y) => y.revision))).seq);
  const reordered = {
    projectionWork: () => [...rows].reverse(),
    projected: () => {},
    hasPendingProjection: () => false,
    recordProjectionConflict: () => assert.fail("no conflict"),
  };
  const result = await drainProjection({ ledger: reordered, db: w.env.DB, now: () => w.platform.now(), limit: 100 });
  assert.deepEqual([result.applied, result.conflict], [rows.length, null]);
  const projected = (id) => row(w, "SELECT revision, observed_seq, credit FROM receipt_projection WHERE receipt = ?", id);
  const newest = (id) => Math.max(...rows.filter((r) => r.receipt === id).map((r) => r.revision));
  assert.deepEqual(projected(first.id), { revision: newest(first.id), observed_seq: rows.find((r) => r.receipt === first.id).observed, credit: 1500 });
  assert.deepEqual(projected(second.id), { revision: newest(second.id), observed_seq: rows.find((r) => r.receipt === second.id).observed, credit: 2500 });
  assert.ok(projected(first.id).observed_seq < projected(second.id).observed_seq, "identity and order unchanged");
  assert.equal(tally(w).last, 2500, "the later first-observed receipt is latest");
});

const legacy = (w, id, sats, at, handle = "legacy-donor", milli = sats) =>
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES (?, ?, ?, '', ?, 'lightning', ?)").run(id, sats, handle, at, milli);
const hourOf = (w, at) => row(w, "SELECT sats, milli FROM tally_hours WHERE hour = ?", at - (at % HOUR));

test("the legacy insert trigger chooses last with the projection's own query", async () => {
  const w = await world(SETTINGS);
  const { LATEST } = await import("../worker/projection.mjs");
  const flat = (s) => s.replace(/\s+/g, " ");
  const triggers = all(w, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'donations'");
  const tally = triggers.find((t) => t.name === "donations_tally");
  assert.ok(flat(tally.sql).includes(`last = ${flat(LATEST)}`), "the same stable chronology, in the trigger");
  // The only donations trigger that writes the tally, so its `last` never depends on trigger order.
  for (const t of triggers) if (t.name !== "donations_tally") assert.equal(/\btally\b/.test(t.sql.replace(/tally_hours/g, "")), false, t.name);
});

test("a late legacy donation with an older time never takes last from a newer receipt, and still counts exactly as before", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1, "settled", 2500)]);
  await w.object.projectReceipts();
  const [r] = receiptsOf(w, invoice);
  assert.equal(tally(w).last, 2500);
  const before = tally(w);
  const hour = hourOf(w, r.created_at - HOUR) ?? { sats: 0, milli: 0 };
  // Recorded now, but at an hour before the receipt was first observed.
  legacy(w, "LegacyOld01", 700, r.created_at - HOUR, "legacy-donor", 650);
  assert.deepEqual(tally(w), { count: before.count + 1, sats: before.sats + 700, milli: before.milli + 650, last: 2500 }, "counted, but not the newest");
  assert.deepEqual(hourOf(w, r.created_at - HOUR), { sats: hour.sats + 700, milli: hour.milli + 650 }, "in its own hour");
  assert.deepEqual(handleTotal(w, "legacy-donor"), { milli: 650, sats: 700, donations: 1 }, "attribution as before");
  // An unpriced legacy donation adds no bananas, as before.
  legacy(w, "LegacyOld02", 300, r.created_at - 2 * HOUR, "", null);
  assert.deepEqual(tally(w), { count: before.count + 2, sats: before.sats + 1000, milli: before.milli + 650, last: 2500 });
  // Older than the newest legacy donation too: never last.
  legacy(w, "LegacyNew01", 900, r.created_at + 1_000);
  assert.equal(tally(w).last, 900, "a newer legacy donation is the newest");
  legacy(w, "LegacyOld03", 400, r.created_at + 500);
  assert.equal(tally(w).last, 900, "a late, older legacy donation never displaces a newer legacy one");
  // Idempotency and the fence are unchanged.
  assert.throws(() => legacy(w, "LegacyNew01", 900, r.created_at + 1_000), /UNIQUE/);
  assert.throws(() => legacy(w, invoice, 900, r.created_at + 2_000), /receipt-mode/);
  assert.equal(tally(w).count, before.count + 4);
});

test("an ordinary current legacy donation is the newest, and same-millisecond ties resolve the same way every time", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1, "settled", 2500)]);
  await w.object.projectReceipts();
  const [r] = receiptsOf(w, invoice);
  // A legacy settlement recorded at the receipt's first-observation millisecond: the receipt is
  // newer, whichever reaches D1 first.
  legacy(w, "LegacyTie01", 700, r.created_at);
  assert.equal(tally(w).last, 2500, "at the same millisecond a receipt is newer than a legacy donation");
  // Two legacy donations at one later millisecond: the one recorded later is newer.
  w.platform.advance(5_000);
  const now = w.platform.now();
  legacy(w, "LegacyTie02", 800, now);
  legacy(w, "LegacyTie03", 600, now);
  assert.equal(tally(w).last, 600, "legacy ties keep their recorded order");
  // An ordinary legacy settlement, recorded now, after everything: newest.
  w.platform.advance(1_000);
  legacy(w, "LegacyNow01", 1234, w.platform.now());
  assert.equal(tally(w).last, 1234);
  // The same data in a fresh world, inserted in another order, gives the same last.
  const w2 = await world(SETTINGS);
  const ledger2 = provider(w2);
  const other = await seed(w2, ledger2);
  legacy(w2, "LegacyTie01", 700, w2.platform.now());
  read(w2, ledger2, other.invoice, [pay(1, "settled", 2500)]);
  await w2.object.projectReceipts();
  assert.equal(receiptsOf(w2, other.invoice)[0].created_at, w2.platform.now());
  assert.equal(tally(w2).last, 2500, "receipt first at the same millisecond, whichever came first");
});

test("reversal and reconfirmation mixed with legacy donations, early and late", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  legacy(w, "LegacyEarly", 700, w.platform.now() - 10_000);
  read(w, ledger, invoice, [pay(1, "settled", 2500)]);
  await w.object.projectReceipts();
  const [r] = receiptsOf(w, invoice);
  assert.equal(tally(w).last, 2500);
  read(w, ledger, invoice, [pay(1, "invalid", 2500)]);
  ledger.reverse(r.id, "synthetic double spend");
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 700, "the reversed receipt falls back to the newest legacy donation");
  // A late legacy donation older than the reversed receipt, but newer than the early one.
  legacy(w, "LegacyLate1", 900, r.created_at - 1_000);
  assert.equal(tally(w).last, 900, "the newest valid donation is the late legacy one");
  read(w, ledger, invoice, [pay(1, "settled", 2500)]);
  await w.object.projectReceipts();
  assert.equal(tally(w).last, 2500, "reconfirmed, the receipt is newest again");
  // And a late legacy donation after the reconfirmation, older than the receipt: never last.
  legacy(w, "LegacyLate2", 300, r.created_at - 500);
  assert.equal(tally(w).last, 2500);
  assert.deepEqual(since(w, { count: 0, sats: 0, milli: 0 }), [4, 4400, 4400], "every donation counted once, the receipt once");
});

test("a guard or fence message wrapped in an error's cause is still a conflict; anything else stays a retried failure", async () => {
  const cases = [
    [new Error("D1_ERROR", { cause: new Error("receipt projection: unsafe total") }), "unsafe-total", null],
    [new Error("D1_ERROR", { cause: new Error("SQLITE_CONSTRAINT: CHECK constraint failed: sats >= 0") }), "unsafe-total", null],
    [new Error("outer", { cause: new Error("D1_ERROR", { cause: new Error("receipt projection: invoice is a legacy donation") }) }), "legacy-collision", null],
    [new Error("D1_ERROR", { cause: new Error("network connection lost") }), null, "D1_ERROR"],
    [new Error("D1_ERROR: storage reset"), null, "D1_ERROR: storage reset"],
  ];
  for (const [error, conflict, failed] of cases) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    read(w, ledger, invoice, [pay(1)]);
    const { batch } = w.env.DB;
    w.env.DB.batch = async (statements) => {
      if (statements.some((s) => s.sql.startsWith("INSERT INTO receipt_projection_guard"))) throw error;
      return batch.call(w.env.DB, statements);
    };
    const pending = () => w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_outbox").one().n;
    const result = await w.object.projectReceipts();
    assert.deepEqual([result.conflict, result.failed], [conflict, failed], error.cause?.message ?? error.message);
    assert.ok(pending() >= 1, "the work is kept either way");
    assert.equal(w.object.accountingCapability().reconciliation, conflict ? "review" : "behind");
  }
});

test("a marker for the same revision with a different payload is a conflict, never a silent success", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  const [first] = w.object.receipts.projectionWork(1);
  w.env.DB.db.prepare("INSERT INTO receipt_applied (receipt, revision, hash, applied_at) VALUES (?, ?, 'not-this-payload', 1)").run(first.receipt, first.revision);
  const pending = outbox(w);
  const result = await w.object.projectReceipts();
  assert.equal(result.conflict, "marker-mismatch");
  assert.equal(outbox(w), pending, "nothing acknowledged");
  assert.equal(w.object.accountingCapability().reconciliation, "review");
});

test("an older revision arriving after a newer one is marked and never applied over it", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  const before = tally(w);
  const rows = w.object.receipts.projectionWork(10);
  assert.ok(rows.length >= 2);
  const reordered = {
    projectionWork: () => [...rows].reverse(),
    projected: () => {},
    hasPendingProjection: () => false,
    recordProjectionConflict: () => assert.fail("no conflict"),
  };
  const result = await drainProjection({ ledger: reordered, db: w.env.DB, now: () => w.platform.now(), limit: 10 });
  assert.deepEqual([result.applied, result.conflict], [rows.length, null]);
  const newest = rows.at(-1);
  assert.equal(d1(w, "SELECT revision FROM receipt_projection WHERE receipt = ?", newest.receipt).revision, newest.revision);
  assert.deepEqual(since(w, before), [1, 1000, 1000]);
  assert.equal(markers(w), rows.length, "every revision marked, the stale one without effect");
});

test("signed-in, anon and unnamed credits tally; named handles rank", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const before = tally(w);
  const named = await seed(w, ledger, { invoice: "NamedInv01", token: TOKEN(0x401), addresses: [1] });
  const guest = await seed(w, ledger, { invoice: "GuestInv01", token: TOKEN(0x402), owner: null, login: null, addresses: [2] });
  ledger.issueInvoice({ invoice: "UnnamedIn1", network: "regtest", provider: "btcpay", store: "store-a", owner: null, login: null,
    messageMinSats: 1000, due: 10_000, requestHash: await hashRequest(TOKEN(0x403)),
    expires: Math.floor(w.platform.now() / 1000) + 900, lightning: "unavailable", bolt11: null });
  await ledger.bindAddress("UnnamedIn1", syntheticAddress(3));
  read(w, ledger, named.invoice, [pay(1)]);
  read(w, ledger, guest.invoice, [{ ...pay(2), destination: syntheticAddress(2) }]);
  read(w, ledger, "UnnamedIn1", [{ ...pay(3), destination: syntheticAddress(3) }]);
  await w.object.projectReceipts();
  assert.deepEqual(since(w, before).slice(0, 2), [3, 3000]);
  assert.deepEqual(handleTotal(w, "ooga-dev"), { milli: 1000, sats: 1000, donations: 1 });
  assert.deepEqual(handleTotal(w, "anon"), { milli: 1000, sats: 1000, donations: 1 }, "the entered anon name combines like any other");
  assert.equal(d1(w, "SELECT count(*) AS n FROM handle_totals").n, 2, "an unnamed credit ranks nowhere");
});

test("an imported transaction's held receipt never reaches the lifetime figures", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  ledger.fenceImportedTransaction("regtest", "01".repeat(32), "synthetic import record");
  const { invoice } = await seed(w, ledger);
  const before = tally(w);
  read(w, ledger, invoice, [pay(1)]);
  await w.object.projectReceipts();
  assert.deepEqual(tally(w), before);
  assert.equal(d1(w, "SELECT credit FROM receipt_projection").credit, 0);
});

// Counts the D1 queries made through w.env.DB: each executed statement, and each batch as one.
function countQueries(w) {
  const { prepare, batch } = w.env.DB;
  const seen = { queries: 0 };
  const wrap = (statement) => new Proxy(statement, {
    get(target, key) {
      if (key === "first" || key === "all" || key === "run") return (...args) => { seen.queries += 1; return target[key](...args); };
      if (key === "bind") return (...args) => wrap(target.bind(...args));
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  w.env.DB.prepare = (sql) => wrap(prepare.call(w.env.DB, sql));
  w.env.DB.batch = async (statements) => { seen.queries += 1; return batch.call(w.env.DB, statements); };
  seen.restore = () => Object.assign(w.env.DB, { prepare, batch });
  return seen;
}

test("drains are serialized, bounded by their own D1-sized batch whatever the replay bound, and resume across restarts", async () => {
  for (const replayMax of [1, 100]) {
    const name = `replayMax ${replayMax}`;
    const w = await world(SETTINGS);
    const ledger = provider(w, { replayMax });
    const { invoice } = await seed(w, ledger);
    read(w, ledger, invoice, Array.from({ length: 8 }, (_, i) => pay(i + 1)));
    const pending = outbox(w);
    assert.ok(pending > PROJECTION_BATCH_MAX, `${name}: more rows than one drain takes`);
    const base = tally(w);
    const seen = countQueries(w);
    const [a, b] = [w.object.projectReceipts(), w.object.projectReceipts()];
    assert.equal(a, b, `${name}: two drains at once share one`);
    const first = await a;
    seen.restore();
    assert.deepEqual([first.applied + first.skipped, first.more], [PROJECTION_BATCH_MAX, true], `${name}: exactly the drain's own bound`);
    // Three per row (marker, previous revision, batch) and four for the publication.
    assert.ok(seen.queries <= 3 * PROJECTION_BATCH_MAX + 4, `${name}: ${seen.queries} D1 queries for one drain`);
    assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), `${name}: the rest is due at once`);
    // One alarm event starts at most one drain.
    w.object = new DonationsObject(w.ctx, w.env, w.platform);
    const work = w.object.receipts.projectionWork.bind(w.object.receipts);
    let drains = 0;
    w.object.receipts.projectionWork = (limit) => { drains += 1; return work(limit); };
    await w.fireAlarm();
    assert.equal(drains, 1, `${name}: one drain per event`);
    for (let i = 0; i < pending && outbox(w) > 0; i++) await w.fireAlarm();
    assert.deepEqual([outbox(w), markers(w)], [0, pending], name);
    assert.deepEqual(since(w, base).slice(0, 2), [8, 8000], `${name}: eight receipts, each once`);
  }
});

test("a conflict blocks new draining but never a publication already owed, which honours its saved retry time", async () => {
  for (const recovery of ["alarm", "restart"]) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    const page = await w.connectPage();
    await w.ctx.settle();
    read(w, ledger, invoice, [pay(1), pay(2)]);
    const rows = w.object.receipts.projectionWork(100);
    assert.ok(rows.length >= 2);
    // The last row's marker is already in D1 with another payload: a conflict, after the earlier
    // rows applied the credit. And the fresh board read fails in the same call.
    const last = rows.at(-1);
    w.env.DB.db.prepare("INSERT INTO receipt_applied (receipt, revision, hash, applied_at) VALUES (?, ?, 'not-this-payload', 1)").run(last.receipt, last.revision);
    const { prepare } = w.env.DB;
    w.env.DB.prepare = (sql) => (sql.includes("FROM handle_totals ORDER BY") || sql.includes("FROM handle_totals WHERE milli > 0")
      ? { bind: () => ({ all: async () => { throw new Error("D1 unavailable"); } }) } : prepare(sql));
    const heard = page.messages().length;
    const result = await w.object.projectReceipts();
    w.env.DB.prepare = prepare;
    assert.equal(result.conflict, "marker-mismatch", recovery);
    const committed = tally(w);
    assert.ok(committed.sats >= 1000, `${recovery}: D1 holds the earlier rows' credit`);
    assert.equal(w.object.receipts.publicationPending(), true, `${recovery}: the publication is still owed`);
    assert.equal(page.messages().slice(heard).filter((m) => m.type === "tally").length, 0, `${recovery}: nothing sent from the failed read`);
    // Never sooner than the saved retry time, conflict or not.
    assert.equal(await w.object.projectReceipts(), null, `${recovery}: not before the retry time`);
    assert.ok(w.object.projectionDue() >= w.platform.now() + PRICE_FRESH_MS, `${recovery}: due at the saved retry time`);
    w.platform.advance(PRICE_FRESH_MS + 1);
    if (recovery === "restart") w.object = new DonationsObject(w.ctx, w.env, w.platform);
    const outboxBefore = outbox(w);
    await w.fireAlarm();
    assert.equal(w.object.receipts.publicationPending(), false, `${recovery}: published`);
    assert.equal(page.messages().slice(heard).filter((m) => m.type === "tally").at(-1)?.sats, committed.sats, `${recovery}: D1's committed figures`);
    assert.equal(outbox(w), outboxBefore, `${recovery}: and the conflict wasn't drained again`);
    assert.equal(w.object.accountingCapability().reconciliation, "review");
    // Nothing more is owed: no alarm for the conflict itself.
    assert.equal(w.object.projectionDue(), null, `${recovery}: no alarm for the conflict alone`);
  }
});

test("pages hear the receipt live first, then the tally and board once D1 holds the change", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const page = await w.connectPage();
  await w.ctx.settle();
  const start = page.messages().length;
  const before = tally(w);
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  const after = page.messages().slice(start);
  const firstTally = after.findIndex((m) => m.type === "tally");
  const lastReceipt = after.map((m) => m.type).lastIndexOf("receipt");
  assert.ok(lastReceipt >= 0 && firstTally > lastReceipt, "live receipt, then lifetime figures");
  assert.equal(after[firstTally].sats, before.sats + 1000, "the tally sent is D1's, after the batch");
  assert.ok(after.some((m) => m.type === "board" && m.entries.some((e) => e.handle === "ooga-dev" && e.sats === 1000)));
  assert.equal(after.filter((m) => m.type === "donation").length, 0, "never a legacy donation event");
  assert.equal(JSON.stringify(after).includes("4242"), false, "no account id on any public frame");
});

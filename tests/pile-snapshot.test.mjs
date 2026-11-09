// The private pile snapshot for OBL's host: the pile aggregate with v: 2, read-only, through
// PageApi, Donations and the object. Through the real object and the real entrypoints, against
// the stand-ins in tests/helpers/; the Workers RPC runtime itself isn't exercised. Every value is
// synthetic.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { DonationsObject } from "../worker/object.mjs";
import { applyPileAnchor, recordPileDelta, savedPileSnapshot } from "../worker/pile.mjs";
import { pay, provider, read, READ, RECEIPT_SETTINGS as SETTINGS, seed } from "./helpers/receipt-seed.mjs";
import { upgrade, world } from "./helpers/world.mjs";

const HOUR = 3_600_000;
const KEYS = ["at", "bananas", "basis", "cutover", "eatPerHour", "reconciliation", "revision", "type", "uncertain", "v"];
const PENDING = { v: 2, type: "pile", bananas: null, at: null, eatPerHour: 0, basis: "credits", cutover: "pending", reconciliation: "review", uncertain: null };
const sql = (w) => w.ctx.storage.sql;
const restart = (w) => { w.object = new DonationsObject(w.ctx, w.env, w.platform); return w.object; };
const anchor = (w, fields) => applyPileAnchor(w.ctx.storage, {
  anchor: "cutover-1", expected: savedPileSnapshot(sql(w)), milli: 0, boundary: 0, reason: "synthetic review", evidence: "synthetic evidence", ...fields,
}, w.platform.now());
const delta = (w, source, milli) => w.ctx.storage.transactionSync(() => recordPileDelta(sql(w), source, milli, w.platform.now()));
const savedCheckpoint = (w, milli, at) => sql(w).exec("INSERT INTO pile (id, milli, at, started) VALUES (1, ?, ?, ?)", milli, at, at - HOUR);

// Every table of the object's storage, row for row, in a stable order.
function dump(w) {
  const tables = sql(w).exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, sql(w).exec(`SELECT * FROM "${t}"`).toArray().map((r) => JSON.stringify({ ...r })).sort()]));
}

// Runs reads with everything a snapshot must not touch watched: every statement other than a
// SELECT, background work, the alarm, D1, the network and sockets. Storage is compared whole.
async function watched(w, reads) {
  await w.ctx.settle();
  const seen = { writes: [], waits: 0, alarms: 0, d1: 0, sockets: 0 };
  const fetched = w.platform.fetched.length;
  const alarm = await w.ctx.storage.getAlarm();
  const before = dump(w);
  const saved = { exec: sql(w).exec, waitUntil: w.ctx.waitUntil, setAlarm: w.ctx.storage.setAlarm, deleteAlarm: w.ctx.storage.deleteAlarm,
    prepare: w.env.DB.prepare, batch: w.env.DB.batch, accept: w.ctx.acceptWebSocket };
  sql(w).exec = (query, ...args) => {
    if (!/^\s*SELECT\b/i.test(query)) seen.writes.push(query);
    return saved.exec.call(sql(w), query, ...args);
  };
  w.ctx.waitUntil = (p) => { seen.waits++; return saved.waitUntil(p); };
  w.ctx.storage.setAlarm = (t) => { seen.alarms++; return saved.setAlarm(t); };
  w.ctx.storage.deleteAlarm = () => { seen.alarms++; return saved.deleteAlarm(); };
  w.env.DB.prepare = (q) => { seen.d1++; return saved.prepare(q); };
  w.env.DB.batch = (s) => { seen.d1++; return saved.batch(s); };
  w.ctx.acceptWebSocket = (...a) => { seen.sockets++; return saved.accept(...a); };
  let results;
  try {
    results = await reads();
  } finally {
    sql(w).exec = saved.exec;
    w.ctx.waitUntil = saved.waitUntil;
    w.ctx.storage.setAlarm = saved.setAlarm;
    w.ctx.storage.deleteAlarm = saved.deleteAlarm;
    w.env.DB.prepare = saved.prepare;
    w.env.DB.batch = saved.batch;
    w.ctx.acceptWebSocket = saved.accept;
  }
  assert.deepEqual(seen, { writes: [], waits: 0, alarms: 0, d1: 0, sockets: 0 }, "nothing written, scheduled, queried or opened");
  assert.equal(w.platform.fetched.length, fetched, "no price fetch or socket");
  assert.equal(await w.ctx.storage.getAlarm(), alarm, "the alarm unchanged");
  assert.deepEqual(dump(w), before, "storage unchanged, row for row");
  return results;
}

const snapshot = async (w) => (await watched(w, () => [w.object.pileSnapshot()]))[0];

// Only the aggregate's own fields, each of its contract's type.
function assertContract(s) {
  assert.deepEqual(Object.keys(s).sort(), KEYS, "exactly the allowlisted fields");
  assert.equal(s.v, 2);
  assert.equal(s.type, "pile");
  assert.ok(s.bananas === null || typeof s.bananas === "number");
  assert.ok(s.at === null || Number.isSafeInteger(s.at));
  assert.equal(s.eatPerHour, 0);
  assert.ok(Number.isSafeInteger(s.revision) && s.revision >= 0);
  assert.equal(s.basis, "credits");
  assert.ok(["pending", "done"].includes(s.cutover));
  assert.ok(["off", "behind", "review", "current"].includes(s.reconciliation));
  if (s.uncertain !== null) assert.deepEqual(Object.keys(s.uncertain).sort(), ["bananas", "sats"]);
}

test("unanchored, fresh or with the old code's checkpoint and queued credits, the snapshot is pending with no number", async () => {
  const fresh = await world();
  const s = await snapshot(fresh);
  assertContract(s);
  assert.deepEqual(s, { ...PENDING, revision: 0 });

  const legacy = await world();
  savedCheckpoint(legacy, 4_321_000, legacy.platform.now() - HOUR);
  delta(legacy, "donation:QueuedAAA1", 10_000);
  restart(legacy);
  const queued = await snapshot(legacy);
  assertContract(queued);
  assert.deepEqual(queued, { ...PENDING, revision: 1 }, "the checkpoint and queued credits never show as a level");
});

test("an anchored zero is a real zero; a level below it is unknown, never zero", async () => {
  const w = await world();
  const appliedAt = w.platform.now();
  assert.equal(anchor(w, { milli: 0 }).ok, true);
  w.platform.advance(HOUR);
  const zero = await snapshot(w);
  assertContract(zero);
  assert.deepEqual(zero, { v: 2, type: "pile", bananas: 0, at: appliedAt, eatPerHour: 0, revision: 1, basis: "credits",
    cutover: "done", reconciliation: "off", uncertain: { sats: 0, bananas: 0 } }, "at is the accounting time, not the read's");
  delta(w, "correction:after-1", -1_500);
  const below = await snapshot(w);
  assertContract(below);
  assert.deepEqual(below, { v: 2, type: "pile", bananas: null, at: null, eatPerHour: 0, revision: 2, basis: "credits",
    cutover: "done", reconciliation: "review", uncertain: null });
});

test("receipt credits and reversals move the snapshot once each, with the credit's accounting time", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  assert.equal(anchor(w, { milli: 10_000 }).ok, true);
  w.platform.advance(1_000);
  const creditAt = w.platform.now();
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  w.platform.advance(HOUR);
  const credited = await snapshot(w);
  assertContract(credited);
  assert.deepEqual({ ...credited, revision: 0 }, { v: 2, type: "pile", bananas: 11, at: creditAt, eatPerHour: 0, revision: 0,
    basis: "credits", cutover: "done", reconciliation: "behind", uncertain: { sats: 0, bananas: 0 } }, "no verified read: behind, never current");
  const [r] = sql(w).exec("SELECT id FROM ra_receipts WHERE invoice = ?", invoice).toArray();
  read(w, ledger, invoice, [pay(1, "invalid")]);
  ledger.reverse(r.id, "synthetic double spend");
  const reversedAt = w.platform.now();
  w.object.pushReceiptFrames();
  const reversed = await snapshot(w);
  assertContract(reversed);
  assert.equal(reversed.bananas, 10, "the reversal takes it back, once");
  assert.equal(reversed.at, reversedAt);
  assert.ok(reversed.revision > credited.revision);
  restart(w).pushReceiptFrames();
  assert.deepEqual(await snapshot(w), w.object.pileSnapshot(), "nothing repeats after a restart");
  assert.equal((await snapshot(w)).bananas, 10);
});

test("health can change at the same revision, and review shows what review receipts still credit", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w, { milli: 10_000 });
  read(w, ledger, invoice, [pay(1)], { capabilities: { complete: true } });
  await w.object.projectReceipts();
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  const current = await snapshot(w);
  assertContract(current);
  assert.deepEqual([current.bananas, current.reconciliation, current.uncertain], [11, "current", { sats: 0, bananas: 0 }]);
  // The verified read ages past its saved freshness bound: behind, at the same revision, with
  // nothing recorded. The socket's pileMessage would record it and move the revision.
  w.platform.advance(READ.freshnessMs + 1);
  const stale = await snapshot(w);
  assert.deepEqual({ ...stale, reconciliation: "current" }, current, "only the health differs");
  assert.equal(stale.reconciliation, "behind");
  assert.equal(stale.revision, current.revision, "the same revision");
  // A receipt held for review still carries its credit: counted, uncertain, and review.
  read(w, ledger, invoice, [pay(1, "invalid")], { capabilities: { complete: true } });
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  const held = await snapshot(w);
  assertContract(held);
  assert.deepEqual([held.bananas, held.cutover, held.reconciliation, held.uncertain], [11, "done", "review", { sats: 1000, bananas: 1 }]);
});

test("repeated reads after the constructor settles agree, and write, schedule and query nothing", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w, { milli: 10_000 });
  const page = await w.connectPage();
  read(w, ledger, invoice, [pay(1)], { capabilities: { complete: true } });
  await w.object.projectReceipts();
  // Entries committed but never bridged: the start bridges them, records what the connected page
  // is owed and schedules the alarm. That is the constructor's work, not the read's.
  restart(w);
  await w.ctx.settle();
  assert.equal(w.object.pileSnapshot().reconciliation, "current");
  // Health then changes with no delta: pileMessage would record it and move the revision here.
  w.platform.advance(READ.freshnessMs + 1);
  const sent = page.sent.length;
  const reads = await watched(w, () => [1, 2, 3].map(() => w.object.pileSnapshot()));
  for (const s of reads) assertContract(s);
  assert.deepEqual([reads[0].bananas, reads[0].reconciliation], [11, "behind"]);
  assert.deepEqual(reads[1], reads[0]);
  assert.deepEqual(reads[2], reads[0]);
  assert.equal(page.sent.length, sent, "nothing sent to pages");
});

test("nothing routes to the snapshot: not the public address, the page's socket path, or the object's fetch", async () => {
  const w = await world();
  for (const path of ["/pileSnapshot", "/pile-snapshot", "/donations/pileSnapshot"]) {
    assert.equal((await w.send(new Request(`https://bananapayserver${path}`))).status, 404, path);
    assert.equal((await w.object.fetch(new Request(`https://object${path}`, { method: "POST", body: "{}" }))).status, 404, path);
    assert.equal((await w.page.fetch(upgrade(path, { "X-Client": "visitor-p" }))).status, 404, path);
  }
});

// The runtime's base classes, so worker/index.mjs itself can load under node --test. Only what
// the entrypoints rely on: ctx and env kept on the instance.
const STUB = `data:text/javascript,${encodeURIComponent(
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n" +
  "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n")}`;
registerHooks({
  resolve: (specifier, context, next) => (specifier === "cloudflare:workers" ? { url: STUB, shortCircuit: true } : next(specifier, context)),
});

test("PageApi forwards to the DONATIONS singleton's Donations, which forwards to its object", async () => {
  const { Donations, PageApi } = await import("../worker/index.mjs");
  const w = await world(SETTINGS);
  anchor(w, { milli: 2_500 });
  // The real Donations over the same storage. Its platform is the runtime's own, so the network
  // and sockets are refused outright for the duration.
  const network = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  const refused = [];
  globalThis.fetch = (url) => { refused.push(String(url)); throw new Error("no network in this test"); };
  globalThis.WebSocket = class { constructor(url) { refused.push(String(url)); throw new Error("no sockets in this test"); } };
  try {
    const donations = new Donations(w.ctx, w.env);
    await w.ctx.settle();
    const forwarded = [];
    const pileSnapshot = donations.object.pileSnapshot.bind(donations.object);
    donations.object.pileSnapshot = (...args) => { forwarded.push(args); return pileSnapshot(...args); };
    const asked = [];
    const env = { ...w.env, DONATIONS: {
      idFromName: (name) => { asked.push(["name", name]); return `id-of-${name}`; },
      get: (id) => { asked.push(["get", id]); return donations; },
    } };
    const api = new PageApi({}, env);
    assert.equal(PageApi.prototype.pileSnapshot.length, 0, "no arguments, no visitor");
    const results = await watched(w, async () => [await api.pileSnapshot(), await api.pileSnapshot()]);
    assert.deepEqual(asked, [["name", "donations"], ["get", "id-of-donations"], ["name", "donations"], ["get", "id-of-donations"]]);
    assert.deepEqual(forwarded, [[], []], "each call reaches the object once, with nothing passed on");
    for (const s of results) {
      assertContract(s);
      assert.deepEqual(s, { v: 2, type: "pile", bananas: 2.5, at: w.platform.now(), eatPerHour: 0, revision: 1, basis: "credits",
        cutover: "done", reconciliation: "off", uncertain: { sats: 0, bananas: 0 } });
    }
    assert.deepEqual(results[0], w.object.pileSnapshot(), "the same aggregate the object itself reads");
  } finally {
    globalThis.fetch = network.fetch;
    globalThis.WebSocket = network.WebSocket;
  }
  assert.deepEqual(refused, [], "no network or socket attempted");
});

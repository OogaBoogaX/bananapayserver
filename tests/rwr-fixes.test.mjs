// Review follow-ups: a page that won't take the pile never stops the work that sent it; a bridge
// failure at start never stops the object starting; a cursor the feed refuses never replays old
// frames as live; and a receipt credit shows its handle's casing. Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject, PRICE_FRESH_MS } from "../worker/object.mjs";
import { applyPileAnchor, savedPileSnapshot } from "../worker/pile.mjs";
import { FakeSocket } from "./helpers/cloudflare.mjs";
import { pay, provider, read, RECEIPT_SETTINGS as SETTINGS, seed } from "./helpers/receipt-seed.mjs";
import { bolt11For } from "./helpers/values.mjs";
import { EXPIRES, world } from "./helpers/world.mjs";

const typed = (page, type) => page.messages().filter((m) => m.type === type);
const meta = (w, key) => w.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
const anchor = (w) => applyPileAnchor(w.ctx.storage, { anchor: "rwr-anchor", expected: savedPileSnapshot(w.ctx.storage.sql), milli: 10_000, boundary: 0,
  reason: "synthetic review", evidence: "synthetic evidence" }, w.platform.now());

// Makes a page's pile sends fail while it stays open, until released.
function failPiles(page) {
  const send = page.send.bind(page);
  let armed = true;
  page.send = (text) => {
    if (armed && JSON.parse(text).type === "pile") throw new Error("synthetic failure on an open page");
    return send(text);
  };
  return () => { armed = false; };
}

// The pile, recovered by the alarm: brought forward to no later than one cadence away by the
// failure. An alarm already due sooner for other work may come first; there is no retry floor.
async function recovered(w, page) {
  const at = await w.ctx.storage.getAlarm();
  assert.ok(at > w.platform.now() && at <= w.platform.now() + PRICE_FRESH_MS, "the backstop alarm is due later than now and no later than one cadence away");
  w.platform.advance(at - w.platform.now());
  await w.fireAlarm();
  assert.deepEqual(typed(page, "pile").at(-1), w.object.pileMessage());
  assert.equal(meta(w, "pile_broadcast"), w.object.pileMessage().revision);
}

test("a legacy settlement finishes, replies recorded and refreshes the figures when an open page won't take the pile", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  anchor(w);
  const healthy = await w.connectPage(undefined, "visitor-1");
  const failing = await w.connectPage(undefined, "visitor-2");
  await w.ctx.settle();
  const release = failPiles(failing);
  const tallies = typed(healthy, "tally").length;
  await w.invoice(relay, { sats: 2_000 }, () => ({ id: "SendFail01", bolt11: bolt11For(2_000), expires: EXPIRES }));
  await w.relaySays(relay, { type: "paid", invoice: "SendFail01", sats: 2_000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: "SendFail01", result: "recorded" }, "the relay hears recorded");
  assert.equal(typed(healthy, "donation").length, 1, "the donation event went out");
  assert.ok(typed(healthy, "tally").length > tallies, "the tally refresh still ran");
  assert.ok(meta(w, "pile_broadcast") < w.object.pileMessage().revision, "the pile isn't marked sent");
  // A retried notice is the usual duplicate, not a second credit.
  await w.relaySays(relay, { type: "paid", invoice: "SendFail01", sats: 2_000, method: "lightning" });
  assert.equal(JSON.parse(relay.sent.at(-1)).result, "duplicate");
  release();
  await recovered(w, failing);
});

test("a quarantine finishes and replies rejected when an open page won't take the pile", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  anchor(w);
  const failing = await w.connectPage();
  await w.ctx.settle();
  const release = failPiles(failing);
  await w.invoice(relay, { sats: 2_000 }, () => ({ id: "SendFail02", bolt11: bolt11For(2_000), expires: EXPIRES }));
  // A D1 row this settlement didn't write: held for review.
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES ('SendFail02', 9000, 'someone-else', '', ?, 'onchain', 9000)")
    .run(w.platform.now());
  await w.relaySays(relay, { type: "paid", invoice: "SendFail02", sats: 2_000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: "SendFail02", result: "rejected" }, "the relay hears rejected");
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM quarantined WHERE invoice = 'SendFail02'").one().n, 1, "archived");
  release();
  await recovered(w, failing);
});

test("private reads answer as usual when an open page won't take the pile", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  anchor(w);
  const failing = await w.connectPage();
  await w.ctx.settle();
  const release = failPiles(failing);
  read(w, ledger, invoice, [pay(1)]);
  const status = await w.post("/donations/status", { request: token });
  assert.equal(status.status, 200, "status");
  const history = await w.post("/donations/history", {}, { donor: { id: 4242, login: "ooga-dev" } });
  assert.equal(history.status, 200, "history");
  assert.ok(meta(w, "pile_broadcast") < w.object.pileMessage().revision);
  release();
  await recovered(w, failing);
});

test("a database error while marking the pile sent is not swallowed", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w);
  await w.connectPage();
  await w.ctx.settle();
  read(w, ledger, invoice, [pay(1)]);
  const sql = w.ctx.storage.sql;
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...args) => {
    if (query.includes("'pile_broadcast'") && query.startsWith("INSERT")) throw new Error("synthetic storage failure");
    return exec(query, ...args);
  };
  assert.throws(() => w.object.publishPile(), /synthetic storage failure/);
  sql.exec = exec;
});

test("a bridge failure at start never stops the object starting; the pile says review until a bridge succeeds, and a repeat is raised", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w);
  read(w, ledger, invoice, [pay(1)]);
  const sql = w.ctx.storage.sql;
  const exec = sql.exec.bind(sql);
  let poisoned = true;
  sql.exec = (query, ...args) => {
    if (poisoned && query.startsWith("UPDATE meta SET value = ? WHERE key = 'receipt_pile_bridged'")) throw new Error("synthetic poisoned entry");
    return exec(query, ...args);
  };
  // The object starts anyway, and says review, never current.
  const object = new DonationsObject(w.ctx, w.env, w.platform);
  w.object = object;
  await w.ctx.settle();
  assert.equal(object.pileMessage().reconciliation, "review");
  assert.equal(sql.exec("SELECT count(*) AS n FROM pile_deltas").toArray()[0].n, 0, "rolled back whole: no delta, no mark");
  assert.ok(await w.ctx.storage.getAlarm() <= w.platform.now() + PRICE_FRESH_MS, "it comes back within one cadence");
  // A later push that fails again raises it: the poison is never hidden.
  assert.throws(() => object.pushReceiptFrames(), /synthetic poisoned entry/);
  // Once it succeeds, the pile carries the entry and review clears.
  poisoned = false;
  object.pushReceiptFrames();
  assert.equal(sql.exec("SELECT count(*) AS n FROM pile_deltas").toArray()[0].n, 1, "the entry, exactly once");
  assert.notEqual(object.pileMessage().reconciliation, "review");
  sql.exec = exec;
});

test("a cursor the feed refuses replays nothing and starts the page at the high-water mark, never at 0", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  const high = w.object.receipts.feedHighWater();
  assert.ok(high > 0);
  // front.mjs refuses malformed cursors first; this reaches the object directly.
  const ws = new FakeSocket();
  w.ctx.acceptWebSocket(ws, ["page"]);
  w.object.receiptReplay(ws, "-5");
  assert.deepEqual(ws.messages().find((m) => m.type === "replay").complete, false);
  assert.equal(ws.deserializeAttachment().through, high);
  w.object.pushReceiptFrames();
  assert.deepEqual(ws.messages().filter((m) => m.type === "receipt" || m.type === "invoiceStatus"), [], "no old frame sent as live");
  read(w, ledger, invoice, [pay(1), pay(2)]);
  w.object.pushReceiptFrames();
  assert.ok(ws.messages().filter((m) => m.type === "receipt").every((m) => m.seq > high), "only frames after the mark");
});

test("a receipt credit shows its own casing of the handle, as a legacy donation does; a reversal never changes it", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const shown = () => w.env.DB.db.prepare("SELECT handle FROM handle_totals").all().map((r) => r.handle);
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES ('LegacyCase', 500, 'Ooga-Dev', '', 1, 'lightning', 500)").run();
  assert.deepEqual(shown(), ["Ooga-Dev"]);
  read(w, ledger, invoice, [pay(1)]);
  await w.object.projectReceipts();
  assert.deepEqual(shown(), ["ooga-dev"], "the newest credit's casing");
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES ('LegacyCas2', 500, 'OOGA-DEV', '', 2, 'lightning', 500)").run();
  assert.deepEqual(shown(), ["OOGA-DEV"]);
  const [r] = w.ctx.storage.sql.exec("SELECT id FROM ra_receipts WHERE invoice = ?", invoice).toArray();
  read(w, ledger, invoice, [pay(1, "invalid")]);
  ledger.reverse(r.id, "synthetic double spend");
  while (w.object.receipts.hasPendingProjection()) await w.object.projectReceipts();
  assert.deepEqual(shown(), ["OOGA-DEV"], "a reversal keeps the casing shown");
  assert.equal(w.env.DB.db.prepare("SELECT sats FROM handle_totals").get().sats, 1000, "and the amounts are exact");
});

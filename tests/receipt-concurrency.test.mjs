// A quote and a receipt have independent price lookups, even when either feed is stalled.
import assert from "node:assert/strict";
import test from "node:test";
import { FakePriceSocket, priceMessage } from "./helpers/cloudflare.mjs";
import { BOLT11, INVOICE } from "./helpers/values.mjs";
import { EXPIRES, world } from "./helpers/world.mjs";
import { PRICE_SOCKET } from "../worker/price.mjs";

const paid = { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" };
const stored = w => w.env.DB.db.prepare("SELECT * FROM donations WHERE id = ?").get(INVOICE);
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const cached of [false, true]) {
  test(`a receipt retries after a failed quote with ${cached ? "a cached price" : "no price"}`, async t => {
    t.mock.method(console, "error", () => {});
    const w = await world();
    const relay = await w.connectRelay();
    if (cached) await w.object.price();
    w.platform.prices = { rest: null, socket: null };
    await w.invoice(relay, { sats: 1000 });
    const asked = w.platform.fetched.length;
    w.platform.advance(5_000);
    w.platform.prices = { rest: 110_000, socket: 120_000 };
    await w.relaySays(relay, paid);
    assert.deepEqual(w.platform.fetched.slice(asked), [PRICE_SOCKET]);
    assert.equal(stored(w).milli, 1200);
    assert.equal(stored(w).price_stale, 0);
  });
}

test("a stalled quote cannot delay or supply a receipt price", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  let release;
  w.platform.fetch = () => new Promise(resolve => { release = resolve; });
  const quote = w.object.price();
  w.platform.prices.socket = 120_000;
  const receipt = w.relaySays(relay, paid);
  try {
    await turn();
    assert.equal(stored(w)?.milli, 1200, "receipt completes while the earlier quote is still blocked");
  } finally {
    release(Response.json({ price: "80000" }));
    await Promise.all([quote, receipt]);
  }
  assert.equal(stored(w).milli, 1200, "a late quote cannot overwrite the durable receipt");
});

test("an invoice uses REST without joining a stalled receipt socket", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  const socket = new FakePriceSocket([]);
  w.platform.socket = () => socket;
  const receipt = w.relaySays(relay, paid);
  let response;
  const pending = w.post("/donations/invoice", { sats: 1000 }).then(value => { response = value; });
  await turn();
  const command = relay.messages().filter(m => m.type === "invoice").at(-1);
  await w.relaySays(relay, {
    type: "invoice", request: command.request,
    invoice: { id: "InvoiceSecond", bolt11: BOLT11, expires: EXPIRES },
  });
  try {
    await turn();
    assert.equal(response?.status, 200, "QR reply completes before the receipt socket answers");
    assert.equal(stored(w), undefined);
  } finally {
    socket.dispatchEvent(Object.assign(new Event("message"), { data: priceMessage(120_000) }));
    await Promise.all([pending, receipt]);
  }
  assert.equal(stored(w).milli, 1200);
});

test("a receipt keeps the jump guard even during the quote retry gate", async t => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  w.platform.prices = { rest: null, socket: null };
  await w.object.price();
  const asked = w.platform.fetched.length;
  w.platform.prices.socket = 300_000;
  await w.relaySays(relay, paid);
  assert.deepEqual(w.platform.fetched.slice(asked), [PRICE_SOCKET]);
  assert.equal(stored(w).milli, 1000);
  assert.equal(stored(w).price_stale, 1);
});

test("invalid limits leave a receipt retryable instead of freezing an unpriced donation", async t => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  const limit = w.env.PRICE_JUMP_MAX;
  delete w.env.PRICE_JUMP_MAX;
  await w.relaySays(relay, paid);
  assert.equal(stored(w), undefined);
  assert.equal(w.object.sql.exec("SELECT price_frozen FROM pending").one().price_frozen, 0);
  assert.equal(relay.messages().filter(m => m.type === "ack").length, 0);
  const received = w.platform.now();
  w.platform.advance(1000);
  w.env.PRICE_JUMP_MAX = limit;
  w.platform.prices.socket = 120_000;
  await w.relaySays(relay, paid);
  assert.equal(stored(w).received_at, received);
  assert.equal(stored(w).milli, 1200);
});

test("a null BOLT11 below the threshold remains a payable unavailable-Lightning invoice", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { response, asked } = await w.invoice(relay, { sats: 1000 }, () => ({ id: INVOICE, bolt11: null, expires: EXPIRES }));
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(asked.onchainOnly, undefined);
  assert.equal(reply.lightning, "unavailable");
  assert.equal(reply.invoice.bolt11, null);
  assert.equal(reply.pricing, "receipt");
  await w.relaySays(relay, { ...paid, method: "onchain" });
  assert.equal(stored(w).sats, 1000);
});

test("a delayed relay notice records backend detection time and the current feed price", async () => {
  const w = await world({}, { prices: { rest: 80_000, socket: 80_000 } });
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  w.platform.advance(2 * 3_600_000);
  w.platform.prices.socket = 120_000;
  await w.relaySays(relay, paid);
  assert.equal(stored(w).received_at, w.platform.now());
  assert.equal(stored(w).price_at, w.platform.now());
  assert.equal(stored(w).price_stale, 0, "freshness describes the feed, not relay delivery latency");
  assert.equal(stored(w).milli, 1200);
});

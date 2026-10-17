// A larger donation crosses both boundaries without attempting to create a Lightning invoice.
import assert from "node:assert/strict";
import test from "node:test";
import { Relay } from "../relay/relay.mjs";
import { parseDown } from "../shared/protocol.mjs";
import { until } from "./helpers/cloudflare.mjs";
import { ADDRESS, BOLT11, INVOICE } from "./helpers/values.mjs";
import { EXPIRES, world } from "./helpers/world.mjs";

test("a donation above Lightning's threshold gets an on-chain invoice, address and settlement", async () => {
  const w = await world({ LIGHTNING_MAX_SATS: "999" });
  const socket = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(page.messages()[0].limits, { minSats: 1, maxSats: 2100000000000000, lightningMaxSats: 999 });
  const calls = [], replies = [];
  const node = new Relay({
    config: { minSats: 1, maxSats: 2100000000000000, lightningMaxSats: 2000, invoiceMinutes: 15, ratePerMinute: 10,
      methods: { lightning: "BTC-LN", onchain: "BTC-CHAIN" } },
    line: { send: message => { replies.push(w.relaySays(socket, message)); return true; } },
    btcpay: {
      createInvoice: async value => { calls.push(value); return { id: INVOICE, expirationTime: EXPIRES }; },
      activate: async (id, method) => { assert.equal(method, "BTC-CHAIN"); },
      paymentMethods: async () => [{ paymentMethodId: "BTC-CHAIN", destination: ADDRESS, due: "0.00001000" }],
    }, now: w.platform.now, log() {},
  });
  const quoting = w.post("/donations/invoice", { sats: 1000, handle: "team" });
  await until(() => socket.sent.length > 0);
  const command = parseDown(socket.sent.at(-1));
  assert.equal(command.onchainOnly, true);
  await node.handle(command); await Promise.all(replies);
  const quote = await (await quoting).json();
  assert.equal(quote.lightning, "limit");
  assert.equal(quote.invoice.bolt11, null);
  assert.deepEqual(calls, [{ sats: 1000, minutes: 15, methods: ["BTC-CHAIN"] }]);
  const switching = w.post("/donations/onchain", { request: quote.request });
  await until(() => JSON.parse(socket.sent.at(-1)).type === "onchain");
  await node.handle(parseDown(socket.sent.at(-1))); await Promise.all(replies);
  assert.deepEqual(await (await switching).json(), { address: ADDRESS, sats: 1000 });
  await w.relaySays(socket, { type: "seen", invoice: INVOICE, sats: 1000, left: 0 });
  await w.relaySays(socket, { type: "paid", invoice: INVOICE, sats: 1000, method: "onchain" });
  assert.equal(w.env.DB.db.prepare("SELECT sats FROM donations").get().sats, 1000);
});

test("the Lightning boundary is inclusive and invalid Bitcoin amounts are still rejected", async () => {
  const w = await world({ LIGHTNING_MAX_SATS: "1000" });
  const relay = await w.connectRelay();
  const normal = await w.invoice(relay, { sats: 1000 });
  assert.equal(normal.asked.onchainOnly, undefined);
  assert.equal((await normal.response.json()).lightning, "available");
  const before = relay.sent.length;
  assert.equal((await w.post("/donations/invoice", { sats: 2100000000000001 })).status, 400);
  assert.equal(relay.sent.length, before, "the Bitcoin amount bound is checked before calling the node");
  assert.equal((await w.post("/donations/invoice", { sats: 1000, onchainOnly: true })).status, 400, "payment policy is not supplied by the browser");
});

test("an unexpected Lightning code above the configured threshold is refused", async () => {
  const w = await world({ LIGHTNING_MAX_SATS: "999" });
  const relay = await w.connectRelay();
  const { response } = await w.invoice(relay, { sats: 1000 }, () => ({ id: INVOICE, bolt11: BOLT11, expires: EXPIRES }));
  assert.equal(response.status, 503);
});

test("amounts above legacy MAX_SATS remain payable on-chain without an application cap", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked, response } = await w.invoice(relay, { sats: 1000000 }, () => ({ id: INVOICE, bolt11: null, expires: EXPIRES }));
  assert.equal(asked.onchainOnly, true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).lightning, "limit");
});

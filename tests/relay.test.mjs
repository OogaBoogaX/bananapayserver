// The relay's work against a fake BTCPay and a fake line: invoices on request, the relay's own
// cap, the on-chain switch, and payment notices until the object acknowledges them.

import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_ID } from "../relay/btcpay.mjs";
import { Relay } from "../relay/relay.mjs";
import { ADDRESS, BOLT11, INVOICE, REQUEST } from "./helpers/values.mjs";

const CONFIG = {
  minSats: 1,
  maxSats: 50_000,
  invoiceMinutes: 15,
  methods: { lightning: "BTC-LN", onchain: "BTC-CHAIN" },
};
const EXPIRES = 1_790_000_900;

function fakeBtcpay(overrides = {}) {
  const calls = [];
  const invoices = new Map([[INVOICE, { id: INVOICE, status: "Settled", amount: "0.00001000", currency: "BTC", metadata: { orderId: ORDER_ID } }]]);
  const btcpay = {
    calls,
    invoices,
    createInvoice: async (args) => {
      calls.push(["createInvoice", args]);
      return { id: INVOICE, expirationTime: EXPIRES };
    },
    activate: async (id, method) => calls.push(["activate", id, method]),
    paymentMethods: async (id) => {
      calls.push(["paymentMethods", id]);
      return [
        { paymentMethodId: "BTC-LN", destination: BOLT11, due: "0.00001000" },
        { paymentMethodId: "BTC-CHAIN", destination: ADDRESS, due: "0.00001000" },
      ];
    },
    invoice: async (id) => {
      calls.push(["invoice", id]);
      return invoices.get(id) ?? null;
    },
    recent: async (since) => {
      calls.push(["recent", since]);
      return [...invoices.values()];
    },
    ...overrides,
  };
  return btcpay;
}

function setup(overrides) {
  const line = { sent: [], send(message) { this.sent.push(message); return true; } };
  const btcpay = fakeBtcpay(overrides);
  const logs = [];
  const relay = new Relay({ btcpay, line, config: CONFIG, now: () => 1_790_000_000_000, log: (m) => logs.push(m) });
  return { relay, line, btcpay, logs };
}

test("an invoice is made with lazy methods, Lightning activated first", async () => {
  const { relay, line, btcpay } = setup();
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  assert.deepEqual(btcpay.calls, [
    ["createInvoice", { sats: 1000, minutes: 15, methods: ["BTC-LN", "BTC-CHAIN"] }],
    ["activate", INVOICE, "BTC-LN"],
    ["paymentMethods", INVOICE],
  ]);
  assert.deepEqual(line.sent, [{ type: "invoice", request: REQUEST, invoice: { id: INVOICE, bolt11: BOLT11, expires: EXPIRES } }]);
  assert.equal(relay.open.get(INVOICE), 1000);
});

test("the relay's own cap holds whatever the Worker allowed", async () => {
  const { relay, line, btcpay } = setup();
  await relay.handle({ type: "invoice", request: REQUEST, sats: 50_001 });
  assert.deepEqual(line.sent, [{ type: "invoice", request: REQUEST, error: "cap" }]);
  assert.deepEqual(btcpay.calls, []);
});

test("a BTCPay failure answers unavailable rather than leaving the page waiting", async () => {
  const { relay, line } = setup({ createInvoice: async () => { throw new Error("BTCPay answered 500"); } });
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  assert.deepEqual(line.sent, [{ type: "invoice", request: REQUEST, error: "unavailable" }]);
});

test("BTCPay 1.x payment method fields are understood too", async () => {
  const { relay, line } = setup({ paymentMethods: async () => [{ paymentMethod: "BTC-LN", destination: BOLT11 }] });
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  assert.equal(line.sent[0].invoice.bolt11, BOLT11);
});

test("the on-chain address is made only when asked, for the relay's own open invoices", async () => {
  const { relay, line, btcpay } = setup();
  await relay.handle({ type: "onchain", request: REQUEST, invoice: INVOICE });
  assert.deepEqual(line.sent.at(-1), { type: "onchain", request: REQUEST, error: "unavailable" });
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  btcpay.calls.length = 0;
  await relay.handle({ type: "onchain", request: REQUEST, invoice: INVOICE });
  assert.deepEqual(btcpay.calls, [["activate", INVOICE, "BTC-CHAIN"], ["paymentMethods", INVOICE]]);
  assert.deepEqual(line.sent.at(-1), { type: "onchain", request: REQUEST, address: ADDRESS, sats: 1000 });
});

test("a settled invoice becomes a notice that repeats until acknowledged", async () => {
  const { relay, line } = setup();
  relay.open.set(INVOICE, 1000);
  await relay.check(INVOICE);
  assert.deepEqual(line.sent, [{ type: "paid", invoice: INVOICE, sats: 1000 }]);
  assert.equal(relay.open.has(INVOICE), false);
  relay.flush();
  assert.equal(line.sent.length, 2);
  await relay.handle({ type: "ack", invoice: INVOICE, result: "recorded" });
  relay.flush();
  assert.equal(line.sent.length, 2);
});

test("only BTCPay's API decides what counts as paid", async () => {
  const cases = [
    ["not the relay's invoice", { metadata: { orderId: "someone-else" } }],
    ["marked settled by hand", { additionalStatus: "Marked" }],
    ["still processing", { status: "Processing" }],
    ["not in BTC", { currency: "USD" }],
    ["a fraction of a sat", { amount: "0.000000001" }],
  ];
  for (const [what, change] of cases) {
    const { relay, line, btcpay } = setup();
    btcpay.invoices.set(INVOICE, { ...btcpay.invoices.get(INVOICE), ...change });
    await relay.check(INVOICE);
    assert.deepEqual(line.sent, [], what);
  }
  const { relay, btcpay } = setup();
  await relay.check("../../admin");
  assert.deepEqual(btcpay.calls, [], "an id that isn't one never reaches the API");
});

test("the sweep drops expired invoices, keeps waiting ones, and resends notices", async () => {
  const { relay, line, btcpay } = setup();
  btcpay.invoices.set("Expired0001", { id: "Expired0001", status: "Expired", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  btcpay.invoices.set("Waiting0001", { id: "Waiting0001", status: "New", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  relay.open.set("Expired0001", 500).set("Waiting0001", 500);
  relay.unacked.set("Unacked0001", 700);
  await relay.sweep();
  assert.deepEqual([...relay.open.keys()], ["Waiting0001"]);
  assert.deepEqual(line.sent, [{ type: "paid", invoice: "Unacked0001", sats: 700 }]);
});

test("after a restart the relay finds its invoices from the last day", async () => {
  const { relay, btcpay } = setup();
  btcpay.invoices.set("Waiting0001", { id: "Waiting0001", status: "Processing", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  btcpay.invoices.set("Marked00001", { id: "Marked00001", status: "Settled", additionalStatus: "Marked", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  await relay.load();
  assert.deepEqual(btcpay.calls, [["recent", 1_790_000_000 - 86_400]]);
  assert.deepEqual([...relay.open], [["Waiting0001", 500]]);
  assert.deepEqual([...relay.unacked], [[INVOICE, 1000]]);
});

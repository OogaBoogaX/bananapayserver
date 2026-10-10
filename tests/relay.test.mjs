// The relay's work against a fake BTCPay and a fake line: invoices on request, the relay's own
// cap, the on-chain switch, and payment notices until the object acknowledges them.

import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_ID } from "../relay/btcpay.mjs";
import { Relay } from "../relay/relay.mjs";
import { until } from "./helpers/cloudflare.mjs";
import { ADDRESS, BOLT11, INVOICE, REQUEST } from "./helpers/values.mjs";

const CONFIG = {
  minSats: 1,
  maxSats: 50_000,
  ratePerMinute: 100,
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
    // The payments each method has received; paid over Lightning unless a test says otherwise.
    payments: { "BTC-LN": [{ status: "Settled" }], "BTC-CHAIN": [] },
    paymentMethods: async (id) => {
      calls.push(["paymentMethods", id]);
      return [
        { paymentMethodId: "BTC-LN", destination: BOLT11, due: "0.00001000", payments: btcpay.payments["BTC-LN"] },
        { paymentMethodId: "BTC-CHAIN", destination: ADDRESS, due: "0.00001000", payments: btcpay.payments["BTC-CHAIN"] },
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

function setup(overrides, config = {}) {
  const line = { sent: [], send(message) { this.sent.push(message); return true; } };
  const btcpay = fakeBtcpay(overrides);
  const logs = [];
  const clock = { now: 1_790_000_000_000 };
  const relay = new Relay({ btcpay, line, config: { ...CONFIG, ...config }, now: () => clock.now, log: (m) => logs.push(m) });
  return { relay, line, btcpay, logs, clock };
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

test("the relay makes only so many invoices and addresses a minute, whatever the Worker asks", async () => {
  const { relay, line, btcpay, logs, clock } = setup({}, { ratePerMinute: 2 });
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  await relay.handle({ type: "onchain", request: REQUEST, invoice: INVOICE });
  btcpay.calls.length = 0;
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  await relay.handle({ type: "onchain", request: REQUEST, invoice: INVOICE });
  assert.deepEqual(btcpay.calls, [], "nothing more reaches BTCPay this minute");
  assert.deepEqual(line.sent.slice(-2), [
    { type: "invoice", request: REQUEST, error: "unavailable" },
    { type: "onchain", request: REQUEST, error: "unavailable" },
  ]);
  assert.equal(logs.filter((m) => m.startsWith("relay: asked for more than 2")).length, 1, "said once, not for every refusal");
  clock.now += 60_000;
  await relay.handle({ type: "invoice", request: REQUEST, sats: 1000 });
  assert.equal(line.sent.at(-1).invoice?.id, INVOICE, "a new minute, a new allowance");
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
  assert.deepEqual(line.sent, [{ type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }]);
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

test("a webhook that arrives while the same invoice is being checked is checked after it", async () => {
  let release = null;
  let reads = 0;
  const { relay, line, btcpay } = setup({
    invoice: async (id) => {
      reads += 1;
      if (reads > 1) return btcpay.invoices.get(id);
      // The sweep's read: BTCPay still says processing, and answers slowly.
      await new Promise((resolve) => { release = resolve; });
      return { ...btcpay.invoices.get(id), status: "Processing" };
    },
  });
  relay.open.set(INVOICE, 1000);
  const sweeping = relay.check(INVOICE);
  await until(() => release);
  await relay.check(INVOICE); // the webhook, as the invoice settles
  release();
  await sweeping;
  assert.equal(reads, 2);
  assert.deepEqual(line.sent, [{ type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }]);
});

test("a sweep still going when the next is due lets it finish instead of starting another", async () => {
  let release = null;
  const reads = [];
  const { relay } = setup({
    invoice: async (id) => {
      reads.push(id);
      if (reads.length === 1) await new Promise((resolve) => { release = resolve; });
      return null;
    },
  });
  relay.open.set("Slow0000001", 500).set("Next0000001", 500);
  const first = relay.sweep();
  await until(() => release);
  await relay.sweep();
  release();
  await first;
  assert.deepEqual(reads, ["Slow0000001", "Next0000001"]);
});

test("the sweep drops expired invoices, keeps waiting ones, and resends notices", async () => {
  const { relay, line, btcpay } = setup();
  btcpay.invoices.set("Expired0001", { id: "Expired0001", status: "Expired", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  btcpay.invoices.set("Waiting0001", { id: "Waiting0001", status: "New", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  relay.open.set("Expired0001", 500).set("Waiting0001", 500);
  relay.unacked.set("Unacked0001", { sats: 700, method: "onchain" });
  await relay.sweep();
  assert.deepEqual([...relay.open.keys()], ["Waiting0001"]);
  assert.deepEqual(line.sent, [{ type: "paid", invoice: "Unacked0001", sats: 700, method: "onchain" }]);
});

test("after a restart the relay finds its invoices from the last day, settled ones included", async () => {
  const { relay, btcpay } = setup();
  btcpay.invoices.set("Waiting0001", { id: "Waiting0001", status: "Processing", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  btcpay.invoices.set("Marked00001", { id: "Marked00001", status: "Settled", additionalStatus: "Marked", amount: "0.00000500", currency: "BTC", metadata: { orderId: ORDER_ID } });
  await relay.load();
  assert.deepEqual(btcpay.calls, [["recent", 1_790_000_000 - 86_400]]);
  assert.deepEqual([...relay.open], [[INVOICE, 1000], ["Waiting0001", 500]], "the next check sends the settled one's notice");
});

test("a payment the sweep finds is sent once, not again by the same sweep", async () => {
  const { relay, line } = setup();
  relay.open.set(INVOICE, 1000);
  await relay.sweep();
  assert.deepEqual(line.sent, [{ type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }]);
});

test("an invoice BTCPay no longer knows, or that isn't the relay's, leaves the sweep", async () => {
  const gone = Object.assign(new Error("BTCPay answered 404 to GET /invoices/Gone000001"), { status: 404 });
  const { relay, btcpay } = setup({
    invoice: async (id) => {
      if (id === "Gone000001") throw gone;
      return { id, status: "New", metadata: { orderId: "someone-else" } };
    },
  });
  relay.open.set("Gone000001", 500).set("NotOurs0001", 500);
  await relay.sweep();
  assert.deepEqual([...relay.open.keys()], []);
  assert.equal(btcpay.calls.length, 0);
});

test("finding its invoices again keeps trying until BTCPay is up", async () => {
  let failures = 2;
  const { relay, line, logs } = setup({
    recent: async () => {
      if (failures-- > 0) throw new Error("connect ECONNREFUSED");
      return [{ id: INVOICE, status: "Settled", amount: "0.00001000", currency: "BTC", metadata: { orderId: ORDER_ID } }];
    },
  });
  const waits = [];
  await relay.loadWhenReady({ wait: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(logs.filter((m) => m.startsWith("load:")).length, 2);
  assert.deepEqual(line.sent, [{ type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }]);
});

test("how the donor paid comes from BTCPay's payments: Lightning, on-chain, or both", async () => {
  const cases = [
    [{ "BTC-LN": [{ status: "Settled" }], "BTC-CHAIN": [] }, "lightning"],
    [{ "BTC-LN": [], "BTC-CHAIN": [{ status: "Settled" }] }, "onchain"],
    [{ "BTC-LN": [], "BTC-CHAIN": [{ status: "Processing" }] }, "onchain"],
    [{ "BTC-LN": [{ status: "Settled" }], "BTC-CHAIN": [{ status: "Settled" }] }, "mixed"],
    [{ "BTC-LN": [{ status: "Invalid" }], "BTC-CHAIN": [{ status: "Settled" }] }, "onchain"],
  ];
  for (const [payments, method] of cases) {
    const { relay, line, btcpay } = setup();
    btcpay.payments = payments;
    relay.open.set(INVOICE, 1000);
    await relay.check(INVOICE);
    assert.deepEqual(line.sent, [{ type: "paid", invoice: INVOICE, sats: 1000, method }], method);
  }
});

test("a settled invoice with no payment to show for it stays open and keeps being reported", async () => {
  const { relay, line, btcpay, logs } = setup();
  btcpay.payments = { "BTC-LN": [{ status: "Invalid" }], "BTC-CHAIN": [] };
  relay.open.set(INVOICE, 1000);
  await relay.check(INVOICE);
  assert.deepEqual(line.sent, []);
  assert.equal(relay.open.has(INVOICE), true);
  assert.ok(logs.some((m) => m.includes("lists no payment")));
});

test("BTCPay 1.x payment fields say how the donor paid too", async () => {
  const { relay, line } = setup({
    paymentMethods: async () => [{ paymentMethod: "BTC-LN", destination: BOLT11, payments: [{ status: "Settled" }] }],
  });
  relay.open.set(INVOICE, 1000);
  await relay.check(INVOICE);
  assert.equal(line.sent[0].method, "lightning");
});

// BTCPay's webhook: only a delivery with the right signature, for the relay's store, about a
// settled invoice, reaches the relay. The relay then asks BTCPay's API anyway.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createWebhookServer, signatureValid, WEBHOOK_PATH } from "../relay/webhook.mjs";

const SECRET = "synthetic-webhook-secret";
const sign = (body, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const event = (overrides = {}) => JSON.stringify({
  deliveryId: "Delivery1", webhookId: "Hook1", type: "InvoiceSettled", timestamp: 1_790_000_000,
  storeId: "Store1234", invoiceId: "Inv0ice1234", metadata: {}, ...overrides,
});

async function listen(t) {
  const settled = [];
  const server = createWebhookServer({ secret: SECRET, storeId: "Store1234", onPayment: (id) => settled.push(id) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const deliver = (body, { signature = sign(body), path = WEBHOOK_PATH, method = "POST" } = {}) =>
    fetch(base + path, { method, body: method === "POST" ? body : undefined, headers: signature ? { "BTCPay-Sig": signature } : {} });
  return { settled, deliver };
}

test("a signed InvoiceSettled for the store reaches the relay", async (t) => {
  const { settled, deliver } = await listen(t);
  assert.equal((await deliver(event())).status, 200);
  assert.deepEqual(settled, ["Inv0ice1234"]);
});

test("a wrong or missing signature is refused", async (t) => {
  const { settled, deliver } = await listen(t);
  assert.equal((await deliver(event(), { signature: sign(event(), "another-secret") })).status, 401);
  assert.equal((await deliver(event(), { signature: null })).status, 401);
  assert.equal((await deliver(event(), { signature: sign(event({ invoiceId: "Other12345" })) })).status, 401);
  assert.deepEqual(settled, []);
});

test("a payment, settled or not, sends the relay to look too, since a late one settles nothing", async (t) => {
  const { settled, deliver } = await listen(t);
  for (const type of ["InvoiceReceivedPayment", "InvoicePaymentSettled"]) {
    assert.equal((await deliver(event({ type }))).status, 200);
  }
  assert.equal(settled.length, 2);
});

test("other events, other stores, other paths and methods do nothing", async (t) => {
  const { settled, deliver } = await listen(t);
  assert.equal((await deliver(event({ type: "InvoiceExpired" }))).status, 200);
  assert.equal((await deliver(event({ storeId: "OtherStore" }))).status, 200);
  assert.equal((await deliver("not json")).status, 200);
  assert.equal((await deliver(event(), { path: "/elsewhere" })).status, 404);
  assert.equal((await deliver(event(), { method: "GET" })).status, 405);
  assert.deepEqual(settled, []);
});

test("an oversized body is cut off", async (t) => {
  const { settled, deliver } = await listen(t);
  const big = event({ metadata: { padding: "x".repeat(70_000) } });
  const status = await deliver(big).then((r) => r.status, () => "reset");
  assert.ok(status === 413 || status === "reset", String(status));
  assert.deepEqual(settled, []);
});

test("signatureValid accepts either case of hex and nothing else", () => {
  const body = Buffer.from(event());
  assert.equal(signatureValid(SECRET, body, sign(body)), true);
  assert.equal(signatureValid(SECRET, body, sign(body).toUpperCase().replace("SHA256=", "sha256=")), true);
  assert.equal(signatureValid(SECRET, body, "sha1=abc"), false);
  assert.equal(signatureValid(SECRET, body, undefined), false);
});

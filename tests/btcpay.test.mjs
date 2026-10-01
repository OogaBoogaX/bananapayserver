// What the relay sends BTCPay, checked against a fake fetch: paths, the key, the bodies.

import assert from "node:assert/strict";
import test from "node:test";
import { BTCPay, btcToSats, ORDER_ID, satsToBtc } from "../relay/btcpay.mjs";

function client(respond = () => new Response("{}")) {
  const requests = [];
  const btcpay = new BTCPay({
    url: "http://btcpay.internal:23000",
    storeId: "Store1234",
    apiKey: "synthetic-api-key",
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
      return respond(url, init);
    },
  });
  return { btcpay, requests };
}

test("an invoice is asked for in BTC, tagged as the relay's, with lazy payment methods", async () => {
  const { btcpay, requests } = client(() => new Response(JSON.stringify({ id: "Inv0ice1234" })));
  const created = await btcpay.createInvoice({ sats: 1000, minutes: 15, methods: ["BTC-LN", "BTC-CHAIN"] });
  assert.equal(created.id, "Inv0ice1234");
  assert.deepEqual(requests, [{
    url: "http://btcpay.internal:23000/api/v1/stores/Store1234/invoices",
    method: "POST",
    headers: { Authorization: "token synthetic-api-key", "Content-Type": "application/json" },
    body: {
      amount: "0.00001000",
      currency: "BTC",
      metadata: { orderId: ORDER_ID },
      checkout: { paymentMethods: ["BTC-LN", "BTC-CHAIN"], defaultPaymentMethod: "BTC-LN", lazyPaymentMethods: true, expirationMinutes: 15 },
    },
  }]);
});

test("the other calls use the store-scoped paths", async () => {
  const { btcpay, requests } = client(() => new Response(""));
  await btcpay.activate("Inv0ice1234", "BTC-CHAIN");
  await btcpay.paymentMethods("Inv0ice1234");
  await btcpay.invoice("Inv0ice1234");
  await btcpay.recent(1_790_000_000);
  const store = "http://btcpay.internal:23000/api/v1/stores/Store1234";
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    `POST ${store}/invoices/Inv0ice1234/payment-methods/BTC-CHAIN/activate`,
    `GET ${store}/invoices/Inv0ice1234/payment-methods`,
    `GET ${store}/invoices/Inv0ice1234`,
    `GET ${store}/invoices?orderId=${ORDER_ID}&startDate=1790000000&take=500&status=New&status=Processing&status=Settled`,
  ]);
});

test("errors name the call but never BTCPay's address, and ids are checked before any call", async () => {
  const { btcpay, requests } = client(() => new Response("nope", { status: 403 }));
  await assert.rejects(btcpay.invoice("Inv0ice1234"), (error) => {
    assert.equal(error.message, "BTCPay answered 403 to GET /invoices/Inv0ice1234");
    return true;
  });
  assert.throws(() => btcpay.invoice("../../server/info"), /not a BTCPay id/);
  assert.equal(requests.length, 1);
});

test("sats and BTC convert exactly, and anything finer than a sat is refused", () => {
  assert.equal(satsToBtc(1), "0.00000001");
  assert.equal(satsToBtc(123_456_789), "1.23456789");
  assert.equal(satsToBtc(2_100_000_000_000_000), "21000000.00000000");
  assert.equal(btcToSats("0.00001"), 1000);
  assert.equal(btcToSats("0.000010000000"), 1000);
  assert.equal(btcToSats("21000000"), 2_100_000_000_000_000);
  for (const bad of ["0.000000001", "1e-5", "-1", "", "0.1.2", " 1", "0x10"]) assert.equal(btcToSats(bad), null, bad);
});

// Bitcoin's price from 2140data's service, and the banana arithmetic built on it.

import assert from "node:assert/strict";
import test from "node:test";
import { bananasOf, fetchPrice, milliBananas, PRICE_SOCKET, PRICE_URL, rateOf } from "../worker/price.mjs";
import { FakePriceSocket, priceMessage } from "./helpers/cloudflare.mjs";

// The service as fetchPrice sees it. socket is what the socket sends, as in FakePriceSocket;
// rest is the REST API's body, or null for an error.
function service({ socket = [priceMessage(84_626.08)], rest = { price: "84626.08" } } = {}) {
  const asked = [];
  const sockets = [];
  return {
    asked,
    sockets,
    socket: (url) => {
      asked.push(url);
      const ws = new FakePriceSocket(socket);
      sockets.push(ws);
      return ws;
    },
    fetch: async (url) => {
      asked.push(String(url));
      return rest === null ? new Response("down", { status: 503 }) : Response.json(rest);
    },
  };
}

test("the socket's first price is used, and the socket is closed at once", async () => {
  const s = service({ socket: [priceMessage(84_626.08), priceMessage(90_000)] });
  assert.deepEqual(await fetchPrice(s), { cents: 8_462_608, from: "socket" });
  assert.deepEqual(s.asked, [PRICE_SOCKET], "REST isn't asked");
  assert.equal(s.sockets[0].closed, true);
});

test("when the socket fails, stays quiet or can't open, the REST API answers", async () => {
  const closes = service({ socket: null, rest: { price: "84626.08" } });
  assert.deepEqual(await fetchPrice(closes), { cents: 8_462_608, from: "rest" });
  assert.deepEqual(closes.asked, [PRICE_SOCKET, PRICE_URL]);

  const quiet = service({ socket: [], rest: { price: "70000" } });
  assert.deepEqual(await fetchPrice(quiet, { timeoutMs: 20 }), { cents: 7_000_000, from: "rest" });
  assert.equal(quiet.sockets[0].closed, true, "a quiet socket is closed when its time is up");

  const unopened = { ...service({ rest: { price: "70000" } }), socket: () => { throw new Error("offline"); } };
  assert.deepEqual(await fetchPrice(unopened), { cents: 7_000_000, from: "rest" });
});

test("when neither answers, there's no price", async () => {
  assert.equal(await fetchPrice(service({ socket: null, rest: null })), null);
  const offline = () => { throw new Error("offline"); };
  assert.equal(await fetchPrice({ socket: offline, fetch: async () => { throw new Error("offline"); } }), null);
});

test("answers that aren't prices are passed over", async () => {
  const junk = ["not json", JSON.stringify({ weightedPrice: "-5" }), JSON.stringify({ weightedPrice: "1e5" }),
    JSON.stringify({ weightedPrice: "0.001" }), JSON.stringify({ weightedPrice: null }), JSON.stringify({ price: "100000" })];
  const s = service({ socket: [...junk, priceMessage(100_000.5)] });
  assert.deepEqual(await fetchPrice(s), { cents: 10_000_050, from: "socket" }, "the first real price after the junk");

  for (const rest of [{ price: "0" }, { price: "abc" }, { price: 1e21 }, { price: [] }, { weightedPrice: "100000" }, []]) {
    assert.equal(await fetchPrice(service({ socket: null, rest }), { timeoutMs: 20 }), null, JSON.stringify(rest));
  }
  assert.deepEqual(await fetchPrice(service({ socket: null, rest: { price: 100_000 } })), { cents: 10_000_000, from: "rest" });
});

test("a banana is a dollar's worth of bitcoin, counted in thousandths and rounded half up", () => {
  assert.equal(milliBananas(10_000, 10_000_000), 10_000, "10,000 sats at $100,000 is 10 bananas");
  assert.equal(milliBananas(1_200, 10_000_000), 1_200);
  assert.equal(milliBananas(120_000, 6_234_512), 74_814, "at $62,345.12");
  assert.equal(milliBananas(5, 1_000_000), 1, "exactly half a thousandth rounds up");
  assert.equal(milliBananas(4, 1_000_000), 0);
  assert.equal(milliBananas(2_100_000_000_000_000, 10_000_000), 2_100_000_000_000_000, "every bitcoin there will be");
});

test("what the donor is shown: exact and rounded bananas, and the rate behind them", () => {
  assert.deepEqual(bananasOf(74_814), { exact: 74.814, rounded: 75 });
  assert.deepEqual(bananasOf(10_000), { exact: 10, rounded: 10 });
  assert.equal(bananasOf(null), null);
  assert.deepEqual(rateOf(6_234_512, 1_790_000_000_000), { usdPerBtc: 62_345.12, satsPerBanana: 1604, at: 1_790_000_000_000 });
  assert.deepEqual(rateOf(10_000_000, 1), { usdPerBtc: 100_000, satsPerBanana: 1000, at: 1 });
});

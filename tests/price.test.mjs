// Bitcoin's price from 2140data's service, and the banana arithmetic built on it.

import assert from "node:assert/strict";
import test from "node:test";
import { bananasOf, fetchPrice, milliBananas, PRICE_SOCKET, PRICE_URL, rateOf } from "../worker/price.mjs";
import { FakePriceSocket, priceMessage } from "./helpers/cloudflare.mjs";

// The service as fetchPrice sees it. rest is the REST API's body, null for an error, or
// "quiet" for no answer at all; socket is what the socket sends, as in FakePriceSocket.
function service({ rest = { price: "84626.08" }, socket = [priceMessage(84_626.08)] } = {}) {
  const asked = [];
  const sockets = [];
  return {
    asked,
    sockets,
    fetch: async (url, init) => {
      asked.push(String(url));
      if (rest === "quiet") {
        // Node doesn't wait on AbortSignal.timeout's timer, so this keeps the test alive until it fires.
        const alive = setInterval(() => {}, 1_000);
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => {
          clearInterval(alive);
          reject(init.signal.reason);
        }));
      }
      return rest === null ? new Response("down", { status: 503 }) : Response.json(rest);
    },
    socket: (url) => {
      asked.push(url);
      const ws = new FakePriceSocket(socket);
      sockets.push(ws);
      return ws;
    },
  };
}

test("the REST API's price is used, and the socket isn't opened", async () => {
  const s = service();
  assert.deepEqual(await fetchPrice(s), { cents: 8_462_608, from: "rest" });
  assert.deepEqual(s.asked, [PRICE_URL]);
});

test("when the REST API fails or stays quiet, the socket's first price is used, and the socket is closed at once", async () => {
  const down = service({ rest: null, socket: [priceMessage(70_000), priceMessage(90_000)] });
  assert.deepEqual(await fetchPrice(down), { cents: 7_000_000, from: "socket" });
  assert.deepEqual(down.asked, [PRICE_URL, PRICE_SOCKET]);
  assert.equal(down.sockets[0].closed, true);

  const quiet = service({ rest: "quiet", socket: [priceMessage(70_000)] });
  assert.deepEqual(await fetchPrice(quiet, { timeoutMs: 20 }), { cents: 7_000_000, from: "socket" });

  const offline = { ...service({ socket: [priceMessage(70_000)] }), fetch: async () => { throw new Error("offline"); } };
  assert.deepEqual(await fetchPrice(offline), { cents: 7_000_000, from: "socket" });
});

test("when neither answers, there's no price", async () => {
  assert.equal(await fetchPrice(service({ rest: null, socket: null })), null);

  const quiet = service({ rest: null, socket: [] });
  assert.equal(await fetchPrice(quiet, { timeoutMs: 20 }), null);
  assert.equal(quiet.sockets[0].closed, true, "a quiet socket is closed when its time is up");

  const offline = () => { throw new Error("offline"); };
  assert.equal(await fetchPrice({ fetch: async () => { throw new Error("offline"); }, socket: offline }), null);
});

test("answers that aren't prices are passed over", async () => {
  for (const rest of [{ price: "0" }, { price: "abc" }, { price: "1e5" }, { price: 1e21 }, { price: [] }, { weightedPrice: "100000" }, []]) {
    assert.equal(await fetchPrice(service({ rest, socket: null })), null, JSON.stringify(rest));
  }
  assert.deepEqual(await fetchPrice(service({ rest: { price: 100_000 } })), { cents: 10_000_000, from: "rest" });

  const junk = ["not json", JSON.stringify({ weightedPrice: "-5" }), JSON.stringify({ weightedPrice: "1e5" }),
    JSON.stringify({ weightedPrice: "0.001" }), JSON.stringify({ weightedPrice: null }), JSON.stringify({ price: "100000" })];
  const s = service({ rest: null, socket: [...junk, priceMessage(100_000.5)] });
  assert.deepEqual(await fetchPrice(s), { cents: 10_000_050, from: "socket" }, "the first real price after the junk");
});

test("a reply too big to be a price is dropped without being read whole", async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new TextEncoder().encode(" ".repeat(4_096)));
    },
  });
  assert.equal(await fetchPrice({ fetch: async () => new Response(endless), socket: () => { throw new Error("no socket"); } }), null);
  assert.ok(pulled < 10, `read ${pulled} chunks of an endless reply`);
  const declared = new Response("{}", { headers: { "Content-Length": "9000000" } });
  assert.equal(await fetchPrice({ fetch: async () => declared, socket: () => { throw new Error("no socket"); } }), null);
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

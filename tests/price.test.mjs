// Bitcoin's price from three sources, and the banana arithmetic built on it.

import assert from "node:assert/strict";
import test from "node:test";
import { agreedPrice, bananasOf, fetchPrice, milliBananas, rateOf } from "../worker/price.mjs";
import { priceAnswers } from "./helpers/cloudflare.mjs";

const from = (answers) => async (url) => priceAnswers(answers)(String(url));

test("the middle of the answers wins, and one wrong source is left out", async () => {
  assert.equal(await fetchPrice(from({ coinbase: 99_000, kraken: 100_000.25, mempool: 101_000 })), 10_000_025);
  assert.equal(await fetchPrice(from({ coinbase: 1, kraken: 100_000, mempool: 100_100 })), 10_005_000);
});

test("a price needs two sources that agree; one alone, or two apart, means no price this time", async () => {
  assert.equal(await fetchPrice(from({ coinbase: null, kraken: 100_000, mempool: 100_200 })), 10_010_000);
  assert.equal(await fetchPrice(from({ coinbase: null, kraken: null, mempool: 100_000 })), null);
  assert.equal(await fetchPrice(from({ coinbase: null, kraken: 100_000, mempool: 90_000 })), null);
  assert.equal(await fetchPrice(from({ coinbase: null, kraken: null, mempool: null })), null);
  assert.equal(await fetchPrice(async () => { throw new Error("offline"); }), null);
});

test("answers that aren't prices are ignored", async () => {
  const odd = async (url) => {
    const host = new URL(url).hostname;
    if (host === "api.coinbase.com") return Response.json({ data: { amount: "-5" } });
    if (host === "api.kraken.com") return Response.json({ result: { XXBTZUSD: { c: ["100100"] } } });
    return Response.json({ USD: 100_000 });
  };
  assert.equal(await fetchPrice(odd), 10_005_000);
});

test("agreement is within 3% of the middle answer", () => {
  assert.equal(agreedPrice([10_000_000, 10_290_000]), 10_145_000);
  assert.equal(agreedPrice([10_000_000, 10_700_000]), null);
  assert.equal(agreedPrice([9_000_000, 10_000_000, 10_100_000]), 10_050_000, "the far one is left out");
  assert.equal(agreedPrice([10_000_000]), null);
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

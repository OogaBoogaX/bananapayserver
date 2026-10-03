import assert from "node:assert/strict";
import test from "node:test";
import { invoiceMatches, invoiceMsat } from "../shared/bolt11.mjs";
import { MAX_MESSAGE, parseDown, parseUp } from "../shared/protocol.mjs";
import { ADDRESS, BOLT11, REQUEST } from "./helpers/values.mjs";

const json = (value) => JSON.stringify(value);

test("parseDown accepts each message the object sends", () => {
  for (const message of [
    { type: "invoice", request: REQUEST, sats: 1000 },
    { type: "onchain", request: REQUEST, invoice: "Inv0ice1234" },
    { type: "ack", invoice: "Inv0ice1234", result: "recorded" },
  ]) assert.deepEqual(parseDown(json(message)), message);
});

test("parseUp accepts each message the relay sends", () => {
  for (const message of [
    { type: "invoice", request: REQUEST, invoice: { id: "Inv0ice1234", bolt11: BOLT11, expires: 1_790_000_000 } },
    { type: "invoice", request: REQUEST, error: "cap" },
    { type: "onchain", request: REQUEST, address: ADDRESS, sats: 1000 },
    { type: "onchain", request: REQUEST, error: "unavailable" },
    { type: "paid", invoice: "Inv0ice1234", sats: 1000, method: "lightning" },
    { type: "paid", invoice: "Inv0ice1234", sats: 1000, method: "onchain" },
    { type: "paid", invoice: "Inv0ice1234", sats: 1000, method: "mixed" },
  ]) assert.deepEqual(parseUp(json(message)), message);
});

test("anything else is dropped", () => {
  const bad = [
    "not json",
    json(null),
    json([]),
    json({ type: "invoice", request: REQUEST, sats: 1000, extra: 1 }),
    json({ type: "invoice", request: "short", sats: 1000 }),
    json({ type: "invoice", request: REQUEST, sats: 0 }),
    json({ type: "invoice", request: REQUEST, sats: 1.5 }),
    json({ type: "invoice", request: REQUEST, sats: "1000" }),
    json({ type: "ack", invoice: "Inv0ice1234", result: "maybe" }),
    json({ type: "toString", request: REQUEST }),
    json({ type: "__proto__" }),
  ];
  for (const text of bad) assert.equal(parseDown(text), null, text);
  for (const text of [
    ...bad,
    json({ type: "paid", invoice: "../../etc", sats: 1, method: "lightning" }),
    json({ type: "paid", invoice: "Inv0ice1234", sats: 1 }),
    json({ type: "paid", invoice: "Inv0ice1234", sats: 1, method: "bitcoin" }),
    json({ type: "paid", invoice: "Inv0ice1234", sats: 2 ** 60 }),
    json({ type: "invoice", request: REQUEST, invoice: { id: "Inv0ice1234", bolt11: "lnbc", expires: 1 } }),
    json({ type: "invoice", request: REQUEST, invoice: { id: "Inv0ice1234", bolt11: BOLT11, expires: 1, x: 1 } }),
    json({ type: "invoice", request: REQUEST, error: "cap", invoice: null }),
    json({ type: "onchain", request: REQUEST, address: "has spaces in it!", sats: 1 }),
  ]) assert.equal(parseUp(text), null, text);
});

test("oversized messages are dropped before parsing", () => {
  const padded = json({ type: "paid", invoice: "Inv0ice1234", sats: 1 }) + " ".repeat(MAX_MESSAGE);
  assert.equal(parseUp(padded), null);
});

test("invoiceMsat reads the amount for the right network only", () => {
  assert.equal(invoiceMsat(BOLT11, "regtest"), 1_000_000n);
  assert.equal(invoiceMsat(`lnbc2500u1${"q".repeat(120)}`, "mainnet"), 250_000_000n);
  assert.equal(invoiceMsat(`lnbc1m1${"q".repeat(120)}`, "mainnet"), 100_000_000n);
  assert.equal(invoiceMsat(`lntb20n1${"q".repeat(120)}`, "testnet"), 2_000n);
  assert.equal(invoiceMsat(`lntbs10p1${"q".repeat(120)}`, "signet"), 1n);
  assert.equal(invoiceMsat(`lnbc2p1${"q".repeat(120)}`, "mainnet"), null, "a fraction of a msat");
  assert.equal(invoiceMsat(`lnbc1${"q".repeat(120)}`, "mainnet"), null, "no amount");
  assert.equal(invoiceMsat(BOLT11, "mainnet"), null, "regtest invoice on mainnet");
  assert.equal(invoiceMsat(`lntbs10u1${"q".repeat(120)}`, "testnet"), null, "signet is not testnet");
  assert.equal(invoiceMsat(`lnbc010u1${"q".repeat(120)}`, "mainnet"), null, "leading zero");
  assert.equal(invoiceMsat("garbage", "mainnet"), null);
  assert.equal(invoiceMsat(BOLT11, "nowhere"), null);
});

test("invoiceMatches compares the amount in sats", () => {
  assert.equal(invoiceMatches(BOLT11, "regtest", 1000), true);
  assert.equal(invoiceMatches(BOLT11, "regtest", 1001), false);
});

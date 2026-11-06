// The shared receipt-accounting v1 vectors: the checked-in fixture must be exactly what the
// core emitters produce today, byte for byte. Pages consume the same committed file at a
// verified commit, rather than mirroring shapes by hand. Regenerate with
// `node scripts/receipt-vectors.mjs` only after a reviewed contract change.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { buildVectors, FIXTURE, serialize } from "./helpers/receipt-vectors.mjs";

test("the committed contract vectors are exactly what the core emits", async () => {
  assert.ok(existsSync(FIXTURE), "tests/fixtures/receipt-accounting-v1.json is missing; run node scripts/receipt-vectors.mjs and review it");
  const committed = readFileSync(FIXTURE, "utf8");
  const emitted = serialize(await buildVectors());
  assert.equal(committed, emitted, "the core's output changed; review the contract change, then regenerate the fixture");
});

test("the vectors are core-only, synthetic and carry nothing private to the public frames", async () => {
  const { contract, scope, vectors } = await buildVectors();
  assert.deepEqual([contract, scope], ["receipt-accounting-v1", "core-only"]);
  const text = serialize(await buildVectors());
  for (const forbidden of ["/Users", "/home/", "C:\\", "file:", "4242"]) {
    // The owner id is private; it may appear only as an input, never in output.
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  // Public frames never carry addresses, outpoints or provider identities.
  const publicFrames = Object.entries(vectors).filter(([name]) => name.startsWith("receipt.") || name.startsWith("replay.") || name === "invoiceStatus");
  const publicText = JSON.stringify(publicFrames);
  for (const forbidden of ["bcrt1", "11".repeat(32), "synthetic-provider", "synthetic-store", "synthetic-payment-1"]) {
    assert.equal(publicText.includes(forbidden), false, forbidden);
  }
  // Exactly the agreed keys, so a silent rename shows up here as well as in the bytes.
  assert.deepEqual(Object.keys(vectors.invoiceStatus).sort(), ["invoice", "replay", "seq", "type"]);
  assert.deepEqual(Object.keys(vectors.invoiceStatus.invoice).sort(), ["credited", "due", "id", "left", "received", "review", "revision", "state"]);
  assert.deepEqual(Object.keys(vectors["receipt.credited"].receipt).sort(),
    ["at", "credit", "firstCreditedSeq", "handle", "id", "invoice", "message", "method", "pricing", "revision", "sats", "state", "verified"]);
  assert.deepEqual(Object.keys(vectors["privateStatus.core"]).sort(), ["addresses", "invoice", "next", "nextAddress", "payableAddress", "receipts"]);
  assert.deepEqual(Object.keys(vectors["replay.gap"]).sort(), ["after", "complete", "frames", "through"]);
  for (const name of ["pile.pending", "pile.anchored", "pile.anchoredReview"]) {
    assert.deepEqual(Object.keys(vectors[name]).sort(),
      ["at", "bananas", "basis", "cutover", "eatPerHour", "reconciliation", "revision", "type", "uncertain"], name);
  }
  // The states each vector is there to show.
  assert.equal(vectors["receipt.pricingPending"].receipt.pricing, null);
  assert.notEqual(vectors["receipt.priceFrozen"].receipt.pricing, null);
  assert.equal(vectors["receipt.credited"].receipt.firstCreditedSeq, vectors["receipt.credited"].seq);
  assert.equal(vectors["receipt.reversed"].receipt.firstCreditedSeq, vectors["receipt.credited"].seq);
  assert.equal(vectors["replay.gap"].complete, false);
  assert.equal(vectors["replay.complete"].complete, true);
  assert.deepEqual([vectors["pile.pending"].bananas, vectors["pile.pending"].cutover], [null, "pending"]);
  assert.deepEqual([vectors["pile.anchoredReview"].bananas, vectors["pile.anchoredReview"].cutover, vectors["pile.anchoredReview"].reconciliation], [null, "done", "review"]);
  assert.notEqual(vectors["privateStatus.core"].payableAddress, null);
  assert.notEqual(vectors["privateStatus.core"].nextAddress, null);
});

test("the OBL donation fixture is untouched by these vectors", () => {
  // The donation event and its text rules stay pinned by obl-contract.test.mjs alone.
  assert.ok(existsSync(new URL("./fixtures/obl-donations.js", import.meta.url)));
});

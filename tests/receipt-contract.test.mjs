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

test("the endpoint vectors are the real replies, with the agreed keys and statuses", async () => {
  const { endpoints } = await buildVectors();
  assert.equal(endpoints.scope, "read-endpoints");
  const v = endpoints.vectors;
  assert.equal(v["status.byToken"].status, 200);
  assert.deepEqual(Object.keys(v["status.byToken"].body), ["invoice", "payableAddress", "addresses", "nextAddress", "receipts", "next"]);
  assert.deepEqual(Object.keys(v["status.byToken"].body.invoice),
    ["id", "accounting", "due", "received", "credited", "review", "left", "state", "revision", "expires", "lightning", "bolt11"]);
  assert.deepEqual([v["status.byToken"].body.invoice.lightning, v["status.byToken"].body.invoice.bolt11], ["unavailable", null], "no provider evidence");
  assert.equal(v["status.addressPage"].status, 200);
  assert.deepEqual([v["status.unknown"], v["status.cursor"], v["status.resync"]],
    [{ status: 404, body: { error: "unknown" } }, { status: 400, body: { error: "cursor" } }, { status: 409, body: { error: "resync" } }]);
  assert.deepEqual(Object.keys(v["history.page"].body), ["revision", "invoices", "next"]);
  assert.deepEqual(v["history.signedOut"], { status: 401, body: { error: "signin" } });
  assert.deepEqual(v["invoice.receiptModeClosed"], { status: 503, body: { error: "closed" } });
  const connect = v["socket.firstConnect"].map((m) => m.type);
  assert.deepEqual(connect, ["status", "recentReceipts", "replay"], "no frames replayed without a cursor");
  assert.equal(v["socket.firstConnect"][0].accounting.issuance, false);
  assert.ok(v["socket.replayFromZero"].filter((m) => m.type === "receipt" || m.type === "invoiceStatus").every((m) => m.replay === true));
  assert.equal(v["socket.replayFromZero"].at(-1).type, "replay");
  // A real second receipt page, and two history pages reached by the generated cursor.
  assert.equal(v["status.receiptPage"].status, 200);
  const firstIds = v["status.byToken"].body.receipts.map((r) => r.id);
  const nextIds = v["status.receiptPage"].body.receipts.map((r) => r.id);
  assert.ok(nextIds.length > 0 && nextIds.every((id) => !firstIds.includes(id)), "the next page continues, without overlap");
  assert.deepEqual(v["history.page"].body.invoices.map((i) => i.id), ["ReceiptInv1", "ReceiptInv2"]);
  assert.deepEqual(v["history.nextPage"].body.invoices.map((i) => i.id), ["ReceiptInv3"]);
  assert.deepEqual([v["history.nextPage"].status, v["history.nextPage"].body.next], [200, null]);
  assert.equal(v["history.nextPage"].body.revision, v["history.page"].body.revision);
  for (const page of [v["history.page"], v["history.nextPage"]]) {
    for (const entry of page.body.invoices) assert.ok(Number.isSafeInteger(entry.expires) && entry.expires > 0);
  }
  // The scoped metadata gate, as the endpoints answer it.
  assert.deepEqual([v["status.metadataClosed"], v["history.metadataClosed"]],
    [{ status: 503, body: { error: "closed" } }, { status: 503, body: { error: "closed" } }]);
  // A genuine first credit heard live by an already-connected socket: after its marker, not
  // replayed, and the one frame whose seq is the receipt's first credit.
  const live = v["socket.liveFirstCredit"];
  const marker = v["socket.firstConnect"].find((m) => m.type === "replay");
  assert.ok(live.length > 0 && live.every((m) => m.replay === false && m.seq > marker.through));
  const credits = live.filter((m) => m.type === "receipt" && m.receipt.state === "credited" && m.seq === m.receipt.firstCreditedSeq);
  assert.equal(credits.length, 1, "exactly one animating frame");
  assert.ok(!firstIds.includes(credits[0].receipt.id) && !nextIds.includes(credits[0].receipt.id), "a new receipt, not history");
  assert.deepEqual(live.map((m) => m.seq), [...live.map((m) => m.seq)].sort((a, b) => a - b), "in feed order");
  assert.ok(v["socket.replayFromZero"].every((m) => !(m.type === "receipt" && m.receipt.id === credits[0].receipt.id)), "never in an earlier snapshot");
  // Nothing private in what pages receive on the socket.
  const socketText = JSON.stringify([v["socket.firstConnect"], v["socket.replayFromZero"], live]);
  for (const forbidden of ["bcrt1", "11".repeat(32), "btcpay", "store-a"]) assert.equal(socketText.includes(forbidden), false, forbidden);
});

test("the OBL donation fixture is untouched by these vectors", () => {
  // The donation event and its text rules stay pinned by obl-contract.test.mjs alone.
  assert.ok(existsSync(new URL("./fixtures/obl-donations.js", import.meta.url)));
});

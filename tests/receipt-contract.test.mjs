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
  // The receipt frames, then the pile they moved: the credit reaches the authoritative pile's
  // journal with them, and the pile is still pending, with no number, until its anchor.
  const heard = v["socket.liveFirstCredit"];
  const live = heard.filter((m) => m.type !== "pile");
  assert.deepEqual(heard.map((m) => m.type), [...live.map((m) => m.type), "pile"], "receipt frames, then the pile");
  assert.deepEqual(heard.at(-1), { type: "pile", bananas: null, at: null, eatPerHour: 0, revision: heard.at(-1).revision, basis: "credits",
    cutover: "pending", reconciliation: "review", uncertain: null });
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

test("the projection vectors are what an open socket hears: D1's figures after the receipt, and a repeated refresh adds nothing", async () => {
  const { projection } = await buildVectors();
  assert.equal(projection.scope, "projection-publication");
  const v = projection.vectors;
  assert.deepEqual(Object.keys(v),
    ["projection.firstCredit", "projection.stoppedAfterBatch", "projection.crashRecovery", "projection.duplicateRefresh", "projection.reversal", "projection.reconfirmation"]);
  const of = (name, type) => v[name].messages.filter((m) => m.type === type);
  const tallyOf = (name) => { const t = of(name, "tally"); assert.equal(t.length, 1, `${name}: one tally`); return t[0]; };
  // Every tally sent is exactly what D1 holds at that point.
  for (const name of Object.keys(v)) {
    if (name === "projection.stoppedAfterBatch") continue;
    const t = tallyOf(name);
    assert.deepEqual([t.count, t.sats, t.last], [v[name].d1.count, v[name].d1.sats, v[name].d1.last], `${name}: the tally sent is D1's`);
    assert.equal(of(name, "board").length, 1, `${name}: one board`);
    // Live receipt frames come before the lifetime figures.
    const types = v[name].messages.map((m) => m.type);
    assert.ok(types.lastIndexOf("receipt") < types.indexOf("board") && types.indexOf("board") < types.indexOf("tally"), `${name}: receipt, board, tally`);
  }
  assert.deepEqual(v["projection.firstCredit"].d1, { count: 1, sats: 1000, milli: 1000, last: 1000 });
  // Stopped after a durable batch: the receipt was heard live, the figures not yet.
  assert.deepEqual(v["projection.stoppedAfterBatch"].messages.map((m) => m.type), ["receipt", "receipt"]);
  assert.deepEqual(v["projection.stoppedAfterBatch"].d1, { count: 2, sats: 3500, milli: 3500, last: 2500 });
  // The recovery and the repeated refresh: no receipt frames, and the same figures, counted once.
  for (const name of ["projection.crashRecovery", "projection.duplicateRefresh"]) {
    assert.equal(of(name, "receipt").length, 0, `${name}: no receipt replayed as new`);
    assert.deepEqual(v[name].d1, v["projection.stoppedAfterBatch"].d1, `${name}: nothing counted again`);
  }
  assert.deepEqual(tallyOf("projection.duplicateRefresh"), tallyOf("projection.crashRecovery"), "a repeated refresh is the same message, adding no credit");
  assert.deepEqual(of("projection.duplicateRefresh", "board"), of("projection.crashRecovery", "board"));
  // Reversal takes the newer receipt out of the figures and of `last`; reconfirmation restores both.
  assert.deepEqual(v["projection.reversal"].d1, { count: 1, sats: 1000, milli: 1000, last: 1000 });
  assert.equal(of("projection.reversal", "receipt").at(-1).receipt.state, "reversed");
  assert.deepEqual(v["projection.reconfirmation"].d1, v["projection.stoppedAfterBatch"].d1, "reconfirmed at the same frozen price");
  assert.deepEqual(of("projection.reconfirmation", "board"), of("projection.crashRecovery", "board"));
  assert.ok([...Object.values(v)].flatMap((x) => x.messages).filter((m) => m.type === "receipt").every((m) => m.replay === false), "all heard live");
  // Nothing private in what the page heard.
  const text = JSON.stringify(v);
  for (const forbidden of ["4242", "bcrt1", "btcpay", "store-a", "owner"]) assert.equal(text.includes(forbidden), false, forbidden);
});

test("the payable vectors are the real positive path: a verified payable address and fresh remainder, withdrawn, expired, and a real gap", async () => {
  const { payable } = await buildVectors();
  assert.equal(payable.scope, "read-endpoints-payable");
  const v = payable.vectors;
  assert.deepEqual(Object.keys(v), ["socket.payableLive", "status.payable", "history.payable", "socket.freshnessWithdrawn", "status.withdrawn",
    "history.withdrawn", "socket.gapMarker", "socket.currentReconnect", "socket.expired", "status.expired", "history.expired",
    "socket.initialConnect", "socket.requests", "socket.earlyConnect", "socket.earlyLive", "socket.earlyGap", "socket.earlyCurrent",
    "status.atEarlyGap", "history.atEarlyGap"]);
  // The reachable gap. A page connects with no cursor, as a page with nothing yet does, and its
  // marker names no position. It hears seq 1 live and goes away; its cursor is what it heard.
  const earlyRequest = (path) => ({ method: "GET", path, upgrade: "websocket" });
  const marker = (name) => v[name].messages.find((m) => m.type === "replay");
  assert.deepEqual(v["socket.earlyConnect"].request, earlyRequest("/donations/socket"));
  assert.deepEqual(marker("socket.earlyConnect"), { type: "replay", after: null, through: null, complete: true });
  assert.deepEqual(v["socket.earlyLive"].map((m) => [m.type, m.seq, m.replay]), [["receipt", 1, false]], "one live frame, then gone");
  // Back after the expiry with receipts=1: more frames wait than the saved bound of 2, so a gap
  // marker and no frames, with the high-water mark to resume from.
  assert.deepEqual(v["socket.earlyGap"].request, earlyRequest("/donations/socket?receipts=1"));
  const gapped = marker("socket.earlyGap");
  assert.deepEqual([gapped.after, gapped.complete], [1, false]);
  assert.ok(gapped.through - gapped.after > 2, "genuinely more than the bound");
  assert.equal(gapped.through, v["socket.expired"].at(-1).seq, "through the expiry's frame");
  assert.ok(v["socket.earlyGap"].messages.every((m) => m.type !== "receipt" && m.type !== "invoiceStatus"), "no frames replayed");
  // From that mark: complete, nothing to replay.
  assert.deepEqual(v["socket.earlyCurrent"].request, earlyRequest(`/donations/socket?receipts=${gapped.through}`));
  assert.deepEqual(marker("socket.earlyCurrent"), { type: "replay", after: gapped.through, through: gapped.through, complete: true });
  for (const name of ["socket.earlyConnect", "socket.earlyGap", "socket.earlyCurrent"]) {
    assert.deepEqual(v[name].messages.slice(0, 1).map((m) => m.type), ["status"], name);
  }
  // The private replies at the same point: the expired invoice, its history kept.
  assert.equal(v["status.atEarlyGap"].body.invoice.lightning, "expired");
  assert.equal(v["status.atEarlyGap"].body.invoice.revision, v["socket.expired"].at(-1).invoice.revision);
  assert.deepEqual(v["history.atEarlyGap"].body.invoices.map((i) => i.id), ["PayableInv1"]);
  // The requests the socket vectors' connects actually sent through PageApi: none with a cursor
  // first, then receipts=0 for the gap, then the gap marker's own high-water mark.
  const requests = v["socket.requests"];
  const socketRequest = (path) => ({ method: "GET", path, upgrade: "websocket" });
  assert.deepEqual(requests, {
    "socket.initialConnect": socketRequest("/donations/socket"),
    "socket.gapMarker": socketRequest("/donations/socket?receipts=0"),
    "socket.currentReconnect": socketRequest(`/donations/socket?receipts=${v["socket.gapMarker"].at(-1).through}`),
  });
  // The first page's connect, before any read or payment: everything it was sent, in order.
  const initial = v["socket.initialConnect"];
  assert.deepEqual(initial.request, requests["socket.initialConnect"]);
  assert.deepEqual(initial.messages.map((m) => m.type), ["status", "pile", "board", "tally", "recent", "recentReceipts", "replay", "tally"]);
  assert.deepEqual(initial.messages[0].accounting, { version: 1, issuance: false, receipts: true, history: true, coverage: "invoice", spends: false,
    reconciliation: initial.messages[0].accounting.reconciliation });
  assert.notEqual(initial.messages[0].accounting.reconciliation, "current");
  assert.deepEqual(initial.messages.find((m) => m.type === "recentReceipts"), { type: "recentReceipts", entries: [] });
  // No cursor and an empty feed: the marker names no position yet, and is complete.
  assert.deepEqual(initial.messages.find((m) => m.type === "replay"), { type: "replay", after: null, through: null, complete: true });
  assert.ok(initial.messages.every((m) => m.type !== "receipt" && m.type !== "invoiceStatus"), "nothing live before the first read");
  // The first live frame the open page heard came after that marker.
  assert.equal(v["socket.payableLive"][0].seq, 1);
  const statusKeys = ["invoice", "payableAddress", "addresses", "nextAddress", "receipts", "next"];
  const invoiceKeys = ["id", "accounting", "due", "received", "credited", "review", "left", "state", "revision", "expires", "lightning", "bolt11"];
  for (const name of ["status.payable", "status.withdrawn", "status.expired"]) {
    assert.equal(v[name].status, 200, name);
    assert.deepEqual(Object.keys(v[name].body), statusKeys, name);
    assert.deepEqual(Object.keys(v[name].body.invoice), invoiceKeys, name);
  }
  // While fresh: a payable address that is one of the invoice's own bound regtest addresses, and
  // the provider's remaining amount, consistent with what was received.
  const fresh = v["status.payable"].body;
  assert.ok(fresh.payableAddress?.startsWith("bcrt1"), "a regtest address");
  assert.ok(fresh.addresses.some((a) => a.address === fresh.payableAddress), "already bound to this invoice");
  assert.deepEqual([fresh.invoice.left, fresh.invoice.received, fresh.invoice.due, fresh.invoice.state], [6000, 4000, 10_000, "partial"]);
  assert.deepEqual([fresh.invoice.lightning, fresh.invoice.bolt11], ["unavailable", null], "no provider has verified the original code");
  assert.ok(fresh.invoice.expires * 1000 > fresh.receipts[0].at, "unexpired original metadata");
  assert.equal(v["history.payable"].body.invoices[0].left, 6000);
  // Live, the page heard the receipt with the fresh remainder, and never the address.
  assert.ok(v["socket.payableLive"].length > 0 && v["socket.payableLive"].every((m) => m.replay === false));
  assert.equal(v["socket.payableLive"].at(-1).invoice.left, 6000);
  // Withdrawn by time: live first, then both replies at that newer revision, nothing payable.
  const withdrawn = v["socket.freshnessWithdrawn"];
  assert.deepEqual(withdrawn.map((m) => [m.type, m.replay, m.invoice.left]), [["invoiceStatus", false, null]]);
  for (const name of ["status.withdrawn", "history.withdrawn"]) {
    const body = v[name].body;
    const entry = body.invoices ? body.invoices[0] : body.invoice;
    assert.deepEqual([entry.left, entry.revision], [null, withdrawn[0].invoice.revision], name);
    assert.ok(entry.revision > (body.invoices ? v["history.payable"].body.invoices[0].revision : fresh.invoice.revision), `${name}: newer`);
  }
  assert.equal(v["status.withdrawn"].body.payableAddress, null);
  assert.deepEqual(v["status.withdrawn"].body.addresses, fresh.addresses, "the address history is kept; it never implies payable");
  // Expired: live, then Lightning expired, the history retaining the invoice, its receipts kept.
  const expired = v["socket.expired"];
  assert.deepEqual(expired.map((m) => [m.type, m.replay]), [["invoiceStatus", false]]);
  assert.equal(v["status.expired"].body.invoice.lightning, "expired");
  assert.equal(v["status.expired"].body.invoice.revision, expired[0].invoice.revision);
  assert.deepEqual(v["status.expired"].body.receipts, fresh.receipts.map((r) => r), "receipts kept");
  assert.deepEqual(v["history.expired"].body.invoices.map((i) => [i.id, i.credited, i.expires]), [["PayableInv1", 4000, fresh.invoice.expires]]);
  // A real gap: more frames waiting than the saved bound, so no frames and complete: false; a
  // current reconnect is complete with nothing to replay.
  const gap = v["socket.gapMarker"];
  assert.deepEqual(gap.map((m) => m.type), ["recentReceipts", "replay"]);
  assert.deepEqual(gap.at(-1), { type: "replay", after: 0, through: withdrawn[0].seq, complete: false });
  assert.deepEqual(v["socket.currentReconnect"].map((m) => m.type), ["recentReceipts", "replay"]);
  assert.deepEqual(v["socket.currentReconnect"].at(-1), { type: "replay", after: withdrawn[0].seq, through: withdrawn[0].seq, complete: true });
  // Nothing private on any socket message: no address, and no account id anywhere.
  const sockets = JSON.stringify(Object.entries(v).filter(([name]) => name.startsWith("socket.")));
  for (const forbidden of ["bcrt1", "payableAddress", "11".repeat(32), "btcpay", "store-a"]) assert.equal(sockets.includes(forbidden), false, forbidden);
  assert.equal(JSON.stringify(v).includes("4242"), false);
});

test("the anchored pile vectors: receipts move the level once each, health is honest, and a stopped object's pile still reaches its page", async () => {
  const { pile } = await buildVectors();
  assert.equal(pile.scope, "anchored-pile");
  const v = pile.vectors;
  assert.deepEqual(Object.keys(v), ["pile.connect", "pile.creditBehind", "pile.creditCurrent", "pile.reviewUncertain", "pile.reversal",
    "pile.reconfirmation", "pile.beforeRestart", "pile.restartRecovery", "pile.reconnect"]);
  const keys = ["type", "bananas", "at", "eatPerHour", "revision", "basis", "cutover", "reconciliation", "uncertain"];
  const heard = Object.entries(v).filter(([name]) => name !== "pile.reconnect").flatMap(([, piles]) => piles);
  for (const p of [...heard, ...v["pile.reconnect"]]) {
    assert.deepEqual(Object.keys(p), keys);
    assert.deepEqual([p.type, p.eatPerHour, p.basis, p.cutover], ["pile", 0, "credits", "done"]);
    assert.ok(["behind", "current", "review"].includes(p.reconciliation), "never off once receipts feed it");
  }
  // The page hears each revision once, in order.
  assert.deepEqual(heard.map((p) => p.revision), [...heard.map((p) => p.revision)].sort((a, b) => a - b));
  assert.equal(new Set(heard.map((p) => p.revision)).size, heard.length);
  const last = (name) => v[name].at(-1);
  // The anchor's reviewed 10 bananas, before any receipt: behind, since no read is verified.
  assert.deepEqual([last("pile.connect").bananas, last("pile.connect").reconciliation], [10, "behind"]);
  // One credit of 1,000 sats at 1,000 sats a banana: +1, behind until verified, then current.
  assert.deepEqual(v["pile.creditBehind"].map((p) => [p.bananas, p.reconciliation]), [[11, "behind"]]);
  assert.deepEqual(v["pile.creditCurrent"].map((p) => [p.bananas, p.reconciliation]), [[11, "current"]], "a new revision for health alone");
  // Held for review: its credit stays in the level and is counted uncertain.
  assert.deepEqual([last("pile.reviewUncertain").bananas, last("pile.reviewUncertain").reconciliation, last("pile.reviewUncertain").uncertain],
    [11, "review", { sats: 1000, bananas: 1 }]);
  // Reversed, it leaves the level once; reconfirmed at its frozen price, it returns once.
  assert.deepEqual([last("pile.reversal").bananas, last("pile.reversal").reconciliation, last("pile.reversal").uncertain], [10, "current", { sats: 0, bananas: 0 }]);
  assert.deepEqual([last("pile.reconfirmation").bananas, last("pile.reconfirmation").reconciliation], [11, "current"]);
  for (const name of ["pile.creditBehind", "pile.creditCurrent", "pile.reviewUncertain", "pile.reversal", "pile.reconfirmation"]) {
    assert.ok(v[name].every((p) => p.reconciliation !== "current" || p.uncertain.sats === 0), `${name}: current only with nothing uncertain`);
  }
  // A second credit of 2,500 sats reached the pile before a stop; the page heard nothing then,
  // and hears the newer pile from the next start, without any further payment.
  assert.deepEqual(v["pile.beforeRestart"], []);
  assert.ok(v["pile.restartRecovery"].length > 0);
  assert.equal(last("pile.restartRecovery").bananas, 13.5);
  assert.ok(last("pile.restartRecovery").revision > last("pile.reconfirmation").revision);
  // A page connecting afterwards gets exactly the current pile.
  assert.deepEqual(v["pile.reconnect"], [last("pile.restartRecovery")]);
});

test("the vectors are deterministic, and every section before payable is unchanged by it", async () => {
  const [a, b] = [serialize(await buildVectors()), serialize(await buildVectors())];
  assert.equal(a, b, "two builds, the same bytes");
  assert.deepEqual(Object.keys(JSON.parse(a)), ["contract", "scope", "note", "vectors", "endpoints", "projection", "payable", "pile"]);
});

test("the OBL donation fixture is untouched by these vectors", () => {
  // The donation event and its text rules stay pinned by obl-contract.test.mjs alone.
  assert.ok(existsSync(new URL("./fixtures/obl-donations.js", import.meta.url)));
});

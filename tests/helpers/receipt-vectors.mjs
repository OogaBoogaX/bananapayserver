// The shared receipt-accounting v1 contract vectors, produced by the real core emitters from a
// fixed synthetic scenario. tests/receipt-contract.test.mjs checks the checked-in fixture is
// byte for byte what these produce; scripts/receipt-vectors.mjs writes it after a reviewed
// change. Pages consume the same committed bytes.
//
// Two sections. `vectors` is core-only: what worker/receipts.mjs and worker/pile.mjs emit,
// labeled as such. `endpoints` is what the read endpoints and the socket actually send through
// the front door and object.

import { fakeCtx, fakeD1, fakePlatform, fakeStorage } from "./cloudflare.mjs";
import { syntheticAddress } from "./synthetic-address.mjs";
import { DonationsObject } from "../../worker/object.mjs";
import { applyPileAnchor, pileView, recordPileDelta } from "../../worker/pile.mjs";
import { hashRequest, ReceiptLedger } from "../../worker/receipts.mjs";
import { pay, provider, read, RECEIPT_SETTINGS, seed, TOKEN } from "./receipt-seed.mjs";
import { world } from "./world.mjs";

export const FIXTURE = new URL("../fixtures/receipt-accounting-v1.json", import.meta.url);

const T0 = 1_790_000_000_000;
const INVOICE = "VectorInv001";
const PROVIDER = "synthetic-provider";
const STORE = "synthetic-store";
const CONFIRMATIONS = "synthetic-confirmations-1";
const LINE = "synthetic-line";
const GENERATION = "0123456789abcdef";
const PRICE = 10_000_000; // $100,000 a bitcoin: 1,000 sats a banana

async function receiptVectors() {
  const time = { now: T0 };
  let n = 0;
  const ledger = new ReceiptLedger({
    storage: fakeStorage(), now: () => time.now, randomHex: () => (++n).toString(16).padStart(32, "0"), issuance: true,
    policy: { editWindow: "first-observation", messageRule: "once", pricingRecovery: "stale-candidate", confirmationPolicy: CONFIRMATIONS, version: "synthetic-policy-1" },
    readSettings: { replayMax: 100, statusPageSize: 1, addressPageSize: 2, historyPageSize: 2, recentSize: 10, cursorTtlMs: 600_000, freshnessMs: 60_000 },
  });
  ledger.issueInvoice({
    invoice: INVOICE, network: "regtest", provider: PROVIDER, store: STORE, owner: 4242, login: "ooga-dev",
    handle: "ooga-dev", message: "for the cave", messageMinSats: 1000, due: 10_000, requestHash: await hashRequest("synthetic-request"),
    expires: Math.floor(T0 / 1000) + 900, lightning: "unavailable", bolt11: null,
  });
  for (const k of [1, 2, 3]) await ledger.bindAddress(INVOICE, syntheticAddress(k));
  const payment = (state) => ({
    method: "onchain", providerId: "synthetic-payment-1", sats: 4000, state, txid: "11".repeat(32), vout: 0,
    destination: syntheticAddress(3), paymentHash: null, blockHash: null, blockHeight: null, confirmations: null,
  });
  const read = (state, left) => {
    const { sequence } = ledger.beginRead(INVOICE, { line: LINE, generation: GENERATION });
    const begin = {
      frame: "begin", status: "Processing", left, destination: syntheticAddress(3), provider: PROVIDER, store: STORE,
      observedAt: time.now, provenance: "sweep", policyVersion: CONFIRMATIONS,
      capabilities: { complete: false, outpoints: true, lightningSuccess: true, remaining: true, destination: true },
    };
    return ledger.applySnapshot({
      invoice: INVOICE, line: LINE, generation: GENERATION, sequence, candidate: { cents: PRICE, at: time.now - 1000 },
      frames: [begin, { frame: "payment", index: 0, payment: payment(state) }, { frame: "end", count: 1 }],
    });
  };

  const [receipt] = read("observed", 6300).priced;
  time.now += 1000;
  ledger.beginPricing(receipt);
  ledger.freezePrice(receipt, { cents: PRICE, at: time.now });
  time.now += 1000;
  read("settled", 6300);
  time.now += 1000;
  read("settled", 6000);
  const access = { donorId: 4242, receiptLimit: 1, addressLimit: 2, ttlMs: 600_000 };
  const privateStatus = ledger.privateStatus(INVOICE, access);
  const addressPage = ledger.privateStatus(INVOICE, { ...access, addressCursor: privateStatus.nextAddress });
  time.now += 1000;
  read("invalid", 6000);
  ledger.reverse(receipt, "synthetic double spend");

  const feed = ledger.feedAfter(0, { limit: 100 });
  const frames = feed.frames;
  const of = (test) => {
    const found = frames.find(test);
    if (!found) throw new Error("the scenario didn't produce an expected frame");
    return found;
  };
  return {
    "receipt.pricingPending": of((f) => f.type === "receipt" && f.receipt.pricing === null),
    "receipt.priceFrozen": of((f) => f.type === "receipt" && f.receipt.state === "confirming" && f.receipt.pricing !== null),
    "receipt.credited": of((f) => f.type === "receipt" && f.receipt.state === "credited"),
    "receipt.reversed": of((f) => f.type === "receipt" && f.receipt.state === "reversed"),
    invoiceStatus: of((f) => f.type === "invoiceStatus"),
    "replay.complete": ledger.feedAfter(feed.through - 2, { limit: 2 }),
    "replay.gap": ledger.feedAfter(0, { limit: 1 }),
    "replay.firstConnect": ledger.feedAfter(null, { limit: 1 }),
    "privateStatus.core": privateStatus,
    "privateStatus.core.addressPage": addressPage,
  };
}

function pileVectors() {
  const ctx = fakeCtx();
  const platform = fakePlatform();
  new DonationsObject(ctx, { DB: fakeD1() }, platform);
  const sql = ctx.storage.sql;
  const at = platform.now();
  const pending = pileView(sql);
  ctx.storage.transactionSync(() => recordPileDelta(sql, "donation:VectorDon001", 2500, at));
  applyPileAnchor(ctx.storage, { anchor: "synthetic-anchor-1", expected: null, milli: 10_000, boundary: 0,
    reason: "synthetic vector", evidence: "synthetic vector" }, at);
  const anchored = pileView(sql);
  ctx.storage.transactionSync(() => recordPileDelta(sql, "correction:synthetic-deficit", -20_000, at));
  return { "pile.pending": pending, "pile.anchored": anchored, "pile.anchoredReview": pileView(sql) };
}

// What the read endpoints and the socket actually send, through the real front door and
// object, for synthetic receipt-mode mappings. Issuance is off, so mappings are seeded through
// the core, as provider ingestion would make them. Every snapshot of a socket is taken by
// message count at a stated point, so a later call can never leak into it.
async function endpointVectors() {
  const w = await world(RECEIPT_SETTINGS);
  const ledger = provider(w);
  // The owner's three invoices, so history has two pages; the first holds the payments.
  await seed(w, ledger, { invoice: "ReceiptInv3", token: TOKEN(0xa3), addresses: [7] });
  await seed(w, ledger, { invoice: "ReceiptInv2", token: TOKEN(0xa2), addresses: [6] });
  const { invoice, token } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)], { left: 7000 });
  w.object.pushReceiptFrames();
  const call = async (path, body, donor = null) => {
    const response = await w.post(path, body, { donor });
    return { status: response.status, body: await response.json() };
  };
  const owner = { id: 4242, login: "ooga-dev" };
  const status = await call("/donations/status", { request: token });
  const receiptPage = await call("/donations/status", { request: token, cursor: status.body.next });
  const addressPage = await call("/donations/status", { request: token, addressCursor: status.body.nextAddress });
  const unknown = await call("/donations/status", { invoice }, { id: 9999, login: "someone-else" });
  const crossKind = await call("/donations/status", { request: token, cursor: status.body.nextAddress });
  const historyPage = await call("/donations/history", {}, owner);
  const historyNext = await call("/donations/history", { cursor: historyPage.body.next }, owner);
  const receiptTypes = new Set(["recentReceipts", "receipt", "invoiceStatus", "replay"]);
  // Each connect's messages, up to and including its replay marker.
  const connected = await w.connectPage();
  // The connect's own background work (the rate refresh) finishes first, so the live slice
  // below holds only what the new payment caused.
  await w.ctx.settle();
  const connectCount = connected.messages().length;
  const firstConnect = connected.messages().filter((m) => receiptTypes.has(m.type) || m.type === "status");
  const replayed = await w.connectPage(undefined, "visitor-q", 0);
  const replayFromZero = replayed.messages().filter((m) => receiptTypes.has(m.type));
  // A new payment, first observed and credited while the first socket is open: exactly what
  // that socket hears live, as the object broadcasts it.
  read(w, ledger, invoice, [pay(1), pay(2), pay(3), pay(4)], { left: 6000 });
  w.object.pushReceiptFrames();
  const liveFirstCredit = connected.messages().slice(connectCount);
  // A new binding moves the invoice's revision, so the earlier receipt cursor is stale.
  await ledger.bindAddress(invoice, syntheticAddress(9));
  const resync = await call("/donations/status", { request: token, cursor: status.body.next });
  // Another account's invoice left by a pre-activation core without its expiry: closed for
  // that invoice and its own history page alone.
  const broken = await seed(w, ledger, { invoice: "BrokenInv01", token: TOKEN(0xbb), owner: 5150, login: "other-donor", addresses: [8] });
  w.ctx.storage.sql.exec("UPDATE ra_invoices SET expires = NULL WHERE invoice = ?", broken.invoice);
  return {
    "status.byToken": status,
    "status.addressPage": addressPage,
    "status.unknown": unknown,
    "status.cursor": crossKind,
    "status.resync": resync,
    "history.page": historyPage,
    "history.signedOut": await call("/donations/history", {}, null),
    "invoice.receiptModeClosed": await call("/donations/invoice", { sats: 1000, accounting: 1 }),
    "socket.firstConnect": firstConnect,
    "socket.replayFromZero": replayFromZero,
    "status.receiptPage": receiptPage,
    "history.nextPage": historyNext,
    "socket.liveFirstCredit": liveFirstCredit,
    "status.metadataClosed": await call("/donations/status", { request: broken.token }),
    "history.metadataClosed": await call("/donations/history", {}, { id: 5150, login: "other-donor" }),
  };
}

export async function buildVectors() {
  return {
    contract: "receipt-accounting-v1",
    scope: "core-only",
    note: "Emitted by worker/receipts.mjs and worker/pile.mjs from a synthetic scenario. Core output, not endpoint " +
      "replies: those are under endpoints. Feed frames are shown as replayed (replay: true); live frames carry replay: false.",
    vectors: { ...(await receiptVectors()), ...pileVectors() },
    endpoints: {
      scope: "read-endpoints",
      note: "What POST /donations/status, POST /donations/history, POST /donations/invoice with accounting: 1, the " +
        "socket's connect sequence and its live broadcast send, through the real front door and object, for synthetic " +
        "receipt-mode mappings seeded through the core. Each reply is { status, body }; socket vectors are the messages " +
        "received at the stated point. Proves the producer's real shapes, cursors, statuses and live/replay framing. Does " +
        "not prove provider ingestion, D1 projection, reconciliation (health is never current here) or any consumer's " +
        "parsing. Issuance is off.",
      vectors: await endpointVectors(),
    },
  };
}

export const serialize = (vectors) => `${JSON.stringify(vectors, null, 2)}\n`;

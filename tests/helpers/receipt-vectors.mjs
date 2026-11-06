// The shared receipt-accounting v1 contract vectors, produced by the real core emitters from a
// fixed synthetic scenario. tests/receipt-contract.test.mjs checks the checked-in fixture is
// byte for byte what these produce; scripts/receipt-vectors.mjs writes it after a reviewed
// change. Pages consume the same committed bytes.
//
// Core-only: these are what worker/receipts.mjs and worker/pile.mjs emit. The endpoint
// wrappers (accounting, expires, lightning, the guarded bolt11), account history and the
// socket's connect sequence aren't built yet, and nothing here stands in for them.

import { fakeCtx, fakeD1, fakePlatform, fakeStorage } from "./cloudflare.mjs";
import { syntheticAddress } from "./synthetic-address.mjs";
import { DonationsObject } from "../../worker/object.mjs";
import { applyPileAnchor, pileView, recordPileDelta } from "../../worker/pile.mjs";
import { hashRequest, ReceiptLedger } from "../../worker/receipts.mjs";

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
    freshnessMs: 60_000,
  });
  ledger.issueInvoice({
    invoice: INVOICE, network: "regtest", provider: PROVIDER, store: STORE, owner: 4242, login: "ooga-dev",
    handle: "ooga-dev", message: "for the cave", messageMinSats: 1000, due: 10_000, requestHash: await hashRequest("synthetic-request"),
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

export async function buildVectors() {
  return {
    contract: "receipt-accounting-v1",
    scope: "core-only",
    note: "Emitted by worker/receipts.mjs and worker/pile.mjs from a synthetic scenario. Not endpoint replies: " +
      "the endpoint wrappers, account history and the socket's connect sequence are not built yet. Feed frames " +
      "are shown as replayed (replay: true); live frames carry replay: false.",
    vectors: { ...(await receiptVectors()), ...pileVectors() },
  };
}

export const serialize = (vectors) => `${JSON.stringify(vectors, null, 2)}\n`;

// Receipt-mode mappings for tests, made through the core as provider ingestion (not built yet)
// would make them, on the object's own storage. Every value is synthetic.

import assert from "node:assert/strict";
import { hashRequest, ReceiptLedger } from "../../worker/receipts.mjs";
import { syntheticAddress } from "./synthetic-address.mjs";
import { BOLT11 } from "./values.mjs";

// The Worker settings these tests run with: a generous per-visitor budget, nothing else. Read
// settings aren't Worker configuration any more; the issuer saves them with its first mapping.
export const RECEIPT_SETTINGS = { RATE_PER_IP: "1000" };

// The reviewed read settings the test issuer saves; test values only, never defaults.
export const READ = { replayMax: 50, statusPageSize: 2, addressPageSize: 2, historyPageSize: 2, recentSize: 10, cursorTtlMs: 600_000, freshnessMs: 60_000 };
export const POLICY = { editWindow: "first-observation", messageRule: "once", pricingRecovery: "stale-candidate", confirmationPolicy: "policy-1", version: "policy-test-1" };
export const TOKEN = (n) => n.toString(16).padStart(32, "0");
const TX = (n) => n.toString(16).padStart(2, "0").repeat(32);

// The provider's side: a ledger that may issue, with the reviewed read settings it saves.
export function provider(w, read = {}) {
  let n = 0x1000;
  return new ReceiptLedger({ storage: w.ctx.storage, now: () => w.platform.now(), randomHex: () => (++n).toString(16).padStart(32, "0"),
    issuance: true, policy: POLICY, readSettings: { ...READ, ...read } });
}

export async function seed(w, ledger, { invoice = "ReceiptInv1", token = TOKEN(0xa1), owner = 4242, login = "ooga-dev", addresses = [1, 2, 3], ...meta } = {}) {
  const issued = ledger.issueInvoice({
    invoice, network: "regtest", provider: "btcpay", store: "store-a", owner, login, handle: login ?? "anon", message: "for the cave",
    messageMinSats: 1000, due: 10_000, requestHash: await hashRequest(token),
    expires: Math.floor(w.platform.now() / 1000) + 900, lightning: "available", bolt11: BOLT11, ...meta,
  });
  assert.equal(issued.error, undefined);
  for (const k of addresses) await ledger.bindAddress(invoice, syntheticAddress(k));
  return { invoice, token };
}

export function read(w, ledger, invoice, payments, { left = null, destination = null, capabilities = {} } = {}) {
  const { sequence } = ledger.beginRead(invoice, { line: "line-1", generation: "0123456789abcdef" });
  const begin = { frame: "begin", status: "Processing", left, destination, provider: "btcpay", store: "store-a",
    observedAt: w.platform.now(), provenance: "sweep", policyVersion: "policy-1",
    capabilities: { complete: false, outpoints: true, lightningSuccess: true, remaining: true, destination: false, ...capabilities } };
  const out = ledger.applySnapshot({ invoice, line: "line-1", generation: "0123456789abcdef", sequence, candidate: { cents: 10_000_000, at: 1 },
    frames: [begin, ...payments.map((payment, index) => ({ frame: "payment", index, payment })), { frame: "end", count: payments.length }] });
  for (const id of out.priced ?? []) {
    ledger.beginPricing(id);
    ledger.freezePrice(id, { cents: 10_000_000, at: w.platform.now() });
  }
  return out;
}

export const pay = (n, state = "settled", sats = 1000) => ({
  method: "onchain", providerId: `p-${n}`, sats, state, txid: TX(n), vout: 0, destination: syntheticAddress(1),
  paymentHash: null, blockHash: null, blockHeight: null, confirmations: null,
});

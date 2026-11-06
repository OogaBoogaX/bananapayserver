// Receipt accounting v1's durable core, against the object's SQLite stand-in. Every value is
// synthetic: addresses are encoded here from repeated-byte programs, with their own checksums.
// Nothing here touches the Worker's live path, which this core doesn't change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fakeStorage } from "./helpers/cloudflare.mjs";
import { canonicalAddress, hashRequest, originalBolt11Allowed, PolicyRequired, qrAmount, ReceiptLedger, verifyAddress } from "../worker/receipts.mjs";
import { MAX_SATS } from "../shared/protocol.mjs";

const LINE = "line-1";
const GEN = "0123456789abcdef";
const FRESH = 60_000;
const POLICY = { editWindow: "first-observation", messageRule: "once" };
const TX = (n) => n.toString(16).padStart(2, "0").repeat(32);
const HASH = (n) => (n + 0x80).toString(16).padStart(2, "0").repeat(32);
const PRICE = { cents: 10_000_000, at: 1_000 }; // $100,000: 1,000 sats a banana

// --- Synthetic addresses, encoded independently of the code under test --------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const GEN5 = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN5[i];
  }
  return chk >>> 0;
}
function words(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}
function segwit(hrp, version, program) {
  const data = [version, ...words(program)];
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = (polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ (version === 0 ? 1 : 0x2bc830a3)) >>> 0;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58check(version, fill) {
  const body = Buffer.from([version, ...Array(20).fill(fill)]);
  const check = createHash("sha256").update(createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([body, check]);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let text = "";
  while (value > 0n) {
    text = B58[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    text = `1${text}`;
  }
  return text;
}
const ADDR = (n) => segwit("bcrt", 0, Array(20).fill(n));

// --- Fixtures -------------------------------------------------------------------------------

const T0 = 1_790_000_000_000;

function setup({ policy = POLICY, storage = fakeStorage(), failpoint, freshnessMs = FRESH } = {}) {
  const time = { now: T0 };
  let n = 0;
  const make = (overrides = {}) => new ReceiptLedger({
    storage, now: () => time.now, randomHex: () => (++n).toString(16).padStart(32, "0"),
    policy, failpoint, freshnessMs, ...overrides,
  });
  return { ledger: make(), storage, time, make };
}

let requests = 0;
async function issue(ledger, overrides = {}) {
  const invoice = overrides.invoice ?? `INVOICE${String(++requests).padStart(4, "0")}`;
  const result = ledger.issueInvoice({
    invoice, network: "regtest", provider: "btcpay", store: "store-a", owner: 4242, login: "ooga-dev",
    handle: "ooga-dev", message: "for the cave", messageMinSats: 1000, due: 10_000,
    requestHash: await hashRequest(`request-${invoice}`), ...overrides,
  });
  assert.equal(result.error, undefined, `issued ${invoice}`);
  return invoice;
}

const CAPS = { complete: false, outpoints: true, lightningSuccess: true, remaining: true, destination: false };
const begin = ({ capabilities, ...o } = {}) => ({
  frame: "begin", status: "Processing", left: null, destination: null, provider: "btcpay", store: "store-a", observedAt: T0,
  provenance: "sweep", policyVersion: "policy-1", ...o, capabilities: { ...CAPS, ...capabilities },
});
const onchain = (o) => ({
  method: "onchain", providerId: `${o.txid ?? TX(1)}-${o.vout ?? 0}`, sats: 1000, state: "settled", txid: TX(1), vout: 0,
  destination: ADDR(1), paymentHash: null, blockHash: null, blockHeight: null, confirmations: null, ...o,
});
const lightning = (o) => ({
  method: "lightning", providerId: "ln-1", sats: 1000, state: "settled", txid: null, vout: null,
  destination: null, paymentHash: HASH(1), blockHash: null, blockHeight: null, confirmations: null, ...o,
});
const framesOf = (b, payments) => [b, ...payments.map((payment, index) => ({ frame: "payment", index, payment })), { frame: "end", count: payments.length }];

// One read, applied, then every receipt it created priced from a fresh lookup unless `skip`.
function snap(ledger, invoice, payments, { begin: b = {}, price = PRICE, candidate = PRICE } = {}) {
  const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.ok(read, "read began");
  const outcome = ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: framesOf(begin({ observedAt: ledger.now(), ...b }), payments), candidate });
  if (price !== "skip") {
    for (const id of outcome.priced ?? []) {
      assert.ok(ledger.beginPricing(id));
      ledger.freezePrice(id, price);
    }
  }
  return outcome;
}

const receipts = (ledger, invoice) => ledger.rows("SELECT * FROM ra_receipts WHERE invoice = ? ORDER BY ord", invoice);
const count = (ledger, table) => ledger.row(`SELECT count(*) AS n FROM ${table}`).n;
const ledgerNet = (ledger, receipt) => ledger.row("SELECT coalesce(sum(sats), 0) AS s FROM ra_ledger WHERE receipt = ?", receipt).s;
const feed = (ledger) => ledger.feedAfter(0, { limit: 10_000 }).frames;
const STATUS = { receiptLimit: 2, addressLimit: 2, ttlMs: 60_000 };
const pick = ({ received, credited, review, left, state }) => ({ received, credited, review, left, state });

// --- Schema, issuance and ownership ---------------------------------------------------------

test("the schema lives in its own tables, migrates once and survives a restart", () => {
  const { storage, make } = setup();
  make();
  assert.equal(storage.sql.exec("SELECT value FROM meta WHERE key = 'receipt_schema'").one().value, 1);
  assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'pending' OR name = 'donations'").one().n, 0);
  make();
});

test("issuance saves a permanent receipt-mode record; legacy and reused ids are fenced", async () => {
  const { ledger } = setup();
  ledger.fenceLegacyInvoice("LEGACY0001", "donations");
  assert.equal(ledger.modeOf("LEGACY0001"), "legacy");
  const base = { network: "regtest", provider: "btcpay", store: "store-a", handle: "x", messageMinSats: 1000, due: 100 };
  assert.equal(ledger.issueInvoice({ ...base, invoice: "LEGACY0001", requestHash: await hashRequest("legacy") }).error, "fenced");
  const invoice = await issue(ledger);
  assert.equal(ledger.issueInvoice({ ...base, invoice, requestHash: await hashRequest("other") }).error, "fenced");
  assert.throws(() => ledger.fenceLegacyInvoice(invoice, "pending"));
  assert.equal(ledger.legacyPaidAllowed(invoice), false);
  assert.equal(ledger.legacyPaidAllowed("LEGACY0001"), true);
  assert.equal(ledger.issueInvoice({ ...base, invoice: "SMALLMSG01", message: "hi", due: 999, requestHash: await hashRequest("small") }).error, "message");
});

test("owner and login are validated together at the boundary", async () => {
  const { ledger } = setup();
  const base = { invoice: "OWNERTEST1", network: "regtest", provider: "btcpay", store: "store-a", handle: "x", messageMinSats: 1000, due: 100, requestHash: await hashRequest("owner") };
  for (const bad of [
    { owner: 0, login: "ooga-dev" }, { owner: -1, login: "ooga-dev" }, { owner: 1.5, login: "ooga-dev" },
    { owner: Number.MAX_SAFE_INTEGER + 1, login: "ooga-dev" }, { owner: "4242", login: "ooga-dev" },
    { owner: null, login: "ooga-dev" }, { owner: 4242, login: null }, { owner: 4242, login: "-bad" },
    { owner: 4242, login: "x".repeat(40) }, { owner: 4242, login: "has space" },
  ]) {
    assert.equal(ledger.issueInvoice({ ...base, ...bad }).error, "invalid", JSON.stringify(bad));
  }
  assert.equal(count(ledger, "ra_invoices"), 0);
  assert.equal(ledger.issueInvoice({ ...base, owner: null, login: null }).invoice, "OWNERTEST1");
});

test("ownership is the authenticated stable id, never the handle or whoever is signed in now", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  const hash = await hashRequest(`request-${invoice}`);
  assert.equal(ledger.updateNote(hash, { handle: "someone-else" }).ok, true);
  assert.equal(ledger.row("SELECT owner FROM ra_invoices WHERE invoice = ?", invoice).owner, 4242);
  assert.equal(ledger.canRead(invoice, { donorId: 4242 }), true);
  assert.equal(ledger.canRead(invoice, { donorId: 9999 }), false);
  assert.equal(ledger.canRead(invoice, { donorId: 0 }), false);
  assert.equal(ledger.canRead(invoice, { requestHash: hash }), true);
  assert.equal(ledger.canRead(invoice, { requestHash: "0".repeat(64) }), false);
  const guest = await issue(ledger, { owner: null, login: null, handle: "ooga-dev" });
  assert.equal(ledger.canRead(guest, { donorId: 4242 }), false);
  await ledger.bindAddress(guest, ADDR(50));
  snap(ledger, guest, [onchain({ txid: TX(50), destination: ADDR(50) })]);
  assert.equal(ledger.publicReceipt(receipts(ledger, guest)[0].id).verified, false, "a typed matching handle earns nothing");
  await ledger.bindAddress(invoice, ADDR(51));
  ledger.updateNote(hash, { handle: "Ooga-Dev" });
  snap(ledger, invoice, [onchain({ txid: TX(51), destination: ADDR(51) })]);
  assert.equal(ledger.publicReceipt(receipts(ledger, invoice)[0].id).verified, true);
});

// --- Addresses ------------------------------------------------------------------------------

test("addresses are fully validated for the network and bound in canonical form", async () => {
  const { ledger } = setup();
  const a = await issue(ledger);
  const b = await issue(ledger);
  const lower = ADDR(7);
  assert.deepEqual(await ledger.bindAddress(a, lower.toUpperCase()), { ok: true, address: lower });
  assert.equal((await ledger.bindAddress(b, lower)).error, "conflict", "another spelling can't slip past ownership");
  assert.equal((await ledger.bindAddress(b, lower.toUpperCase())).error, "conflict");
  const mixed = lower.slice(0, 10).toUpperCase() + lower.slice(10);
  const corrupt = lower.slice(0, -1) + (lower.at(-1) === "q" ? "p" : "q");
  for (const bad of [mixed, corrupt, segwit("bc", 0, Array(20).fill(7)), segwit("tb", 0, Array(20).fill(7)),
    segwit("bcrt", 0, Array(25).fill(7)), base58check(0x00, 9), "not an address", ""]) {
    assert.equal((await ledger.bindAddress(b, bad)).error, "invalid", bad);
  }
  // A version-1 program needs bech32m: a bech32 checksum for it is refused.
  const taproot = segwit("bcrt", 1, Array(32).fill(3));
  assert.equal(await verifyAddress(taproot, "regtest"), taproot);
  const wrongConstant = (() => {
    const data = [1, ...words(Array(32).fill(3))];
    const hrp = "bcrt";
    const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
    const mod = (polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1) >>> 0;
    return `${hrp}1${[...data, ...[0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31)].map((d) => CHARSET[d]).join("")}`;
  })();
  assert.equal(await verifyAddress(wrongConstant, "regtest"), null);
  // Base58 keeps its case, and its checksum and version are checked.
  const legacy = base58check(0x6f, 9);
  assert.deepEqual(await ledger.bindAddress(b, legacy), { ok: true, address: legacy });
  assert.equal(await verifyAddress(legacy.slice(0, -1) + (legacy.at(-1) === "z" ? "y" : "z"), "regtest"), null);
  assert.equal(await verifyAddress(base58check(0xc4, 9), "regtest"), base58check(0xc4, 9));
  assert.equal(await verifyAddress(base58check(0x05, 9), "regtest"), null);
  assert.equal(await verifyAddress(base58check(0x05, 9), "mainnet"), base58check(0x05, 9));
  // BIP 173's own uppercase test vector, for mainnet.
  assert.equal(canonicalAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "mainnet"), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  assert.equal(canonicalAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "regtest"), null);
});

test("a conflicting binding fails closed and flags both invoices", async () => {
  const { ledger } = setup();
  const a = await issue(ledger);
  const b = await issue(ledger);
  assert.equal((await ledger.bindAddress(a, ADDR(1))).ok, true);
  assert.equal((await ledger.bindAddress(a, ADDR(1))).ok, true);
  assert.equal((await ledger.bindAddress(b, ADDR(1))).error, "conflict");
  assert.equal(ledger.row("SELECT invoice FROM ra_addresses WHERE address = ?", ADDR(1)).invoice, a);
  assert.equal(ledger.totals(a).state, "review");
  assert.equal(ledger.totals(b).state, "review");
  assert.equal((await ledger.bindAddress("NOSUCHINV1", ADDR(2))).error, "invalid");
});

test("snapshot destinations are canonicalized; malformed ones reject the snapshot", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ destination: ADDR(1).toUpperCase() })]);
  assert.deepEqual(ledger.holds(receipts(ledger, invoice)[0].id), []);
  assert.equal(receipts(ledger, invoice)[0].state, "credited");
  const mixed = ADDR(1).slice(0, 8).toUpperCase() + ADDR(1).slice(8);
  const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.equal(ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, candidate: PRICE,
    frames: framesOf(begin(), [onchain({ txid: TX(2), destination: mixed })]) }).result, "rejected");
  assert.equal(receipts(ledger, invoice).length, 1);
});

// --- Amounts --------------------------------------------------------------------------------

test("actual amounts: partial, split, excess, late and repeat receipts each count once", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const pay = (n, sats) => onchain({ txid: TX(n), sats, providerId: `p-${n}` });
  snap(ledger, invoice, [pay(1, 3000)], { begin: { left: 7100 } });
  assert.deepEqual(pick(ledger.totals(invoice)), { received: 3000, credited: 3000, review: 0, left: 7100, state: "partial" });
  snap(ledger, invoice, [pay(1, 3000), pay(2, 4000)], { begin: { left: 3200 } });
  assert.equal(ledger.totals(invoice).state, "partial", "a confirmed split short of the total is never paid");
  snap(ledger, invoice, [pay(1, 3000), pay(2, 4000), pay(3, 5000)], { begin: { left: 0 } });
  assert.deepEqual(pick(ledger.totals(invoice)), { received: 12_000, credited: 12_000, review: 0, left: 0, state: "paid" });
  snap(ledger, invoice, [pay(1, 3000), pay(2, 4000), pay(3, 5000), pay(4, 2500), pay(5, 2500)], { begin: { left: 0, status: "Expired" } });
  assert.deepEqual(pick(ledger.totals(invoice)), { received: 17_000, credited: 17_000, review: 0, left: 0, state: "paid" });
  const before = count(ledger, "ra_ledger");
  snap(ledger, invoice, [pay(1, 3000), pay(2, 4000), pay(3, 5000), pay(4, 2500), pay(5, 2500)], { begin: { left: 0 } });
  assert.equal(count(ledger, "ra_ledger"), before);
  assert.equal(receipts(ledger, invoice).length, 5);
  assert.deepEqual(ledger.pileDelta(), { sats: 17_000, milli: 17_000 });
});

test("a tiny receipt counts; the message threshold limits only the message", async () => {
  for (const [rule, expected] of [["once", ["", "for the cave", ""]], ["each-qualifying", ["", "for the cave", "for the cave"]]]) {
    const { ledger } = setup({ policy: { editWindow: "first-observation", messageRule: rule } });
    const invoice = await issue(ledger);
    await ledger.bindAddress(invoice, ADDR(1));
    const pays = [onchain({ txid: TX(1), sats: 1, providerId: "a" }), onchain({ txid: TX(2), sats: 1500, providerId: "b" }), onchain({ txid: TX(3), sats: 2000, providerId: "c" })];
    snap(ledger, invoice, pays.slice(0, 1));
    snap(ledger, invoice, pays.slice(0, 2));
    snap(ledger, invoice, pays);
    const all = receipts(ledger, invoice).map((r) => ledger.publicReceipt(r.id));
    assert.deepEqual(all.map((r) => r.credit), [1, 1500, 2000]);
    assert.deepEqual(all.map((r) => r.message), expected, `rule ${rule}`);
    assert.equal(ledger.totals(invoice).credited, 3501);
  }
});

test("Lightning and on-chain receipts on one invoice add up without double counting", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const pays = [lightning({ sats: 4000 }), onchain({ sats: 6000 })];
  snap(ledger, invoice, pays, { begin: { left: 0 } });
  snap(ledger, invoice, pays, { begin: { left: 0 } });
  assert.deepEqual(receipts(ledger, invoice).map((r) => r.method), ["lightning", "onchain"]);
  assert.deepEqual(pick(ledger.totals(invoice)), { received: 10_000, credited: 10_000, review: 0, left: 0, state: "paid" });
});

test("totals refuse amounts beyond the safe range rather than round them", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const huge = [1, 2, 3, 4, 5].map((n) => onchain({ txid: TX(n), providerId: `h${n}`, sats: MAX_SATS }));
  const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.throws(() => ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: framesOf(begin(), huge), candidate: PRICE }), RangeError);
  assert.equal(count(ledger, "ra_receipts"), 0, "nothing half-applied");
  const over = onchain({ sats: MAX_SATS + 1 });
  assert.equal(ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: framesOf(begin(), [over]), candidate: PRICE }).result, "rejected");
});

// --- Identity -------------------------------------------------------------------------------

test("Lightning success needs a verified identity; fragments sharing it are one payment", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  snap(ledger, invoice, [lightning({ providerId: "part-1" })]);
  snap(ledger, invoice, [lightning({ providerId: "part-2" })]);
  assert.equal(receipts(ledger, invoice).length, 1);
  assert.equal(ledger.totals(invoice).credited, 1000);
  const unverified = await issue(ledger);
  snap(ledger, unverified, [lightning({ providerId: "frag-1", paymentHash: HASH(2) }), lightning({ providerId: "frag-2", paymentHash: HASH(2) })], { begin: { capabilities: { lightningSuccess: false } } });
  assert.deepEqual(receipts(ledger, unverified).map((r) => [r.state, ledger.holds(r.id), r.credit]),
    [["review", ["identity-unverified"], 0], ["review", ["identity-unverified"], 0]]);
  const hashless = await issue(ledger);
  snap(ledger, hashless, [lightning({ paymentHash: null })]);
  assert.deepEqual(ledger.holds(receipts(ledger, hashless)[0].id), ["identity-unverified"]);
});

test("on-chain identity needs verified outpoints; an unbound destination is held", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ providerId: "no-outpoint", txid: null, vout: null })]);
  snap(ledger, invoice, [onchain({ txid: TX(9) })], { begin: { capabilities: { outpoints: false } } });
  snap(ledger, invoice, [onchain({ txid: TX(8), destination: ADDR(99) })]);
  assert.deepEqual(receipts(ledger, invoice).map((r) => ledger.holds(r.id)), [["identity-unverified"], ["identity-unverified"], ["destination-unbound"]]);
  assert.equal(ledger.totals(invoice).credited, 0);
});

test("a known payment's identity is immutable: every changed field is held, never applied", async () => {
  const cases = [
    ["identity-changed", (p) => ({ ...p, txid: TX(2) })],
    ["identity-changed", (p) => ({ ...p, vout: 3 })],
    ["identity-changed", (p) => lightning({ providerId: p.providerId, paymentHash: HASH(9), sats: p.sats })],
    ["amount-changed", (p) => ({ ...p, sats: p.sats + 1 })],
    ["destination-changed", (p) => ({ ...p, destination: ADDR(2) })],
  ];
  for (const [reason, change] of cases) {
    const { ledger } = setup();
    const invoice = await issue(ledger);
    await ledger.bindAddress(invoice, ADDR(1));
    await ledger.bindAddress(invoice, ADDR(2));
    const original = onchain({ providerId: "alias-1", sats: 2000 });
    snap(ledger, invoice, [original]);
    const [{ id }] = receipts(ledger, invoice);
    const changed = { ...change(original), state: "invalid" };
    assert.doesNotThrow(() => snap(ledger, invoice, [changed]));
    const [r] = receipts(ledger, invoice);
    assert.deepEqual(ledger.holds(id), [reason], reason);
    assert.equal(receipts(ledger, invoice).length, 1);
    assert.deepEqual([r.txid, r.vout, r.destination, r.sats, r.method, r.provider_state], [TX(1), 0, ADDR(1), 2000, "onchain", "settled"]);
    assert.equal(count(ledger, "ra_outputs") + count(ledger, "ra_lightning"), 1, "no second canonical identity");
    assert.deepEqual(ledger.rows("SELECT provider_state, applied FROM ra_evidence WHERE receipt = ? ORDER BY sequence", id).map((e) => ({ ...e })),
      [{ provider_state: "settled", applied: 1 }, { provider_state: "invalid", applied: 0 }]);
    assert.equal(r.state, "review");
    assert.equal(ledger.totals(invoice).credited, 2000, "held, not silently reversed");
  }
});

test("verified evidence attaches to an unverified receipt once, with its fences", async () => {
  const { ledger } = setup();
  ledger.fenceImportedTransaction("regtest", TX(4), "import record");
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const caps = { capabilities: { outpoints: false } };
  snap(ledger, invoice, [onchain({ providerId: "plain", txid: TX(3) }), onchain({ providerId: "fenced", txid: TX(4) })], { begin: caps });
  assert.equal(ledger.totals(invoice).credited, 0);
  snap(ledger, invoice, [onchain({ providerId: "plain", txid: TX(3) }), onchain({ providerId: "fenced", txid: TX(4) })]);
  const [plain, fenced] = receipts(ledger, invoice);
  assert.deepEqual([ledger.holds(plain.id), plain.state], [[], "credited"]);
  assert.deepEqual(ledger.holds(fenced.id), ["import-fence"]);
  assert.equal(ledger.totals(invoice).credited, 1000);
  assert.equal(count(ledger, "ra_outputs"), 2);
});

test("one output is credited once, whichever provider, store or invoice claims it", async () => {
  const { ledger } = setup();
  const a = await issue(ledger);
  const b = await issue(ledger, { provider: "other-provider", store: "store-b" });
  await ledger.bindAddress(a, ADDR(1));
  await ledger.bindAddress(b, ADDR(2));
  snap(ledger, a, [onchain({ txid: TX(7), destination: ADDR(1) })]);
  const read = ledger.beginRead(b, { line: LINE, generation: GEN });
  assert.equal(ledger.applySnapshot({ invoice: b, line: LINE, generation: GEN, sequence: read.sequence, candidate: PRICE,
    frames: framesOf(begin({ provider: "other-provider", store: "store-b" }), [onchain({ txid: TX(7), destination: ADDR(2), providerId: "elsewhere" })]) }).result, "applied");
  assert.equal(receipts(ledger, b).length, 0);
  assert.equal(ledger.totals(b).state, "review");
  assert.deepEqual(ledger.holds(receipts(ledger, a)[0].id), ["claimed-by-other-invoice"]);
  assert.equal(ledger.totals(a).credited, 1000);
  assert.deepEqual(ledger.pileDelta(), { sats: 1000, milli: 1000 });
  const c = await issue(ledger);
  snap(ledger, c, [onchain({ txid: TX(6), destination: ADDR(1), providerId: `${TX(7)}-0` })]);
  assert.equal(receipts(ledger, c).length, 0, "the same provider alias for another invoice fails closed");
  assert.equal(ledger.totals(c).state, "review");
});

test("an alias and a canonical identity that disagree hold both, without throwing", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ providerId: "x", txid: TX(1) }), onchain({ providerId: "y", txid: TX(2) })]);
  assert.doesNotThrow(() => snap(ledger, invoice, [onchain({ providerId: "x", txid: TX(2) })]));
  assert.deepEqual(receipts(ledger, invoice).map((r) => ledger.holds(r.id)), [["identity-conflict"], ["identity-conflict"]]);
  assert.equal(ledger.releaseHold(receipts(ledger, invoice)[0].id, "identity-conflict", "looked").error, "unreleasable");
});

// --- Snapshot validation --------------------------------------------------------------------

test("a snapshot's duplicates collapse when identical and quarantine it when they disagree, in any order", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const p = onchain({ providerId: "dup" });
  snap(ledger, invoice, [p, p]);
  assert.equal(receipts(ledger, invoice).length, 1);
  snap(ledger, invoice, [onchain({ txid: TX(2), providerId: "alias-a" }), onchain({ txid: TX(2), providerId: "alias-b" })]);
  assert.equal(receipts(ledger, invoice).length, 2, "two aliases of one output are one receipt");
  assert.equal(ledger.row("SELECT count(*) AS n FROM ra_aliases WHERE receipt = ?", receipts(ledger, invoice)[1].id).n, 2);
  const conflicts = [
    [onchain({ txid: TX(3), providerId: "c" }), onchain({ txid: TX(3), providerId: "c", state: "invalid" })],
    [onchain({ txid: TX(3), providerId: "c" }), onchain({ txid: TX(3), providerId: "d", sats: 999 })],
    [onchain({ txid: TX(3), providerId: "c" }), onchain({ txid: TX(3), providerId: "d", confirmations: 4 })],
  ];
  for (const pair of conflicts) {
    for (const ordered of [pair, [...pair].reverse()]) {
      const before = [count(ledger, "ra_receipts"), count(ledger, "ra_evidence"), count(ledger, "ra_feed"), count(ledger, "ra_ledger")];
      const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
      assert.equal(ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: framesOf(begin(), ordered), candidate: PRICE }).result, "rejected");
      assert.deepEqual([count(ledger, "ra_receipts"), count(ledger, "ra_evidence"), count(ledger, "ra_ledger")], [before[0], before[1], before[3]]);
      assert.equal(ledger.totals(invoice).state, "review");
    }
  }
  assert.equal(ledger.row("SELECT reason FROM ra_reviews WHERE invoice = ? AND resolved_at IS NULL", invoice).reason, "snapshot-conflict");
});

test("absence counts only in a verified complete snapshot", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({})]);
  snap(ledger, invoice, []);
  assert.equal(receipts(ledger, invoice)[0].state, "credited", "an unverified snapshot proves nothing by omission");
  snap(ledger, invoice, [], { begin: { capabilities: { complete: true } } });
  assert.deepEqual(ledger.holds(receipts(ledger, invoice)[0].id), ["missing-from-complete-snapshot"]);
  assert.equal(ledger.totals(invoice).credited, 1000);
});

test("reads are sequenced, serialized and fenced by line and generation", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const frames = framesOf(begin(), [onchain({})]);
  const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.equal(ledger.beginRead(invoice, { line: LINE, generation: GEN }), null, "one read at a time");
  const apply = (o) => ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames, candidate: PRICE, ...o });
  assert.equal(apply({ line: "line-2" }).result, "stale");
  assert.equal(apply({ generation: "fedcba9876543210" }).result, "stale");
  assert.equal(apply({ sequence: read.sequence + 1 }).result, "stale");
  assert.equal(count(ledger, "ra_receipts"), 0);
  assert.equal(apply().result, "applied");
  assert.equal(apply().result, "stale", "a duplicate reply");
  const old = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  ledger.abandonReads();
  const fresh = ledger.beginRead(invoice, { line: "line-3", generation: "1111111111111111" });
  assert.ok(fresh.sequence > old.sequence);
  assert.equal(ledger.applySnapshot({ invoice, line: "line-3", generation: "1111111111111111", sequence: old.sequence, frames, candidate: PRICE }).result, "stale");
  assert.equal(ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: old.sequence, frames, candidate: PRICE }).result, "stale");
  assert.throws(() => ledger.beginRead(invoice, { line: LINE, generation: "short" }));
});

test("incomplete or malformed snapshots change nothing", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const payment = { frame: "payment", index: 0, payment: onchain({}) };
  const cases = [
    ["incomplete", [begin(), payment]],
    ["incomplete", [begin(), payment, { frame: "end", count: 2 }]],
    ["incomplete", [begin(), { ...payment, index: 1 }, { frame: "end", count: 1 }]],
    ["incomplete", [payment, { frame: "end", count: 1 }]],
    ["rejected", [begin({ provider: "someone-else" }), payment, { frame: "end", count: 1 }]],
    ["rejected", [begin(), { ...payment, payment: { ...onchain({}), sats: 0 } }, { frame: "end", count: 1 }]],
    ["rejected", [begin(), { ...payment, payment: { ...onchain({}), extra: 1 } }, { frame: "end", count: 1 }]],
    ["rejected", [{ ...begin(), capabilities: { ...CAPS, complete: "yes" } }, payment, { frame: "end", count: 1 }]],
    ["rejected", [{ ...begin(), capabilities: { complete: false } }, payment, { frame: "end", count: 1 }]],
    ["rejected", [begin({ destination: segwit("bc", 0, Array(20).fill(1)) }), payment, { frame: "end", count: 1 }]],
    ["rejected", [begin({ left: -1 }), payment, { frame: "end", count: 1 }]],
  ];
  for (const [result, frames] of cases) {
    const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
    assert.equal(ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames, candidate: PRICE }).result, result);
    assert.equal(count(ledger, "ra_receipts"), 0);
  }
  assert.equal(ledger.row("SELECT applied_sequence FROM ra_invoices").applied_sequence, 0);
});

// --- Holds and fences -----------------------------------------------------------------------

test("holds accumulate; resolving one never credits while another remains", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  await ledger.bindAddress(invoice, ADDR(2));
  // Unverified identity, then a changed amount on the same alias.
  snap(ledger, invoice, [onchain({ providerId: "u", txid: TX(1) })], { begin: { capabilities: { outpoints: false } } });
  const [{ id }] = receipts(ledger, invoice);
  snap(ledger, invoice, [onchain({ providerId: "u", txid: TX(1), sats: 1001 })], { begin: { capabilities: { outpoints: false } } });
  assert.deepEqual(ledger.holds(id), ["identity-unverified", "amount-changed"]);
  assert.equal(ledger.releaseHold(id, "identity-unverified", "trust me").error, "unreleasable");
  assert.deepEqual(ledger.releaseHold(id, "amount-changed", "reviewed").holds, ["identity-unverified"]);
  assert.equal(receipts(ledger, invoice)[0].state, "review");
  assert.equal(ledger.totals(invoice).credited, 0);
  assert.equal(ledger.releaseHold(id, "amount-changed", "again").error, "not held");
});

test("an import fence outlives every other resolution and can't be released by hand", async () => {
  const { ledger } = setup();
  ledger.fenceImportedTransaction("regtest", TX(3), "import record 1");
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  await ledger.bindAddress(invoice, ADDR(2));
  snap(ledger, invoice, [onchain({ providerId: "f", txid: TX(3) })]);
  const [{ id }] = receipts(ledger, invoice);
  snap(ledger, invoice, [onchain({ providerId: "f", txid: TX(3), destination: ADDR(2) })]);
  assert.deepEqual(ledger.holds(id), ["import-fence", "destination-changed"]);
  assert.equal(ledger.releaseHold(id, "destination-changed", "reviewed").ok, true);
  assert.equal(ledger.releaseHold(id, "import-fence", "reviewed").error, "unreleasable");
  assert.deepEqual([receipts(ledger, invoice)[0].state, ledger.totals(invoice).credited], ["review", 0]);
});

test("mapping an imported transaction never re-credits funds a legacy import already counted", async () => {
  const { ledger } = setup();
  // A historical manual import: its legacy row is fenced, and so is its transaction.
  ledger.fenceLegacyInvoice("IMPORTED01", "donations");
  ledger.fenceImportedTransaction("regtest", TX(5), "manual import IMPORTED01");
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ txid: TX(5), vout: 0 }), onchain({ txid: TX(5), vout: 1, providerId: "second-output" })]);
  assert.throws(() => ledger.mapImportedTransaction("regtest", TX(5), invoice, ""));
  assert.equal(ledger.mapImportedTransaction("regtest", TX(5), invoice, "reviewed against the import record").ok, true);
  assert.equal(ledger.mapImportedTransaction("regtest", TX(5), invoice, "again").error, "invalid");
  snap(ledger, invoice, [onchain({ txid: TX(5), vout: 0 }), onchain({ txid: TX(5), vout: 1, providerId: "second-output" })]);
  assert.deepEqual(receipts(ledger, invoice).map((r) => [r.state, ledger.holds(r.id)]), [["review", ["import-fence"]], ["review", ["import-fence"]]]);
  assert.equal(ledger.totals(invoice).credited, 0);
  assert.deepEqual(ledger.pileDelta(), { sats: 0, milli: 0 });
  assert.equal(count(ledger, "ra_ledger"), 0);
});

// --- State changes --------------------------------------------------------------------------

test("a regression to observed or unaccounted goes to review and keeps, never repeats, the credit", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ sats: 2000 })]);
  const [{ id, first_credited_seq: first }] = receipts(ledger, invoice);
  snap(ledger, invoice, [onchain({ sats: 2000, state: "observed" })]);
  assert.deepEqual(pick(ledger.totals(invoice)), { received: 2000, credited: 2000, review: 2000, left: null, state: "review" });
  assert.equal(ledger.health(), "review");
  snap(ledger, invoice, [onchain({ sats: 2000, state: "settled" })]);
  assert.equal(receipts(ledger, invoice)[0].state, "credited");
  snap(ledger, invoice, [onchain({ sats: 2000, state: "unaccounted" })]);
  assert.equal(receipts(ledger, invoice)[0].state, "review");
  snap(ledger, invoice, [onchain({ sats: 2000 })]);
  assert.equal(ledgerNet(ledger, id), 2000);
  assert.equal(count(ledger, "ra_ledger"), 1);
  assert.equal(receipts(ledger, invoice)[0].first_credited_seq, first);
});

test("invalid after credit is reviewed, reversed by an entry, and reconfirmed at most once", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ sats: 5000 })], { begin: { left: 0 } });
  const [{ id, first_credited_seq: first }] = receipts(ledger, invoice);
  assert.equal(ledger.reverse(id, "not under review").error, "not reversible");
  snap(ledger, invoice, [onchain({ sats: 5000, state: "invalid" })]);
  assert.equal(receipts(ledger, invoice)[0].state, "review");
  assert.equal(ledger.totals(invoice).credited, 5000, "no reversal is implied before one is recorded");
  assert.throws(() => ledger.reverse(id, ""));
  assert.equal(ledger.reverse(id, "double spend confirmed").ok, true);
  assert.equal(ledger.reverse(id, "again").error, "not reversible");
  assert.deepEqual(pick(ledger.totals(invoice)), { received: 0, credited: 0, review: 0, left: null, state: "unpaid" });
  assert.deepEqual(ledger.pileDelta(), { sats: 0, milli: 0 });
  snap(ledger, invoice, [onchain({ sats: 5000, state: "invalid" })]);
  assert.equal(receipts(ledger, invoice)[0].state, "reversed");
  snap(ledger, invoice, [onchain({ sats: 5000, state: "settled" })]);
  snap(ledger, invoice, [onchain({ sats: 5000, state: "settled" })]);
  assert.equal(ledgerNet(ledger, id), 5000);
  assert.deepEqual(ledger.rows("SELECT kind FROM ra_ledger WHERE receipt = ? ORDER BY seq", id).map((r) => r.kind), ["credit", "reversal", "credit"]);
  assert.equal(receipts(ledger, invoice)[0].first_credited_seq, first);
  assert.equal(receipts(ledger, invoice)[0].price_cents, PRICE.cents);
});

// --- Pricing --------------------------------------------------------------------------------

test("pricing intent is durable before the lookup; a restart never samples again", async () => {
  const { ledger, make } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const out = snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b" })], { price: "skip", candidate: { cents: 9_000_000, at: 500 } });
  const [first, second] = out.priced;
  assert.deepEqual(receipts(ledger, invoice).map((r) => [r.price_state, r.candidate_cents, r.state]), [["intent", 9_000_000, "confirming"], ["intent", 9_000_000, "confirming"]]);
  assert.equal(ledger.publicReceipt(first).pricing, null, "unresolved pricing is null");
  assert.equal(ledger.beginPricing(first), true);
  assert.equal(ledger.beginPricing(first), false, "one lookup per receipt, even concurrently");
  const restarted = make();
  assert.equal(restarted.beginPricing(first), false);
  assert.equal(restarted.beginPricing(second), false);
  assert.throws(() => restarted.freezePrice(first, PRICE));
  assert.deepEqual(restarted.interruptedPricing(), [first, second]);
  assert.throws(() => restarted.recoverPricing(first), PolicyRequired);
  restarted.recoverPricing(first, "stale-candidate");
  restarted.recoverPricing(second, "review");
  const [a, b] = receipts(restarted, invoice);
  assert.deepEqual([a.price_cents, a.price_stale, a.state], [9_000_000, 1, "credited"]);
  assert.deepEqual([b.price_state, restarted.holds(b.id), b.state], ["intent", ["pricing-interrupted"], "review"]);
  ledger.freezePrice(first, PRICE);
  assert.equal(receipts(restarted, invoice)[0].price_cents, 9_000_000, "the late answer can't overwrite the recovery");
});

test("a crash after the lookup but before the freeze commits can't lead to a second sample", async () => {
  let armed = false;
  const { ledger } = setup({ failpoint: (name) => {
    if (armed && name === "price:frozen") throw new Error("crash");
  } });
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  const [id] = snap(ledger, invoice, [onchain({})], { price: "skip" }).priced;
  assert.ok(ledger.beginPricing(id));
  armed = true;
  assert.throws(() => ledger.freezePrice(id, PRICE), /crash/);
  armed = false;
  assert.equal(ledger.beginPricing(id), false);
  assert.throws(() => ledger.freezePrice(id, PRICE));
  assert.deepEqual(ledger.interruptedPricing(), [id]);
  ledger.recoverPricing(id, "stale-candidate");
  assert.deepEqual([receipts(ledger, invoice)[0].price_stale, ledger.totals(invoice).credited], [1, 1000]);
});

test("every price freeze is a new public revision, even when the state stays", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  // A receipt still confirming, and one held: both get a pricing revision without credit.
  const [confirming, held] = snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "c", state: "observed" }), onchain({ txid: TX(2), providerId: "h", destination: ADDR(9) })], { price: "skip" }).priced;
  for (const id of [confirming, held]) {
    const before = ledger.publicReceipt(id);
    assert.equal(before.pricing, null);
    assert.ok(ledger.beginPricing(id));
    ledger.freezePrice(id, PRICE);
    const after = ledger.publicReceipt(id);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.state, before.state);
    assert.deepEqual([after.pricing.bananas.exact, after.firstCreditedSeq, after.credit], [1, null, 0]);
  }
  const frames = feed(ledger).filter((f) => f.type === "receipt" && f.receipt.id === confirming);
  assert.deepEqual(frames.map((f) => [f.receipt.state, f.receipt.pricing === null]), [["confirming", true], ["confirming", false]]);
  // Settling it later credits at the frozen price, and only then sets its first credit.
  snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "c" })]);
  const credited = ledger.publicReceipt(confirming);
  assert.equal(credited.state, "credited");
  const last = feed(ledger).filter((f) => f.type === "receipt" && f.receipt.id === confirming).at(-1);
  assert.equal(credited.firstCreditedSeq, last.seq);
});

test("a failed lookup freezes the stored candidate as stale, or an explicit no-price", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" })], { price: null, candidate: { cents: 9_000_000, at: 500 } });
  snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b", sats: 3000 })], { price: null, candidate: null });
  const [a, b] = receipts(ledger, invoice).map((r) => ledger.publicReceipt(r.id));
  assert.equal(a.pricing.rate.stale, true);
  assert.equal(a.pricing.bananas.exact, 0.9);
  assert.deepEqual([b.pricing.rate, b.pricing.bananas, b.credit], [null, null, 3000]);
  assert.equal(ledger.totals(invoice).credited, 4000);
});

// --- Policy and attribution -----------------------------------------------------------------

test("unsettled policy and configuration are never defaulted", async () => {
  const { ledger } = setup({ policy: {} });
  const invoice = await issue(ledger);
  const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.throws(() => ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: framesOf(begin(), []) }), PolicyRequired);
  assert.equal(ledger.row("SELECT status FROM ra_reads").status, "outstanding");
  const unbounded = setup({ freshnessMs: null }).ledger;
  assert.throws(() => unbounded.health(), PolicyRequired);
  assert.throws(() => ledger.feedAfter(0, {}), PolicyRequired);
  assert.throws(() => ledger.privateStatus(invoice, { donorId: 4242 }), PolicyRequired);
  assert.throws(() => ledger.recoverPricing("r1", "guess"), PolicyRequired);
});

test("a missing or invalid message rule refuses every crediting operation, atomically", async () => {
  for (const messageRule of [undefined, "first-only", ""]) {
    const { ledger, make } = setup();
    const invoice = await issue(ledger);
    await ledger.bindAddress(invoice, ADDR(1));
    const [id] = snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" })], { price: "skip" }).priced;
    snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b", sats: 1001 })]);
    snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b", sats: 1002 })]);
    const heldId = receipts(ledger, invoice)[1].id;
    const tables = ["ra_receipts", "ra_ledger", "ra_feed", "ra_outbox", "ra_evidence", "ra_holds", "ra_reads"];
    const state = () => [tables.map((t) => count(ledger, t)), receipts(ledger, invoice).map((r) => ({ ...r }))];
    const before = state();
    // A valid edit window, so only the message rule is missing.
    const unruled = make({ policy: { editWindow: "first-observation", messageRule } });
    const read = unruled.beginRead(invoice, { line: LINE, generation: GEN });
    const afterRead = state();
    assert.throws(() => unruled.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence,
      frames: framesOf(begin(), [onchain({ txid: TX(1), providerId: "a" })]), candidate: PRICE }), PolicyRequired);
    assert.deepEqual(state(), afterRead, "nothing applied");
    assert.equal(unruled.row("SELECT status FROM ra_reads WHERE sequence = ?", read.sequence).status, "outstanding");
    assert.throws(() => unruled.recoverPricing(id, "stale-candidate"), PolicyRequired);
    assert.throws(() => unruled.releaseHold(heldId, "amount-changed", "reviewed"), PolicyRequired);
    assert.deepEqual(state()[1], before[1], "no credit, attribution or evidence lost");
    assert.equal(receipts(ledger, invoice)[0].price_state, "intent", "the intent survives for a properly configured recovery");
    // A lookup already in flight isn't consumed by a refused freeze.
    const ruled = make();
    ruled.abandonReads();
    const [fresh] = snap(ruled, invoice, [onchain({ txid: TX(3), providerId: "c" })], { price: "skip" }).priced;
    assert.ok(ruled.beginPricing(fresh));
    ruled.policy.messageRule = null;
    assert.throws(() => ruled.freezePrice(fresh, PRICE), PolicyRequired);
    ruled.policy.messageRule = "once";
    ruled.freezePrice(fresh, PRICE);
    assert.equal(receipts(ruled, invoice).find((r) => r.id === fresh).state, "credited");
  }
});

test("the settlement window locks attribution at the settled observation, before any lookup", async () => {
  const { ledger } = setup({ policy: { editWindow: "settlement", messageRule: "once" } });
  const invoice = await issue(ledger);
  const hash = await hashRequest(`request-${invoice}`);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ state: "observed" })]);
  assert.equal(ledger.updateNote(hash, { handle: "renamed" }).ok, true, "edits stay open while only observed");
  const [id] = snap(ledger, invoice, [onchain({}), onchain({ txid: TX(2), providerId: "second" })], { price: "skip" }).priced;
  // The settled observation committed; the second receipt's lookup hasn't run yet.
  assert.equal(ledger.updateNote(hash, { handle: "during-lookup" }).error, "unknown");
  assert.ok(ledger.beginPricing(id));
  ledger.freezePrice(id, PRICE);
  assert.deepEqual(receipts(ledger, invoice).map((r) => ledger.publicReceipt(r.id).handle), ["renamed", "renamed"]);
});

test("the first-observation window locks attribution at the first receipt", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  const hash = await hashRequest(`request-${invoice}`);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ state: "observed" })]);
  assert.equal(ledger.updateNote(hash, { handle: "too-late" }).error, "unknown");
  snap(ledger, invoice, [onchain({})]);
  ledger.sql.exec("UPDATE ra_invoices SET handle = 'mutated' WHERE invoice = ?", invoice);
  snap(ledger, invoice, [onchain({})]);
  assert.equal(ledger.publicReceipt(receipts(ledger, invoice)[0].id).handle, "ooga-dev", "a captured snapshot never changes");
});

test("attribution stays hidden until the first credit", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ sats: 2000, state: "observed" })]);
  const shown = ledger.publicReceipt(receipts(ledger, invoice)[0].id);
  assert.deepEqual([shown.handle, shown.message, shown.verified, shown.firstCreditedSeq], ["", "", false, null]);
});

// --- Atomicity ------------------------------------------------------------------------------

const FAILPOINTS = [
  ["snapshot", "transition:feed"], ["snapshot", "transition:outbox"], ["snapshot", "snapshot:before-commit"],
  ["freeze", "price:frozen"], ["freeze", "transition:ledger"], ["freeze", "transition:feed"], ["freeze", "transition:outbox"],
];
for (const [phase, point] of FAILPOINTS) {
  test(`a crash at ${point} during the ${phase} leaves nothing half-done, and recovery credits once`, async () => {
    let armed = null;
    const { ledger, make } = setup({ failpoint: (name) => {
      if (armed === phase && name === point) throw new Error(`crash at ${name}`);
    } });
    const invoice = await issue(ledger);
    await ledger.bindAddress(invoice, ADDR(1));
    const tables = ["ra_receipts", "ra_ledger", "ra_feed", "ra_outbox", "ra_pile_deltas", "ra_evidence", "ra_aliases", "ra_outputs", "ra_holds"];
    const counts = () => tables.map((t) => count(ledger, t));
    const revision = () => ledger.row("SELECT revision FROM ra_invoices WHERE invoice = ?", invoice).revision;
    const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
    const apply = () => ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: framesOf(begin(), [onchain({})]), candidate: PRICE });
    if (phase === "snapshot") {
      const before = [counts(), revision()];
      armed = phase;
      assert.throws(apply, /crash at/);
      assert.deepEqual([counts(), revision()], before);
      assert.equal(ledger.row("SELECT status FROM ra_reads WHERE sequence = ?", read.sequence).status, "outstanding");
    } else {
      const [id] = apply().priced;
      const before = [counts(), revision()];
      assert.ok(ledger.beginPricing(id));
      armed = phase;
      assert.throws(() => ledger.freezePrice(id, PRICE), /crash at/);
      assert.deepEqual([counts(), revision()], before);
      assert.equal(receipts(ledger, invoice)[0].price_state, "intent");
    }
    armed = null;
    const restarted = make();
    restarted.abandonReads();
    snap(restarted, invoice, [onchain({})]);
    for (const id of restarted.interruptedPricing()) restarted.recoverPricing(id, "stale-candidate");
    assert.equal(count(restarted, "ra_receipts"), 1);
    assert.equal(count(restarted, "ra_ledger"), 1);
    assert.equal(ledgerNet(restarted, receipts(restarted, invoice)[0].id), 1000);
    assert.equal(restarted.totals(invoice).credited, 1000);
    assert.equal(count(restarted, "ra_outbox"), feed(restarted).filter((f) => f.type === "receipt").length);
  });
}

// --- Feed -----------------------------------------------------------------------------------

test("the feed replays bounded revisions against a high-water mark; only the first credit animates", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ sats: 5000 })]);
  snap(ledger, invoice, [onchain({ sats: 5000, state: "invalid" })]);
  ledger.reverse(receipts(ledger, invoice)[0].id, "double spend");
  snap(ledger, invoice, [onchain({ sats: 5000 })]);
  snap(ledger, invoice, [onchain({ sats: 5000, state: "observed" })]);
  snap(ledger, invoice, [onchain({ sats: 5000 })]);
  const all = ledger.feedAfter(0, { limit: 100 });
  assert.equal(all.complete, true);
  assert.ok(all.frames.every((f) => f.replay === true));
  const animates = (f) => f.type === "receipt" && f.receipt.state === "credited" && f.seq === f.receipt.firstCreditedSeq;
  assert.equal(all.frames.filter(animates).length, 1, "reversal and reconfirmation never re-animate");
  const seqs = all.frames.map((f) => f.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.deepEqual(ledger.feedAfter(null, { limit: 100 }), { frames: [], after: null, through: all.through, complete: true });
  assert.deepEqual(ledger.feedAfter(0, { limit: 2 }), { frames: [], after: 0, through: all.through, complete: false });
  assert.equal(ledger.feedAfter(all.through + 5, { limit: 100 }).complete, false);
  assert.equal(ledger.feedAfter(all.through - 1, { limit: 100 }).frames.length, 1);
  assert.deepEqual(all.frames.slice(0, 2).map((f) => [f.receipt.state, f.receipt.pricing === null]), [["confirming", true], ["credited", false]]);
});

test("receipt frames carry the read's final totals; time and remaining-only changes send invoiceStatus", async () => {
  const { ledger, time } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  // A remaining amount before any receipt publishes nothing.
  snap(ledger, invoice, [], { begin: { left: 10_300 } });
  assert.equal(feed(ledger).length, 0);
  snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b", sats: 2000 })], { begin: { left: 7300 }, price: "skip" });
  const created = feed(ledger);
  assert.ok(created.length >= 2);
  for (const f of created) assert.deepEqual([f.invoice.left, f.invoice.received], [7300, 3000], "every frame has the final totals");
  // Only the remaining amount changes: one invoiceStatus frame, with exactly the agreed shape.
  const before = feed(ledger).length;
  snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b", sats: 2000 })], { begin: { left: 7000 }, price: "skip" });
  const status = feed(ledger).slice(before);
  assert.equal(status.length, 1);
  assert.deepEqual(Object.keys(status[0]).sort(), ["invoice", "replay", "seq", "type"]);
  assert.equal(status[0].type, "invoiceStatus");
  assert.deepEqual(Object.keys(status[0].invoice).sort(), ["credited", "due", "id", "left", "received", "review", "revision", "state"]);
  assert.equal(status[0].invoice.left, 7000);
  assert.ok(status[0].invoice.revision > created.at(-1).invoice.revision);
  // The same read again changes nothing visible.
  snap(ledger, invoice, [onchain({ txid: TX(1), providerId: "a" }), onchain({ txid: TX(2), providerId: "b", sats: 2000 })], { begin: { left: 7000 }, price: "skip" });
  assert.equal(feed(ledger).length, before + 1);
  // Time alone: the remaining amount goes stale and is withdrawn, as a newer invoiceStatus.
  time.now += FRESH + 1;
  assert.equal(ledger.totals(invoice).left, null);
  ledger.refreshFreshness();
  const stale = feed(ledger).at(-1);
  assert.deepEqual([stale.type, stale.invoice.left, stale.invoice.revision > status[0].invoice.revision], ["invoiceStatus", null, true]);
  ledger.refreshFreshness();
  assert.equal(feed(ledger).at(-1).seq, stale.seq, "nothing new to say");
  // A quarantine alone is visible too.
  const flagged = await ledger.bindAddress(await issue(ledger), ADDR(1));
  assert.equal(flagged.error, "conflict");
  assert.deepEqual([feed(ledger).at(-1).type, feed(ledger).at(-1).invoice.state], ["invoiceStatus", "review"]);
});

test("the public feed carries no addresses, outpoints, accounts or tokens", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({ txid: TX(4) }), lightning({})], { begin: { left: 0, destination: ADDR(1), capabilities: { destination: true } } });
  const text = JSON.stringify(ledger.feedAfter(0, { limit: 100 }));
  for (const secret of [ADDR(1), TX(4), HASH(1), "4242", "store-a", "btcpay", await hashRequest(`request-${invoice}`)]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("projection rows wait in the outbox until applied, across restarts", async () => {
  const { ledger, make } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({})]);
  const pending = ledger.pendingProjections(10);
  assert.equal(pending.length, feed(ledger).filter((f) => f.type === "receipt").length);
  assert.equal(ledger.health(), "behind");
  const restarted = make();
  assert.deepEqual(restarted.pendingProjections(10), pending);
  for (const row of pending) restarted.projected(row.id);
  assert.equal(count(restarted, "ra_outbox"), 0);
});

// --- Private status -------------------------------------------------------------------------

test("private status pages receipts and addresses newest first, each cursor fenced", async () => {
  const { ledger, time } = setup();
  const invoice = await issue(ledger);
  const token = await hashRequest(`request-${invoice}`);
  for (let i = 1; i <= 5; i++) await ledger.bindAddress(invoice, ADDR(i));
  snap(ledger, invoice, [1, 2, 3].map((n) => onchain({ txid: TX(n), providerId: `p${n}`, destination: ADDR(n) })));
  const first = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  assert.deepEqual(Object.keys(first).sort(), ["addresses", "invoice", "next", "nextAddress", "payableAddress", "receipts"]);
  assert.deepEqual(first.addresses.map((a) => a.address), [ADDR(5), ADDR(4)]);
  for (const a of first.addresses) assert.deepEqual(Object.keys(a), ["address", "issuedAt"]);
  const seen = [...first.addresses.map((a) => a.address)];
  let cursor = first.nextAddress;
  while (cursor) {
    const page = ledger.privateStatus(invoice, { requestHash: token, addressCursor: cursor, ...STATUS });
    seen.push(...page.addresses.map((a) => a.address));
    cursor = page.nextAddress;
  }
  assert.deepEqual(seen, [5, 4, 3, 2, 1].map(ADDR), "no address is ever dropped");
  assert.deepEqual(first.receipts.map((r) => r.id), receipts(ledger, invoice).slice(1).reverse().map((r) => r.id));
  const rest = ledger.privateStatus(invoice, { requestHash: token, cursor: first.next, ...STATUS });
  assert.deepEqual([rest.receipts.length, rest.next], [1, null]);
  // Cursors belong to their kind, invoice and reader.
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, cursor: first.nextAddress, ...STATUS }).error, "cursor");
  assert.equal(ledger.privateStatus(invoice, { donorId: 4242, cursor: first.next, ...STATUS }).error, "cursor");
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, cursor: "r.1.1.1.00000000", ...STATUS }).error, "cursor");
  assert.equal(ledger.privateStatus(invoice, { donorId: 9999, ...STATUS }).error, "unknown");
  // Any mutation bumps the revision: binding, notes and new receipts.
  await ledger.bindAddress(invoice, ADDR(6));
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, addressCursor: first.nextAddress, ...STATUS }).error, "resync");
  const again = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  snap(ledger, invoice, [onchain({ txid: TX(9), providerId: "p9", destination: ADDR(6) })]);
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, cursor: again.next, ...STATUS }).error, "resync");
  time.now += STATUS.ttlMs + 1;
  const late = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  time.now += STATUS.ttlMs + 1;
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, cursor: late.next, ...STATUS }).error, "cursor", "expired");
});

test("a note bumps the revision, so a held cursor resyncs", async () => {
  const { ledger, make } = setup({ policy: { editWindow: "settlement", messageRule: "once" } });
  const invoice = await issue(ledger);
  const token = await hashRequest(`request-${invoice}`);
  for (let i = 1; i <= 3; i++) await ledger.bindAddress(invoice, ADDR(i));
  const page = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  ledger.updateNote(token, { handle: "new-name" });
  assert.equal(make().privateStatus(invoice, { requestHash: token, addressCursor: page.nextAddress, ...STATUS }).error, "resync");
});

test("the payable address comes only from fresh verified evidence for a bound address", async () => {
  const { ledger, time } = setup();
  const invoice = await issue(ledger);
  const token = await hashRequest(`request-${invoice}`);
  await ledger.bindAddress(invoice, ADDR(1));
  await ledger.bindAddress(invoice, ADDR(2));
  const status = () => ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  snap(ledger, invoice, [], { begin: { left: 5000, destination: ADDR(2) } });
  assert.equal(status().payableAddress, null, "without verified destination capability");
  snap(ledger, invoice, [], { begin: { left: 5000, destination: ADDR(2).toUpperCase(), capabilities: { destination: true } } });
  assert.equal(status().payableAddress, ADDR(2));
  assert.equal(qrAmount(status(), ADDR(2)), 5000);
  assert.equal(qrAmount(status(), ADDR(1)), null, "an older address never implies the amount");
  snap(ledger, invoice, [], { begin: { left: null, destination: ADDR(2), capabilities: { destination: true } } });
  assert.equal(qrAmount(status(), ADDR(2)), null, "no amount without a current remaining amount");
  snap(ledger, invoice, [], { begin: { left: 0, destination: ADDR(2), capabilities: { destination: true } } });
  assert.equal(qrAmount(status(), ADDR(2)), null);
  snap(ledger, invoice, [], { begin: { left: 5000, destination: ADDR(2), capabilities: { destination: true, remaining: false } } });
  assert.deepEqual([status().invoice.left, qrAmount(status(), ADDR(2))], [null, null], "unverified remaining is withdrawn");
  snap(ledger, invoice, [], { begin: { left: 5000, destination: ADDR(2), capabilities: { destination: true } } });
  time.now += FRESH + 1;
  assert.deepEqual([status().payableAddress, status().invoice.left, qrAmount(status(), ADDR(2))], [null, null, null], "stale evidence");
  snap(ledger, invoice, [], { begin: { left: 5000, destination: ADDR(3), capabilities: { destination: true } } });
  assert.equal(status().payableAddress, null);
  assert.equal(status().invoice.state, "review", "an unbound payable destination is flagged");
});

test("private-only changes signal invoiceStatus; a read confirming nothing new is silent", async () => {
  const { ledger } = setup({ policy: { editWindow: "settlement", messageRule: "once" } });
  const invoice = await issue(ledger);
  const token = await hashRequest(`request-${invoice}`);
  await ledger.bindAddress(invoice, ADDR(1));
  await ledger.bindAddress(invoice, ADDR(2));
  const pay = onchain({ state: "observed" });
  const at = (destination) => ({ begin: { left: 5000, destination, capabilities: { destination: true } } });
  snap(ledger, invoice, [pay], at(ADDR(1)));
  const statuses = () => feed(ledger).filter((f) => f.type === "invoiceStatus");
  const latest = () => feed(ledger).at(-1);
  let count0 = statuses().length;
  // The provider's current destination rotates with the remaining amount unchanged.
  snap(ledger, invoice, [pay], at(ADDR(2)));
  assert.equal(statuses().length, count0 + 1);
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, ...STATUS }).payableAddress, ADDR(2));
  assert.equal(latest().invoice.revision, ledger.row("SELECT revision FROM ra_invoices WHERE invoice = ?", invoice).revision);
  assert.equal(JSON.stringify(latest()).includes(ADDR(2)), false, "the signal carries no private field");
  snap(ledger, invoice, [pay], at(ADDR(1)));
  assert.equal(statuses().length, count0 + 2);
  // The same read again, then a provider refresh with nothing new, say nothing.
  count0 = statuses().length;
  snap(ledger, invoice, [pay], at(ADDR(1)));
  snap(ledger, invoice, [pay], at(ADDR(1)));
  assert.equal(statuses().length, count0);
  // A new bound address and a note are private changes too.
  await ledger.bindAddress(invoice, ADDR(3));
  assert.equal(statuses().length, count0 + 1);
  assert.equal(ledger.updateNote(token, { handle: "renamed" }).ok, true);
  assert.equal(statuses().length, count0 + 2);
  assert.equal(latest().invoice.revision, ledger.row("SELECT revision FROM ra_invoices WHERE invoice = ?", invoice).revision);
});

test("an authorized status read commits what time withdrew before judging its cursors", async () => {
  const { ledger, time } = setup();
  // Cursors outlive the read's freshness here, so only the revision can make them stale.
  const STATUS = { receiptLimit: 2, addressLimit: 2, ttlMs: 10 * FRESH };
  const invoice = await issue(ledger);
  const token = await hashRequest(`request-${invoice}`);
  for (let i = 1; i <= 3; i++) await ledger.bindAddress(invoice, ADDR(i));
  snap(ledger, invoice, [1, 2, 3].map((n) => onchain({ txid: TX(n), providerId: `p${n}`, destination: ADDR(n) })),
    { begin: { left: 4000, destination: ADDR(3), capabilities: { destination: true } } });
  const before = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  assert.deepEqual([before.payableAddress, qrAmount(before, ADDR(3))], [ADDR(3), 4000]);
  const frames = feed(ledger).length;
  // An unauthorized read after expiry changes nothing and learns nothing.
  time.now += FRESH + 1;
  assert.equal(ledger.privateStatus(invoice, { donorId: 9999, ...STATUS }).error, "unknown");
  assert.equal(feed(ledger).length, frames);
  // The first authorized read commits the withdrawal: a newer revision, one signal.
  const after = ledger.privateStatus(invoice, { requestHash: token, cursor: before.next, ...STATUS });
  assert.equal(after.error, "resync", "a cursor from before the withdrawal is stale");
  const fresh = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  assert.ok(fresh.invoice.revision > before.invoice.revision);
  assert.deepEqual([fresh.payableAddress, fresh.invoice.left, qrAmount(fresh, ADDR(3))], [null, null, null], "address only, amount unavailable");
  const signals = feed(ledger).slice(frames);
  assert.equal(signals.length, 1);
  assert.deepEqual([signals[0].type, signals[0].invoice.left, signals[0].invoice.revision], ["invoiceStatus", null, fresh.invoice.revision]);
  ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  ledger.refreshFreshness();
  assert.equal(feed(ledger).length, frames + 1, "exactly once");
  assert.equal(ledger.privateStatus(invoice, { requestHash: token, addressCursor: fresh.nextAddress, ...STATUS }).addresses.length, 1);
});

test("a reply older than the freshness bound from its read's start is refused", async () => {
  const { ledger, time } = setup();
  const invoice = await issue(ledger);
  const token = await hashRequest(`request-${invoice}`);
  await ledger.bindAddress(invoice, ADDR(1));
  const offer = { left: 4000, destination: ADDR(1), capabilities: { destination: true } };
  const reply = (read, observedAt) => ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence,
    frames: framesOf(begin({ ...offer, observedAt }), [onchain({})]), candidate: PRICE });
  // Delayed past the bound: even the current line and sequence can't make it current.
  let read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  const started = time.now;
  time.now += FRESH + 1;
  assert.equal(reply(read, time.now).result, "stale");
  assert.equal(count(ledger, "ra_receipts"), 0);
  // A recent read whose observation predates it, or lies in the future, is impossible.
  read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.equal(reply(read, started).result, "rejected");
  read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.equal(reply(read, time.now + 1).result, "rejected");
  assert.equal(count(ledger, "ra_receipts"), 0);
  // A valid reply counts from the read's start, not its arrival.
  read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  const readStart = time.now;
  time.now += FRESH - 10;
  assert.equal(reply(read, readStart + 5).result, "applied");
  let status = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  assert.deepEqual([status.payableAddress, qrAmount(status, ADDR(1))], [ADDR(1), 4000]);
  time.now += 11;
  status = ledger.privateStatus(invoice, { requestHash: token, ...STATUS });
  assert.deepEqual([status.payableAddress, status.invoice.left, qrAmount(status, ADDR(1))], [null, null, null], "fresh by arrival, stale by origin");
  for (const row of ledger.pendingProjections(10)) ledger.projected(row.id);
  assert.equal(ledger.health(), "behind");
});

test("the original full-target BOLT11 is withdrawn once anything is received", async () => {
  const { ledger } = setup();
  const invoice = await issue(ledger);
  await ledger.bindAddress(invoice, ADDR(1));
  assert.equal(originalBolt11Allowed(ledger.totals(invoice)), true);
  snap(ledger, invoice, [onchain({ sats: 100, state: "observed" })]);
  assert.equal(originalBolt11Allowed(ledger.totals(invoice)), false, "a confirming partial");
  const held = await issue(ledger);
  snap(ledger, held, [lightning({ paymentHash: null })]);
  assert.deepEqual([ledger.totals(held).received, ledger.totals(held).review], [1000, 1000]);
  assert.equal(originalBolt11Allowed(ledger.totals(held)), false, "a receipt in review");
  const reversed = await issue(ledger);
  await ledger.bindAddress(reversed, ADDR(2));
  snap(ledger, reversed, [onchain({ txid: TX(2), destination: ADDR(2) })]);
  snap(ledger, reversed, [onchain({ txid: TX(2), destination: ADDR(2), state: "invalid" })]);
  ledger.reverse(receipts(ledger, reversed)[0].id, "double spend");
  assert.deepEqual(pick(ledger.totals(reversed)), { received: 0, credited: 0, review: 0, left: null, state: "unpaid" });
  assert.equal(originalBolt11Allowed(ledger.totals(reversed)), true, "nothing left received after a full reversal");
});

// --- Health ---------------------------------------------------------------------------------

test("health is off, then behind, review or current, and goes stale with time", async () => {
  const { ledger, time } = setup();
  assert.equal(ledger.health(), "off");
  const invoice = await issue(ledger);
  assert.equal(ledger.health(), "behind", "never read");
  await ledger.bindAddress(invoice, ADDR(1));
  snap(ledger, invoice, [onchain({})]);
  for (const row of ledger.pendingProjections(10)) ledger.projected(row.id);
  assert.equal(ledger.health(), "behind", "an unverified snapshot isn't complete coverage");
  snap(ledger, invoice, [onchain({})], { begin: { capabilities: { complete: true } } });
  for (const row of ledger.pendingProjections(10)) ledger.projected(row.id);
  assert.equal(ledger.health(), "current");
  time.now += FRESH + 1;
  assert.equal(ledger.health(), "behind", "an old complete read isn't current forever");
  snap(ledger, invoice, [onchain({})], { begin: { capabilities: { complete: true } } });
  for (const row of ledger.pendingProjections(10)) ledger.projected(row.id);
  assert.equal(ledger.health(), "current");
  const read = ledger.beginRead(invoice, { line: LINE, generation: GEN });
  assert.equal(ledger.health(), "behind", "a read in flight");
  ledger.applySnapshot({ invoice, line: LINE, generation: GEN, sequence: read.sequence, frames: [begin()], candidate: PRICE });
  assert.equal(ledger.health(), "behind", "the latest read was incomplete");
});

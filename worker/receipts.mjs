// Receipt accounting v1: the durable core. See docs/receipt-accounting-v1.md.
//
// Inactive. Nothing in the Worker, the object or the relay calls this yet: it issues no
// invoice, reads no provider and deducts no spend. It runs on the object's SQLite storage,
// `{ sql, transactionSync }`, in tables of its own, beside the object's and never inside them.
// Every state change happens in one synchronous transaction, so a crash leaves either all of
// it or none. Price lookups happen between transactions, and are guarded so a restart never
// samples the market again for a receipt it has already seen.
//
// Unsettled policy is never defaulted. The edit window, the message rule, the pricing fallback
// after an interrupted lookup and the freshness bound are explicit inputs; without them, the
// operations that need them refuse. Provider capabilities are inputs too, never assumed.

import { cleanHandle } from "../shared/handle.mjs";
import { MESSAGE_MAX, sanitize } from "../shared/donation.mjs";
import { isNetwork } from "../shared/bolt11.mjs";
import { MAX_SATS } from "../shared/protocol.mjs";
import { bananasOf, milliBananas, rateOf } from "./price.mjs";

export const MODE = "receipt-v1";
export const EDIT_WINDOWS = ["first-observation", "settlement"];
export const MESSAGE_RULES = ["once", "each-qualifying"];
export const PRICING_RECOVERY = ["stale-candidate", "review"];

// Holds keep a receipt in review, each until resolved on its own; a receipt with any open hold
// never credits. The first three are never released by hand: only verified evidence clears an
// unverified identity, and nothing in this foundation releases an import fence or an unbound
// destination.
export const HOLDS = [
  "identity-unverified", "import-fence", "destination-unbound", "identity-conflict",
  "identity-changed", "amount-changed", "destination-changed", "claimed-by-other-invoice",
  "missing-from-complete-snapshot", "pricing-interrupted", "confirmation-policy",
];
const UNRELEASABLE = new Set(["identity-unverified", "import-fence", "destination-unbound", "identity-conflict"]);

const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SCOPE = /^[A-Za-z0-9._:-]{1,64}$/;
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// A GitHub login, as the front door accepts it.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const PROVIDER_STATES = ["observed", "settled", "unaccounted", "invalid"];
const PROVENANCE = ["webhook", "sweep", "restart"];
const CAPABILITIES = ["complete", "outpoints", "lightningSuccess", "remaining", "destination"];

const SCHEMA = [
  `CREATE TABLE ra_invoices (
    invoice TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode = 'receipt-v1'),
    network TEXT NOT NULL,
    provider TEXT NOT NULL,
    store TEXT NOT NULL,
    owner INTEGER CHECK (owner IS NULL OR owner > 0),
    login TEXT,
    handle TEXT NOT NULL,
    message TEXT NOT NULL,
    message_min_sats INTEGER NOT NULL,
    message_receipt TEXT,
    request_hash TEXT NOT NULL UNIQUE,
    due INTEGER NOT NULL CHECK (due > 0),
    created INTEGER NOT NULL,
    editable INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    left_sats INTEGER,
    left_at INTEGER,
    payable_address TEXT,
    payable_at INTEGER,
    next_sequence INTEGER NOT NULL DEFAULT 0,
    applied_sequence INTEGER NOT NULL DEFAULT 0,
    applied_at INTEGER,
    verified_complete INTEGER NOT NULL DEFAULT 0,
    published TEXT,
    CHECK ((owner IS NULL) = (login IS NULL))
  );
  CREATE INDEX ra_invoices_owner ON ra_invoices (owner, created);
  CREATE TABLE ra_legacy_invoices (invoice TEXT PRIMARY KEY, source TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE ra_import_txs (
    network TEXT NOT NULL,
    txid TEXT NOT NULL,
    source TEXT NOT NULL,
    mapped_invoice TEXT,
    mapped_reason TEXT,
    mapped_at INTEGER,
    PRIMARY KEY (network, txid)
  );
  CREATE TABLE ra_addresses (
    network TEXT NOT NULL,
    address TEXT NOT NULL,
    invoice TEXT NOT NULL,
    ord INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    PRIMARY KEY (network, address)
  );
  CREATE UNIQUE INDEX ra_addresses_ord ON ra_addresses (invoice, ord);
  CREATE TABLE ra_receipts (
    id TEXT PRIMARY KEY,
    invoice TEXT NOT NULL,
    ord INTEGER NOT NULL,
    network TEXT NOT NULL,
    provider TEXT NOT NULL,
    store TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('lightning', 'onchain')),
    sats INTEGER NOT NULL CHECK (sats > 0),
    state TEXT NOT NULL CHECK (state IN ('confirming', 'credited', 'invalid', 'reversed', 'review')),
    credit INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    provider_state TEXT NOT NULL,
    txid TEXT,
    vout INTEGER,
    payment_hash TEXT,
    destination TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    first_credited_seq INTEGER,
    attr_captured INTEGER NOT NULL DEFAULT 0,
    handle TEXT NOT NULL DEFAULT '',
    attr_message TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    price_state TEXT NOT NULL CHECK (price_state IN ('intent', 'frozen')),
    candidate_cents INTEGER,
    candidate_at INTEGER,
    price_cents INTEGER,
    price_at INTEGER,
    price_stale INTEGER,
    milli INTEGER,
    CHECK (credit = 0 OR credit = sats)
  );
  CREATE UNIQUE INDEX ra_receipts_ord ON ra_receipts (invoice, ord);
  CREATE TABLE ra_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  );
  CREATE UNIQUE INDEX ra_holds_open ON ra_holds (receipt, reason) WHERE resolved_at IS NULL;
  CREATE TABLE ra_outputs (
    network TEXT NOT NULL, txid TEXT NOT NULL, vout INTEGER NOT NULL, receipt TEXT NOT NULL UNIQUE,
    PRIMARY KEY (network, txid, vout)
  );
  CREATE TABLE ra_lightning (
    network TEXT NOT NULL, payment_hash TEXT NOT NULL, receipt TEXT NOT NULL UNIQUE,
    PRIMARY KEY (network, payment_hash)
  );
  CREATE TABLE ra_aliases (
    network TEXT NOT NULL, provider TEXT NOT NULL, store TEXT NOT NULL, provider_id TEXT NOT NULL,
    receipt TEXT NOT NULL,
    PRIMARY KEY (network, provider, store, provider_id)
  );
  CREATE TABLE ra_evidence (
    receipt TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    provider_state TEXT NOT NULL,
    sats INTEGER NOT NULL,
    block_hash TEXT,
    block_height INTEGER,
    confirmations INTEGER,
    policy_version TEXT,
    provenance TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    complete INTEGER NOT NULL,
    applied INTEGER NOT NULL,
    PRIMARY KEY (receipt, sequence)
  );
  CREATE TABLE ra_reads (
    invoice TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    line TEXT NOT NULL,
    generation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('outstanding', 'applied', 'stale', 'incomplete', 'rejected', 'abandoned')),
    started_at INTEGER NOT NULL,
    PRIMARY KEY (invoice, sequence)
  );
  CREATE UNIQUE INDEX ra_reads_outstanding ON ra_reads (invoice) WHERE status = 'outstanding';
  CREATE TABLE ra_feed (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('receipt', 'invoiceStatus')),
    invoice TEXT NOT NULL,
    receipt TEXT,
    revision INTEGER NOT NULL,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ra_feed_receipt ON ra_feed (receipt, revision) WHERE receipt IS NOT NULL;
  CREATE TABLE ra_ledger (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt TEXT NOT NULL,
    transition INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('credit', 'reversal')),
    sats INTEGER NOT NULL,
    milli INTEGER NOT NULL,
    at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    UNIQUE (receipt, transition)
  );
  CREATE TABLE ra_pile_deltas (
    ledger_seq INTEGER PRIMARY KEY,
    sats INTEGER NOT NULL,
    milli INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE ra_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_seq INTEGER NOT NULL UNIQUE,
    ledger_seq INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE ra_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  );`,
  // Each invoice keeps the reviewed attribution policy it was issued under, with its version,
  // so its receipts are processed by that policy whatever later configuration says. Rows from
  // before this step have none, and processing them refuses.
  `ALTER TABLE ra_invoices ADD COLUMN edit_window TEXT;
  ALTER TABLE ra_invoices ADD COLUMN message_rule TEXT;
  ALTER TABLE ra_invoices ADD COLUMN policy_version TEXT;`,
  // The rest of the reviewed policy: how an interrupted price lookup is resolved, and which
  // provider confirmation policy a settled observation must have been made under.
  `ALTER TABLE ra_invoices ADD COLUMN pricing_recovery TEXT;
  ALTER TABLE ra_invoices ADD COLUMN confirmation_policy TEXT;`,
  // What the private status reports about the original invoice: its expiry in seconds, how
  // Lightning was offered, the original code, and when the provider last verified that code
  // is still usable (nothing sets it until provider ingestion exists). An order for history
  // pages, and each account's history revision.
  `ALTER TABLE ra_invoices ADD COLUMN expires INTEGER;
  ALTER TABLE ra_invoices ADD COLUMN lightning TEXT;
  ALTER TABLE ra_invoices ADD COLUMN bolt11 TEXT;
  ALTER TABLE ra_invoices ADD COLUMN bolt11_verified_at INTEGER;
  ALTER TABLE ra_invoices ADD COLUMN ord INTEGER;
  UPDATE ra_invoices SET ord = rowid;
  CREATE UNIQUE INDEX ra_invoices_ord ON ra_invoices (ord);
  CREATE INDEX ra_invoices_owner_ord ON ra_invoices (owner, ord);
  CREATE TABLE ra_accounts (owner INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
  INSERT INTO ra_accounts (owner, revision) SELECT owner, 1 FROM ra_invoices WHERE owner IS NOT NULL GROUP BY owner;`,
  // The reviewed read settings, saved once before the first mapping is exposed, so reads never
  // depend on configuration that can disappear. Whether an invoice's expiry has been committed
  // as a revision, so expiring is a change pages hear rather than a silent one.
  `CREATE TABLE ra_read_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    replay_max INTEGER NOT NULL CHECK (replay_max > 0),
    status_page_size INTEGER NOT NULL CHECK (status_page_size BETWEEN 1 AND 100),
    address_page_size INTEGER NOT NULL CHECK (address_page_size BETWEEN 1 AND 100),
    history_page_size INTEGER NOT NULL CHECK (history_page_size BETWEEN 1 AND 100),
    recent_size INTEGER NOT NULL CHECK (recent_size > 0),
    cursor_ttl_ms INTEGER NOT NULL CHECK (cursor_ttl_ms > 0),
    freshness_ms INTEGER NOT NULL CHECK (freshness_ms > 0),
    saved_at INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  ALTER TABLE ra_invoices ADD COLUMN expiry_committed INTEGER NOT NULL DEFAULT 0;`,
  // Outbox rows the D1 projection refused to apply: a marker for the same revision with a
  // different payload, or a collision with a legacy donation. Draining stops until review.
  `CREATE TABLE ra_projection_conflicts (
    outbox_id INTEGER PRIMARY KEY,
    receipt TEXT NOT NULL,
    revision INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    resolved_at INTEGER
  );`,
  // The receipts held for review, so the pile's uncertain amount reads only those, however long
  // the history.
  `CREATE INDEX ra_receipts_review ON ra_receipts (id) WHERE state = 'review';`,
];

const LIGHTNING = ["available", "limit", "unavailable"];
const BOLT11 = /^ln[a-z0-9]{1,90}1[02-9ac-hj-np-z]{100,6000}$/;

const READ_KEYS = ["replayMax", "statusPageSize", "addressPageSize", "historyPageSize", "recentSize", "cursorTtlMs", "freshnessMs"];
// The wire bound on any private page, receipts, addresses or history: pages carry at most
// this many rows, as agreed with the consumer. A protocol limit, not a deployment choice:
// each deployment still sets its own sizes, at or under it.
export const PRIVATE_PAGE_MAX = 100;
const PAGE_KEYS = ["statusPageSize", "addressPageSize", "historyPageSize"];
const validReadSettings = (s) => s !== null && typeof s === "object" &&
  READ_KEYS.every((k) => Number.isSafeInteger(s[k]) && s[k] > 0) && PAGE_KEYS.every((k) => s[k] <= PRIVATE_PAGE_MAX);
const sameReadSettings = (a, b) => READ_KEYS.every((k) => a[k] === b[k]);

// Whether an invoice's original metadata is whole: an expiry, how Lightning was offered, and the
// code exactly when it was offered. New mappings can't be made without it.
const INCOMPLETE_METADATA = "(expires IS NULL OR expires <= 0 OR lightning IS NULL OR lightning NOT IN ('available', 'limit', 'unavailable') " +
  "OR ((lightning = 'available') <> (bolt11 IS NOT NULL)))";
const metadataComplete = (m) => Number.isSafeInteger(m.expires) && m.expires > 0 && LIGHTNING.includes(m.lightning) &&
  (m.lightning === "available" ? typeof m.bolt11 === "string" && BOLT11.test(m.bolt11) : m.bolt11 === null);

const POLICY_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const isReference = (v) => typeof v === "string" && POLICY_VERSION.test(v);

export class PolicyRequired extends Error {
  constructor(name) {
    super(`receipt accounting needs an explicit ${name}`);
    this.policy = name;
  }
}

// The request token's SHA-256, the only form in which the ledger keeps it.
export async function hashRequest(request) {
  return hex(await sha256(new TextEncoder().encode(request)));
}

export class ReceiptLedger {
  // storage: { sql, transactionSync }. now: milliseconds. randomHex: 32 hex characters.
  // issuance: true only where new receipt-mode invoices may be issued; off unless given.
  // policy: { editWindow, messageRule, pricingRecovery, confirmationPolicy, version }, the
  // reviewed policy new invoices are issued under. confirmationPolicy names the provider's
  // confirmation policy that settled observations must report. It is saved with each invoice;
  // processing always uses the invoice's own copy, so turning issuance off or changing
  // configuration never changes how issued invoices count.
  // freshnessMs: how long a provider read stays current; deployment configuration, required by
  // everything that publishes totals or health. failpoint: called by name inside transactions,
  // so tests can stop the work at each boundary.
  // readSettings: the reviewed read bounds, { replayMax, statusPageSize, addressPageSize,
  // historyPageSize, recentSize, cursorTtlMs, freshnessMs }, all required for issuance. The
  // first issuance saves them durably, before any mapping exists; from then on reads use the
  // saved copy, whatever later configuration says. freshnessMs alone is accepted for a ledger
  // that never issues and has nothing saved yet.
  constructor({ storage, now, randomHex, issuance = false, policy = {}, readSettings = null, freshnessMs = null, failpoint = () => {} }) {
    Object.assign(this, { storage, sql: storage.sql, now, randomHex, failpoint });
    this.issuance = issuance === true;
    this.policy = {
      editWindow: EDIT_WINDOWS.includes(policy.editWindow) ? policy.editWindow : null,
      messageRule: MESSAGE_RULES.includes(policy.messageRule) ? policy.messageRule : null,
      pricingRecovery: PRICING_RECOVERY.includes(policy.pricingRecovery) ? policy.pricingRecovery : null,
      confirmationPolicy: isReference(policy.confirmationPolicy) ? policy.confirmationPolicy : null,
      version: isReference(policy.version) ? policy.version : null,
    };
    this.configuredRead = validReadSettings(readSettings) ? { ...readSettings } : null;
    this.configuredFreshness = this.configuredRead?.freshnessMs ?? (isPositive(freshnessMs) ? freshnessMs : null);
    // Receipts this instance created, and lookups it started. A restart forgets both, so an
    // older intent can only be recovered, never priced from a new sample.
    this.fresh = new Set();
    this.inflight = new Set();
    this.touched = null;
    this.migrate();
  }

  migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const done = this.row("SELECT value FROM meta WHERE key = 'receipt_schema'")?.value ?? 0;
    if (done >= SCHEMA.length) return;
    this.storage.transactionSync(() => {
      for (const step of SCHEMA.slice(done)) this.sql.exec(step);
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('receipt_schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        SCHEMA.length,
      );
    });
  }

  rows(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray();
  }

  row(query, ...bindings) {
    return this.rows(query, ...bindings)[0] ?? null;
  }

  // The reviewed policy new invoices are issued under: every part, or a refusal.
  issuancePolicy() {
    if (!this.policy.editWindow) throw new PolicyRequired("edit window policy");
    if (!this.policy.messageRule) throw new PolicyRequired("message rule policy");
    if (!this.policy.pricingRecovery) throw new PolicyRequired("pricing recovery policy");
    if (!this.policy.confirmationPolicy) throw new PolicyRequired("confirmation policy reference");
    if (!this.policy.version) throw new PolicyRequired("policy version");
    return this.policy;
  }

  // The policy an invoice was issued under, saved with it. Anything that can observe, price or
  // credit its receipts needs every part. A row without them, or with a value this code doesn't
  // know, is refused, never defaulted.
  invoicePolicy(invoice) {
    const row = this.row(
      "SELECT edit_window, message_rule, pricing_recovery, confirmation_policy, policy_version FROM ra_invoices WHERE invoice = ?",
      invoice,
    );
    if (!row) return null;
    if (!EDIT_WINDOWS.includes(row.edit_window)) throw new PolicyRequired("edit window policy");
    if (!MESSAGE_RULES.includes(row.message_rule)) throw new PolicyRequired("message rule policy");
    if (!PRICING_RECOVERY.includes(row.pricing_recovery)) throw new PolicyRequired("pricing recovery policy");
    if (!isReference(row.confirmation_policy)) throw new PolicyRequired("confirmation policy reference");
    if (!isReference(row.policy_version)) throw new PolicyRequired("policy version");
    return {
      editWindow: row.edit_window, messageRule: row.message_rule, pricingRecovery: row.pricing_recovery,
      confirmationPolicy: row.confirmation_policy, version: row.policy_version,
    };
  }

  receiptPolicy(receipt) {
    const row = this.row("SELECT invoice FROM ra_receipts WHERE id = ?", receipt);
    return row ? this.invoicePolicy(row.invoice) : null;
  }

  // The saved read settings, or null before the first issuance saved them.
  readSettings() {
    const r = this.row("SELECT * FROM ra_read_settings WHERE id = 1");
    return r ? {
      replayMax: r.replay_max, statusPageSize: r.status_page_size, addressPageSize: r.address_page_size,
      historyPageSize: r.history_page_size, recentSize: r.recent_size, cursorTtlMs: r.cursor_ttl_ms, freshnessMs: r.freshness_ms,
    } : null;
  }

  saveReadSettings(s, reason) {
    this.sql.exec(
      "INSERT INTO ra_read_settings (id, replay_max, status_page_size, address_page_size, history_page_size, recent_size, cursor_ttl_ms, freshness_ms, saved_at, reason) " +
      "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      s.replayMax, s.statusPageSize, s.addressPageSize, s.historyPageSize, s.recentSize, s.cursorTtlMs, s.freshnessMs, this.now(), reason,
    );
  }

  // For mappings made before read settings were saved: an operator adopts a complete reviewed
  // set once. Nothing here picks the values, and a saved set is never replaced.
  adoptReadSettings(settings, reason) {
    if (!validReadSettings(settings)) throw new PolicyRequired("read settings");
    if (typeof reason !== "string" || !reason.trim()) throw new Error("adopting read settings needs a reason");
    return this.mutate(() => {
      if (this.readSettings()) return { error: "saved" };
      this.saveReadSettings(settings, reason);
      return { ok: true };
    });
  }

  // How long a provider read stays fresh: the saved bound, so removing or changing configuration
  // can't change what is current at an unchanged revision. Before anything is saved, the bound
  // this instance was given, if any.
  get freshnessMs() {
    return this.readSettings()?.freshnessMs ?? this.configuredFreshness;
  }

  freshness() {
    const bound = this.freshnessMs;
    if (bound === null) throw new PolicyRequired("freshness bound");
    return bound;
  }

  // Every mutation runs here: one transaction, and before it commits, every receipt frame it
  // made gets the invoice's final totals, and any visible change without one gets an
  // invoiceStatus frame.
  mutate(work) {
    return this.storage.transactionSync(() => {
      this.touched = new Map();
      try {
        const result = work();
        this.finalize();
        return result;
      } finally {
        this.touched = null;
      }
    });
  }

  // touch marks an invoice for republishing; bump also says its private view changed.
  touch(invoice, seq = null) {
    const entry = this.touched.get(invoice) ?? { frames: [], bumped: false };
    if (seq !== null) entry.frames.push(seq);
    this.touched.set(invoice, entry);
    return entry;
  }

  bump(invoice) {
    this.revise(invoice);
    this.touch(invoice).bumped = true;
  }

  // Every invoice revision also moves its owner's history revision, so history cursors fence
  // on any change to any of the account's invoices.
  revise(invoice) {
    this.sql.exec("UPDATE ra_invoices SET revision = revision + 1 WHERE invoice = ?", invoice);
    this.reviseAccount(this.row("SELECT owner FROM ra_invoices WHERE invoice = ?", invoice)?.owner ?? null);
  }

  reviseAccount(owner) {
    if (owner === null) return;
    this.sql.exec(
      "INSERT INTO ra_accounts (owner, revision) VALUES (?, 1) ON CONFLICT (owner) DO UPDATE SET revision = revision + 1",
      owner,
    );
  }

  // Withdraws a remaining amount or payable address that has outlived the freshness bound, as
  // a committed change with a newer revision, so no reader sees it change at an old revision.
  // Without a configured bound nothing is withdrawn from storage; reads simply treat both as
  // unknown until the bound is configured again.
  // The invoice's own expiry is committed the same way, once, so the private status turns
  // `expired` at a newer revision, never silently.
  expire(invoice) {
    const inv = this.row("SELECT left_at, payable_at, bolt11_verified_at, expires, expiry_committed FROM ra_invoices WHERE invoice = ?", invoice);
    let changed = false;
    if (inv.expires !== null && !inv.expiry_committed && this.now() >= inv.expires * 1000) {
      this.sql.exec("UPDATE ra_invoices SET expiry_committed = 1 WHERE invoice = ?", invoice);
      changed = true;
    }
    if (this.freshnessMs !== null) {
      if (inv.left_at !== null && !this.isFresh(inv.left_at)) {
        this.sql.exec("UPDATE ra_invoices SET left_sats = NULL, left_at = NULL WHERE invoice = ?", invoice);
        changed = true;
      }
      if (inv.payable_at !== null && !this.isFresh(inv.payable_at)) {
        this.sql.exec("UPDATE ra_invoices SET payable_address = NULL, payable_at = NULL WHERE invoice = ?", invoice);
        changed = true;
      }
      if (inv.bolt11_verified_at !== null && !this.isFresh(inv.bolt11_verified_at)) {
        this.sql.exec("UPDATE ra_invoices SET bolt11_verified_at = NULL WHERE invoice = ?", invoice);
        changed = true;
      }
    }
    if (changed) this.bump(invoice);
  }

  // Invoices holding something time has made stale, or whose expiry has passed uncommitted:
  // only these need a commit, so the work stays bounded by what changed.
  staleInvoices(owner = undefined) {
    const now = this.now();
    const bound = this.freshnessMs;
    const cutoff = bound === null ? Number.MIN_SAFE_INTEGER : now - bound;
    return this.rows(
      "SELECT invoice FROM ra_invoices WHERE (? IS NULL OR owner = ?) AND (" +
      "(left_at IS NOT NULL AND left_at < ?) OR (payable_at IS NOT NULL AND payable_at < ?) OR " +
      "(bolt11_verified_at IS NOT NULL AND bolt11_verified_at < ?) OR " +
      "(expires IS NOT NULL AND expiry_committed = 0 AND expires * 1000 <= ?))",
      owner ?? null, owner ?? null, cutoff, cutoff, cutoff, now,
    ).map((r) => r.invoice);
  }

  // When the next such change is due, in milliseconds, or null: for the object's alarm.
  nextDeadline() {
    const bound = this.freshnessMs;
    const times = [];
    if (bound !== null) {
      const r = this.row("SELECT min(left_at) AS l, min(payable_at) AS p, min(bolt11_verified_at) AS b FROM ra_invoices");
      for (const at of [r.l, r.p, r.b]) if (at !== null) times.push(at + bound + 1);
    }
    const e = this.row("SELECT min(expires) AS e FROM ra_invoices WHERE expires IS NOT NULL AND expiry_committed = 0").e;
    if (e !== null) times.push(e * 1000);
    return times.length ? Math.min(...times) : null;
  }

  finalize() {
    for (const invoice of [...this.touched.keys()]) this.expire(invoice);
    for (const [invoice, { frames, bumped }] of this.touched) {
      const totals = this.totals(invoice);
      const visible = JSON.stringify({ ...totals, revision: undefined });
      const published = this.row("SELECT published FROM ra_invoices WHERE invoice = ?", invoice).published;
      for (const seq of frames) {
        const { payload } = this.row("SELECT payload FROM ra_feed WHERE seq = ?", seq);
        const receipt = JSON.parse(payload).receipt;
        this.sql.exec("UPDATE ra_feed SET payload = ? WHERE seq = ?", JSON.stringify({ type: "receipt", seq, receipt, invoice: totals }), seq);
      }
      const observed = this.row("SELECT 1 FROM ra_receipts WHERE invoice = ?", invoice);
      // Any change to the private view (a payable address, a binding, a note) or to the public
      // totals is signalled once an invoice has receipts, so the page refreshes its private
      // status. The frame carries public totals only. A read that confirms nothing new is silent.
      if (!frames.length && observed && (bumped || visible !== published)) {
        if (!bumped) this.revise(invoice);
        const status = this.totals(invoice);
        const seq = this.sql.exec(
          "INSERT INTO ra_feed (kind, invoice, receipt, revision, at, payload) VALUES ('invoiceStatus', ?, NULL, ?, ?, '') RETURNING seq",
          invoice, status.revision, this.now(),
        ).toArray()[0].seq;
        this.sql.exec("UPDATE ra_feed SET payload = ? WHERE seq = ?", JSON.stringify({ type: "invoiceStatus", seq, invoice: status }), seq);
      }
      if (frames.length || observed) this.sql.exec("UPDATE ra_invoices SET published = ? WHERE invoice = ?", visible, invoice);
    }
  }

  // --- Modes and fences ---------------------------------------------------------------------

  // Legacy invoices: found in D1's donations, the object's finished marks, or a pending row
  // without a mode. Fenced here, never by writing into donations.
  fenceLegacyInvoice(invoice, source) {
    if (!INVOICE_ID.test(invoice) || !["donations", "finished", "pending"].includes(source)) throw new Error("invalid legacy fence");
    this.storage.transactionSync(() => {
      if (this.row("SELECT 1 FROM ra_invoices WHERE invoice = ?", invoice)) throw new Error("a receipt-mode invoice can't be fenced as legacy");
      this.sql.exec("INSERT INTO ra_legacy_invoices (invoice, source, at) VALUES (?, ?, ?) ON CONFLICT (invoice) DO NOTHING", invoice, source, this.now());
    });
  }

  // Every output of an imported transaction is fenced. Its funds may already be counted by a
  // legacy import row, so nothing here ever releases the fence or credits them.
  fenceImportedTransaction(network, txid, source) {
    if (!isNetwork(network) || !HEX64.test(txid) || typeof source !== "string" || !source) throw new Error("invalid import fence");
    this.sql.exec("INSERT INTO ra_import_txs (network, txid, source) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", network, txid, source);
  }

  // Records a reviewed mapping of an imported transaction to an invoice. A mapping says where
  // the funds were meant to go, not that they're uncounted: the fence stays, and nothing credits.
  mapImportedTransaction(network, txid, invoice, reason) {
    if (typeof reason !== "string" || !reason) throw new Error("a mapping needs a reason");
    const fence = this.row("SELECT * FROM ra_import_txs WHERE network = ? AND txid = ?", network, txid);
    if (!fence || fence.mapped_invoice !== null || !this.row("SELECT 1 FROM ra_invoices WHERE invoice = ?", invoice)) return { error: "invalid" };
    this.sql.exec(
      "UPDATE ra_import_txs SET mapped_invoice = ?, mapped_reason = ?, mapped_at = ? WHERE network = ? AND txid = ?",
      invoice, reason, this.now(), network, txid,
    );
    return { ok: true };
  }

  modeOf(invoice) {
    if (this.row("SELECT 1 FROM ra_invoices WHERE invoice = ?", invoice)) return MODE;
    if (this.row("SELECT 1 FROM ra_legacy_invoices WHERE invoice = ?", invoice)) return "legacy";
    return null;
  }

  // A legacy paid notice never credits a receipt-mode invoice.
  legacyPaidAllowed(invoice) {
    return this.modeOf(invoice) !== MODE;
  }

  // --- Issuance and attribution -------------------------------------------------------------

  // Saves the invoice's permanent record before anything reaches the page. owner is OBL's
  // stable account id with its login, or both null when signed out or anonymous; the handle
  // never stands in for either.
  // expires (unix seconds), lightning ("available", "limit" or "unavailable") and the original
  // bolt11 (exactly when Lightning was available) describe the provider's invoice as issued.
  // All are required, so no mapping is ever exposed without them, and none is guessed.
  issueInvoice({ invoice, network, provider, store, owner = null, login = null, handle, message = "",
    messageMinSats, requestHash, due, expires = null, lightning = null, bolt11 = null }) {
    // New issuance is off unless this instance was told otherwise, and needs a whole reviewed
    // policy and the reviewed read settings. None of it affects invoices already issued.
    if (!this.issuance) return { error: "closed" };
    const policy = this.issuancePolicy();
    const saved = this.readSettings();
    if (!saved && !this.configuredRead) throw new PolicyRequired("read settings");
    // Configured read settings that differ from the saved ones are a drift to review, never a
    // silent change to how existing mappings are read.
    if (saved && this.configuredRead && !sameReadSettings(saved, this.configuredRead)) return { error: "closed" };
    if (!metadataComplete({ expires, lightning, bolt11 })) return { error: "invalid" };
    if (!INVOICE_ID.test(invoice) || !isNetwork(network) || !SCOPE.test(provider) || !SCOPE.test(store)) return { error: "invalid" };
    if (owner === null ? login !== null : !isPositive(owner) || typeof login !== "string" || !LOGIN.test(login)) return { error: "invalid" };
    if (!isPositive(due) || due > MAX_SATS || !Number.isSafeInteger(messageMinSats) || messageMinSats < 0) return { error: "invalid" };
    if (typeof requestHash !== "string" || !HEX64.test(requestHash)) return { error: "invalid" };
    if (handle !== undefined && typeof handle !== "string") return { error: "invalid" };
    const text = sanitize(message, MESSAGE_MAX);
    if (text && due < messageMinSats) return { error: "message" };
    return this.mutate(() => {
      if (this.modeOf(invoice) !== null) return { error: "fenced" };
      if (this.row("SELECT 1 FROM ra_invoices WHERE request_hash = ?", requestHash)) return { error: "invalid" };
      // The read settings are saved, in the same transaction, before the first mapping exists.
      if (!this.readSettings()) this.saveReadSettings(this.configuredRead, "saved with the first receipt-mode issuance");
      const ord = (this.row("SELECT max(ord) AS ord FROM ra_invoices").ord ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO ra_invoices (invoice, mode, network, provider, store, owner, login, handle, message, message_min_sats, request_hash, due, created, " +
        "edit_window, message_rule, pricing_recovery, confirmation_policy, policy_version, expires, lightning, bolt11, ord) " +
        "VALUES (?, 'receipt-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        invoice, network, provider, store, owner, login,
        displayHandle(handle === undefined && owner !== null ? login : handle), text, messageMinSats, requestHash, due, this.now(),
        policy.editWindow, policy.messageRule, policy.pricingRecovery, policy.confirmationPolicy, policy.version,
        expires, lightning, bolt11, ord,
      );
      this.reviseAccount(owner);
      return { invoice, accounting: MODE };
    });
  }

  // For a mapping made before its original metadata was required: an operator supplies the
  // provider's reviewed expiry, Lightning offer and code, once. Until then that invoice's status,
  // and its owner's history, are closed rather than shown with anything guessed. Metadata that
  // is already whole is never replaced. Nothing in the Worker routes here.
  reconcileInvoiceMetadata(invoice, { expires, lightning, bolt11 }, reason) {
    if (typeof reason !== "string" || !reason.trim()) throw new Error("a reconciliation needs a reason");
    if (!metadataComplete({ expires, lightning, bolt11 })) return { error: "invalid" };
    return this.mutate(() => {
      const row = this.row("SELECT expires, lightning, bolt11 FROM ra_invoices WHERE invoice = ?", invoice);
      if (!row) return { error: "unknown" };
      if (metadataComplete(row)) return { error: "complete" };
      this.sql.exec(
        "UPDATE ra_invoices SET expires = ?, lightning = ?, bolt11 = ?, expiry_committed = 0, bolt11_verified_at = NULL WHERE invoice = ?",
        expires, lightning, bolt11, invoice,
      );
      this.sql.exec("INSERT INTO ra_reviews (invoice, reason, at, resolved_at, resolution) VALUES (?, 'metadata-reconciled', ?, ?, ?)",
        invoice, this.now(), this.now(), reason);
      this.bump(invoice);
      return { ok: true };
    });
  }

  // Note autosaves change the durable record while edits are allowed, in one transaction.
  updateNote(requestHash, { handle, message } = {}) {
    return this.mutate(() => {
      const row = this.row("SELECT * FROM ra_invoices WHERE request_hash = ? AND editable = 1", requestHash);
      if (!row) return { error: "unknown" };
      if (handle !== undefined && typeof handle !== "string") return { error: "invalid" };
      const text = message === undefined ? row.message : sanitize(message, MESSAGE_MAX);
      if (text && row.due < row.message_min_sats) return { error: "message" };
      this.sql.exec(
        "UPDATE ra_invoices SET handle = ?, message = ? WHERE invoice = ?",
        handle === undefined ? row.handle : displayHandle(handle), text, row.invoice,
      );
      this.bump(row.invoice);
      return { ok: true };
    });
  }

  // Binds an address to its invoice before the page sees it. The address is fully validated
  // for the invoice's network first, bech32 checksums and base58 checksums alike, and kept in
  // canonical form, so another spelling can't slip past ownership. An address bound elsewhere
  // fails closed and is flagged on both invoices; it is never reassigned.
  async bindAddress(invoice, address) {
    const network = this.row("SELECT network FROM ra_invoices WHERE invoice = ?", invoice)?.network;
    if (!network) return { error: "invalid" };
    const canonical = await verifyAddress(address, network);
    if (!canonical) return { error: "invalid" };
    return this.mutate(() => {
      const bound = this.row("SELECT invoice FROM ra_addresses WHERE network = ? AND address = ?", network, canonical);
      if (bound?.invoice === invoice) return { ok: true, address: canonical };
      if (bound) {
        this.flag(invoice, "address-conflict");
        this.flag(bound.invoice, "address-conflict");
        return { error: "conflict" };
      }
      const ord = (this.row("SELECT max(ord) AS ord FROM ra_addresses WHERE invoice = ?", invoice).ord ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO ra_addresses (network, address, invoice, ord, issued_at) VALUES (?, ?, ?, ?, ?)",
        network, canonical, invoice, ord, this.now(),
      );
      this.bump(invoice);
      return { ok: true, address: canonical };
    });
  }

  // Who may read an invoice: the holder of its request token, or the signed-in owner by stable
  // id. A matching handle or login is never enough. The principal binds cursors to the reader.
  principal(invoice, { requestHash = null, donorId = null } = {}) {
    const row = this.row("SELECT owner, request_hash FROM ra_invoices WHERE invoice = ?", invoice);
    if (!row) return null;
    if (typeof requestHash === "string" && requestHash === row.request_hash) return `t:${requestHash}`;
    if (isPositive(donorId) && row.owner !== null && donorId === row.owner) return `a:${donorId}`;
    return null;
  }

  canRead(invoice, access) {
    return this.principal(invoice, access) !== null;
  }

  // --- Provider reads -----------------------------------------------------------------------

  // The sequence is assigned before the provider is read, one read per invoice at a time.
  beginRead(invoice, { line, generation }) {
    if (typeof line !== "string" || !line || typeof generation !== "string" || !/^[0-9a-f]{16}$/.test(generation)) {
      throw new Error("a read needs its line and a 16-hex generation");
    }
    return this.storage.transactionSync(() => {
      const row = this.row("SELECT next_sequence FROM ra_invoices WHERE invoice = ?", invoice);
      if (!row || this.row("SELECT 1 FROM ra_reads WHERE invoice = ? AND status = 'outstanding'", invoice)) return null;
      const sequence = row.next_sequence + 1;
      this.sql.exec("UPDATE ra_invoices SET next_sequence = ? WHERE invoice = ?", sequence, invoice);
      this.sql.exec(
        "INSERT INTO ra_reads (invoice, sequence, line, generation, status, started_at) VALUES (?, ?, ?, ?, 'outstanding', ?)",
        invoice, sequence, line, generation, this.now(),
      );
      return { invoice, sequence };
    });
  }

  // A new line or generation abandons every read in flight; their replies can never apply.
  abandonReads() {
    this.sql.exec("UPDATE ra_reads SET status = 'abandoned' WHERE status = 'outstanding'");
  }

  // A read that timed out, so the invoice can be read again.
  abandonRead(invoice, sequence) {
    this.sql.exec("UPDATE ra_reads SET status = 'abandoned' WHERE invoice = ? AND sequence = ? AND status = 'outstanding'", invoice, sequence);
  }

  // Applies one snapshot: frames are begin, payment 0..n-1, end. Answers applied, stale,
  // incomplete or rejected, like the line's ack. The whole snapshot is validated, and its
  // duplicates checked, before anything changes; only `applied` changes receipts. candidate is
  // the object's stored last price, { cents, at } or null: each new receipt keeps it as its
  // pricing intent. Returns the receipts that need a price.
  applySnapshot({ invoice, line, generation, sequence, frames, candidate = null }) {
    this.invoicePolicy(invoice);
    this.freshness();
    const outcome = this.mutate(() => {
      const read = this.row("SELECT * FROM ra_reads WHERE invoice = ? AND sequence = ?", invoice, sequence);
      if (!read || read.status !== "outstanding" || read.line !== line || read.generation !== generation) return { result: "stale" };
      const inv = this.row("SELECT * FROM ra_invoices WHERE invoice = ?", invoice);
      const settle = (status) => this.sql.exec("UPDATE ra_reads SET status = ? WHERE invoice = ? AND sequence = ?", status, invoice, sequence);
      const now = this.now();
      // A reply that arrives after the freshness bound, counted from when the read began, is
      // too old to describe the invoice now, whatever its sequence or line.
      if (now - read.started_at > this.freshness()) {
        settle("stale");
        return { result: "stale" };
      }
      const parsed = parseFrames(frames, inv);
      if (parsed.error) {
        // A contradictory snapshot is quarantined as a whole, visibly, whatever its order.
        if (parsed.conflict) this.flag(invoice, "snapshot-conflict");
        settle(parsed.error);
        return { result: parsed.error };
      }
      const { begin, payments } = parsed;
      // The provider's observation must fall inside the read: not before it began, and not in
      // the future. Anything else is impossible metadata, and the snapshot is refused.
      if (begin.observedAt < read.started_at || begin.observedAt > now) {
        settle("rejected");
        return { result: "rejected" };
      }
      // Freshness counts from the read's start, the oldest the data can be.
      const asOf = read.started_at;
      // The provider's remaining amount and current destination count only with verified
      // capability, and only a destination already bound to this invoice can be payable.
      const left = begin.capabilities.remaining ? begin.left : null;
      let payable = null;
      if (begin.capabilities.destination && begin.destination !== null) {
        const bound = this.row("SELECT invoice FROM ra_addresses WHERE network = ? AND address = ?", inv.network, begin.destination);
        if (bound?.invoice === invoice) payable = begin.destination;
        else this.flag(invoice, "payable-unbound");
      }
      this.sql.exec(
        "UPDATE ra_invoices SET left_sats = ?, left_at = ?, payable_address = ?, payable_at = ?, applied_sequence = ?, applied_at = ?, verified_complete = ? WHERE invoice = ?",
        left, left === null ? null : asOf, payable, payable === null ? null : asOf, sequence, asOf,
        begin.capabilities.complete ? 1 : 0, invoice,
      );
      // The private view changes when the remaining amount or payable address does; a read
      // that only confirms them leaves cursors valid. Either way, finalize republishes if needed.
      if (left !== inv.left_sats || payable !== inv.payable_address) this.bump(invoice);
      else this.touch(invoice);
      const seen = new Set();
      const priced = [];
      for (const payment of payments) {
        const result = this.observe(inv, payment, begin, sequence, candidate);
        if (result.receipt) seen.add(result.receipt);
        if (result.created) priced.push(result.receipt);
      }
      // Absence means something only when the read is verified complete.
      if (begin.capabilities.complete) {
        for (const r of this.rows("SELECT id FROM ra_receipts WHERE invoice = ?", invoice)) {
          if (!seen.has(r.id)) this.hold(r.id, "missing-from-complete-snapshot");
        }
      }
      this.failpoint("snapshot:before-commit");
      settle("applied");
      return { result: "applied", priced };
    });
    // Only once committed may this instance price what it created.
    for (const id of outcome.priced ?? []) this.fresh.add(id);
    return outcome;
  }

  // Inside a transaction: one normalized payment from an applied snapshot.
  observe(inv, p, begin, sequence, candidate) {
    const network = inv.network;
    const caps = begin.capabilities;
    const alias = this.row(
      "SELECT receipt FROM ra_aliases WHERE network = ? AND provider = ? AND store = ? AND provider_id = ?",
      network, begin.provider, begin.store, p.providerId,
    )?.receipt ?? null;
    const verified = isVerified(p, caps);
    let canonical = null;
    if (verified && p.method === "onchain") {
      canonical = this.row("SELECT receipt FROM ra_outputs WHERE network = ? AND txid = ? AND vout = ?", network, p.txid, p.vout)?.receipt ?? null;
    }
    if (verified && p.method === "lightning") {
      canonical = this.row("SELECT receipt FROM ra_lightning WHERE network = ? AND payment_hash = ?", network, p.paymentHash)?.receipt ?? null;
    }
    if (alias && canonical && alias !== canonical) {
      this.hold(alias, "identity-conflict");
      this.hold(canonical, "identity-conflict");
      this.flag(inv.invoice, "identity-conflict");
      return {};
    }
    const existingId = canonical ?? alias;
    if (existingId) return this.observeExisting(inv, existingId, p, begin, sequence, { alias, canonical, verified });

    const id = `r${this.randomHex()}`;
    if (!HEX32.test(id.slice(1)) || id.length !== 33) throw new Error("randomHex must give 32 hex characters");
    const holds = [];
    const trusted = this.trustedSettlement(inv.invoice, p, begin);
    if (!verified) holds.push("identity-unverified");
    if (p.state === "settled" && !trusted) holds.push("confirmation-policy");
    if (p.method === "onchain") {
      if (this.row("SELECT invoice FROM ra_addresses WHERE network = ? AND address = ?", network, p.destination)?.invoice !== inv.invoice) {
        holds.push("destination-unbound");
      }
      if (p.txid !== null && this.row("SELECT 1 FROM ra_import_txs WHERE network = ? AND txid = ?", network, p.txid)) holds.push("import-fence");
    }
    const ord = (this.row("SELECT max(ord) AS ord FROM ra_receipts WHERE invoice = ?", inv.invoice).ord ?? 0) + 1;
    const now = this.now();
    const usable = candidate && isPositive(candidate.cents) && Number.isSafeInteger(candidate.at);
    this.sql.exec(
      "INSERT INTO ra_receipts (id, invoice, ord, network, provider, store, method, sats, state, provider_state, txid, vout, payment_hash, destination, " +
      "created_at, updated_at, price_state, candidate_cents, candidate_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirming', ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)",
      id, inv.invoice, ord, network, begin.provider, begin.store, p.method, p.sats, p.state,
      verified ? p.txid : null, verified ? p.vout : null, verified ? p.paymentHash : null, p.destination, now, now,
      usable ? candidate.cents : null, usable ? candidate.at : null,
    );
    this.addAlias(network, begin, p.providerId, id);
    if (verified) this.addCanonical(network, p, id);
    this.evidence(id, sequence, p, begin, true);
    for (const reason of holds) this.openHold(id, reason);
    if (this.invoicePolicy(inv.invoice).editWindow === "first-observation" || trusted) this.capture(id);
    this.settleState(id, { force: true });
    return { receipt: id, created: true };
  }

  // A payment already known by its alias or canonical identity. Its identity is immutable:
  // method, amount, destination, scope and canonical outpoint or payment hash. Any change is
  // held for review and not applied, so neither its state nor its evidence moves on.
  observeExisting(inv, id, p, begin, sequence, { alias, canonical, verified }) {
    const e = this.row("SELECT * FROM ra_receipts WHERE id = ?", id);
    if (e.invoice !== inv.invoice) {
      this.hold(e.id, "claimed-by-other-invoice");
      this.flag(inv.invoice, "claimed-by-other-invoice");
      return {};
    }
    const changes = [];
    if (p.method !== e.method || e.network !== inv.network || e.provider !== begin.provider || e.store !== begin.store) changes.push("identity-changed");
    if (p.sats !== e.sats) changes.push("amount-changed");
    if (p.method === "onchain" && p.destination !== e.destination) changes.push("destination-changed");
    const known = e.txid !== null || e.payment_hash !== null;
    const differs = p.method === "onchain"
      ? known && p.txid !== null && (p.txid !== e.txid || p.vout !== e.vout)
      : known && p.paymentHash !== null && p.paymentHash !== e.payment_hash;
    if (differs) changes.push("identity-changed");
    if (changes.length) {
      for (const reason of new Set(changes)) this.hold(e.id, reason);
      this.evidence(e.id, sequence, p, begin, false);
      return { receipt: e.id };
    }
    if (!alias) this.addAlias(inv.network, begin, p.providerId, e.id);
    if (verified && !canonical && !known) {
      // Verified evidence for a receipt first seen without it: attach it, apply its fences,
      // and only then clear the unverified hold.
      this.addCanonical(inv.network, p, e.id);
      if (p.method === "onchain" && this.row("SELECT 1 FROM ra_import_txs WHERE network = ? AND txid = ?", inv.network, p.txid)) {
        this.openHold(e.id, "import-fence");
      }
      this.resolveHold(e.id, "identity-unverified", "verified identity observed");
    }
    this.sql.exec("UPDATE ra_receipts SET provider_state = ? WHERE id = ?", p.state, e.id);
    this.evidence(e.id, sequence, p, begin, true);
    // A settlement reported under a confirmation policy other than the invoice's reviewed one
    // is quarantined, and it captures nothing.
    if (this.trustedSettlement(inv.invoice, p, begin)) this.capture(e.id);
    else if (p.state === "settled") this.openHold(e.id, "confirmation-policy");
    this.settleState(e.id);
    return { receipt: e.id };
  }

  // A settled observation counts only when the read reports the provider confirmation policy
  // the invoice was issued against. Anything else, missing or different, is not trusted.
  trustedSettlement(invoice, p, begin) {
    return p.state === "settled" && begin.policyVersion === this.invoicePolicy(invoice).confirmationPolicy;
  }

  addAlias(network, begin, providerId, receipt) {
    this.sql.exec(
      "INSERT INTO ra_aliases (network, provider, store, provider_id, receipt) VALUES (?, ?, ?, ?, ?)",
      network, begin.provider, begin.store, providerId, receipt,
    );
  }

  addCanonical(network, p, receipt) {
    if (p.method === "onchain") {
      this.sql.exec("INSERT INTO ra_outputs (network, txid, vout, receipt) VALUES (?, ?, ?, ?)", network, p.txid, p.vout, receipt);
      this.sql.exec("UPDATE ra_receipts SET txid = ?, vout = ? WHERE id = ?", p.txid, p.vout, receipt);
    } else {
      this.sql.exec("INSERT INTO ra_lightning (network, payment_hash, receipt) VALUES (?, ?, ?)", network, p.paymentHash, receipt);
      this.sql.exec("UPDATE ra_receipts SET payment_hash = ? WHERE id = ?", p.paymentHash, receipt);
    }
  }

  // What was observed, and whether it was applied: evidence never claims a state the receipt
  // didn't take.
  evidence(receipt, sequence, p, begin, applied) {
    this.sql.exec(
      "INSERT INTO ra_evidence (receipt, sequence, provider_state, sats, block_hash, block_height, confirmations, policy_version, provenance, observed_at, complete, applied) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      receipt, sequence, p.state, p.sats, p.blockHash, p.blockHeight, p.confirmations, begin.policyVersion, begin.provenance,
      begin.observedAt, begin.capabilities.complete ? 1 : 0, applied ? 1 : 0,
    );
  }

  // An invoice-level review: conflicts that name no receipt of the invoice's own.
  flag(invoice, reason) {
    if (!this.row("SELECT 1 FROM ra_reviews WHERE invoice = ? AND reason = ? AND resolved_at IS NULL", invoice, reason)) {
      this.sql.exec("INSERT INTO ra_reviews (invoice, reason, at) VALUES (?, ?, ?)", invoice, reason, this.now());
    }
    this.bump(invoice);
  }

  openHold(receipt, reason) {
    if (!HOLDS.includes(reason)) throw new Error(`unknown hold ${reason}`);
    this.sql.exec("INSERT INTO ra_holds (receipt, reason, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", receipt, reason, this.now());
  }

  hold(receipt, reason) {
    if (!this.row("SELECT 1 FROM ra_receipts WHERE id = ?", receipt)) return;
    this.openHold(receipt, reason);
    this.settleState(receipt);
  }

  resolveHold(receipt, reason, resolution) {
    this.sql.exec(
      "UPDATE ra_holds SET resolved_at = ?, resolution = ? WHERE receipt = ? AND reason = ? AND resolved_at IS NULL",
      this.now(), resolution, receipt, reason,
    );
  }

  held(receipt) {
    return this.row("SELECT 1 FROM ra_holds WHERE receipt = ? AND resolved_at IS NULL", receipt) !== null;
  }

  holds(receipt) {
    return this.rows("SELECT reason FROM ra_holds WHERE receipt = ? AND resolved_at IS NULL ORDER BY id", receipt).map((r) => r.reason);
  }

  // Captures the receipt's attribution snapshot once, from the invoice's durable record, and
  // ends the invoice's edit window. Called inside the observing transaction, before any lookup.
  capture(receipt) {
    const r = this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
    if (r.attr_captured) return;
    const inv = this.row("SELECT * FROM ra_invoices WHERE invoice = ?", r.invoice);
    const verified = inv.owner !== null && inv.handle.toLowerCase() === inv.login.toLowerCase() ? 1 : 0;
    this.sql.exec(
      "UPDATE ra_receipts SET attr_captured = 1, handle = ?, attr_message = ?, verified = ? WHERE id = ?",
      inv.handle, inv.message, verified, receipt,
    );
    if (inv.editable) {
      this.sql.exec("UPDATE ra_invoices SET editable = 0 WHERE invoice = ?", r.invoice);
      this.bump(r.invoice);
    }
  }

  // The state a receipt should be in now, from its provider state, holds, credit and price.
  target(r) {
    if (this.held(r.id)) return "review";
    switch (r.provider_state) {
      case "settled":
        return r.credit > 0 || r.price_state === "frozen" ? "credited" : "confirming";
      case "observed":
        return r.credit > 0 ? "review" : "confirming";
      case "unaccounted":
        return "review";
      case "invalid":
        if (r.credit > 0) return "review";
        return r.first_credited_seq !== null ? "reversed" : "invalid";
    }
    throw new Error(`unknown provider state ${r.provider_state}`);
  }

  // Moves a receipt to its target state as one revision. force makes a revision even when the
  // state stays, as a first observation or a price freeze does.
  settleState(receipt, { force = false } = {}) {
    const r = this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
    const state = this.target(r);
    if (!force && state === r.state) return;
    const ledger = state === "credited" && r.credit === 0 ? { kind: "credit", reason: `provider ${r.provider_state}` } : null;
    this.transition(r, state, ledger);
  }

  // One revision: receipt state, ledger entry, pile delta, invoice revision, feed frame and
  // outbox row, all inside the caller's transaction. The frame's invoice totals are filled in
  // when the transaction finishes, so they are always the committed ones.
  transition(r, state, ledger) {
    const now = this.now();
    const revision = r.revision + 1;
    let credit = r.credit;
    let ledgerSeq = null;
    if (ledger) {
      const sign = ledger.kind === "credit" ? 1 : -1;
      const milli = r.milli ?? 0;
      ledgerSeq = this.sql.exec(
        "INSERT INTO ra_ledger (receipt, transition, kind, sats, milli, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        r.id, revision, ledger.kind, sign * r.sats, sign * milli, now, ledger.reason,
      ).toArray()[0].seq;
      this.failpoint("transition:ledger");
      this.sql.exec("INSERT INTO ra_pile_deltas (ledger_seq, sats, milli, at) VALUES (?, ?, ?, ?)", ledgerSeq, sign * r.sats, sign * milli, now);
      credit = ledger.kind === "credit" ? r.sats : 0;
    }
    const seq = this.sql.exec(
      "INSERT INTO ra_feed (kind, invoice, receipt, revision, at, payload) VALUES ('receipt', ?, ?, ?, ?, '') RETURNING seq",
      r.invoice, r.id, revision, now,
    ).toArray()[0].seq;
    const first = r.first_credited_seq ?? (state === "credited" ? seq : null);
    this.sql.exec(
      "UPDATE ra_receipts SET state = ?, credit = ?, revision = ?, updated_at = ?, first_credited_seq = ? WHERE id = ?",
      state, credit, revision, now, first, r.id,
    );
    if (first === seq) this.firstCredit(r.id);
    this.revise(r.invoice);
    this.failpoint("transition:feed");
    this.sql.exec("UPDATE ra_feed SET payload = ? WHERE seq = ?", JSON.stringify({ receipt: this.publicReceipt(r.id) }), seq);
    this.sql.exec("INSERT INTO ra_outbox (feed_seq, ledger_seq, created_at) VALUES (?, ?, ?)", seq, ledgerSeq, now);
    this.touch(r.invoice, seq);
    this.failpoint("transition:outbox");
  }

  // At the first credit, the message rule decides, once, whether this receipt carries the
  // invoice's message. Attribution was captured at the settled observation, before any lookup.
  firstCredit(receipt) {
    const r = this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
    if (!r.attr_captured) throw new Error("a receipt credited without its attribution captured");
    // The invoice's own saved rule, read inside the crediting transaction, so a missing one
    // rolls it all back.
    const { messageRule } = this.invoicePolicy(r.invoice);
    const inv = this.row("SELECT message_min_sats, message_receipt FROM ra_invoices WHERE invoice = ?", r.invoice);
    let message = "";
    const qualifies = r.attr_message && r.sats >= inv.message_min_sats;
    if (qualifies && messageRule === "each-qualifying") message = r.attr_message;
    if (qualifies && messageRule === "once" && inv.message_receipt === null) {
      message = r.attr_message;
      this.sql.exec("UPDATE ra_invoices SET message_receipt = ? WHERE invoice = ?", receipt, r.invoice);
    }
    this.sql.exec("UPDATE ra_receipts SET message = ? WHERE id = ?", message, receipt);
  }

  // --- Pricing ------------------------------------------------------------------------------

  // Starts this instance's one lookup for a receipt it created. False for anything else: an
  // intent from before a restart, one already being looked up, or one already frozen.
  beginPricing(receipt) {
    if (!this.fresh.has(receipt)) return false;
    this.fresh.delete(receipt);
    const r = this.row("SELECT price_state FROM ra_receipts WHERE id = ?", receipt);
    if (!r || r.price_state !== "intent") return false;
    this.inflight.add(receipt);
    return true;
  }

  // Freezes a price from this instance's own lookup. fresh is { cents, at } or null when the
  // lookup failed, which falls back to the stored candidate, marked stale, as receipts do
  // today. The lookup is spent before the transaction: if the freeze fails, the receipt can only
  // be recovered, never sampled again.
  freezePrice(receipt, fresh) {
    if (!this.inflight.has(receipt)) throw new Error("no lookup of this instance's is pricing that receipt");
    this.receiptPolicy(receipt);
    this.inflight.delete(receipt);
    if (fresh !== null && (!isPositive(fresh?.cents) || !Number.isSafeInteger(fresh?.at))) throw new Error("invalid price");
    return this.mutate(() => this.freeze(receipt, fresh));
  }

  freeze(receipt, fresh) {
    const r = this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
    if (r.price_state === "frozen") return r;
    const price = fresh ? { cents: fresh.cents, at: fresh.at, stale: 0 }
      : r.candidate_cents !== null ? { cents: r.candidate_cents, at: r.candidate_at, stale: 1 } : null;
    const milli = price ? milliBananas(r.sats, price.cents) : null;
    if (milli !== null && !Number.isSafeInteger(milli)) throw new RangeError("a banana count outside the safe range");
    this.sql.exec(
      "UPDATE ra_receipts SET price_state = 'frozen', price_cents = ?, price_at = ?, price_stale = ?, milli = ? WHERE id = ?",
      price?.cents ?? null, price?.at ?? null, price ? price.stale : null, milli, receipt,
    );
    this.failpoint("price:frozen");
    // A frozen price is public, so it is always a new revision, even when the state stays.
    this.settleState(receipt, { force: true });
    return this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
  }

  // Intents whose lookup was lost to a restart or a failed freeze.
  interruptedPricing() {
    return this.rows(
      "SELECT id FROM ra_receipts r WHERE price_state = 'intent' AND NOT EXISTS " +
      "(SELECT 1 FROM ra_holds h WHERE h.receipt = r.id AND h.reason = 'pricing-interrupted' AND h.resolved_at IS NULL) ORDER BY created_at, id",
    ).map((r) => r.id).filter((id) => !this.inflight.has(id) && !this.fresh.has(id));
  }

  // Resolves an interrupted lookup without a new market sample, by the recovery rule saved with
  // the receipt's invoice: freeze the stored candidate as stale (or null), or quarantine it.
  // Nothing passed in at startup can choose the outcome.
  recoverPricing(receipt) {
    if (arguments.length !== 1) throw new Error("recovery follows the invoice's saved rule; it takes no policy");
    const policy = this.receiptPolicy(receipt)?.pricingRecovery;
    if (this.inflight.has(receipt) || this.fresh.has(receipt)) throw new Error("that receipt's lookup belongs to this instance");
    return this.mutate(() => {
      const r = this.row("SELECT price_state FROM ra_receipts WHERE id = ?", receipt);
      if (!r || r.price_state !== "intent") return r;
      if (policy === "review") return this.hold(receipt, "pricing-interrupted");
      return this.freeze(receipt, null);
    });
  }

  // --- Corrections --------------------------------------------------------------------------

  // An auditable reversal of a credited receipt under review. Its first-credit identity stays.
  reverse(receipt, reason) {
    if (typeof reason !== "string" || !reason) throw new Error("a reversal needs a reason");
    return this.mutate(() => {
      const r = this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
      if (!r || r.state !== "review" || r.credit === 0) return { error: "not reversible" };
      // Any hold still keeps it in review; otherwise it stays reversed until the provider settles it again.
      this.transition(r, this.held(r.id) ? "review" : "reversed", { kind: "reversal", reason });
      return { ok: true };
    });
  }

  // A reviewed resolution of one hold. Other open holds keep the receipt in review, and holds
  // that only evidence may clear can't be released here.
  releaseHold(receipt, reason, resolution) {
    if (typeof resolution !== "string" || !resolution) throw new Error("a release needs a resolution");
    if (UNRELEASABLE.has(reason)) return { error: "unreleasable" };
    this.receiptPolicy(receipt);
    return this.mutate(() => {
      if (!this.row("SELECT 1 FROM ra_holds WHERE receipt = ? AND reason = ? AND resolved_at IS NULL", receipt, reason)) return { error: "not held" };
      this.resolveHold(receipt, reason, resolution);
      // A reviewed release of an untrusted settlement is the point it becomes trusted.
      if (reason === "confirmation-policy" && this.row("SELECT 1 FROM ra_receipts WHERE id = ? AND provider_state = 'settled'", receipt)) this.capture(receipt);
      this.settleState(receipt);
      return { ok: true, holds: this.holds(receipt) };
    });
  }

  // A reviewed resolution of an invoice-level flag.
  resolveFlag(invoice, reason, resolution) {
    if (typeof resolution !== "string" || !resolution) throw new Error("a resolution is required");
    return this.mutate(() => {
      this.sql.exec(
        "UPDATE ra_reviews SET resolved_at = ?, resolution = ? WHERE invoice = ? AND reason = ? AND resolved_at IS NULL",
        this.now(), resolution, invoice, reason,
      );
      this.bump(invoice);
      return { ok: true };
    });
  }

  // Publishes what time alone changed: a remaining amount or payable address that is no longer
  // fresh is withdrawn, and pages hear it as an invoiceStatus frame.
  refreshFreshness() {
    // Only invoices holding something that has just gone stale or expired, so this stays
    // bounded by what changed rather than by every invoice ever issued.
    const stale = this.staleInvoices();
    return this.mutate(() => {
      for (const invoice of stale) this.touch(invoice);
    });
  }

  // --- Views --------------------------------------------------------------------------------

  // pricing is null while the intent is unresolved. Once frozen it is an object, and a rate
  // and bananas of null mean permanently unpriced: sats counted, zero bananas.
  publicReceipt(receipt) {
    const r = this.row("SELECT * FROM ra_receipts WHERE id = ?", receipt);
    const shown = r.first_credited_seq !== null;
    return {
      id: r.id, invoice: r.invoice, method: r.method, sats: r.sats, credit: r.credit, state: r.state,
      revision: r.revision, at: r.updated_at, firstCreditedSeq: r.first_credited_seq,
      handle: shown ? r.handle : "", message: shown ? r.message ?? "" : "", verified: shown && r.verified === 1,
      pricing: r.price_state === "frozen" ? {
        receivedAt: r.created_at,
        rate: r.price_cents === null ? null : { ...rateOf(r.price_cents, r.price_at), stale: r.price_stale === 1 },
        bananas: bananasOf(r.milli),
      } : null,
    };
  }

  // Without a configured bound nothing counts as fresh: a remaining amount, payable address or
  // usable BOLT11 is reported unknown, never assumed current.
  isFresh(at) {
    return at !== null && this.freshnessMs !== null && this.now() - at <= this.freshnessMs;
  }

  // The invoice's authoritative cumulative totals, summed with overflow checks. left is the
  // provider's verified remaining amount from a fresh read, or null.
  totals(invoice) {
    const inv = this.row("SELECT * FROM ra_invoices WHERE invoice = ?", invoice);
    let received = 0, credited = 0, review = 0, confirming = 0;
    for (const r of this.rows("SELECT state, sats, credit FROM ra_receipts WHERE invoice = ?", invoice)) {
      if (r.state !== "invalid" && r.state !== "reversed") received = safeAdd(received, r.sats);
      credited = safeAdd(credited, r.credit);
      if (r.state === "review") review = safeAdd(review, r.sats);
      if (r.state === "confirming") confirming += 1;
    }
    const flagged = this.row("SELECT 1 FROM ra_reviews WHERE invoice = ? AND resolved_at IS NULL", invoice);
    const left = this.isFresh(inv.left_at) ? inv.left_sats : null;
    const state = review > 0 || flagged ? "review"
      : left === 0 && confirming === 0 && credited > 0 ? "paid"
      : left === 0 && confirming > 0 ? "confirming"
      : received > 0 ? "partial" : "unpaid";
    return { id: invoice, due: inv.due, received, credited, review, left, state, revision: inv.revision };
  }

  // The original BOLT11 asks for the full target. It stays withdrawn for good once any receipt
  // has ever been observed on the invoice, whatever became of it: invalid, reversed or netting
  // to zero, nothing brings it back. v1 has no verified replacement code for the remaining
  // amount. This is only a necessary guard: showing the code also needs fresh provider evidence
  // that it is usable, unexpired and unpaid, which the API wrapper must check, and a page can
  // never infer it from totals.
  originalBolt11Allowed(invoice) {
    if (!this.row("SELECT 1 FROM ra_invoices WHERE invoice = ?", invoice)) return false;
    return this.row("SELECT 1 FROM ra_receipts WHERE invoice = ?", invoice) === null;
  }

  // The address the provider currently offers, from fresh verified evidence, already bound to
  // this invoice; null otherwise. An address in the history never implies it is payable now.
  payableAddress(invoice) {
    const inv = this.row("SELECT payable_address, payable_at FROM ra_invoices WHERE invoice = ?", invoice);
    return inv && this.isFresh(inv.payable_at) ? inv.payable_address : null;
  }

  // The private status: totals, the payable address, and newest-first pages of receipts and
  // addresses. Both cursors are bound to their kind, the invoice, the reader and the invoice's
  // revision; a malformed, expired or foreign one is `cursor`, a changed revision `resync`.
  privateStatus(invoice, { requestHash = null, donorId = null, cursor = null, addressCursor = null, receiptLimit, addressLimit, ttlMs }) {
    for (const v of [receiptLimit, addressLimit, ttlMs]) {
      if (!isPositive(v)) throw new PolicyRequired("page size and cursor lifetime");
    }
    if (receiptLimit > PRIVATE_PAGE_MAX || addressLimit > PRIVATE_PAGE_MAX) throw new RangeError(`a private page carries at most ${PRIVATE_PAGE_MAX} rows`);
    const principal = this.principal(invoice, { requestHash, donorId });
    if (!principal) return { error: "unknown" };
    // Only for an authorized reader: commit whatever time has withdrawn, with its revision and
    // feed signal, before reading the revision or judging any cursor against it.
    this.mutate(() => this.touch(invoice));
    const { revision } = this.row("SELECT revision FROM ra_invoices WHERE invoice = ?", invoice);
    const scope = `${invoice}|${principal}`;
    const position = (value, kind) => {
      if (value === null) return { position: Number.MAX_SAFE_INTEGER };
      const c = readCursor(value, kind, scope, this.now(), ttlMs);
      if (c.error) return c;
      return c.revision === revision ? c : { error: "resync" };
    };
    const r = position(cursor, "receipts");
    const a = position(addressCursor, "addresses");
    for (const c of [r, a]) if (c.error === "cursor") return c;
    for (const c of [r, a]) if (c.error) return c;
    const receiptRows = this.rows("SELECT id, ord FROM ra_receipts WHERE invoice = ? AND ord < ? ORDER BY ord DESC LIMIT ?", invoice, r.position, receiptLimit + 1);
    const addressRows = this.rows("SELECT address, ord, issued_at FROM ra_addresses WHERE invoice = ? AND ord < ? ORDER BY ord DESC LIMIT ?", invoice, a.position, addressLimit + 1);
    const page = (rows, limit, kind) => ({
      items: rows.slice(0, limit),
      next: rows.length > limit ? makeCursor(kind, scope, revision, rows[limit - 1].ord, this.now()) : null,
    });
    const receipts = page(receiptRows, receiptLimit, "receipts");
    const addresses = page(addressRows, addressLimit, "addresses");
    return {
      invoice: this.totals(invoice),
      payableAddress: this.payableAddress(invoice),
      addresses: addresses.items.map((row) => ({ address: row.address, issuedAt: row.issued_at })),
      nextAddress: addresses.next,
      receipts: receipts.items.map((row) => this.publicReceipt(row.id)),
      next: receipts.next,
    };
  }

  // The invoice a request token's hash belongs to, or null.
  invoiceForRequest(requestHash) {
    return typeof requestHash === "string" ? this.row("SELECT invoice FROM ra_invoices WHERE request_hash = ?", requestHash)?.invoice ?? null : null;
  }

  hasMappings() {
    return this.row("SELECT 1 FROM ra_invoices") !== null;
  }

  // The endpoint's reply for POST /donations/status: the core status, with what the page needs
  // about the original invoice. The original BOLT11 is offered only while no receipt has ever
  // been observed, the invoice hasn't expired, and the provider has freshly verified the code
  // is still usable; otherwise it is null and Lightning reads as unavailable or expired. Nothing
  // is guessed: an invoice without whole saved metadata is answered 503 closed, for that invoice
  // alone, until an operator reconciles it; expires is always the saved number.
  statusReply(invoice, access) {
    // Access first, so an unauthorized reader learns and changes nothing.
    if (!this.principal(invoice, access)) return { error: "unknown" };
    // A mapping without its whole original metadata is closed until reconciled.
    if (!metadataComplete(this.row("SELECT expires, lightning, bolt11 FROM ra_invoices WHERE invoice = ?", invoice))) return { error: "closed" };
    const core = this.privateStatus(invoice, access);
    if (core.error) return core;
    // Read after the core committed what time changed: expiry and the code's verification age
    // are revisions, so they never differ at an unchanged revision.
    const meta = this.row("SELECT expires, lightning, bolt11, bolt11_verified_at, expiry_committed FROM ra_invoices WHERE invoice = ?", invoice);
    const usable = meta.lightning === "available" && this.originalBolt11Allowed(invoice) && this.isFresh(meta.bolt11_verified_at);
    const lightning = meta.expiry_committed ? "expired" : meta.lightning === "limit" ? "limit" : usable ? "available" : "unavailable";
    const t = core.invoice;
    return {
      invoice: {
        id: t.id, accounting: MODE, due: t.due, received: t.received, credited: t.credited, review: t.review,
        left: t.left, state: t.state, revision: t.revision, expires: meta.expires, lightning,
        bolt11: lightning === "available" ? meta.bolt11 : null,
      },
      payableAddress: core.payableAddress,
      addresses: core.addresses,
      nextAddress: core.nextAddress,
      receipts: core.receipts,
      next: core.next,
    };
  }

  // A signed-in account's own receipt-mode invoices, newest first, by stable account id only.
  // The cursor is bound to the account and its history revision, which moves with any change to
  // any of its invoices; a stale one is `resync`. No request token or address appears.
  accountHistory(owner, { cursor = null, limit, ttlMs }) {
    if (!isPositive(limit) || !isPositive(ttlMs)) throw new PolicyRequired("page size and cursor lifetime");
    if (limit > PRIVATE_PAGE_MAX) throw new RangeError(`a private page carries at most ${PRIVATE_PAGE_MAX} rows`);
    if (!isPositive(owner)) return { error: "unknown" };
    // Commit what time has withdrawn from this account's invoices first, touching only the
    // stale ones, so entries never change at an old revision.
    const stale = this.staleInvoices(owner);
    if (stale.length) this.mutate(() => { for (const invoice of stale) this.touch(invoice); });
    const revision = this.row("SELECT revision FROM ra_accounts WHERE owner = ?", owner)?.revision ?? 0;
    const scope = `account:${owner}`;
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor !== null) {
      const c = readCursor(cursor, "history", scope, this.now(), ttlMs);
      if (c.error) return c;
      if (c.revision !== revision) return { error: "resync" };
      before = c.position;
    }
    const rows = this.rows("SELECT invoice, ord, created, handle, expires, lightning, bolt11 FROM ra_invoices WHERE owner = ? AND ord < ? ORDER BY ord DESC LIMIT ?", owner, before, limit + 1);
    const page = rows.slice(0, limit);
    // A mapping made without its whole original metadata can't be shown as agreed. Only the page
    // holding it is closed, until it is reconciled: it is never omitted, and its expiry is never
    // filled in by a guess. Other pages, and their cursors, are unaffected.
    if (page.some((r) => !metadataComplete(r))) return { error: "closed" };
    return {
      revision,
      invoices: page.map((r) => {
        const t = this.totals(r.invoice);
        return { id: r.invoice, accounting: MODE, createdAt: r.created, handle: r.handle, due: t.due, received: t.received,
          credited: t.credited, review: t.review, left: t.left, state: t.state, revision: t.revision, expires: r.expires };
      }),
      next: rows.length > limit ? makeCursor("history", scope, revision, page.at(-1).ord, this.now()) : null,
    };
  }

  // The newest receipts that have been credited, still credited or held for review since, for
  // a page that connects. Ordered by when each was first observed, its first feed frame, which
  // never changes, so a late credit or a correction can't push a newer receipt out. Never
  // animated.
  recentReceipts(limit) {
    if (!isPositive(limit)) throw new PolicyRequired("recent receipts size");
    return this.rows(
      "SELECT r.id FROM ra_receipts r JOIN ra_feed f ON f.receipt = r.id AND f.revision = 1 " +
      "WHERE r.first_credited_seq IS NOT NULL AND r.state IN ('credited', 'review') ORDER BY f.seq DESC LIMIT ?",
      limit,
    ).map((r) => this.publicReceipt(r.id));
  }

  // Up to limit feed frames committed after seq, oldest first, as stored; for the object's live
  // broadcast, which resumes from its own durable mark.
  feedSince(seq, limit) {
    if (!isPositive(limit)) throw new PolicyRequired("broadcast batch size");
    return this.rows("SELECT seq, payload FROM ra_feed WHERE seq > ? ORDER BY seq LIMIT ?", seq, limit)
      .map((r) => ({ seq: r.seq, frame: JSON.parse(r.payload) }));
  }

  feedHighWater() {
    return this.row("SELECT max(seq) AS seq FROM ra_feed").seq ?? 0;
  }

  // Receipt and invoiceStatus frames after a cursor, bounded, against the high-water mark taken
  // now. A gap larger than the bound, or a cursor past the mark, replays nothing and says so.
  feedAfter(after, { limit }) {
    if (!isPositive(limit)) throw new PolicyRequired("replay bound");
    const through = this.row("SELECT max(seq) AS seq FROM ra_feed").seq ?? null;
    if (after === null) return { frames: [], after: null, through, complete: true };
    if (!Number.isSafeInteger(after) || after < 0) return { error: "invalid" };
    if (through === null) return { frames: [], after, through, complete: after === 0 };
    const waiting = this.row("SELECT count(*) AS n FROM ra_feed WHERE seq > ? AND seq <= ?", after, through).n;
    if (after > through || waiting > limit) return { frames: [], after, through, complete: false };
    const frames = this.rows("SELECT payload FROM ra_feed WHERE seq > ? AND seq <= ? ORDER BY seq", after, through)
      .map((r) => ({ ...JSON.parse(r.payload), replay: true }));
    return { frames, after, through, complete: true };
  }

  // The projection's work: outbox rows to apply to D1, oldest first, and their removal once a
  // batch has applied them. A crash between the two leaves the row, so it is applied again,
  // idempotently, by its (receipt, revision) marker.
  pendingProjections(limit) {
    if (!isPositive(limit)) throw new Error("a projection batch needs a size");
    return this.rows(
      "SELECT o.id, o.feed_seq, o.ledger_seq, f.receipt, f.revision, f.payload FROM ra_outbox o JOIN ra_feed f ON f.seq = o.feed_seq ORDER BY o.id LIMIT ?",
      limit,
    );
  }

  // Removes an applied outbox row. publish: the applied batch may have moved lifetime figures,
  // so pages must be sent D1's current ones; recorded durably in the same step, so a crash or a
  // failed read before they go out leaves the work to do, never a silently stale page.
  projected(id, { publish = false } = {}) {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ra_outbox WHERE id = ?", id);
      if (publish) {
        this.sql.exec("INSERT INTO meta (key, value) VALUES ('projection_publish', 1) ON CONFLICT (key) DO UPDATE SET value = 1");
      }
    });
  }

  publicationPending() {
    return (this.row("SELECT value FROM meta WHERE key = 'projection_publish'")?.value ?? 0) === 1;
  }

  // Cleared only after D1's current figures have actually gone out.
  published() {
    this.sql.exec("UPDATE meta SET value = 0 WHERE key = 'projection_publish'");
  }

  projectionConflict() {
    return this.row("SELECT 1 FROM ra_projection_conflicts WHERE resolved_at IS NULL") !== null;
  }

  // What the D1 projection applies, one committed receipt revision per outbox row, oldest
  // first. No address, provider id or outpoint. owner is the invoice's saved stable account id,
  // or null: it goes only into D1's private account totals, never into any public frame. The
  // credited milli is the receipt's frozen price, which never changes after its freeze, so a
  // reversal and a reconfirmation carry the same value. observed is the feed sequence of the
  // receipt's first revision: the feed is never pruned and its sequence never reused, so it is
  // the same on every revision, and orders receipts first observed in the same millisecond.
  // Nothing while a conflict waits for
  // review: the projection keeps strict order rather than skip past it.
  projectionWork(limit) {
    if (!isPositive(limit)) throw new PolicyRequired("projection batch size");
    if (this.projectionConflict()) return [];
    return this.rows(
      "SELECT o.id, f.receipt, f.revision, f.seq, f.payload, r.milli, r.created_at, i.owner, " +
      "(SELECT min(seq) FROM ra_feed WHERE receipt = f.receipt) AS observed FROM ra_outbox o " +
      "JOIN ra_feed f ON f.seq = o.feed_seq JOIN ra_receipts r ON r.id = f.receipt JOIN ra_invoices i ON i.invoice = r.invoice " +
      "ORDER BY o.id LIMIT ?",
      limit,
    ).map((row) => {
      const view = JSON.parse(row.payload).receipt;
      return {
        id: row.id, receipt: row.receipt, revision: row.revision, seq: row.seq, observed: row.observed, invoice: view.invoice,
        state: view.state, sats: view.sats, credit: view.credit, milli: view.credit > 0 ? row.milli ?? 0 : 0,
        handle: view.handle, owner: row.owner, receivedAt: row.created_at,
      };
    });
  }

  hasPendingProjection() {
    return this.row("SELECT 1 FROM ra_outbox") !== null;
  }

  // A projection that can't be applied safely: kept for review, and the projection stops.
  recordProjectionConflict(outbox, receipt, revision, reason) {
    this.sql.exec(
      "INSERT INTO ra_projection_conflicts (outbox_id, receipt, revision, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (outbox_id) DO NOTHING",
      outbox, receipt, revision, reason, this.now(),
    );
  }

  // The receipt pile journal for the object's bridge to the authoritative pile: entries after a
  // ledger sequence, oldest first, each with its permanent identity, (receipt, transition), and
  // its invoice. Bounded by the caller.
  pileEntriesAfter(seq, limit) {
    if (!isPositive(limit)) throw new PolicyRequired("pile bridge batch size");
    return this.rows(
      "SELECT d.ledger_seq AS seq, l.receipt, l.transition, r.invoice, d.sats, d.milli, d.at FROM ra_pile_deltas d " +
      "JOIN ra_ledger l ON l.seq = d.ledger_seq JOIN ra_receipts r ON r.id = l.receipt WHERE d.ledger_seq > ? ORDER BY d.ledger_seq LIMIT ?",
      seq, limit,
    );
  }

  pileEntryHighWater() {
    return this.row("SELECT max(ledger_seq) AS seq FROM ra_pile_deltas").seq ?? 0;
  }

  // What receipts held for review still credit: the pile's uncertain amount, in sats and banana
  // thousandths. Null if a sum can't be represented exactly.
  reviewCredit() {
    let sats = 0, milli = 0;
    for (const r of this.rows("SELECT sats, credit, milli FROM ra_receipts INDEXED BY ra_receipts_review WHERE state = 'review'")) {
      if (r.credit <= 0) continue;
      const s = sats + r.credit, m = milli + (r.milli ?? 0);
      if (!Number.isSafeInteger(s) || !Number.isSafeInteger(m)) return null;
      sats = s;
      milli = m;
    }
    return { sats, milli };
  }

  // The pile's change from receipts, summed over the whole journal. For checks only; the object
  // bridges entries to the authoritative pile one at a time, by their identity.
  pileDelta() {
    let sats = 0, milli = 0;
    for (const row of this.rows("SELECT sats, milli FROM ra_pile_deltas")) {
      sats = safeAdd(sats, row.sats);
      milli = safeAdd(milli, row.milli);
    }
    return { sats, milli };
  }

  // Truthful health: off with no receipt-mode invoice; review while anything is quarantined;
  // current only when every invoice's latest read applied, was verified complete and is still
  // fresh, and nothing waits; otherwise behind.
  // Without a configured freshness bound, nothing can be current: behind.
  health() {
    if (!this.row("SELECT 1 FROM ra_invoices")) return "off";
    if (this.row("SELECT 1 FROM ra_reviews WHERE resolved_at IS NULL") || this.row("SELECT 1 FROM ra_holds WHERE resolved_at IS NULL") ||
        this.row("SELECT 1 FROM ra_receipts WHERE state = 'review'")) return "review";
    // A projection conflict: D1 disagrees with a committed revision, and draining has stopped.
    if (this.row("SELECT 1 FROM ra_projection_conflicts WHERE resolved_at IS NULL")) return "review";
    // Mappings without saved read settings or whole metadata wait on an operator's reconciliation.
    if (!this.readSettings() || this.row(`SELECT 1 FROM ra_invoices WHERE ${INCOMPLETE_METADATA}`)) return "review";
    const bound = this.freshnessMs;
    if (bound === null) return "behind";
    const now = this.now();
    const lagging = this.row(
      "SELECT 1 FROM ra_invoices i WHERE verified_complete = 0 OR applied_at IS NULL OR ? - applied_at > ? OR " +
      "(SELECT status FROM ra_reads r WHERE r.invoice = i.invoice ORDER BY sequence DESC LIMIT 1) IS NOT 'applied'",
      now, bound,
    );
    const waiting = lagging || this.row("SELECT 1 FROM ra_outbox") || this.row("SELECT 1 FROM ra_receipts WHERE price_state = 'intent'");
    return waiting ? "behind" : "current";
  }
}

// An amount-bearing QR is allowed only for the payable address, with a current positive
// remaining amount. Otherwise the page shows the bare address and says the amount is unknown.
export function qrAmount(status, selectedAddress) {
  const left = status?.invoice?.left;
  return status?.payableAddress !== null && selectedAddress === status?.payableAddress && isPositive(left) ? left : null;
}

const isPositive = (v) => Number.isSafeInteger(v) && v > 0;

function safeAdd(a, b) {
  const sum = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(sum)) throw new RangeError("an amount outside the safe range");
  return sum;
}

// The object's display rule: an explicit handle is cleaned (empty becomes `anon`), and no
// handle at all stays empty.
const displayHandle = (handle) => (typeof handle === "string" ? cleanHandle(handle) : "");

const isVerified = (p, caps) => p.method === "onchain"
  ? caps.outpoints && p.txid !== null && p.vout !== null
  : caps.lightningSuccess && p.paymentHash !== null;

// --- Frames ---------------------------------------------------------------------------------

const isInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const nullOr = (check) => (v) => v === null || check(v);
const isBool = (v) => v === true || v === false;

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

const BEGIN = ["frame", "status", "left", "destination", "provider", "store", "observedAt", "provenance", "policyVersion", "capabilities"];
const PAYMENT = ["method", "providerId", "sats", "state", "txid", "vout", "destination", "paymentHash", "blockHash", "blockHeight", "confirmations"];

// Validates the whole snapshot, canonicalizes its addresses, and checks its duplicates, before
// anything is applied. Exact repeats collapse; any two entries for one payment that disagree
// make the snapshot a conflict, whatever their order.
function parseFrames(frames, inv) {
  if (!Array.isArray(frames) || frames.length < 2) return { error: "incomplete" };
  const [begin, ...rest] = frames;
  const end = rest.pop();
  if (begin?.frame !== "begin" || end?.frame !== "end") return { error: "incomplete" };
  if (!exactKeys(end, ["frame", "count"]) || !isInt(end.count) || end.count !== rest.length) return { error: "incomplete" };
  const caps = begin.capabilities;
  if (!exactKeys(begin, BEGIN) || typeof begin.status !== "string" || !nullOr(isInt)(begin.left) ||
      !SCOPE.test(begin.provider) || !SCOPE.test(begin.store) || !isInt(begin.observedAt, 1) ||
      !PROVENANCE.includes(begin.provenance) || !nullOr((v) => typeof v === "string" && v.length <= 64)(begin.policyVersion) ||
      !exactKeys(caps, CAPABILITIES) || !Object.values(caps).every(isBool)) {
    return { error: "rejected" };
  }
  if (begin.left !== null && begin.left > MAX_SATS) return { error: "rejected" };
  if (begin.provider !== inv.provider || begin.store !== inv.store) return { error: "rejected" };
  let destination = null;
  if (begin.destination !== null) {
    destination = canonicalAddress(begin.destination, inv.network);
    if (!destination) return { error: "rejected" };
  }
  const payments = [];
  for (const [index, frame] of rest.entries()) {
    if (!exactKeys(frame, ["frame", "index", "payment"]) || frame.frame !== "payment") return { error: "incomplete" };
    if (frame.index !== index) return { error: "incomplete" };
    const p = frame.payment;
    if (!exactKeys(p, PAYMENT) || !["onchain", "lightning"].includes(p.method) || typeof p.providerId !== "string" || !PROVIDER_ID.test(p.providerId) ||
        !isInt(p.sats, 1) || p.sats > MAX_SATS || !PROVIDER_STATES.includes(p.state) ||
        !nullOr((v) => typeof v === "string" && HEX64.test(v))(p.txid) || !nullOr(isInt)(p.vout) ||
        !nullOr((v) => typeof v === "string" && HEX64.test(v))(p.paymentHash) || !nullOr((v) => typeof v === "string" && HEX64.test(v))(p.blockHash) ||
        !nullOr(isInt)(p.blockHeight) || !nullOr(isInt)(p.confirmations)) {
      return { error: "rejected" };
    }
    if (p.method === "onchain" && (p.paymentHash !== null || p.destination === null || (p.txid === null) !== (p.vout === null))) return { error: "rejected" };
    if (p.method === "lightning" && (p.txid !== null || p.vout !== null || p.destination !== null)) return { error: "rejected" };
    const canonical = p.destination === null ? null : canonicalAddress(p.destination, inv.network);
    if (p.destination !== null && !canonical) return { error: "rejected" };
    payments.push({ ...p, destination: canonical });
  }
  const byAlias = new Map();
  const byIdentity = new Map();
  const unique = [];
  for (const p of payments) {
    const same = byAlias.get(p.providerId);
    if (same) {
      if (!samePayment(same, p, true)) return { error: "rejected", conflict: true };
      continue;
    }
    byAlias.set(p.providerId, p);
    if (isVerified(p, caps)) {
      const key = p.method === "onchain" ? `o:${p.txid}:${p.vout}` : `l:${p.paymentHash}`;
      const twin = byIdentity.get(key);
      if (twin && !samePayment(twin, p, false)) return { error: "rejected", conflict: true };
      byIdentity.set(key, p);
    }
    unique.push(p);
  }
  return { begin: { ...begin, destination }, payments: unique };
}

// Two entries describe the same observation: every field equal, the provider id too unless
// they are two aliases of one canonical payment.
function samePayment(a, b, withId) {
  return PAYMENT.every((key) => (key === "providerId" && !withId) || a[key] === b[key]);
}

// --- Addresses ------------------------------------------------------------------------------

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const HRP = { mainnet: "bc", testnet: "tb", signet: "tb", regtest: "bcrt" };
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const VERSIONS = { mainnet: [0x00, 0x05], testnet: [0x6f, 0xc4], signet: [0x6f, 0xc4], regtest: [0x6f, 0xc4] };

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function convertBits(data, from, to) {
  let acc = 0, bits = 0;
  const out = [];
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & ((1 << to) - 1));
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= from || acc !== 0) return null;
  return out;
}

// A segwit address for the network, BIP 173 and BIP 350, in its canonical lowercase; null if
// it is mixed-case, for another network, malformed or fails its checksum.
function segwitAddress(address, network) {
  if (address.length > 90 || (address !== address.toLowerCase() && address !== address.toUpperCase())) return null;
  const lower = address.toLowerCase();
  const split = lower.lastIndexOf("1");
  if (split < 1 || split + 7 > lower.length || lower.slice(0, split) !== HRP[network]) return null;
  const data = [...lower.slice(split + 1)].map((c) => BECH32.indexOf(c));
  if (data.some((v) => v < 0)) return null;
  const hrp = lower.slice(0, split);
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const version = data[0];
  if (polymod([...expanded, ...data]) !== (version === 0 ? 1 : 0x2bc830a3)) return null;
  const program = convertBits(data.slice(1, -6), 5, 8);
  if (!program || version > 16 || program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  return lower;
}

function base58Bytes(address) {
  if (address.length < 26 || address.length > 35) return null;
  let value = 0n;
  for (const c of address) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const c of address) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return bytes.length === 25 ? Uint8Array.from(bytes) : null;
}

// A base58 address's shape and version for the network, case kept exactly; its checksum needs
// verifyAddress. Snapshots compare it only with addresses verified when they were bound.
function base58Address(address, network) {
  const bytes = base58Bytes(address);
  return bytes && VERSIONS[network].includes(bytes[0]) ? { address, bytes } : null;
}

// The canonical address, synchronously: segwit fully checked; base58 checked except its
// checksum. Null for anything else.
export function canonicalAddress(address, network) {
  if (typeof address !== "string" || !isNetwork(network)) return null;
  return segwitAddress(address, network) ?? base58Address(address, network)?.address ?? null;
}

// The canonical address, fully checked, base58 checksums included, with the platform's SHA-256.
export async function verifyAddress(address, network) {
  if (typeof address !== "string" || !isNetwork(network)) return null;
  const segwit = segwitAddress(address, network);
  if (segwit) return segwit;
  const found = base58Address(address, network);
  if (!found) return null;
  const check = await sha256(await sha256(found.bytes.slice(0, 21)));
  return check.slice(0, 4).every((byte, i) => byte === found.bytes[21 + i]) ? found.address : null;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// --- Cursors --------------------------------------------------------------------------------

// Opaque to pages: kind, revision, position, issue time and a check binding it to one scope,
// well under 128 characters. Not a secret: access is checked on every call regardless.
const KINDS = { receipts: "r", addresses: "a", history: "h" };
const CURSOR = /^([rah])\.(\d{1,16})\.(\d{1,16})\.(\d{1,16})\.([0-9a-f]{8})$/;

function scopeCheck(kind, scope) {
  let hash = 0x811c9dc5;
  for (const char of `${kind}:${scope}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function makeCursor(kind, scope, revision, position, at) {
  return `${KINDS[kind]}.${revision}.${position}.${at}.${scopeCheck(kind, scope)}`;
}

function readCursor(cursor, kind, scope, now, ttlMs) {
  const m = typeof cursor === "string" ? CURSOR.exec(cursor) : null;
  if (!m || m[1] !== KINDS[kind] || m[5] !== scopeCheck(kind, scope)) return { error: "cursor" };
  const [revision, position, at] = [m[2], m[3], m[4]].map(Number);
  if (![revision, position, at].every((v) => Number.isSafeInteger(v))) return { error: "cursor" };
  if (now - at > ttlMs || at > now) return { error: "cursor" };
  return { revision, position };
}

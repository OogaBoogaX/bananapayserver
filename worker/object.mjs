// The Durable Object: the one place where the relay's line, every page's socket and the
// pending requests meet, and where the global pile, the leaderboard and the board's tally are
// kept. It accepts sockets with the Hibernation API, so an idle line costs no duration, and its
// one alarm wakes it only while pages are open. It checks every message from the relay before
// acting on it.

import { invoiceMatches } from "../shared/bolt11.mjs";
import { donationEvent, MESSAGE_MAX, sanitize } from "../shared/donation.mjs";
import { cleanHandle } from "../shared/handle.mjs";
import { parseUp } from "../shared/protocol.mjs";
import { readLimits, readSettings } from "./config.mjs";
import { bridgeReceiptEntries, bumpPileRevision, PILE_SCHEMA, pileKnows, pileRevision, pileView, receiptBacklog, recordPileDelta, recordPileException } from "./pile.mjs";
import { hashRequest, MODE, ReceiptLedger } from "./receipts.mjs";
import { drainProjection, PROJECTION_BATCH_MAX } from "./projection.mjs";
import { relayAuthorized } from "./relay-token.mjs";
import { BANANA_CENTS, bananasOf, fetchPrice, milliBananas, rateOf } from "./price.mjs";

// The most donations a reconnecting page is sent to catch up.
export const REPLAY_MAX = 50;

// How many donation handles each leaderboard shows.
export const BOARD_SIZE = 20;

// The newest donations sent to a page when it joins.
export const RECENT_SIZE = 10;

// After the price service fails to answer, how long invoices use the last price before the
// object asks it again, so no donor waits on a service that's down.
export const PRICE_RETRY_MS = 60_000;

// How old the price beside the tally may get while pages are open, and how often the alarm
// checks it. See decision 0017.
export const PRICE_FRESH_MS = 5 * 60_000;

// The tally's hours: the current one and those before it, seven days in all.
export const TALLY_HOURS = 7 * 24;

// Cloudflare allows an object 32,768 hibernatable sockets. Pages stop short of that, so a
// crowd of them can never leave the relay without room for its line.
export const PAGE_SOCKETS_MAX = 30_000;

const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const OPEN = 1;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const BECH32 = "[02-9ac-hj-np-z]{11,87}";
const BASE58 = "[1-9A-HJ-NP-Za-km-z]{25,34}";
const ADDRESS = {
  mainnet: new RegExp(`^(bc1${BECH32}|[13]${BASE58})$`),
  testnet: new RegExp(`^(tb1${BECH32}|[mn2]${BASE58})$`),
  signet: new RegExp(`^(tb1${BECH32}|[mn2]${BASE58})$`),
  regtest: new RegExp(`^(bcrt1${BECH32}|[mn2]${BASE58})$`),
};

// The object's own storage, step by step. Each step runs once, including on an object made
// before it existed. Pending requests stay here, never in D1: who gave it and the message wait
// here until the invoice is paid, and the node never sees them.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS pending (
    request TEXT PRIMARY KEY,
    sats INTEGER NOT NULL,
    handle TEXT NOT NULL,
    message TEXT NOT NULL,
    invoice TEXT UNIQUE,
    expires INTEGER,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_created ON pending (created);`,
  // Who gave it and what it's worth in bananas, the price it was counted at, the pile, and which
  // donations have been pushed to pages and added to it.
  `ALTER TABLE pending ADD COLUMN github_id INTEGER;
  ALTER TABLE pending ADD COLUMN price_cents INTEGER;
  ALTER TABLE pending ADD COLUMN price_at INTEGER;
  ALTER TABLE pending ADD COLUMN milli INTEGER;
  CREATE TABLE price (id INTEGER PRIMARY KEY CHECK (id = 1), cents INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE pile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    milli INTEGER NOT NULL,
    at INTEGER NOT NULL,
    started INTEGER NOT NULL
  );
  CREATE TABLE finished (invoice TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE INDEX finished_at ON finished (at);`,
  // When the price service last failed, so the tally's rate stays stale after the object has
  // slept, and the rate the pages last got with the tally, so an unchanged one isn't sent again.
  `ALTER TABLE price ADD COLUMN failed INTEGER;
  CREATE TABLE tally_rate (id INTEGER PRIMARY KEY CHECK (id = 1), rate TEXT NOT NULL);`,
  // The minute's rate limit counts, so they hold when the object sleeps. Keyed by a visitor's
  // group, never their address, and gone when the minute is.
  `CREATE TABLE rate (key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL);`,
  // Once settlement starts, freeze attribution before an awaited D1 write lets a note interleave.
  `ALTER TABLE pending ADD COLUMN settling INTEGER NOT NULL DEFAULT 0;`,
  // Estimates may move; the first full receipt freezes a separate, durable pricing snapshot.
  // Already-issued invoices keep their quoted price; their receipt time is unknown.
  `ALTER TABLE pending ADD COLUMN received_at INTEGER;
  ALTER TABLE pending ADD COLUMN price_frozen INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending ADD COLUMN price_stale INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending ADD COLUMN pricing TEXT NOT NULL DEFAULT 'receipt';
  UPDATE pending SET price_frozen = 1, pricing = 'invoice' WHERE invoice IS NOT NULL;`,
  // Legacy quotes did not record whether their price was stale. Keep that unknown without
  // changing any frozen receipt price or its recorded freshness.
  `ALTER TABLE pending RENAME COLUMN price_stale TO previous_price_stale;
  ALTER TABLE pending ADD COLUMN price_stale INTEGER;
  UPDATE pending SET price_stale = CASE WHEN pricing = 'invoice' THEN NULL ELSE previous_price_stale END;
  ALTER TABLE pending DROP COLUMN previous_price_stale;`,
  `ALTER TABLE pending ADD COLUMN github_login TEXT;`,
  // The pile stops decaying. Its saved row stays exactly as it was, as the checkpoint; credits
  // from now on are permanent deltas, and the pile is pending until an audited anchor. Every
  // donation with a finished mark now is already in the checkpoint, and is fenced for good.
  PILE_SCHEMA,
  // Each settlement's provenance token, saved before its D1 insert; see migration 0009.
  `ALTER TABLE pending ADD COLUMN d1_token TEXT;`,
  // What a quarantined settlement knew, kept privately and for good, so review can recover
  // who it was for and how it was valued. Never purged, never overwritten, never published.
  // The request token is kept only as its SHA-256.
  `CREATE TABLE quarantined (
    invoice TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    method TEXT,
    sats INTEGER NOT NULL,
    handle TEXT NOT NULL,
    message TEXT NOT NULL,
    github_id INTEGER,
    github_login TEXT,
    price_cents INTEGER,
    price_at INTEGER,
    milli INTEGER,
    received_at INTEGER,
    price_stale INTEGER,
    pricing TEXT,
    d1_token TEXT,
    created INTEGER NOT NULL,
    existing_seq INTEGER,
    existing_sats INTEGER,
    existing_provenance TEXT,
    quarantined_at INTEGER NOT NULL,
    PRIMARY KEY (invoice, request_hash)
  );`,
  // What the pile showed pages at its revision, beyond what its own deltas decide: the receipt
  // side's health and uncertain amount. A change to them gets a new pile revision.
  `CREATE TABLE pile_shown (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, view TEXT NOT NULL);`,
];

export class DonationsObject {
  // platform: { pair, upgrade, now, id, fetch }, so the tests can run this without the runtime.
  constructor(ctx, env, platform) {
    this.ctx = ctx;
    this.env = env;
    this.platform = platform;
    this.sql = ctx.storage.sql;
    this.migrate();
    this.waiting = new Map();
    this.minute = null;
    this.boardEntries = null;
    this.boardSatsEntries = null;
    this.boardAsked = 0;
    this.boardShown = 0;
    this.recentEntries = null;
    this.recentLoading = null;
    this.recentAsked = 0;
    this.recentShown = 0;
    this.tallyFigures = null;
    this.tallyAsked = 0;
    this.tallyShown = 0;
    this.rateSending = null;
    this.refreshing = null;
    this.receiving = new Map();
    // Receipt accounting, read side only. Issuance is off, and nothing about receipts is
    // configured here: every issued mapping carries its own saved policy, and the read settings
    // were saved with the first issuance, so reads, history and replay go on whatever startup
    // configuration says, and removing configuration changes nothing at an unchanged revision.
    this.receipts = new ReceiptLedger({
      storage: ctx.storage, now: () => platform.now(), randomHex: () => platform.id(), issuance: false, policy: {},
    });
    this.receiptBacklog = false;
    this.projecting = null;
    this.capability = JSON.stringify(this.accountingCapability());
    // Receipt ledger entries committed before a stop reach the pile before anything is read.
    // Pages that stayed connected across the stop may not have heard the pile's newest revision:
    // the alarm sends it, once, through the normal path.
    // A bridge that fails here mustn't stop the object starting: legacy donations, the relay and
    // reads don't depend on it. The failure is logged and the pile says review, never current,
    // until a later bridge succeeds. The next push or alarm tries again, and raises it if it fails
    // again, so nothing is hidden; the alarm comes back within one cadence for that.
    this.bridgeFailure = null;
    try {
      this.pileBacklog = this.bridgeReceipts();
    } catch (error) {
      this.bridgeFailure = error.message;
      this.pileBacklog = false;
      console.error(`pile bridge: failed at start (${error.message}); the pile says review, retrying later`);
      this.ctx.waitUntil(this.scheduleAt(this.platform.now() + PRICE_FRESH_MS));
    }
    if (this.pileBacklog || this.pileUnsent()) this.ctx.waitUntil(this.scheduleAt(this.platform.now()));
    // Pages that stayed connected across a stop and are behind on receipt frames: the alarm
    // sends them, at once or at a page's retry time.
    const frames = this.receiptFramesDue();
    if (frames !== null) this.ctx.waitUntil(this.scheduleAt(frames));
  }

  // The pile revision last sent to every page, kept durably, so a stop between a change and its
  // broadcast is found on the next start.
  pileBroadcast() {
    return this.sql.exec("SELECT value FROM meta WHERE key = 'pile_broadcast'").toArray()[0]?.value ?? 0;
  }

  // Whether connected pages may be behind the pile's current revision.
  pileUnsent() {
    return this.ctx.getWebSockets("page").length > 0 && this.pileMessage().revision > this.pileBroadcast();
  }

  // Receipt ledger entries into the authoritative pile: one bounded batch, in ledger order,
  // from a durable mark, each entry and the mark's move in one transaction, so a stop at any
  // point repeats or skips nothing. The first run notes how far the receipt journal already
  // went, and whether an anchor already existed then: see bridgeReceiptEntries. The batch is the
  // saved replay bound; true if more entries wait.
  bridgeReceipts() {
    const meta = (key) => this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
    const more = this.ctx.storage.transactionSync(() => {
      if (meta("receipt_pile_bridged") === null) {
        const anchored = this.sql.exec("SELECT 1 FROM pile_anchor").toArray().length > 0 ? 1 : 0;
        this.sql.exec("INSERT INTO meta (key, value) VALUES ('receipt_pile_bridged', 0), ('receipt_pile_retained', ?), ('receipt_pile_retained_anchored', ?)",
          this.receipts.pileEntryHighWater(), anchored);
      }
      const bridged = meta("receipt_pile_bridged");
      const high = this.receipts.pileEntryHighWater();
      if (high <= bridged) return false;
      const limit = this.receipts.readSettings()?.replayMax;
      // Entries without saved read settings can't exist outside a broken store; they wait, and
      // health already says review.
      if (!limit) return false;
      const entries = this.receipts.pileEntriesAfter(bridged, limit);
      const through = bridgeReceiptEntries(this.sql, entries, {
        retained: meta("receipt_pile_retained"), anchoredBefore: meta("receipt_pile_retained_anchored") === 1,
      });
      this.sql.exec("UPDATE meta SET value = ? WHERE key = 'receipt_pile_bridged'", through);
      return high > through;
    });
    this.bridgeFailure = null;
    return more;
  }

  // What receipt accounting tells the pile: null while there is none, so the pile reads as it
  // always has; otherwise its health, never better than the bridge, and what review receipts
  // still credit. Never current while the bridge is behind or any read is unverified.
  pileAccounting() {
    const health = this.receipts.health();
    if (health === "off") return null;
    const behind = receiptBacklog(this.sql);
    // A bridge that failed and hasn't succeeded since is review: something must be looked at.
    const review = health === "review" || this.bridgeFailure !== null;
    return { reconciliation: review ? "review" : behind ? "behind" : health, uncertain: this.receipts.reviewCredit() };
  }

  // Sends the pile to every page if its revision is newer than the one they were last sent. At
  // least once: a page may hear a revision twice across a stop, and deduplicates by revision.
  // With no page connected there is nobody to tell, and a page that connects is sent it then.
  // A page that doesn't take it leaves it unmarked, and broadcast brings the alarm forward to no
  // later than one price-check cadence away; an alarm already due sooner sends it then. Nothing is
  // thrown: a page's delivery problem never stops the work that called this.
  publishPile() {
    const pile = this.pileMessage();
    if (pile.revision <= this.pileBroadcast()) return true;
    if (this.ctx.getWebSockets("page").length === 0) {
      this.markPileBroadcast(pile.revision);
      return true;
    }
    return this.broadcast(pile);
  }

  markPileBroadcast(revision) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('pile_broadcast', ?) ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)", revision);
  }

  // What the status message says about receipt accounting. Issuance is always off in this
  // build. Reads are available once a receipt-mode mapping exists with its saved read settings;
  // health is the core's own, never claimed current.
  accountingCapability() {
    const readable = this.receiptsReadable();
    return { version: 1, issuance: false, receipts: readable, history: readable, coverage: "invoice", spends: false,
      reconciliation: this.receipts.health() };
  }

  receiptsReadable() {
    return this.receipts.hasMappings() && this.receipts.readSettings() !== null;
  }

  // When live receipt frames are next due for some open page: now for a page behind and free to
  // be sent, its retry time for one waiting after a failure, or null when every open page has
  // been sent everything.
  receiptFramesDue() {
    if (!this.receipts.readSettings()) return null;
    const high = this.receipts.feedHighWater();
    const now = this.platform.now();
    let due = null;
    for (const ws of this.ctx.getWebSockets("page")) {
      if (ws.readyState !== OPEN) continue;
      const { through = high, retryAt = null } = ws.deserializeAttachment() ?? {};
      if (through >= high) continue;
      const at = retryAt > now ? retryAt : now;
      due = due === null ? at : Math.min(due, at);
    }
    return due;
  }

  // The earliest retry time of an open page still behind, or null.
  receiptRetryAt() {
    const due = this.receiptFramesDue();
    return due !== null && due > this.platform.now() ? due : null;
  }

  // Sends committed feed frames each page hasn't been sent live, in order, per page, from that
  // page's own position. A page's position starts at the high-water mark its connect captured:
  // anything at or below it was its snapshot or replay, and never arrives as live. It moves to
  // a frame's seq only once ws.send took that frame for the page without failing. That proves
  // the frame was handed to the socket (an enqueue), not that the page received it; nothing
  // here hears back from the page. The position is kept in the socket's attachment, so it
  // survives hibernation and a restart.
  // - A page that is closing or closed is skipped: it never holds anyone else up.
  // - An open page whose send fails stops at that frame, so it never gets a later frame first,
  //   and is retried no sooner than one price-check cadence later, never in a tight loop. Other
  //   pages go on.
  // - Each page is sent at most the saved replay bound of frames per call; a page left behind
  //   asks the alarm to continue at once.
  // At least once: a frame may reach a page twice across a failure or stop, or also in its
  // replay; pages deduplicate by revision. Each page's position is the only record of what it was
  // sent; no object-wide mark is kept. A capability change sends a new status.
  pushReceiptFrames() {
    // Committed ledger entries reach the pile first, so the pile sent after these frames, and
    // to any page that connects, already holds them.
    this.pileBacklog = this.bridgeReceipts();
    const settings = this.receipts.readSettings();
    const high = this.receipts.feedHighWater();
    const now = this.platform.now();
    const pages = this.ctx.getWebSockets("page").filter((ws) => ws.readyState === OPEN);
    this.receiptBacklog = false;
    if (settings) {
      const batches = new Map();
      const batch = (after) => {
        if (!batches.has(after)) batches.set(after, this.receipts.feedSince(after, settings.replayMax));
        return batches.get(after);
      };
      for (const ws of pages) {
        const attachment = ws.deserializeAttachment() ?? {};
        let through = attachment.through ?? high;
        if (through < high && !(attachment.retryAt > now)) {
          const frames = batch(through);
          let failed = false;
          for (const { seq, frame } of frames) {
            try {
              ws.send(JSON.stringify({ ...frame, replay: false }));
            } catch (error) {
              // A page that closed under the send is going away; one still open is retried.
              failed = ws.readyState === OPEN;
              if (failed) console.error(`receipt frames: a page didn't take frame ${seq} (${error.message}); retrying later`);
              break;
            }
            through = seq;
          }
          ws.serializeAttachment({ ...attachment, through, retryAt: failed ? now + PRICE_FRESH_MS : null });
          if (!failed && frames.length === settings.replayMax && high > through) this.receiptBacklog = true;
        }
      }
    }
    if (this.receiptBacklog || this.pileBacklog) this.ctx.waitUntil(this.ctx.storage.setAlarm(this.platform.now()));
    // A page waiting to be retried brings the alarm forward to its retry time. The page itself is
    // never sent to before then (its retry time is a fence); the alarm may be due sooner for
    // other work.
    const retry = this.receiptRetryAt();
    if (retry !== null) this.ctx.waitUntil(this.scheduleAt(retry));
    this.kickProjection();
    const capability = JSON.stringify(this.accountingCapability());
    if (capability !== this.capability) {
      this.capability = capability;
      this.broadcast(this.statusMessage(this.line() !== null));
    }
    this.publishPile();
  }

  migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const [row] = this.sql.exec("SELECT value FROM meta WHERE key = 'schema'").toArray();
    const done = row?.value ?? 0;
    if (done >= MIGRATIONS.length) return;
    this.ctx.storage.transactionSync(() => {
      for (const step of MIGRATIONS.slice(done)) this.sql.exec(step);
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        MIGRATIONS.length,
      );
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/invoice":
        return this.invoice(await request.json());
      case "/note":
        return this.note(await request.json());
      case "/onchain":
        return this.onchain(await request.json());
      case "/status":
        return this.status(await request.json());
      case "/history":
        return this.history(await request.json());
      case "/page":
        return this.page(request, url);
      case "/relay":
        // Checked here as well as at the front door: another Worker in the account could
        // bind this object and reach it without passing through the front.
        if (!(await relayAuthorized(request, this.env))) return json({ error: "unauthorized" }, 401);
        return this.relay();
    }
    return json({ error: "not found" }, 404);
  }

  // github is the signed-in donor, { id, login }, or null for an anonymous donation. The front
  // door has already checked everything; the text is cleaned again here because every page shows
  // it, and another Worker in the account could reach this object without the front door.
  async invoice({ sats, handle, message, github, client, accounting }) {
    // Receipt-mode issuance is off in this build. An explicit request for it is closed, before
    // any provider call, and never quietly downgraded to legacy.
    if (accounting !== undefined) return closed();
    const limits = readLimits(this.env);
    const { network, invoiceTimeoutMs } = readSettings(this.env);
    if (!limits || !network) return closed();
    if (!Number.isSafeInteger(sats) || sats < limits.minSats || sats > limits.maxSats) return json({ error: "amount" }, 400);
    if (sats < limits.messageMinSats && sanitize(message, MESSAGE_MAX)) return json({ error: "message" }, 400);
    if (!this.allow("work", client, limits)) return busy();
    const line = this.line();
    if (!line) return closed();

    this.purge();
    const request = this.platform.id();
    const onchainOnly = sats > limits.lightningMaxSats;
    const command = { type: "invoice", request, sats };
    if (onchainOnly) command.onchainOnly = true;
    const display = handle === undefined ? github?.login : handle;
    this.sql.exec(
      "INSERT INTO pending (request, sats, handle, message, github_id, github_login, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
      request, sats, display ? cleanHandle(display) : "", sanitize(message, MESSAGE_MAX), github?.id ?? null, github?.login ?? null, this.platform.now(),
    );
    // The price is looked up while the relay makes the invoice, so it costs the donor no time.
    const [reply, price] = await Promise.all([
      this.ask(line, command, invoiceTimeoutMs),
      this.price(),
    ]);
    // The pages' tally follows the price this lookup got, without holding up the donor.
    this.ctx.waitUntil(this.pushRateIfChanged());
    const invoice = reply?.invoice;
    // This is an estimate. The first full receipt takes its own price snapshot.
    const milli = price ? milliBananas(sats, price.cents) : null;
    if (!invoice || invoice.bolt11 !== null && !invoiceMatches(invoice.bolt11, network, sats)
        || onchainOnly && invoice.bolt11 !== null || !this.attach(request, invoice, price, milli)) {
      this.sql.exec("DELETE FROM pending WHERE request = ?", request);
      return reply?.error === "cap" ? json({ error: "amount" }, 400) : closed();
    }
    return json({
      request,
      invoice: { id: invoice.id, bolt11: invoice.bolt11, expires: invoice.expires },
      bananas: bananasOf(milli),
      rate: price ? { ...rateOf(price.cents, price.at), stale: price.stale } : null,
      pricing: "receipt",
      lightning: invoice.bolt11 === null ? onchainOnly ? "limit" : "unavailable" : "available",
    });
  }

  // Records which invoice answers a request, and its estimated price. False if the relay
  // reused an invoice id.
  attach(request, { id, expires }, price, milli) {
    // An invoice id this object already knows a donation for (credited, in the checkpoint, held
    // for review, or still marked finished) came back from the provider. It is refused before
    // the donor sees anything payable. Only the object's own records are read, so the quote
    // waits on nothing; an older id D1 alone remembers is caught at payment, and held there.
    if (pileKnows(this.sql, `donation:${id}`) || this.sql.exec("SELECT 1 FROM finished WHERE invoice = ?", id).toArray().length) {
      console.error(`invoice: the provider reused invoice id ${id}; refused before it was shown`);
      return false;
    }
    try {
      this.sql.exec(
        "UPDATE pending SET invoice = ?, expires = ?, price_cents = ?, price_at = ?, milli = ? WHERE request = ?",
        id, expires, price?.cents ?? null, price?.at ?? null, milli, request,
      );
      return true;
    } catch {
      return false;
    }
  }

  // The request capability may update display text until settlement starts. Account identity,
  // invoice, amount and rate stay fixed. A handle-only update preserves the existing message, and a
  // donation under the message bar refuses a new nonempty message.
  note({ request, handle, message, client }) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    if (!this.allow("note", client, limits)) return busy();
    const clean = message === undefined ? undefined : sanitize(message, MESSAGE_MAX);
    if (clean) {
      const [row] = this.sql.exec("SELECT sats FROM pending WHERE request = ? AND settling = 0", request).toArray();
      if (!row) return json({ error: "unknown" }, 404);
      if (row.sats < limits.messageMinSats) return json({ error: "message" }, 400);
    }
    const updated = this.sql.exec(
      "UPDATE pending SET handle = coalesce(?, handle), message = coalesce(?, message) " +
      "WHERE request = ? AND settling = 0 RETURNING request",
      handle === undefined ? null : cleanHandle(handle), clean === undefined ? null : clean, request,
    ).toArray();
    return updated.length ? new Response(null, { status: 204 }) : json({ error: "unknown" }, 404);
  }

  async onchain({ request, client }) {
    const limits = readLimits(this.env);
    const { network, invoiceTimeoutMs } = readSettings(this.env);
    if (!limits || !network) return closed();
    if (!this.allow("work", client, limits)) return busy();
    const [row] = this.sql.exec(
      "SELECT sats, invoice, expires FROM pending WHERE request = ? AND invoice IS NOT NULL",
      request,
    ).toArray();
    if (!row) return json({ error: "unknown" }, 404);
    if (row.expires * 1000 <= this.platform.now()) return json({ error: "expired" }, 410);
    const line = this.line();
    if (!line) return closed();

    const reply = await this.ask(line, { type: "onchain", request, invoice: row.invoice }, invoiceTimeoutMs);
    if (!reply?.address || !ADDRESS[network].test(reply.address)) return closed();
    // Room for a network fee, if the store adds one, and never a mistake in units.
    if (reply.sats < row.sats || reply.sats > row.sats + limits.onchainFeeAllowance) return closed();
    return json({ address: reply.address, sats: reply.sats });
  }

  async page(request, url) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    const visitor = request.headers.get("X-Client") ?? "";
    if (!this.allow("page", visitor, limits)) return busy();
    if (this.ctx.getWebSockets("page").length >= PAGE_SOCKETS_MAX) return busy();
    const group = visitorGroup(visitor);
    if (this.ctx.getWebSockets(group).length >= limits.socketsPerIp) return busy();
    const [client, server] = this.platform.pair();
    // From the moment it is accepted, a page hears live only frames committed after now; any
    // older backlog still being broadcast is never presented to it as live.
    server.serializeAttachment({ role: "page", through: this.receipts.feedHighWater() });
    this.ctx.acceptWebSocket(server, ["page", group]);
    server.send(JSON.stringify(this.statusMessage(this.line() !== null)));
    server.send(JSON.stringify(this.pileMessage()));
    const board = await this.board();
    if (board) server.send(JSON.stringify(board));
    const tally = await this.tally();
    if (tally) {
      server.send(JSON.stringify(tally));
      if (this.sentRate() === null) this.markRateSent(tally.rate);
    }
    const recent = await this.recent({ messageMinSats: limits.messageMinSats });
    if (recent) server.send(JSON.stringify(recent));
    const after = url.searchParams.get("after");
    if (after && INVOICE_ID.test(after)) await this.replay(server, after, limits.messageMinSats);
    if (this.receiptsReadable()) this.receiptReplay(server, url.searchParams.get("receipts"));
    // A page never waits for a price. One older than five minutes is refreshed once the page
    // has what's known, and the alarm keeps it fresh while pages stay.
    this.ctx.waitUntil(this.freshenRate());
    await this.scheduleFreshening();
    return this.platform.upgrade(client);
  }

  // Applies the receipt outbox to D1's lifetime figures, then sends pages D1's current ones.
  // - One drain at a time: a drain already running is shared, never overlapped.
  // - Bounded by PROJECTION_BATCH_MAX rows (see projection.mjs), never the client-facing replay
  //   bound; a full drain continues at once, in a new alarm invocation.
  // - A drain that applied a figure-moving batch leaves a durable note (with the outbox row's
  //   removal); the note is cleared only after D1's tally and board were read fresh and sent. A
  //   failed read keeps the note, and a restart finds it, so pages are never left stale.
  // - A D1 failure, or a failed publication, is retried once the existing five-minute alarm
  //   cadence (PRICE_FRESH_MS) has passed, persisted so a restart keeps it: never a tight loop.
  // - A conflict waits for review, and is never drained again until it is resolved. It doesn't
  //   hold back a publication already owed: figures D1 committed before the conflict are still
  //   read and sent, on the same retry cadence.
  // Health stays behind while anything waits, and review on a conflict.
  projectReceipts() {
    if (this.projecting) return this.projecting;
    const settings = this.receipts.readSettings();
    if (!settings) return Promise.resolve(null);
    const draining = this.receipts.hasPendingProjection() && !this.receipts.projectionConflict();
    const publishing = this.receipts.publicationPending();
    if (!draining && !publishing) return Promise.resolve(null);
    if (this.projectionRetryAt() > this.platform.now()) return Promise.resolve(null);
    this.projecting = (async () => {
      try {
        let result = null;
        if (draining) {
          result = await drainProjection({ ledger: this.receipts, db: this.env.DB, now: () => this.platform.now(), limit: PROJECTION_BATCH_MAX });
          if (result.failed) console.error(`receipt projection: D1 refused a batch (${result.failed}); retrying later`);
          if (result.conflict) console.error(`receipt projection: ${result.conflict}; held for review`);
        }
        let published = true;
        if (this.receipts.publicationPending()) published = await this.publishLifetime();
        if (result?.failed || !published) this.setProjectionRetry(this.platform.now() + PRICE_FRESH_MS);
        else this.setProjectionRetry(null);
        if (result?.more && !result.failed) await this.scheduleAt(this.platform.now());
        else if (result?.failed || !published) await this.scheduleAt(this.projectionRetryAt());
        const capability = JSON.stringify(this.accountingCapability());
        if (capability !== this.capability) {
          this.capability = capability;
          this.broadcast(this.statusMessage(this.line() !== null));
        }
        // The receipt side's health is part of the pile's.
        this.publishPile();
        return result;
      } finally {
        this.projecting = null;
      }
    })();
    return this.projecting;
  }

  // D1's current tally and board, read fresh and sent; false, keeping the work, if either read
  // fails. Nothing is credited here, so a retry only sends the same authoritative figures again.
  async publishLifetime() {
    try {
      const [board, tally] = await Promise.all([this.board({ refresh: true, strict: true }), this.tally({ refresh: true, strict: true })]);
      if (board) this.broadcast(board);
      if (tally) {
        this.markRateSent(tally.rate);
        this.broadcast(tally);
      }
      this.receipts.published();
      return true;
    } catch (error) {
      console.error(`receipt projection: publishing lifetime figures failed (${error.message}); retrying later`);
      return false;
    }
  }

  projectionRetryAt() {
    return this.sql.exec("SELECT value FROM meta WHERE key = 'projection_retry'").toArray()[0]?.value ?? 0;
  }

  setProjectionRetry(at) {
    if (at === null) this.sql.exec("DELETE FROM meta WHERE key = 'projection_retry'");
    else this.sql.exec("INSERT INTO meta (key, value) VALUES ('projection_retry', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", at);
  }

  // When the projection next needs the alarm, or null. A conflict waiting for review needs none
  // for draining, but a publication already owed still does, at its retry time.
  projectionDue() {
    if (!this.receipts.readSettings()) return null;
    const draining = this.receipts.hasPendingProjection() && !this.receipts.projectionConflict();
    if (!draining && !this.receipts.publicationPending()) return null;
    return Math.max(this.projectionRetryAt(), this.platform.now());
  }

  // Starts projection work in the background, first making sure a durable alarm will come back
  // one cadence later in case this instance stops before the work, or its publication, is done.
  kickProjection() {
    if (this.projectionDue() === null) return;
    this.ctx.waitUntil(this.scheduleAt(this.platform.now() + PRICE_FRESH_MS));
    this.ctx.waitUntil(this.projectReceipts());
  }

  // Brings the alarm forward to `at`, never back.
  async scheduleAt(at) {
    if (at === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  // On every connect while receipt reads are available: the newest credited receipts, then any
  // receipt and invoiceStatus frames after the page's cursor, then the marker with the
  // high-water mark taken here. All of it synchronously, so every frame committed later reaches
  // this page live, after the marker. Nothing here animates: replayed frames say replay: true,
  // and a cursor too far behind gets no frames and complete: false, to resync.
  receiptReplay(ws, cursor) {
    const settings = this.receipts.readSettings();
    ws.send(JSON.stringify({ type: "recentReceipts", entries: this.receipts.recentReceipts(settings.recentSize) }));
    const replay = this.receipts.feedAfter(cursor === null ? null : Number(cursor), { limit: settings.replayMax });
    for (const frame of replay.frames ?? []) ws.send(JSON.stringify(frame));
    ws.send(JSON.stringify({ type: "replay", after: replay.after ?? null, through: replay.through ?? null, complete: replay.complete ?? false }));
    // Remembered with the socket, so it survives hibernation: live frames start after this mark.
    // A cursor the feed refuses (front.mjs rejects malformed ones first) replays nothing and
    // starts at the high-water mark, never at 0, so old frames are never sent as live.
    const through = replay.error ? this.receipts.feedHighWater() : replay.through ?? 0;
    ws.serializeAttachment({ ...ws.deserializeAttachment(), through });
  }

  // POST /donations/status: one invoice's private status, by its bearer request token or by
  // its signed-in owner's stable id, never by handle. A reader without access gets the same 404
  // as an unknown invoice, and changes nothing.
  async status({ request, invoice, cursor = null, addressCursor = null, donor = null, client }) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    if (!this.allow("read", client, limits)) return busy();
    if (!this.receiptsReadable()) return closed();
    let id = null;
    let access;
    if (request !== undefined) {
      const requestHash = await hashRequest(request);
      id = this.receipts.invoiceForRequest(requestHash);
      access = { requestHash };
    } else {
      id = invoice;
      access = { donorId: donor?.id ?? null };
    }
    if (!id || !this.receipts.canRead(id, access)) return json({ error: "unknown" }, 404);
    const s = this.receipts.readSettings();
    const result = this.receipts.statusReply(id, { ...access, cursor, addressCursor,
      receiptLimit: s.statusPageSize, addressLimit: s.addressPageSize, ttlMs: s.cursorTtlMs });
    this.pushReceiptFrames();
    await this.scheduleFreshening();
    return readReply(result);
  }

  // POST /donations/history: the signed-in account's own receipt-mode invoices, by stable id.
  async history({ cursor = null, donor = null, client }) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    if (!this.allow("read", client, limits)) return busy();
    if (!this.receiptsReadable()) return closed();
    if (!donor) return json({ error: "signin" }, 401);
    const s = this.receipts.readSettings();
    const result = this.receipts.accountHistory(donor.id, { cursor, limit: s.historyPageSize, ttlMs: s.cursorTtlMs });
    this.pushReceiptFrames();
    await this.scheduleFreshening();
    return readReply(result);
  }

  // A page that reconnects names the last donation it saw and gets anything newer. A donation
  // recorded while the replay is on its way can reach the page twice; pages ignore an id they
  // have already played.
  async replay(ws, after, messageMinSats) {
    try {
      const { results } = await this.env.DB.prepare(
        "SELECT seq, id, sats, handle, message, at, milli, verified FROM donations " +
        "WHERE seq > (SELECT seq FROM donations WHERE id = ?) ORDER BY seq LIMIT ?",
      ).bind(after, REPLAY_MAX).all();
      for (const row of results) ws.send(JSON.stringify(donationMessage(atMessageBar(row, messageMinSats))));
    } catch (error) {
      console.error("replay failed:", error.message);
    }
  }

  // The latest donations, every amount, cached across page connects. Concurrent cold connects
  // share a read; refreshes may overlap, so only a newer successful read replaces the cache.
  async recent({ refresh = false, messageMinSats = 0 } = {}) {
    if (!refresh && this.recentLoading) await this.recentLoading;
    else if (refresh || !this.recentEntries) {
      const asked = ++this.recentAsked;
      const loading = (async () => {
        try {
          const { results } = await this.env.DB.prepare(
            "SELECT seq, id, sats, handle, message, at, milli, verified FROM donations ORDER BY seq DESC LIMIT ?",
          ).bind(RECENT_SIZE).all();
          if (asked > this.recentShown) {
            this.recentShown = asked;
            this.recentEntries = results.map(recentEntry);
          }
        } catch (error) {
          console.error("reading recent donations failed:", error.message);
        }
      })();
      this.recentLoading = loading;
      await loading;
      if (this.recentLoading === loading) this.recentLoading = null;
    }
    return this.recentEntries ? { type: "recent", entries: messageMinSats
      ? this.recentEntries.map((entry) => atMessageBar(entry, messageMinSats)) : this.recentEntries } : null;
  }

  // The newest line wins: a relay that redials replaces a line that may be half dead.
  relay() {
    for (const old of this.ctx.getWebSockets("relay")) {
      try {
        old.close(4000, "replaced");
      } catch {
        // Already closing.
      }
    }
    const [client, server] = this.platform.pair();
    server.serializeAttachment({ role: "relay" });
    this.ctx.acceptWebSocket(server, ["relay"]);
    this.broadcast(this.statusMessage(true));
    return this.platform.upgrade(client);
  }

  async webSocketMessage(ws, message) {
    if (ws.deserializeAttachment()?.role !== "relay") {
      // Pages have nothing to say, and each message would wake the object.
      ws.close(1008, "pages don't send");
      return;
    }
    // Anything from the relay that isn't the protocol is dropped.
    const reply = typeof message === "string" ? parseUp(message) : null;
    if (!reply) return;
    if (reply.type === "seen") return this.seen(reply);
    if (reply.type !== "paid") {
      this.waiting.get(`${reply.type}:${reply.request}`)?.resolve(reply);
      return;
    }
    let result;
    try {
      result = await this.paid(reply);
    } catch (error) {
      // No acknowledgement: the relay keeps the notice and sends it again.
      console.error("recording a payment failed:", error.message);
      return;
    }
    ws.send(JSON.stringify({ type: "ack", invoice: reply.invoice, result }));
  }

  // Each invoice is recorded once in D1, then pushed to pages and added to the pile once. D1
  // calls let other messages in while they wait, so a repeated notice can arrive mid-way, and
  // the object can stop between D1 and the rest. The `finished` table marks the rest as done,
  // so whichever notice gets there first does it, and a resent one finishes what a stopped
  // object didn't.
  async paid({ invoice, sats, method }) {
    // A legacy notice never credits a receipt-mode invoice, nor makes it a donation.
    if (this.receipts.modeOf(invoice) === MODE) return "rejected";
    let [row] = this.sql.exec(
      "SELECT * FROM pending WHERE invoice = ?",
      invoice,
    ).toArray();
    if (!row) {
      const known = await this.env.DB.prepare("SELECT 1 FROM donations WHERE id = ?").bind(invoice).first();
      return known ? "duplicate" : "unknown";
    }
    if (row.sats !== sats) return "rejected";
    this.sql.exec("UPDATE pending SET settling = 1 WHERE request = ?", row.request);
    row = await this.freezePrice(invoice);
    // Another delivery may have completed while this one was taking the price.
    if (!row) {
      const known = await this.env.DB.prepare("SELECT 1 FROM donations WHERE id = ?").bind(invoice).first();
      return known ? "duplicate" : "unknown";
    }
    // The settlement's provenance token, saved before the insert and reused by every retry, so
    // a row this request wrote can be told from any other.
    if (row.d1_token === null) {
      this.sql.exec("UPDATE pending SET d1_token = coalesce(d1_token, ?) WHERE request = ?", this.platform.id(), row.request);
      row = this.sql.exec("SELECT * FROM pending WHERE request = ?", row.request).toArray()[0];
    }
    const limits = readLimits(this.env);
    if (!limits) throw new Error("settlement requires valid limits");
    const message = row.sats >= limits.messageMinSats ? row.message : "";
    const verified = row.github_id !== null && row.github_login && row.handle.toLowerCase() === row.github_login.toLowerCase() ? 1 : 0;
    const inserted = await this.env.DB.prepare(
      "INSERT INTO donations (id, sats, handle, message, at, method, github_id, price_cents, price_at, banana_cents, milli, received_at, price_stale, pricing, verified, provenance) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (id) DO NOTHING RETURNING seq, id, sats, handle, message, at, milli, verified, provenance",
    ).bind(
      invoice, sats, row.handle, message, this.platform.now(), method, row.github_id,
      row.price_cents, row.price_at, row.price_cents === null ? null : BANANA_CENTS, row.milli,
      row.received_at, row.price_stale, row.pricing, verified, row.d1_token,
    ).first();
    const recorded = inserted ?? await this.env.DB.prepare(
      "SELECT seq, id, sats, handle, message, at, milli, verified, provenance FROM donations WHERE id = ?",
    ).bind(invoice).first();
    if (!recorded) throw new Error("a donation that was neither inserted nor found");
    // D1 already holds a donation under this id that this settlement didn't write: an older row,
    // a manual import, or a write the old code made before a crash. None of them proves whether
    // its credit is already in the pile, and timestamps can't tell them apart, so it is held for
    // review: no credit, no donation event, and D1 unchanged.
    if (!inserted && recorded.provenance !== row.d1_token) return this.quarantine(invoice, row, "unproven-existing-donation", { method, recorded });
    const pile = this.finish(recorded);
    this.sql.exec("DELETE FROM pending WHERE request = ?", row.request);
    if (pile !== false) {
      this.broadcast(donationMessage(recorded));
      if (pile) this.broadcast(pile);
      await Promise.all([
        this.recent({ refresh: true }),
        row.handle && this.board({ refresh: true }).then((board) => { if (board) this.broadcast(board); }),
        this.pushTally({ refresh: true }),
      ]);
    }
    return inserted ? "recorded" : "duplicate";
  }

  // Freeze when BTCPay first reports the whole amount, including any required network fee.
  // Partial receipts don't fix a price or credit the pile. Confirmation only credits the snapshot.
  async seen({ invoice, sats, left }) {
    // A receipt-mode invoice never emits a legacy seen.
    if (this.receipts.modeOf(invoice) === MODE) return;
    let [row] = this.sql.exec("SELECT * FROM pending WHERE invoice = ?", invoice).toArray();
    if (!row) return;
    if (left === 0) row = await this.freezePrice(invoice);
    if (!row) return;
    const message = { type: "seen", id: invoice, sats, due: row.sats, left };
    if (row.price_frozen && row.pricing === "receipt") message.pricing = {
      receivedAt: row.received_at,
      rate: row.price_cents === null ? null : { ...rateOf(row.price_cents, row.price_at), stale: !!row.price_stale },
      bananas: bananasOf(row.milli),
    };
    this.broadcast(message);
  }

  // Concurrent seen/paid messages share one lookup. Store the result before awaiting D1,
  // including an unavailable price, so retries and a sleeping object never reprice a receipt.
  freezePrice(invoice) {
    const [row] = this.sql.exec("SELECT * FROM pending WHERE invoice = ?", invoice).toArray();
    if (!row || row.price_frozen) return Promise.resolve(row);
    if (this.receiving.has(invoice)) return this.receiving.get(invoice);
    this.sql.exec("UPDATE pending SET received_at = coalesce(received_at, ?) WHERE invoice = ?", this.platform.now(), invoice);
    const pending = (async () => {
      // Receipts neither join a quote nor inherit its retry delay. Each invoice must try
      // its own lookup before freezing a fallback; quotes remain free to use fast REST.
      const limits = readLimits(this.env);
      if (!limits) throw new Error("receipt pricing requires valid limits");
      const fresh = await this.lookupPrice(limits, true);
      const last = this.sql.exec("SELECT cents, at FROM price").toArray()[0];
      const price = fresh ?? (last ? { ...last, stale: true } : null);
      this.sql.exec(
        "UPDATE pending SET price_cents = ?, price_at = ?, milli = ?, price_stale = ?, price_frozen = 1 WHERE invoice = ? AND price_frozen = 0",
        price?.cents ?? null, price?.at ?? null, price ? milliBananas(row.sats, price.cents) : null,
        price?.stale ? 1 : 0, invoice,
      );
      return this.sql.exec("SELECT * FROM pending WHERE invoice = ?", invoice).toArray()[0];
    })().finally(() => this.receiving.delete(invoice));
    this.receiving.set(invoice, pending);
    return pending;
  }

  // A settlement the pile can't credit safely: recorded once for review, and its pending
  // request archived privately before it is removed, all in one step. The archive keeps what
  // the settlement knew (who it was for, the text, the sats, the frozen price and its
  // provenance token) and what it found in D1, so the payment can be reconciled later. A
  // retry, or a second notice racing this one, changes nothing already archived. Every page
  // is told the pile's state now needs review.
  async quarantine(invoice, row, reason, { method = null, recorded = null } = {}) {
    const requestHash = await hashRequest(row.request);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO quarantined (invoice, request_hash, reason, method, sats, handle, message, github_id, github_login, " +
        "price_cents, price_at, milli, received_at, price_stale, pricing, d1_token, created, existing_seq, existing_sats, " +
        "existing_provenance, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (invoice, request_hash) DO NOTHING",
        invoice, requestHash, reason, method, row.sats, row.handle, row.message, row.github_id, row.github_login ?? null,
        row.price_cents, row.price_at, row.milli, row.received_at, row.price_stale, row.pricing, row.d1_token, row.created,
        recorded?.seq ?? null, recorded?.sats ?? null, recorded?.provenance ?? null, this.platform.now(),
      );
      recordPileException(this.sql, `donation:${invoice}`, reason, row.milli, this.platform.now());
      this.sql.exec("DELETE FROM pending WHERE request = ?", row.request);
    });
    this.broadcast(this.pileMessage());
    console.error(`paid: invoice ${invoice} is held for review (${reason})`);
    return "rejected";
  }

  // Marks a recorded donation finished and credits the pile, in one step. False if it was
  // already finished; otherwise the pile's new state, or null when the pile didn't change: a
  // donation with no bananas, or one whose credit is already recorded. The credit is keyed by
  // its invoice for good, so it can never repeat, even after the finished mark has been purged.
  finish({ id, milli, at }) {
    return this.ctx.storage.transactionSync(() => {
      const first = this.sql.exec(
        "INSERT INTO finished (invoice, at) VALUES (?, ?) ON CONFLICT (invoice) DO NOTHING RETURNING invoice",
        id, at,
      ).toArray();
      if (!first.length) return false;
      if (milli === null) return null;
      // A repeat with a different amount isn't a retry: it is recorded for review, and the
      // pile's changed health goes out like any other change.
      const revision = pileRevision(this.sql);
      if (!recordPileDelta(this.sql, `donation:${id}`, milli, at)) return pileRevision(this.sql) === revision ? null : this.pileMessage();
      return this.pileMessage();
    });
  }

  // The global pile: one level for everyone, with no decay. Pending until its audited anchor;
  // see pile.mjs.
  //
  // With receipt accounting, the pile also shows the receipt side's health and what review
  // receipts still credit, which can change with no delta. Pages deduplicate by revision, so
  // what was last shown at the current revision is kept, and a change gets a new revision.
  pileMessage() {
    const accounting = this.pileAccounting();
    let view = pileView(this.sql, accounting);
    const shown = (v) => [v.reconciliation, v.uncertain === null ? null : [v.uncertain.sats, v.uncertain.bananas]];
    const now = JSON.stringify(shown(view));
    const stored = this.sql.exec("SELECT revision, view FROM pile_shown WHERE id = 1").toArray()[0] ?? null;
    if (stored && stored.revision === view.revision && stored.view !== now) {
      bumpPileRevision(this.sql);
      view = pileView(this.sql, accounting);
    }
    if (!stored || stored.revision !== view.revision || stored.view !== now) {
      this.sql.exec("INSERT INTO pile_shown (id, revision, view) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, view = excluded.view",
        view.revision, now);
    }
    return view;
  }

  // The top entered handles in each unit: recorded fractional bananas and exact sats. Each list is limited
  // independently, since a changing price can give them different leaders. Matching handles combine
  // across accounts and guests, case-insensitively. Legacy unnamed donations never appear. Kept in memory between donations; null if D1 can't be read and nothing is
  // kept. Reads can come back out of order, so only the newest one asked for is kept.
  // strict: a failed read throws instead of falling back to the cached board, for a caller that
  // must know the board it sends is D1's current one.
  async board({ refresh = false, strict = false } = {}) {
    if (refresh || !this.boardEntries) {
      const asked = ++this.boardAsked;
      try {
        const [bananas, sats] = await Promise.all([
          this.env.DB.prepare("SELECT handle, milli, sats FROM handle_totals WHERE milli > 0 ORDER BY milli DESC, handle LIMIT ?")
            .bind(BOARD_SIZE).all(),
          this.env.DB.prepare("SELECT handle, milli, sats FROM handle_totals ORDER BY sats DESC, handle LIMIT ?")
            .bind(BOARD_SIZE).all(),
        ]);
        if (asked > this.boardShown) {
          this.boardShown = asked;
          const entry = (r) => ({ handle: r.handle, bananas: r.milli / 1000, sats: r.sats });
          this.boardEntries = bananas.results.map(entry);
          this.boardSatsEntries = sats.results.map(entry);
        }
      } catch (error) {
        console.error("reading the leaderboard failed:", error.message);
        if (strict) throw error;
      }
    }
    return this.boardEntries ? { type: "board", entries: this.boardEntries, satsEntries: this.boardSatsEntries } : null;
  }

  // Bitcoin's price for an invoice, in cents: a new one from 2140data's service, asked for
  // while the relay makes the invoice, so it costs the donor no time. When the service doesn't
  // answer, the last price it gave, marked stale so the page can say so. With no price at all,
  // a donation still goes through; it just has no bananas until someone works them out from
  // its sats.
  async price() {
    const fresh = await this.refreshPrice();
    const last = this.sql.exec("SELECT cents, at FROM price").toArray()[0];
    return last ? { cents: last.cents, at: last.at, stale: !fresh } : null;
  }

  // True when a new price came in. Invoices asking at the same time share one lookup. When the
  // last lookup failed, the next waits a minute, and the failure is kept in storage so that
  // holds after the object sleeps. A price more than PRICE_JUMP_MAX times the last one, or the
  // last divided by it, within a day of it, is taken for a fault at the service rather than the
  // market: banana counts are kept for good, so a wrong price would stay on the pile and the
  // board. With a limit missing, donations are closed and nothing says which price to believe.
  refreshPrice() {
    if (this.refreshing) return this.refreshing;
    const limits = readLimits(this.env);
    if (!limits) return Promise.resolve(false);
    const [failed] = this.sql.exec("SELECT value FROM meta WHERE key = 'price_failed'").toArray();
    if (failed && this.platform.now() - failed.value < PRICE_RETRY_MS) return Promise.resolve(false);
    this.refreshing = this.lookupPrice(limits).then(Boolean)
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  // Quotes and receipts use the same jump guard and cache, but never wait on each other.
  // Return this lookup's accepted snapshot, so a concurrent quote cannot replace a receipt.
  async lookupPrice(limits, socketFirst = false) {
    const price = await fetchPrice(this.platform, { socketFirst });
    const [last] = this.sql.exec("SELECT cents, at FROM price").toArray();
    const jumped = price && last && this.platform.now() - last.at < DAY &&
      (price.cents > last.cents * limits.priceJumpMax || price.cents * limits.priceJumpMax < last.cents);
    if (price === null || jumped) {
      const now = this.platform.now();
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('price_failed', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        now,
      );
      this.sql.exec("UPDATE price SET failed = ? WHERE id = 1", now);
      const fallback = last ? `the last price, from ${new Date(last.at).toISOString()}, marked stale` : "no price";
      const why = jumped
        ? `gave $${price.cents / 100}, too far from the last price, $${last.cents / 100}`
        : "answered neither by REST nor by socket";
      console.error(`price: 2140data's service ${why}; invoices get ${fallback}`);
      return null;
    }
    if (price.from === "socket" && !socketFirst) console.warn("price: 2140data's REST API didn't answer; its socket did");
    if (price.from === "rest" && socketFirst) console.warn("price: 2140data's socket didn't answer; its REST API did");
    this.sql.exec("DELETE FROM meta WHERE key = 'price_failed'");
    const at = this.platform.now();
    this.sql.exec(
      "INSERT INTO price (id, cents, at, failed) VALUES (1, ?, ?, NULL) " +
      "ON CONFLICT (id) DO UPDATE SET cents = excluded.cents, at = excluded.at, failed = NULL",
      price.cents, at,
    );
    return { cents: price.cents, at, stale: false };
  }

  // The board's figures from D1, kept up to date there with each donation recorded: every
  // donation, all time, and the last seven days by the hour, with the rate beside them. Kept in
  // memory between donations; null if D1 can't be read and nothing is kept.
  async tally({ refresh = false, strict = false } = {}) {
    if (refresh || !this.tallyFigures) {
      const asked = ++this.tallyAsked;
      try {
        const [overall, hours] = await Promise.all([
          this.env.DB.prepare("SELECT count, sats, milli, last FROM tally WHERE id = 1").first(),
          this.env.DB.prepare("SELECT hour, sats, milli FROM tally_hours WHERE hour >= ? ORDER BY hour")
            .bind(this.tallySince()).all(),
        ]);
        if (!overall) throw new Error("D1 has no tally row");
        if (asked > this.tallyShown) {
          this.tallyShown = asked;
          this.tallyFigures = { ...overall, hours: hours.results };
        }
      } catch (error) {
        console.error("reading the tally failed:", error.message);
        if (strict) throw error;
      }
    }
    if (!this.tallyFigures) return null;
    const { count, sats, milli, last, hours } = this.tallyFigures;
    const since = this.tallySince();
    return {
      type: "tally",
      count,
      sats,
      bananas: milli / 1000,
      last: last ?? null,
      hours: hours.filter((h) => h.hour >= since).map((h) => [h.hour, h.sats, h.milli / 1000]),
      rate: this.currentRate(),
    };
  }

  // The start of the earliest hour the tally shows.
  tallySince() {
    const now = this.platform.now();
    return now - (now % HOUR) - (TALLY_HOURS - 1) * HOUR;
  }

  // The last price, as the invoice reply gives it, marked stale while the service isn't
  // answering. Null with no price ever.
  currentRate() {
    const [last] = this.sql.exec("SELECT cents, at, failed FROM price").toArray();
    return last ? { ...rateOf(last.cents, last.at), stale: last.failed !== null } : null;
  }

  sentRate() {
    return this.sql.exec("SELECT rate FROM tally_rate").toArray()[0]?.rate ?? null;
  }

  markRateSent(rate) {
    this.sql.exec(
      "INSERT INTO tally_rate (id, rate) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET rate = excluded.rate",
      rateKey(rate),
    );
  }

  // Every page gets the tally: after a donation, with its figures read again; after a new
  // price, only when the rate changed, so pages never get the same tally twice.
  async pushTally({ refresh = false } = {}) {
    const tally = await this.tally({ refresh });
    if (!tally) return;
    this.markRateSent(tally.rate);
    this.broadcast(tally);
  }

  // The rate in storage is the one the pages last got, and only a tally that went out changes
  // it, so one that couldn't be read is tried again. The rate on its way is noted in memory
  // before anything waits, so lookups that finish together send it once.
  async pushRateIfChanged() {
    const key = rateKey(this.currentRate());
    if (key === this.sentRate() || key === this.rateSending) return;
    this.rateSending = key;
    try {
      await this.pushTally();
    } finally {
      if (this.rateSending === key) this.rateSending = null;
    }
  }

  // A price older than five minutes is asked for again, sharing a lookup already on its way
  // and keeping 0013's minute after a failure, then the pages hear if the rate changed.
  async freshenRate() {
    try {
      const [last] = this.sql.exec("SELECT at FROM price").toArray();
      if (!last || this.platform.now() - last.at >= PRICE_FRESH_MS) await this.refreshPrice();
      await this.pushRateIfChanged();
    } catch (error) {
      console.error("freshening the rate failed:", error.message);
    }
  }

  // The object has one alarm, and this is all it's used for. Set when a page connects and none
  // is due.
  // Brought forward when something is due sooner, such as a receipt deadline.
  async scheduleFreshening() {
    const current = await this.ctx.storage.getAlarm();
    const due = this.freshenAt();
    if (current === null || due < current) await this.ctx.storage.setAlarm(due);
  }

  // When the price turns five minutes old, or five minutes from now if it already has, as when
  // the service isn't answering; sooner when a receipt-mode invoice's remaining amount, payable
  // address, code verification or expiry is due to change, so an amount-bearing QR is withdrawn
  // on time, not at the next price check.
  freshenAt() {
    const now = this.platform.now();
    const [last] = this.sql.exec("SELECT at FROM price").toArray();
    const due = last ? last.at + PRICE_FRESH_MS : 0;
    const price = due > now ? due : now + PRICE_FRESH_MS;
    const receipt = this.receiptsReadable() ? this.receipts.nextDeadline() : null;
    return receipt === null ? price : Math.min(price, Math.max(receipt, now));
  }

  // While pages are open, the price beside the tally is never much more than five minutes old.
  // With none open, the alarm isn't set again and the object sleeps; the relay's line doesn't
  // keep it going. Between alarms, pages' sockets hibernate, as they always do.
  // With pages open: the price check, receipt deadlines and any broadcast backlog. With none
  // open, only projection work keeps it, and only on its own schedule; otherwise it sleeps.
  async alarm() {
    const pages = this.ctx.getWebSockets("page").length > 0;
    try {
      // First, synchronously, before anything waits on D1 or the network: commit what time has
      // withdrawn from receipt-mode invoices, and send it to the open pages. A stalled D1 can
      // never delay this. With no page open nothing is shown, and the next authorized read
      // commits it.
      if (pages && this.receiptsReadable()) {
        this.receipts.refreshFreshness();
        this.pushReceiptFrames();
      } else {
        // The pile still takes what the receipt ledger holds, and any page still connected hears
        // a revision it missed.
        this.pileBacklog = this.bridgeReceipts();
        this.publishPile();
      }
      // The D1 projection runs whether or not pages are open, in the background; it schedules
      // its own continuation or retry when it finishes, so it never holds this alarm up.
      this.kickProjection();
      if (pages) await this.freshenRate();
    } finally {
      // Whatever failed above, the next alarm is set on its usual schedule: a pile left
      // unacknowledged is sent then, never in a tight loop.
      const now = this.platform.now();
      const due = [];
      // A broadcast backlog continues at once; otherwise the next price check or receipt deadline.
      if (pages) due.push(this.receiptBacklog ? now : this.freshenAt());
      // A page waiting to be retried, at its retry time.
      const retry = this.receiptRetryAt();
      if (retry !== null) due.push(retry);
      // Pile bridge entries still waiting continue at once, a bounded batch each time.
      if (this.pileBacklog) due.push(now);
      // Projection work not already running, at its own time: never sooner than a retry allows.
      if (!this.projecting) {
        const projection = this.projectionDue();
        if (projection !== null) due.push(projection);
      }
      if (due.length) await this.scheduleAt(Math.min(...due));
    }
  }

  webSocketClose(ws) {
    // The closing socket may still read as open inside this handler, so it's left out.
    if (ws.deserializeAttachment()?.role !== "relay" || this.line(ws) !== null) return;
    this.broadcast(this.statusMessage(false));
    // Nobody waits out a timeout on a line that's gone.
    for (const { resolve } of [...this.waiting.values()]) resolve(null);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  // Whether donations are open, and on which network, so a page can label test donations.
  // `accounting` appears only once a receipt-mode mapping exists. Until then there is no
  // receipt service to describe, and its absence means legacy, as it does from older Workers.
  statusMessage(open) {
    const limits = readLimits(this.env);
    const message = { type: "status", open, network: readSettings(this.env).network,
      limits: limits ? { minSats: limits.minSats, maxSats: limits.maxSats, lightningMaxSats: limits.lightningMaxSats, messageMinSats: limits.messageMinSats } : null };
    if (this.receipts.hasMappings()) message.accounting = this.accountingCapability();
    return message;
  }

  line(excluding = null) {
    return this.ctx.getWebSockets("relay").find((ws) => ws !== excluding && ws.readyState === OPEN) ?? null;
  }

  // One question per request at a time: asking again while an answer is on its way, as a
  // double click would, shares that answer.
  ask(line, message, timeoutMs) {
    const key = `${message.type}:${message.request}`;
    const asked = this.waiting.get(key);
    if (asked) return asked.promise;
    const entry = {};
    entry.promise = new Promise((resolve) => {
      const timer = setTimeout(() => entry.resolve(null), timeoutMs);
      entry.resolve = (reply) => {
        clearTimeout(timer);
        if (this.waiting.get(key) === entry) this.waiting.delete(key);
        resolve(reply);
      };
    });
    this.waiting.set(key, entry);
    try {
      line.send(JSON.stringify(message));
    } catch {
      entry.resolve(null);
    }
    return entry.promise;
  }

  // A pile message is marked sent durably only after every page was tried, and only if no page
  // that is still open failed to take it ("sent" meaning ws.send took it: an enqueue, not proof of
  // receipt). Such a failure isn't a page going away: the pile stays unmarked, the failure is
  // logged, and the alarm is brought forward to no later than one price-check cadence away, as a
  // backstop. An alarm already due sooner, for receipt deadlines, a frame backlog or projection
  // work, comes first and sends it then; there is no retry floor for the pile itself. Connected
  // pages already keep an alarm set. Nothing is thrown, so settlement,
  // quarantine, reads and the alarm carry on: a page's delivery problem is never theirs. Returns
  // whether a pile message was marked; other messages are sent as before.
  broadcast(message) {
    const text = JSON.stringify(message);
    const pile = message?.type === "pile";
    let failure = null;
    for (const ws of this.ctx.getWebSockets("page")) {
      // A page closing or closed has nobody to tell.
      if (pile && ws.readyState !== OPEN) continue;
      try {
        ws.send(text);
      } catch (error) {
        // A page that's going away misses nothing it can use.
        if (pile && ws.readyState === OPEN) failure ??= error;
      }
    }
    if (!pile) return true;
    if (failure) {
      console.error(`pile: an open page didn't take revision ${message.revision} (${failure.message}); sending it again later`);
      this.ctx.waitUntil(this.scheduleAt(this.platform.now() + PRICE_FRESH_MS));
      return false;
    }
    this.markPileBroadcast(message.revision);
    return true;
  }

  // Fixed one-minute windows. Invoices and on-chain switches, the requests that make work for
  // the node, count per visitor and overall. Notes and page sockets count per visitor, each on
  // their own, so a crowd of page loads can't close donations. The counts are kept in storage,
  // so they hold when the object sleeps, under the visitor's group rather than their address,
  // and go when the minute ends. A visitor shares a count only with the rare other in their
  // group.
  allow(kind, visitor, { ratePerIp, noteRatePerIp, rateGlobal }) {
    const minute = Math.floor(this.platform.now() / 60_000);
    if (this.minute !== minute) {
      this.minute = minute;
      this.sql.exec("DELETE FROM rate WHERE minute <> ?", minute);
    }
    const counted = (key) => this.sql.exec("SELECT count FROM rate WHERE key = ?", key).toArray()[0]?.count ?? 0;
    const add = (key) => this.sql.exec(
      "INSERT INTO rate (key, minute, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1",
      key, minute,
    );
    const key = `${kind} ${visitorGroup(visitor, 64)}`;
    const limit = kind === "note" ? noteRatePerIp : ratePerIp;
    if (counted(key) >= limit || (kind === "work" && counted("total") >= rateGlobal)) return false;
    add(key);
    if (kind === "work") add("total");
    return true;
  }

  // Unpaid requests, and the marks of donations long finished, go after the retention period.
  // The relay stops resending a notice well before then.
  purge() {
    const cutoff = this.platform.now() - readSettings(this.env).pendingDays * DAY;
    this.sql.exec("DELETE FROM pending WHERE created < ?", cutoff);
    this.sql.exec("DELETE FROM finished WHERE at < ?", cutoff);
  }
}

// An IPv6 visitor counts by its /64, the block a single host can rotate through, or by a wider
// prefix where asked. Something that isn't an address counts as itself.
export function visitorKey(address, prefix = 64) {
  if (!address.includes(":")) return address;
  if (address.includes(".")) return address.slice(address.lastIndexOf(":") + 1);
  const [head, tail, extra] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (extra !== undefined || left.length + right.length > (tail === undefined ? 8 : 7)) return address;
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, prefix / 16).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/${prefix}`;
}

// What the object keeps of a visitor: never the address, but 16 bits of a hash of it, or of its
// IPv6 prefix. That makes it one of 65,536 groups, each shared by tens of thousands of addresses.
// Page sockets, which stay open for as long as a page does, carry it as a tag, by the /48, the
// block one customer can get; the rate limits count by it, by the /64. FNV-1a, which needs no
// waiting, so nothing a page or donor does takes longer.
export function visitorGroup(visitor, prefix = 48) {
  let hash = 0x811c9dc5;
  for (const char of visitorKey(visitor, prefix)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return `visitor-${((hash >>> 16) ^ (hash & 0xffff)).toString(16).padStart(4, "0")}`;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const closed = () => json({ error: "closed" }, 503);
const busy = () => json({ error: "busy" }, 429);

// A private read's answer: the core's errors as their agreed statuses, otherwise the reply.
const READ_ERRORS = { unknown: 404, cursor: 400, resync: 409, closed: 503 };
const readReply = (result) => (result.error ? json({ error: result.error }, READ_ERRORS[result.error] ?? 400) : json(result));

// What a page shows of a rate: the price and whether it's stale, not when it was fetched. A
// tally goes out again only when this changes.
const rateKey = (rate) => (rate ? `${rate.usdPerBtc} ${rate.stale}` : "none");

// OBL's donation event stays unchanged; sequence and account-name proof belong to its envelope.
const donationMessage = (row) => ({ type: "donation", donation: donationEvent(row), bananas: bananasOf(row.milli ?? null),
  seq: row.seq, verified: row.verified === 1 });
const recentEntry = (row) => ({ ...donationEvent(row), bananas: bananasOf(row.milli ?? null)?.exact ?? 0,
  seq: row.seq, verified: row.verified === 1 });
const atMessageBar = (row, messageMinSats) => row.sats < messageMinSats && row.message ? { ...row, message: "" } : row;

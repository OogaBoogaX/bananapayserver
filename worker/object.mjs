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
import { PILE_SCHEMA, pileKnows, pileRevision, pileView, recordPileDelta, recordPileException } from "./pile.mjs";
import { hashRequest, MODE, ReceiptLedger } from "./receipts.mjs";
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
    // Frames committed before this start that pages never heard live are sent on the next push;
    // a first start begins at the current mark, so history is never broadcast as live.
    if (!this.sql.exec("SELECT 1 FROM meta WHERE key = 'receipt_broadcast'").toArray().length) {
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('receipt_broadcast', ?)", this.receipts.feedHighWater());
    }
    this.receiptBacklog = false;
    this.capability = JSON.stringify(this.accountingCapability());
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

  // Sends committed feed frames pages haven't heard live, in order, one bounded batch at a
  // time from a durable mark, so a long backlog never loads at once and nothing is skipped: a
  // full batch asks the alarm to continue at once. With no page connected there is nobody to
  // tell; the mark moves to the high-water point, and pages that connect later get recent
  // receipts and the marker instead. At least once: a frame may also reach a page in its replay,
  // and pages deduplicate by revision. A capability change sends a new status.
  pushReceiptFrames() {
    const settings = this.receipts.readSettings();
    const last = this.sql.exec("SELECT value FROM meta WHERE key = 'receipt_broadcast'").one().value;
    if (settings && this.ctx.getWebSockets("page").length > 0) {
      const frames = this.receipts.feedSince(last, settings.replayMax);
      // A page hears live only frames after the high-water mark its own connect captured;
      // anything at or below it was its snapshot or replay, and never arrives as live.
      const pages = this.ctx.getWebSockets("page");
      for (const { seq, frame } of frames) {
        const text = JSON.stringify({ ...frame, replay: false });
        for (const ws of pages) {
          if ((ws.deserializeAttachment()?.through ?? -1) >= seq) continue;
          try {
            ws.send(text);
          } catch {
            // A page that's going away misses nothing it can use.
          }
        }
      }
      if (frames.length) this.sql.exec("UPDATE meta SET value = ? WHERE key = 'receipt_broadcast'", frames.at(-1).seq);
      this.receiptBacklog = frames.length === settings.replayMax && this.receipts.feedHighWater() > frames.at(-1).seq;
    } else {
      this.sql.exec("UPDATE meta SET value = ? WHERE key = 'receipt_broadcast'", Math.max(last, this.receipts.feedHighWater()));
      this.receiptBacklog = false;
    }
    if (this.receiptBacklog) this.ctx.waitUntil(this.ctx.storage.setAlarm(this.platform.now()));
    const capability = JSON.stringify(this.accountingCapability());
    if (capability !== this.capability) {
      this.capability = capability;
      this.broadcast(this.statusMessage(this.line() !== null));
    }
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
    ws.serializeAttachment({ ...ws.deserializeAttachment(), through: replay.through ?? 0 });
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
  pileMessage() {
    return pileView(this.sql);
  }

  // The top entered handles in each unit: recorded fractional bananas and exact sats. Each list is limited
  // independently, since a changing price can give them different leaders. Matching handles combine
  // across accounts and guests, case-insensitively. Legacy unnamed donations never appear. Kept in memory between donations; null if D1 can't be read and nothing is
  // kept. Reads can come back out of order, so only the newest one asked for is kept.
  async board({ refresh = false } = {}) {
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
  async tally({ refresh = false } = {}) {
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
  async alarm() {
    if (this.ctx.getWebSockets("page").length === 0) return;
    try {
      // What time alone withdrew from receipt-mode invoices goes out while pages are open.
      if (this.receiptsReadable()) {
        this.receipts.refreshFreshness();
        this.pushReceiptFrames();
      }
      await this.freshenRate();
    } finally {
      // A broadcast backlog continues at once; otherwise the next price check or receipt deadline.
      await this.ctx.storage.setAlarm(this.receiptBacklog ? this.platform.now() : this.freshenAt());
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

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets("page")) {
      try {
        ws.send(text);
      } catch {
        // A page that's going away misses nothing it can use.
      }
    }
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

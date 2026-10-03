// The Durable Object: the one place where the relay's line, every page's socket and the
// pending requests meet, and where the global pile and the leaderboard are kept. It accepts
// sockets with the Hibernation API, so an idle line costs no duration. It checks every message
// from the relay before acting on it.

import { invoiceMatches } from "../shared/bolt11.mjs";
import { donationEvent } from "../shared/donation.mjs";
import { parseUp } from "../shared/protocol.mjs";
import { readLimits, readSettings } from "./config.mjs";
import { BANANA_CENTS, bananasOf, fetchPrice, milliBananas, rateOf } from "./price.mjs";

// The most donations a reconnecting page is sent to catch up.
export const REPLAY_MAX = 50;

// How many signed-in donors the leaderboard shows.
export const BOARD_SIZE = 20;

// After the price service fails to answer, how long invoices use the last price before the
// object asks it again, so no donor waits on a service that's down.
export const PRICE_RETRY_MS = 60_000;

// Cloudflare allows an object 32,768 hibernatable sockets. Pages stop short of that, so a
// crowd of them can never leave the relay without room for its line.
export const PAGE_SOCKETS_MAX = 30_000;

const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const OPEN = 1;
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
    this.boardAsked = 0;
    this.boardShown = 0;
    this.refreshing = null;
    this.priceFailedAt = null;
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
      case "/page":
        return this.page(request, url);
      case "/relay":
        return this.relay();
    }
    return json({ error: "not found" }, 404);
  }

  // github is the signed-in donor, { id, login }, or null for an anonymous donation.
  async invoice({ sats, message, github, client }) {
    const limits = readLimits(this.env);
    const { network, invoiceTimeoutMs } = readSettings(this.env);
    if (!limits || !network) return closed();
    if (!this.allow("work", client, limits)) return busy();
    const line = this.line();
    if (!line) return closed();

    this.purge();
    const request = this.platform.id();
    this.sql.exec(
      "INSERT INTO pending (request, sats, handle, message, github_id, created) VALUES (?, ?, ?, ?, ?, ?)",
      request, sats, github?.login ?? "", message, github?.id ?? null, this.platform.now(),
    );
    // The price is looked up while the relay makes the invoice, so it costs the donor no time.
    const [reply, price] = await Promise.all([
      this.ask(line, { type: "invoice", request, sats }, invoiceTimeoutMs),
      this.price(),
    ]);
    const invoice = reply?.invoice;
    // The rate is locked here, so the donor's count is what they were shown, however long the
    // payment takes.
    const milli = price ? milliBananas(sats, price.cents) : null;
    if (!invoice || !invoiceMatches(invoice.bolt11, network, sats) || !this.attach(request, invoice, price, milli)) {
      this.sql.exec("DELETE FROM pending WHERE request = ?", request);
      return reply?.error === "cap" ? json({ error: "amount" }, 400) : closed();
    }
    return json({
      request,
      invoice: { id: invoice.id, bolt11: invoice.bolt11, expires: invoice.expires },
      bananas: bananasOf(milli),
      rate: price ? { ...rateOf(price.cents, price.at), stale: price.stale } : null,
    });
  }

  // Records which invoice answers a request, and the price it's counted at. False if the relay
  // reused an invoice id.
  attach(request, { id, expires }, price, milli) {
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

  // The message can follow the amount, any time before the invoice is paid. Who gave it was
  // settled when the invoice was made.
  note({ request, message, client }) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    if (!this.allow("note", client, limits)) return busy();
    const updated = this.sql.exec(
      "UPDATE pending SET message = ? WHERE request = ? RETURNING request",
      message, request,
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
    if (!reply?.address || !ADDRESS[network].test(reply.address) || reply.sats < row.sats) return closed();
    return json({ address: reply.address, sats: reply.sats });
  }

  async page(request, url) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    if (!this.allow("page", request.headers.get("X-Client") ?? "", limits)) return busy();
    if (this.ctx.getWebSockets("page").length >= PAGE_SOCKETS_MAX) return busy();
    const [client, server] = this.platform.pair();
    server.serializeAttachment({ role: "page" });
    this.ctx.acceptWebSocket(server, ["page"]);
    server.send(JSON.stringify({ type: "status", open: this.line() !== null }));
    server.send(JSON.stringify(this.pileMessage(this.platform.now())));
    const board = await this.board();
    if (board) server.send(JSON.stringify(board));
    const after = url.searchParams.get("after");
    if (after && INVOICE_ID.test(after)) await this.replay(server, after);
    return this.platform.upgrade(client);
  }

  // A page that reconnects names the last donation it saw and gets anything newer. A donation
  // recorded while the replay is on its way can reach the page twice; pages ignore an id they
  // have already played.
  async replay(ws, after) {
    try {
      const { results } = await this.env.DB.prepare(
        "SELECT id, sats, handle, message, at, milli FROM donations " +
        "WHERE seq > (SELECT seq FROM donations WHERE id = ?) ORDER BY seq LIMIT ?",
      ).bind(after, REPLAY_MAX).all();
      for (const row of results) ws.send(JSON.stringify(donationMessage(row)));
    } catch (error) {
      console.error("replay failed:", error.message);
    }
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
    this.broadcast({ type: "status", open: true });
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
    const [row] = this.sql.exec(
      "SELECT request, sats, handle, message, github_id, price_cents, price_at, milli FROM pending WHERE invoice = ?",
      invoice,
    ).toArray();
    if (!row) {
      const known = await this.env.DB.prepare("SELECT 1 FROM donations WHERE id = ?").bind(invoice).first();
      return known ? "duplicate" : "unknown";
    }
    if (row.sats !== sats) return "rejected";
    const inserted = await this.env.DB.prepare(
      "INSERT INTO donations (id, sats, handle, message, at, method, github_id, price_cents, price_at, banana_cents, milli) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (id) DO NOTHING RETURNING id, sats, handle, message, at, milli",
    ).bind(
      invoice, sats, row.handle, row.message, this.platform.now(), method, row.github_id,
      row.price_cents, row.price_at, row.price_cents === null ? null : BANANA_CENTS, row.milli,
    ).first();
    const recorded = inserted ?? await this.env.DB.prepare(
      "SELECT id, sats, handle, message, at, milli FROM donations WHERE id = ?",
    ).bind(invoice).first();
    if (!recorded) throw new Error("a donation that was neither inserted nor found");
    const pile = this.finish(recorded);
    this.sql.exec("DELETE FROM pending WHERE request = ?", row.request);
    if (pile !== false) {
      this.broadcast(donationMessage(recorded));
      if (pile) this.broadcast(pile);
      if (row.github_id !== null && recorded.milli !== null) {
        const board = await this.board({ refresh: true });
        if (board) this.broadcast(board);
      }
    }
    return inserted ? "recorded" : "duplicate";
  }

  // Marks a recorded donation finished and adds it to the pile, in one step. False if it was
  // already finished; otherwise the pile's new state, or null for a donation with no bananas.
  finish({ id, milli, at }) {
    return this.ctx.storage.transactionSync(() => {
      const first = this.sql.exec(
        "INSERT INTO finished (invoice, at) VALUES (?, ?) ON CONFLICT (invoice) DO NOTHING RETURNING invoice",
        id, at,
      ).toArray();
      if (!first.length) return false;
      return milli === null ? null : this.addToPile(milli, at);
    });
  }

  // The global pile: one level for everyone, worked out from the donations and a fixed eating
  // rate. Each donation is added once, and the Oogas eat at the same rate on every page, so any
  // page can tell the level from the last state it was sent. Its clock never runs backwards,
  // even when notices finish out of order.
  pileState(now) {
    let [row] = this.sql.exec("SELECT milli, at FROM pile").toArray();
    if (!row) {
      row = { milli: readSettings(this.env).pileStart * 1000, at: now };
      this.sql.exec("INSERT INTO pile (id, milli, at, started) VALUES (1, ?, ?, ?)", row.milli, now, now);
    }
    return row;
  }

  pileAt(now, state = this.pileState(now)) {
    // Thousandths eaten: bananas an hour, times milliseconds, over 3,600 seconds' worth.
    const eaten = BigInt(readSettings(this.env).pileEatPerHour) * BigInt(Math.max(0, now - state.at)) / 3_600n;
    return Math.max(0, state.milli - Number(eaten));
  }

  addToPile(milli, at) {
    const state = this.pileState(at);
    const time = Math.max(at, state.at);
    const level = this.pileAt(time, state) + milli;
    this.sql.exec("UPDATE pile SET milli = ?, at = ? WHERE id = 1", level, time);
    return this.pileMessage(time, level);
  }

  pileMessage(now, level = this.pileAt(now)) {
    return { type: "pile", bananas: level / 1000, at: now, eatPerHour: readSettings(this.env).pileEatPerHour };
  }

  // The top signed-in donors, rounded to whole bananas. Anonymous donations count in the pile
  // but never here. Kept in memory between donations; null if D1 can't be read and nothing is
  // kept. Reads can come back out of order, so only the newest one asked for is kept.
  async board({ refresh = false } = {}) {
    if (refresh || !this.boardEntries) {
      const asked = ++this.boardAsked;
      try {
        const { results } = await this.env.DB.prepare(
          "SELECT login, milli FROM totals ORDER BY milli DESC, github_id LIMIT ?",
        ).bind(BOARD_SIZE).all();
        if (asked > this.boardShown) {
          this.boardShown = asked;
          this.boardEntries = results.map((r) => ({ handle: r.login, bananas: Math.round(r.milli / 1000) }));
        }
      } catch (error) {
        console.error("reading the leaderboard failed:", error.message);
      }
    }
    return this.boardEntries ? { type: "board", entries: this.boardEntries } : null;
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

  // True when a new price came in. Invoices asking at the same time share one lookup.
  refreshPrice() {
    if (this.refreshing) return this.refreshing;
    if (this.priceFailedAt !== null && this.platform.now() - this.priceFailedAt < PRICE_RETRY_MS) return Promise.resolve(false);
    this.refreshing = fetchPrice(this.platform)
      .then((price) => {
        if (price === null) {
          this.priceFailedAt = this.platform.now();
          const [last] = this.sql.exec("SELECT at FROM price").toArray();
          const fallback = last ? `the last price, from ${new Date(last.at).toISOString()}, marked stale` : "no price";
          console.error(`price: 2140data's service answered neither by socket nor by REST; invoices get ${fallback}`);
          return false;
        }
        if (price.from === "rest") console.warn("price: 2140data's socket didn't answer; its REST API did");
        this.priceFailedAt = null;
        this.sql.exec(
          "INSERT INTO price (id, cents, at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET cents = excluded.cents, at = excluded.at",
          price.cents, this.platform.now(),
        );
        return true;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  webSocketClose(ws) {
    // The closing socket may still read as open inside this handler, so it's left out.
    if (ws.deserializeAttachment()?.role !== "relay" || this.line(ws) !== null) return;
    this.broadcast({ type: "status", open: false });
    // Nobody waits out a timeout on a line that's gone.
    for (const { resolve } of [...this.waiting.values()]) resolve(null);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
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
  // their own, so a crowd of page loads can't close donations. Addresses live in memory for at
  // most a minute and are never stored.
  allow(kind, visitor, { ratePerIp, rateGlobal }) {
    const minute = Math.floor(this.platform.now() / 60_000);
    if (this.minute !== minute) {
      this.minute = minute;
      this.counts = new Map();
      this.total = 0;
    }
    const key = `${kind} ${visitorKey(visitor)}`;
    const count = this.counts.get(key) ?? 0;
    if (count >= ratePerIp || (kind === "work" && this.total >= rateGlobal)) return false;
    this.counts.set(key, count + 1);
    if (kind === "work") this.total += 1;
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

// An IPv6 visitor counts by its /64, the block a single host can rotate through.
export function visitorKey(address) {
  if (!address.includes(":")) return address;
  if (address.includes(".")) return address.slice(address.lastIndexOf(":") + 1);
  const [head, tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const closed = () => json({ error: "closed" }, 503);
const busy = () => json({ error: "busy" }, 429);

// OBL's donation event, unchanged, with what it counted for in bananas alongside.
const donationMessage = (row) => ({ type: "donation", donation: donationEvent(row), bananas: bananasOf(row.milli ?? null) });

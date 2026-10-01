// The Durable Object: the one place where the relay's line, every page's socket and the
// pending requests meet. It accepts sockets with the Hibernation API, so an idle line costs no
// duration. It checks every message from the relay before acting on it.

import { invoiceMatches } from "../shared/bolt11.mjs";
import { donationEvent } from "../shared/donation.mjs";
import { parseUp } from "../shared/protocol.mjs";
import { readLimits, readSettings } from "./config.mjs";

// The most donations a reconnecting page is sent to catch up.
export const REPLAY_MAX = 50;

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

// Pending requests stay in the object's own storage, never in D1: the handle and message wait
// here until the invoice is paid, and the node never sees them.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending (
    request TEXT PRIMARY KEY,
    sats INTEGER NOT NULL,
    handle TEXT NOT NULL,
    message TEXT NOT NULL,
    invoice TEXT UNIQUE,
    expires INTEGER,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_created ON pending (created);
`;

export class DonationsObject {
  // platform: { pair, upgrade, now, id }, so the tests can run this without the runtime.
  constructor(ctx, env, platform) {
    this.ctx = ctx;
    this.env = env;
    this.platform = platform;
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.waiting = new Map();
    this.minute = null;
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

  async invoice({ sats, handle, message, client }) {
    const limits = readLimits(this.env);
    const { network, invoiceTimeoutMs } = readSettings(this.env);
    if (!limits || !network) return closed();
    if (!this.allow("work", client, limits)) return busy();
    const line = this.line();
    if (!line) return closed();

    this.purge();
    const request = this.platform.id();
    this.sql.exec(
      "INSERT INTO pending (request, sats, handle, message, created) VALUES (?, ?, ?, ?, ?)",
      request, sats, handle, message, this.platform.now(),
    );
    const reply = await this.ask(line, { type: "invoice", request, sats }, invoiceTimeoutMs);
    const invoice = reply?.invoice;
    if (!invoice || !invoiceMatches(invoice.bolt11, network, sats) || !this.attach(request, invoice)) {
      this.sql.exec("DELETE FROM pending WHERE request = ?", request);
      return reply?.error === "cap" ? json({ error: "amount" }, 400) : closed();
    }
    return json({ request, invoice: { id: invoice.id, bolt11: invoice.bolt11, expires: invoice.expires } });
  }

  // Records which invoice answers a request. False if the relay reused an invoice id.
  attach(request, { id, expires }) {
    try {
      this.sql.exec("UPDATE pending SET invoice = ?, expires = ? WHERE request = ?", id, expires, request);
      return true;
    } catch {
      return false;
    }
  }

  // The handle and message can follow the amount, any time before the invoice is paid.
  note({ request, handle, message, client }) {
    const limits = readLimits(this.env);
    if (!limits) return closed();
    if (!this.allow("note", client, limits)) return busy();
    const updated = this.sql.exec(
      "UPDATE pending SET handle = ?, message = ? WHERE request = ? RETURNING request",
      handle, message, request,
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
        "SELECT id, sats, handle, message, at FROM donations " +
        "WHERE seq > (SELECT seq FROM donations WHERE id = ?) ORDER BY seq LIMIT ?",
      ).bind(after, REPLAY_MAX).all();
      for (const row of results) ws.send(JSON.stringify({ type: "donation", donation: donationEvent(row) }));
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

  // Each invoice is recorded once and pushed once. D1 calls let other messages in while they
  // wait, so a repeated notice can arrive mid-way; only the call whose insert writes the row
  // pushes it.
  async paid({ invoice, sats }) {
    const [row] = this.sql.exec(
      "SELECT request, sats, handle, message FROM pending WHERE invoice = ?",
      invoice,
    ).toArray();
    if (!row) {
      const known = await this.env.DB.prepare("SELECT 1 FROM donations WHERE id = ?").bind(invoice).first();
      return known ? "duplicate" : "unknown";
    }
    if (row.sats !== sats) return "rejected";
    const recorded = await this.env.DB.prepare(
      "INSERT INTO donations (id, sats, handle, message, at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (id) DO NOTHING RETURNING id, sats, handle, message, at",
    ).bind(invoice, sats, row.handle, row.message, this.platform.now()).first();
    this.sql.exec("DELETE FROM pending WHERE request = ?", row.request);
    if (!recorded) return "duplicate";
    this.broadcast({ type: "donation", donation: donationEvent(recorded) });
    return "recorded";
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

  purge() {
    const cutoff = this.platform.now() - readSettings(this.env).pendingDays * DAY;
    this.sql.exec("DELETE FROM pending WHERE created < ?", cutoff);
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

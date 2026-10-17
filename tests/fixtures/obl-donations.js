// Donations, simulated or real. Real mode talks to the page's API (bananapayserver, its contract in that repository's
// docs/protocol.md): `invoice` asks it for a Lightning invoice, `note` sets the message, `onchain` adds an address to
// pay that invoice on-chain, and `subscribe` opens its socket, which pushes each donation in OBL's event shape
// `{ id, sats, handle, message, at }`, the pile, the leaderboard, the tally of every donation it holds with its current
// rate, whether donations are open, and each on-chain payment seen before its block. Without an API the simulator plays
// tips now and then, as it always has, for demos and for the suite.
//
// The page only ever calls its own address: its Worker passes /donations/* on to bananapayserver over a service binding
// and names the donor from its own GitHub sign-in, while the page supplies the editable display handle. Real mode starts once that Worker says
// it has the binding (`useOrigin`, which the director calls when the account's look at /api/me reports `donations`), so
// staging and production each find their own with nothing stamped into the build. The socket's status says which
// network the payments are on: anything but mainnet is a test (`testNetwork`), and the page labels it so.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const NETWORKS = ["mainnet", "testnet", "signet", "regtest"];
  let real = false, invoiceMessageMax = 80;
  const config = {
    serverUrl: "https://btcpay.example.org",
    storeId: "REPLACE_WITH_STORE_ID",
    currency: "BTC",
    simulate: true
  };
  // GitHub usernames run to 39 characters; the API's copy of the contract holds the same.
  const HANDLE_MAX = 39;
  const MESSAGE_MAX = 280;
  const sanitize = (text, max) => String(text || "").replace(/[^\w .,!?'@#:-]/g, "").trim().slice(0, max);
  const randomId = () => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const createRequest = ({ handle = "", message = "" } = {}) => {
    const id = `banana-${randomId()}`;
    const url = new URL(`${config.serverUrl}/api/v1/invoices`);
    url.searchParams.set("storeId", config.storeId);
    url.searchParams.set("currency", config.currency);
    url.searchParams.set("orderId", id);
    const cleanHandle = sanitize(handle, HANDLE_MAX);
    const cleanMessage = sanitize(message, MESSAGE_MAX);
    if (cleanHandle) url.searchParams.set("handle", cleanHandle);
    if (cleanMessage) url.searchParams.set("message", cleanMessage);
    return { id, url: url.toString(), handle: cleanHandle, message: cleanMessage };
  };

  // ---- real mode: the API ------------------------------------------------------------------------------------
  const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
  // A price as the API sends one: dollars a bitcoin, sats a banana, when it was fetched and whether that was the last
  // price because a newer one could not be had.
  const rateOf = (rate) => rate && isNumber(rate.usdPerBtc) && isNumber(rate.satsPerBanana)
    ? { usdPerBtc: rate.usdPerBtc, satsPerBanana: rate.satsPerBanana, at: isNumber(rate.at) ? rate.at : 0, stale: !!rate.stale } : null;
  // One call to the page's own Worker: JSON in and out with the sign-in cookie. Resolves to the reply (`{}` for a
  // 204), or to `{ error }` as the API names it, `network` when it cannot be reached.
  const call = async (path, body) => {
    let res;
    try {
      res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      return { error: "network" };
    }
    if (res.status === 204) return {};
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Not JSON: checked below.
    }
    if (!res.ok) return { error: data && typeof data.error === "string" ? data.error : "invalid" };
    return data && typeof data === "object" && !Array.isArray(data) ? data : { error: "invalid" };
  };
  // An invoice for `sats`, with the message if there is one: `{ request, invoice: { id, bolt11, expires }, bananas,
  // rate }` checked field by field (`bananas` and `rate` null when there has never been a price, `bolt11` null when the
  // API couldn't make the Lightning half in time, and the invoice can still be paid on-chain), or `{ error }`.
  // `request` stays in memory, never in an address.
  const invoice = async ({ sats, handle, message = "", anon = false }) => {
    const body = { sats }, text = sanitize(message, MESSAGE_MAX);
    if (handle !== undefined) body.handle = sanitize(handle, HANDLE_MAX).replace(/^@+/, "").trim() || "anon";
    if (text) body.message = text;
    if (anon) body.anon = true;
    let r = await call("/donations/invoice", body);
    // Keep default-name payments working during the coordinated backend rollout. An older
    // server rejects the new handle key; never silently discard a custom name or long message.
    if (r.error === "invalid" && body.handle !== undefined) {
      const defaultHandle = BL.net?.state.me?.login || "anon";
      if (body.handle !== defaultHandle || text.length > 80) return { error: "details" };
      delete body.handle;
      r = await call("/donations/invoice", body);
    }
    if (r.error) return r;
    const inv = r.invoice, b = r.bananas, rate = r.rate;
    if (typeof r.request !== "string" || !inv || typeof inv.id !== "string" || typeof inv.bolt11 !== "string" && inv.bolt11 != null || !isNumber(inv.expires)) return { error: "invalid" };
    invoiceMessageMax = body.handle === undefined ? 80 : MESSAGE_MAX;
    return {
      request: r.request,
      invoice: { id: inv.id, bolt11: inv.bolt11 || null, expires: inv.expires },
      bananas: b && isNumber(b.exact) && isNumber(b.rounded) ? { exact: b.exact, rounded: b.rounded } : null,
      rate: rateOf(rate),
      pricing: r.pricing === "receipt" ? "receipt" : "invoice",
      lightning: ["available", "limit", "unavailable"].includes(r.lightning) ? r.lightning : inv.bolt11 ? "available" : "unavailable"
    };
  };
  // Replaces the message on a request not yet paid.
  const note = (request, message, handle) => {
    const body = { request, message: sanitize(message, MESSAGE_MAX) };
    // Older servers accept notes but silently cap them at 80 characters. Never claim a long edit saved there.
    if (body.message.length > invoiceMessageMax) return Promise.resolve({ error: "invalid" });
    if (handle !== undefined) body.handle = sanitize(handle, HANDLE_MAX).replace(/^@+/, "").trim() || "anon";
    return call("/donations/note", body);
  };
  // Switches a request's invoice to on-chain as well: `{ address, sats }`, the address and what to send there (more than
  // the invoice when the store adds a network fee), checked, or `{ error }` (`expired` once the invoice has).
  const onchain = async (request) => {
    const r = await call("/donations/onchain", { request });
    if (r.error) return r;
    if (typeof r.address !== "string" || !/^[0-9A-Za-z]{14,100}$/.test(r.address) || !Number.isInteger(r.sats) || r.sats <= 0) return { error: "invalid" };
    return { address: r.address, sats: r.sats };
  };
  // The invoices the kiosk let the visitor go from with an on-chain address shown and nothing received, kept for the
  // page life so the payment, when it is seen and when it confirms, can say it was theirs: `waitFor(id)`,
  // `waitingOn(id)`, and `waited(id)`, true once when that invoice's donation comes. Past WAIT_MAX the oldest is dropped.
  const WAIT_MAX = 16, waiting = new Set();
  const waitFor = (id) => {
    waiting.add(id);
    if (waiting.size > WAIT_MAX) waiting.delete(waiting.values().next().value);
  };
  const waitingOn = (id) => waiting.has(id);
  const waited = (id) => waiting.delete(id);

  // The socket. It sends nothing (a page that does is closed), comes back with backoff, and on a reconnect asks for
  // what it missed after the last donation it played; a donation already played is skipped. `state.open` is the
  // API's last word on whether donations are open, and `state.network` the network it takes payments on, each null
  // before it has said. `state.tally` is its latest tally, null before the first.
  const SOCKET_MIN = 1000, SOCKET_MAX = 60000, PLAYED = 64;
  const state = { open: null, network: null, connected: false, attempts: 0, donations: 0, tally: null, board: null, boardSats: null, limits: null };
  const limitsOf = (v) => v && Number.isSafeInteger(v.minSats) && v.minSats > 0
    && Number.isSafeInteger(v.maxSats) && v.maxSats >= v.minSats
    && Number.isSafeInteger(v.lightningMaxSats) && v.lightningMaxSats > 0 && v.lightningMaxSats <= v.maxSats
    ? { minSats: v.minSats, maxSats: v.maxSats, lightningMaxSats: v.lightningMaxSats } : null;
  const readers = new Set();
  const notify = () => { for (const reader of readers) reader(); };
  const subscribeState = (reader) => {
    readers.add(reader);
    return () => readers.delete(reader);
  };
  const played = new Array(PLAYED).fill(""), handlers = { donation: null, status: null, pile: null, board: null, seen: null };
  let socket = null, timer = 0, backoff = SOCKET_MIN, after = "", playedAt = 0, live = false;
  const donationOf = (d) => {
    if (!d || typeof d.id !== "string" || !d.id || d.id.length > 64 || !Number.isInteger(d.sats) || d.sats <= 0 || !isNumber(d.at)) return null;
    return { id: d.id, sats: d.sats, handle: sanitize(d.handle, HANDLE_MAX), message: sanitize(d.message, MESSAGE_MAX), at: d.at };
  };
  const boardOf = (entries) => entries.slice(0, 256)
    .filter((e) => e && typeof e.handle === "string" && isNumber(e.bananas) && e.bananas >= 0)
    .map((e) => ({ handle: sanitize(e.handle, HANDLE_MAX), bananas: e.bananas, sats: Number.isSafeInteger(e.sats) && e.sats >= 0 ? e.sats : null }));
  // The tally: every donation the API holds, all time (`count`, `sats`, `bananas`), the latest one's sats, the last
  // seven days in UTC hours (`[start in ms, sats, bananas]`, only hours with donations) and its current rate. A new
  // object each time, so a reader sees a change by its identity.
  const TALLY_HOURS = 7 * 24 + 1;
  const tallyOf = (t) => {
    if (!isNumber(t.count) || !isNumber(t.sats) || !isNumber(t.bananas) || t.last !== null && !isNumber(t.last) || !Array.isArray(t.hours)) return null;
    const hours = [];
    for (const h of t.hours) if (hours.length < TALLY_HOURS && Array.isArray(h) && isNumber(h[0]) && isNumber(h[1]) && isNumber(h[2])) hours.push([h[0], Math.max(0, h[1]), Math.max(0, h[2])]);
    return { count: Math.max(0, t.count), sats: Math.max(0, t.sats), bananas: Math.max(0, t.bananas), last: Math.max(0, t.last), hours, rate: rateOf(t.rate) };
  };
  const onMessage = (text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    backoff = SOCKET_MIN;
    if (data.type === "status" && typeof data.open === "boolean") {
      state.open = data.open;
      if (NETWORKS.includes(data.network)) state.network = data.network;
      const limits = limitsOf(data.limits);
      if (data.limits === null || limits) state.limits = limits;
      if (handlers.status) handlers.status(data.open);
      notify();
    } else if (data.type === "donation") {
      const donation = donationOf(data.donation), b = data.bananas;
      if (!donation || played.includes(donation.id)) return;
      played[playedAt] = after = donation.id;
      playedAt = (playedAt + 1) % PLAYED;
      state.donations++;
      // A paid invoice with no price counts no bananas; it must never use the simulator's conversion.
      handlers.donation(donation, b && isNumber(b.exact) && isNumber(b.rounded) ? { exact: Math.max(0, b.exact), rounded: Math.max(0, b.rounded) } : { exact: 0, rounded: 0 });
    } else if (data.type === "pile" && isNumber(data.bananas) && isNumber(data.eatPerHour)) {
      if (handlers.pile) handlers.pile({ bananas: Math.max(0, data.bananas), eatPerHour: Math.max(0, data.eatPerHour) });
    } else if (data.type === "board" && Array.isArray(data.entries)) {
      // Independent rankings: the sat leaders may be outside the banana leaders. Older APIs
      // have no satsEntries; never estimate their historical sats from today's price.
      state.board = boardOf(data.entries);
      state.boardSats = Array.isArray(data.satsEntries) ? boardOf(data.satsEntries) : null;
      if (handlers.board) handlers.board(state.board);
      notify();
    } else if (data.type === "tally") {
      const tally = tallyOf(data);
      if (tally) { state.tally = tally; notify(); }
    } else if (data.type === "seen" && typeof data.id === "string" && data.id && Number.isInteger(data.sats) && data.sats > 0 && Number.isInteger(data.due) && data.due > 0 && Number.isInteger(data.left) && data.left >= 0) {
      // An on-chain payment seen before its block: everything received on that invoice so far, its amount, and what
      // is left to send, the network fee for a second payment included (0 once it is all there).
      const p = data.pricing, b = p?.bananas;
      const pricing = data.left === 0 && p && isNumber(p.receivedAt) && p.receivedAt > 0
        ? { receivedAt: p.receivedAt, rate: rateOf(p.rate), bananas: b && isNumber(b.exact) && isNumber(b.rounded) && b.exact >= 0 && b.rounded >= 0 ? { exact: b.exact, rounded: b.rounded } : null } : null;
      if (handlers.seen) handlers.seen(data.id, data.sats, data.due, data.left, pricing);
    }
  };
  const retry = () => {
    if (!live || timer) return;
    timer = window.setTimeout(connect, backoff * (0.8 + Math.random() * 0.4));
    backoff = Math.min(SOCKET_MAX, backoff * 2);
  };
  const connect = () => {
    timer = 0;
    if (!live || socket) return;
    state.attempts++;
    let ws;
    try {
      ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/donations/socket${after ? `?after=${encodeURIComponent(after)}` : ""}`);
    } catch {
      retry();
      return;
    }
    socket = ws;
    ws.onopen = () => { state.connected = true; };
    ws.onmessage = (e) => onMessage(e.data);
    ws.onclose = () => {
      if (socket === ws) socket = null;
      state.connected = false;
      retry();
    };
    ws.onerror = () => {};
  };

  // ---- the simulator ----------------------------------------------------------------------------------------
  // Weights tuned so about half the draws cross the 1,000 sat crate threshold.
  const SIM_AMOUNTS = [300, 500, 800, 1200, 2500, 6000, 25000, 120000];
  const SIM_WEIGHTS = [3, 3, 2.5, 3, 2.5, 1.5, 0.6, 0.2];
  const pickAmount = () => {
    const total = SIM_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < SIM_AMOUNTS.length; i++) {
      r -= SIM_WEIGHTS[i];
      if (r <= 0) return SIM_AMOUNTS[i];
    }
    return SIM_AMOUNTS[0];
  };
  let simTimer = 0, identity = () => ({}), subscribed = false;
  const simulate = (delayMs) => {
    simTimer = window.setTimeout(() => {
      const who = identity();
      handlers.donation({
        id: `sim-${randomId()}`,
        sats: pickAmount(),
        handle: sanitize(who.handle, HANDLE_MAX),
        message: sanitize(who.message, MESSAGE_MAX),
        at: Date.now()
      }, null);
      simulate(15e3 + Math.random() * 20e3);
    }, delayMs);
  };
  // Real mode opens the socket; otherwise the simulator plays, unless nosim has switched it off.
  const begin = () => {
    if (!real) {
      if (config.simulate) simulate(6e3);
      return;
    }
    if (typeof WebSocket === "undefined") return;
    live = true;
    connect();
  };
  // Each donation reaches `onDonation(donation, bananas)`, `bananas` the API's `{ exact, rounded }` in real mode and
  // null from the simulator. In real mode `onStatus(open)`, `onPile({ bananas, eatPerHour })`, `onBoard(entries)` and
  // `onSeen(id, sats, due, left)` follow the socket too; a seen payment may come twice.
  const subscribe = (onDonation, { identity: who = () => ({}), onStatus = null, onPile = null, onBoard = null, onSeen = null } = {}) => {
    Object.assign(handlers, { donation: onDonation, status: onStatus, pile: onPile, board: onBoard, seen: onSeen });
    identity = who;
    subscribed = true;
    begin();
    return () => {
      subscribed = live = false;
      window.clearTimeout(simTimer);
      window.clearTimeout(timer);
      simTimer = timer = 0;
      if (socket) {
        const ws = socket;
        socket = null;
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
      state.connected = false;
    };
  };
  // The page's own Worker reaches the API: real mode from now on. The answer can come after the simulator has started,
  // which then stops for the socket.
  const useOrigin = () => {
    if (real || location.protocol !== "https:" && location.protocol !== "http:") return;
    real = true;
    notify();
    if (!subscribed) return;
    window.clearTimeout(simTimer);
    simTimer = 0;
    begin();
  };
  // The test network real donations are paid on (signet on staging), or "" for mainnet, before the API has said, and
  // when simulated.
  const testNetwork = () => real && state.network && state.network !== "mainnet" ? state.network : "";
  BL.donations = { config, get real() { return real; }, get testNetwork() { return testNetwork(); }, state, useOrigin, createRequest, invoice, note, onchain, waitFor, waitingOn, waited, subscribe, subscribeState, sanitize, HANDLE_MAX, MESSAGE_MAX };
})();

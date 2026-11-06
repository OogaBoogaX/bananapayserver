// The shared receipt-accounting v1 contract vectors, produced by the real core emitters from a
// fixed synthetic scenario. tests/receipt-contract.test.mjs checks the checked-in fixture is
// byte for byte what these produce; scripts/receipt-vectors.mjs writes it after a reviewed
// change. Pages consume the same committed bytes.
//
// Three sections. `vectors` is core-only: what worker/receipts.mjs and worker/pile.mjs emit,
// labeled as such. `endpoints` is what the read endpoints and the socket actually send through
// the front door and object. `projection` is what an open socket hears when the D1 projection
// publishes lifetime figures.

import { fakeCtx, fakeD1, fakePlatform, fakeStorage } from "./cloudflare.mjs";
import { syntheticAddress } from "./synthetic-address.mjs";
import { DonationsObject, PRICE_FRESH_MS } from "../../worker/object.mjs";
import { applyPileAnchor, pileView, recordPileDelta, savedPileSnapshot } from "../../worker/pile.mjs";
import { hashRequest, ReceiptLedger } from "../../worker/receipts.mjs";
import { pay, provider, read, READ, RECEIPT_SETTINGS, seed, TOKEN } from "./receipt-seed.mjs";
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

// What an open page hears when the D1 projection publishes lifetime figures, through the real
// object and the D1 stand-in. Each vector is the socket's messages from a stated point until the
// object's background work (the projection and its publication) has finished, with the D1
// lifetime tally after it, so a consumer can see that a refresh is the authoritative figure and
// a repeated one adds nothing.
async function projectionVectors() {
  const w = await world(RECEIPT_SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger, { invoice: "ProjectInv1", token: TOKEN(0xc1), addresses: [1] });
  const page = await w.connectPage();
  await w.ctx.settle();
  const lifetime = () => {
    const t = w.env.DB.db.prepare("SELECT count, sats, milli, last FROM tally WHERE id = 1").get();
    return { count: t.count, sats: t.sats, milli: t.milli, last: t.last };
  };
  const kinds = new Set(["receipt", "tally", "board"]);
  // The socket's receipt, tally and board messages from `from`, after background work settles.
  const heard = async (from) => {
    await w.ctx.settle();
    return { messages: page.messages().slice(from).filter((m) => kinds.has(m.type)), d1: lifetime() };
  };
  const restart = () => { w.object = new DonationsObject(w.ctx, w.env, w.platform); };

  // A first credit, broadcast as ingestion would: the receipt live, then D1's figures.
  let mark = page.messages().length;
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  const firstCredit = await heard(mark);

  // A second credit whose batch is durable when the object stops, before its outbox row is
  // removed. After a restart, with the page's socket still open, the marker matches: nothing is
  // counted again, and the page gets D1's current figures.
  // It is first observed a moment later, with a different amount, so `last` shows which is newest.
  w.platform.advance(1_000);
  read(w, ledger, invoice, [pay(1), pay(2, "settled", 2500)]);
  w.object.receipts.projected = (id, options) => {
    if (options?.publish) throw new Error("synthetic stop after the batch");
    return ReceiptLedger.prototype.projected.call(w.object.receipts, id, options);
  };
  mark = page.messages().length;
  w.object.pushReceiptFrames();
  await w.ctx.settle().catch(() => {});
  const stoppedLive = page.messages().slice(mark).filter((m) => kinds.has(m.type));
  restart();
  // This time the figures are sent, but the object stops before noting the publication done.
  w.object.receipts.published = () => { throw new Error("synthetic stop after the broadcast"); };
  mark = page.messages().length;
  await w.object.projectReceipts();
  const crashRecovery = await heard(mark);

  // After a restart, once the retry cadence has passed, the same authoritative figures are sent
  // again, and nothing is credited.
  w.platform.advance(PRICE_FRESH_MS + 1);
  restart();
  mark = page.messages().length;
  await w.object.projectReceipts();
  const duplicateRefresh = await heard(mark);

  // The newer receipt reversed, then reconfirmed at its frozen price: `last` falls back to the
  // older one, then returns, its first observation unchanged.
  const [, second] = w.ctx.storage.sql.exec("SELECT id FROM ra_receipts WHERE invoice = ? ORDER BY ord", invoice).toArray();
  read(w, ledger, invoice, [pay(1), pay(2, "invalid", 2500)]);
  ledger.reverse(second.id, "synthetic double spend");
  mark = page.messages().length;
  w.object.pushReceiptFrames();
  const reversal = await heard(mark);
  read(w, ledger, invoice, [pay(1), pay(2, "settled", 2500)]);
  mark = page.messages().length;
  w.object.pushReceiptFrames();
  const reconfirmation = await heard(mark);
  return {
    "projection.firstCredit": firstCredit,
    // The second credit's receipt frames, heard live before the stop: no tally or board yet.
    "projection.stoppedAfterBatch": { messages: stoppedLive, d1: lifetime() },
    "projection.crashRecovery": crashRecovery,
    "projection.duplicateRefresh": duplicateRefresh,
    "projection.reversal": reversal,
    "projection.reconfirmation": reconfirmation,
  };
}

// The positive payable path through the real front door, object and socket: a complete
// synthetic snapshot, read through the supported ledger path with destination capability, names
// an address already bound to the invoice and a remaining amount. Then time withdraws both, and
// later the original invoice expires, with the private history kept throughout. This world
// saves a replay bound of 2 (a reviewed read setting, as any deployment saves its own), so a
// page reconnecting from an old cursor is genuinely too far behind and gets the gap marker.
async function payableVectors() {
  const w = await world(RECEIPT_SETTINGS);
  const ledger = provider(w, { replayMax: 2 });
  const { invoice, token } = await seed(w, ledger, { invoice: "PayableInv1", token: TOKEN(0xd1), addresses: [1, 2] });
  const owner = { id: 4242, login: "ooga-dev" };
  const call = async (path, body, donor = null) => {
    const response = await w.post(path, body, { donor });
    return { status: response.status, body: await response.json() };
  };
  // Every socket request exactly as it reached PageApi: its method, path and query, and its
  // upgrade header. The visitor header is left out; it only groups rate limits.
  const sockets = [];
  const fetch = w.page.fetch.bind(w.page);
  w.page.fetch = (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/donations/socket") sockets.push({ method: request.method, path: url.pathname + url.search, upgrade: request.headers.get("Upgrade") });
    return fetch(request);
  };
  const page = await w.connectPage();
  await w.ctx.settle();
  // Everything the first page received on connecting, before any read or payment: its status
  // with the accounting capability, the pile, board and tally, recent receipts and the marker.
  const initialConnect = { request: sockets[0], messages: page.messages() };
  // A second page that connects the same way, hears the first live frame, and goes away before
  // the next: as a page closing its socket would, so later sends find it closed. What it last
  // heard, seq 1, is the cursor it reconnects with.
  const early = await w.connectPage(undefined, "visitor-early");
  await w.ctx.settle();
  const earlyConnect = { request: sockets.at(-1), messages: early.messages() };
  const earlyFrom = early.messages().length;
  const sendEarly = early.send.bind(early);
  early.send = (text) => {
    sendEarly(text);
    if (["receipt", "invoiceStatus"].includes(JSON.parse(text).type)) early.readyState = 3;
  };
  const kinds = new Set(["receipt", "invoiceStatus", "replay", "recentReceipts"]);
  const live = (from) => page.messages().slice(from).filter((m) => kinds.has(m.type));
  // A complete snapshot: one partial payment to the first bound address, and the provider
  // currently offering the second bound address with 6,000 sats left.
  let mark = page.messages().length;
  read(w, ledger, invoice, [{ ...pay(1, "settled", 4000), destination: syntheticAddress(1) }],
    { left: 6000, destination: syntheticAddress(2), capabilities: { complete: true, destination: true } });
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  const socketPayable = live(mark);
  const statusPayable = await call("/donations/status", { request: token });
  const historyPayable = await call("/donations/history", {}, owner);
  // Past the freshness bound: the alarm withdraws the remaining amount and payable address, live,
  // and the private status and history say so, at a newer revision.
  w.platform.advance(READ.freshnessMs + 1);
  mark = page.messages().length;
  await w.fireAlarm();
  const socketWithdrawn = live(mark);
  const statusWithdrawn = await call("/donations/status", { request: token });
  const historyWithdrawn = await call("/donations/history", {}, owner);
  // A reconnect from the start of the feed: three frames now wait, more than the saved bound of
  // 2, so a gap marker and no frames. A reconnect from the current mark replays nothing and is
  // complete.
  const gap = await w.connectPage(undefined, "visitor-gap", 0);
  const gapRequest = sockets.at(-1);
  const socketGap = gap.messages().filter((m) => kinds.has(m.type));
  const current = await w.connectPage(undefined, "visitor-current", w.object.receipts.feedHighWater());
  const currentRequest = sockets.at(-1);
  const socketCurrent = current.messages().filter((m) => kinds.has(m.type));
  // Past the original invoice's expiry: the alarm commits it live, Lightning reads expired, and
  // the history keeps the invoice.
  w.platform.advance(900_000);
  mark = page.messages().length;
  await w.fireAlarm();
  const socketExpired = live(mark);
  const statusExpired = await call("/donations/status", { request: token });
  const historyExpired = await call("/donations/history", {}, owner);
  // The early page, back after the expiry with the cursor it last heard: more frames now wait
  // after it than the saved bound of 2, so a gap marker and no frames. Then a reconnect from that
  // marker's high-water mark, which is complete. The private replies at the same point.
  const earlyLive = early.messages().slice(earlyFrom);
  const cursor = earlyLive.at(-1).seq;
  const earlyGapPage = await w.connectPage(undefined, "visitor-early", cursor);
  const earlyGap = { request: sockets.at(-1), messages: earlyGapPage.messages() };
  const earlyThrough = earlyGap.messages.find((m) => m.type === "replay").through;
  const earlyCurrentPage = await w.connectPage(undefined, "visitor-early", earlyThrough);
  const earlyCurrent = { request: sockets.at(-1), messages: earlyCurrentPage.messages() };
  const statusAtEarlyGap = await call("/donations/status", { request: token });
  const historyAtEarlyGap = await call("/donations/history", {}, owner);
  return {
    "socket.payableLive": socketPayable,
    "status.payable": statusPayable,
    "history.payable": historyPayable,
    "socket.freshnessWithdrawn": socketWithdrawn,
    "status.withdrawn": statusWithdrawn,
    "history.withdrawn": historyWithdrawn,
    "socket.gapMarker": socketGap,
    "socket.currentReconnect": socketCurrent,
    "socket.expired": socketExpired,
    "status.expired": statusExpired,
    "history.expired": historyExpired,
    "socket.initialConnect": initialConnect,
    // The request each socket vector's connect sent, in order.
    "socket.requests": { "socket.initialConnect": sockets[0], "socket.gapMarker": gapRequest, "socket.currentReconnect": currentRequest },
    // The reachable gap: a page connecting with no cursor, hearing seq 1 live, going away, and
    // coming back with the cursor it heard, after more than the saved bound of frames.
    "socket.earlyConnect": earlyConnect,
    "socket.earlyLive": earlyLive,
    "socket.earlyGap": earlyGap,
    "socket.earlyCurrent": earlyCurrent,
    "status.atEarlyGap": statusAtEarlyGap,
    "history.atEarlyGap": historyAtEarlyGap,
  };
}

// What an open page hears of the anchored pile as receipts move it, through the real object: the
// anchor applied through applyPileAnchor on the object's storage, as an operator would, with no
// endpoint. Each vector is the pile messages the page heard from a stated point, once the
// object's background work has finished.
async function anchoredPileVectors() {
  const w = await world(RECEIPT_SETTINGS);
  const ledger = provider(w);
  const sql = w.ctx.storage.sql;
  const anchored = applyPileAnchor(w.ctx.storage, { anchor: "synthetic-anchor-2", expected: savedPileSnapshot(sql), milli: 10_000, boundary: 0,
    reason: "synthetic vector", evidence: "synthetic vector" }, w.platform.now());
  if (!anchored.ok) throw new Error("the synthetic anchor was refused");
  const { invoice } = await seed(w, ledger, { invoice: "PileInv0001", token: TOKEN(0xe1), addresses: [1] });
  const page = await w.connectPage();
  await w.ctx.settle();
  const piles = (from) => page.messages().slice(from).filter((m) => m.type === "pile");
  const step = async (change) => {
    const mark = page.messages().length;
    change();
    w.object.pushReceiptFrames();
    await w.ctx.settle();
    return piles(mark);
  };
  const complete = { capabilities: { complete: true } };
  const connect = piles(0);
  // A credit from a read nobody verified complete: in the level, and behind.
  const creditBehind = await step(() => read(w, ledger, invoice, [pay(1)]));
  // The same credit, now read verified complete, with D1 drained and the bridge done: current,
  // at a new revision though the level is unchanged.
  const creditCurrent = await step(() => read(w, ledger, invoice, [pay(1)], complete));
  // The provider calls it invalid: held for review, its credit still in the level, uncertain.
  const reviewUncertain = await step(() => read(w, ledger, invoice, [pay(1, "invalid")], complete));
  const [receipt] = sql.exec("SELECT id FROM ra_receipts WHERE invoice = ? ORDER BY ord", invoice).toArray();
  const reversal = await step(() => ledger.reverse(receipt.id, "synthetic double spend"));
  const reconfirmation = await step(() => read(w, ledger, invoice, [pay(1)], complete));
  // A second credit reaches the pile, and the object stops before the page hears it. The next
  // start's alarm sends the newer pile to the page that stayed connected.
  let mark = page.messages().length;
  read(w, ledger, invoice, [pay(1), pay(2, "settled", 2500)], complete);
  w.object.bridgeReceipts();
  const beforeRestart = piles(mark);
  w.object = new DonationsObject(w.ctx, w.env, w.platform);
  await w.ctx.settle();
  mark = page.messages().length;
  await w.fireAlarm();
  await w.ctx.settle();
  const restartRecovery = piles(mark);
  // A page that connects now is sent the current pile at once.
  const reconnect = (await w.connectPage(undefined, "visitor-pile")).messages().filter((m) => m.type === "pile");
  return {
    "pile.connect": connect,
    "pile.creditBehind": creditBehind,
    "pile.creditCurrent": creditCurrent,
    "pile.reviewUncertain": reviewUncertain,
    "pile.reversal": reversal,
    "pile.reconfirmation": reconfirmation,
    "pile.beforeRestart": beforeRestart,
    "pile.restartRecovery": restartRecovery,
    "pile.reconnect": reconnect,
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
    projection: {
      scope: "projection-publication",
      note: "What an open page's socket hears when the D1 projection publishes lifetime figures, through the real object " +
        "and the D1 stand-in, after the object's background work has finished: the receipt, tally and board messages " +
        "from the stated point, and d1, the lifetime tally D1 holds afterwards. A first credit; a restart after a durable " +
        "batch whose outbox row wasn't removed; a refresh repeated after a stop between sending and noting it sent, which " +
        "credits nothing; a reversal; and a reconfirmation at the frozen price. Proves the producer's publication order " +
        "and that every refresh is D1's figure. Does not prove real D1, Durable Object or socket runtime behaviour, " +
        "provider ingestion, or any consumer's parsing. Issuance is off.",
      vectors: await projectionVectors(),
    },
    payable: {
      scope: "read-endpoints-payable",
      note: "The positive payable path through the real front door, object and socket. A complete synthetic snapshot, " +
        "read through the supported ledger path with destination capability, names a regtest address already bound to " +
        "the invoice and 6,000 sats left; the private status and history report them while fresh. Past the freshness " +
        "bound the alarm withdraws both, live, and the replies say so at a newer revision; past the original invoice's " +
        "expiry Lightning reads expired, and the history keeps the invoice. This world saves a replay bound of 2, so a " +
        "reconnect from cursor 0 is genuinely too far behind and gets the gap marker. Issuance is off, and no provider " +
        "has verified the original BOLT11, so Lightning is never available here. Does not prove provider ingestion, " +
        "real runtime behaviour or any consumer's parsing.",
      vectors: await payableVectors(),
    },
    pile: {
      scope: "anchored-pile",
      note: "What an open page hears of the anchored pile as receipts move it, through the real object, with the anchor " +
        "applied through applyPileAnchor on the object's storage, as an operator would; no endpoint applies it. Each vector " +
        "is the pile messages heard from the stated point once background work has finished: on connect; a credit from an " +
        "unverified read (behind); the same credit read verified complete (current, a new revision at the same level); the " +
        "receipt held for review (its credit uncertain); its reversal; its reconfirmation; a second credit bridged before a " +
        "stop, heard by the surviving page from the next start's alarm; and a page connecting after. basis: credits is the " +
        "anchor plus credits minus reversals, not a wallet balance. Does not prove provider ingestion, real runtime " +
        "behaviour, any consumer's parsing, or how an operator applies an anchor. Issuance is off.",
      vectors: await anchoredPileVectors(),
    },
  };
}

export const serialize = (vectors) => `${JSON.stringify(vectors, null, 2)}\n`;

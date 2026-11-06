// The receipt-mode read side through the real front door and object: private status, account
// history, the socket's capability, recent receipts and replay. Issuance stays off; mappings
// are seeded through the core, as provider ingestion (not built yet) would make them. Every
// value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject } from "../worker/object.mjs";
import { pay, provider, READ, read, RECEIPT_SETTINGS as SETTINGS, seed, TOKEN } from "./helpers/receipt-seed.mjs";
import { syntheticAddress } from "./helpers/synthetic-address.mjs";
import { BOLT11 } from "./helpers/values.mjs";
import { donor, world } from "./helpers/world.mjs";

const typed = (page, type) => page.messages().filter((m) => m.type === type);
const OWNER = donor("ooga-dev", 4242);

const status = async (w, body, who = null) => {
  const response = await w.post("/donations/status", body, { donor: who });
  return { status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json() };
};
const history = async (w, body, who) => {
  const response = await w.post("/donations/history", body, { donor: who });
  return { status: response.status, body: await response.json() };
};
const feedCount = (w) => w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_feed").one().n;
const revision = (w, invoice) => w.ctx.storage.sql.exec("SELECT revision FROM ra_invoices WHERE invoice = ?", invoice).one().revision;

test("a receipt-mode issuance request is closed before any provider call, and legacy is unchanged", async () => {
  const w = await world(SETTINGS);
  const relay = await w.connectRelay();
  const asked = relay.sent.length;
  const closed = await w.post("/donations/invoice", { sats: 1000, accounting: 1 });
  assert.deepEqual([closed.status, await closed.json()], [503, { error: "closed" }]);
  for (const accounting of [2, "1", true, null]) {
    const refused = await w.post("/donations/invoice", { sats: 1000, accounting });
    assert.deepEqual([refused.status, await refused.json()], [400, { error: "invalid" }], JSON.stringify(accounting));
  }
  assert.equal(relay.sent.length, asked, "the relay was never asked");
  // The object refuses too, should anything reach it with the field.
  assert.equal((await w.object.invoice({ sats: 1000, accounting: 1, client: "visitor-a" })).status, 503);
  // Without the field, a legacy invoice as before, with no accounting key in its reply.
  const { response } = await w.invoice(relay, { sats: 1000 });
  const reply = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(reply.invoice, "accounting"), false);
});

test("with no receipt-mode mapping, reads are closed and the status message is the legacy one", async () => {
  const w = await world(SETTINGS);
  const page = await w.connectPage();
  assert.equal(Object.hasOwn(typed(page, "status")[0], "accounting"), false);
  assert.equal(typed(page, "recentReceipts").length, 0);
  assert.deepEqual((await status(w, { request: TOKEN(1) })).status, 503);
  assert.deepEqual((await history(w, {}, OWNER)).status, 503);
});

test("status by bearer token or by its owner; any other reader gets the same 404 and changes nothing", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)], { left: 7000 });
  w.object.pushReceiptFrames();
  const byToken = await status(w, { request: token });
  assert.equal(byToken.status, 200);
  assert.equal(byToken.cache, "no-store");
  assert.deepEqual(Object.keys(byToken.body), ["invoice", "payableAddress", "addresses", "nextAddress", "receipts", "next"]);
  assert.deepEqual(Object.keys(byToken.body.invoice),
    ["id", "accounting", "due", "received", "credited", "review", "left", "state", "revision", "expires", "lightning", "bolt11"]);
  assert.deepEqual([byToken.body.invoice.accounting, byToken.body.invoice.received, byToken.body.invoice.left], ["receipt-v1", 3000, 7000]);
  assert.deepEqual(byToken.body.addresses.map((a) => a.address), [syntheticAddress(3), syntheticAddress(2)], "newest issued first");
  assert.equal(byToken.body.receipts.length, 2);
  const byOwner = await status(w, { invoice }, OWNER);
  assert.equal(byOwner.status, 200);
  assert.deepEqual(byOwner.body.invoice, byToken.body.invoice);
  // Denied: another account, signed out by invoice, a wrong token, an unknown invoice.
  const before = [feedCount(w), revision(w, invoice)];
  for (const [body, who] of [[{ invoice }, donor("ooga-dev", 9999)], [{ invoice }, null], [{ request: TOKEN(0xb2) }, null], [{ invoice: "NoSuchInv1" }, OWNER]]) {
    const denied = await status(w, body, who);
    assert.deepEqual([denied.status, denied.body], [404, { error: "unknown" }], JSON.stringify(body));
  }
  assert.deepEqual([feedCount(w), revision(w, invoice)], before, "unauthorized reads mutate nothing");
  // A handle matching the owner's login is no access: ownership is the stable id.
  assert.equal((await status(w, { invoice }, donor("ooga-dev", 7))).status, 404);
  // Exactly one way in, and only the agreed keys.
  for (const body of [{}, { request: token, invoice }, { request: "not-a-token" }, { invoice: 12 }, { request: token, extra: 1 }]) {
    assert.deepEqual((await status(w, body)).body, { error: "invalid" }, JSON.stringify(body));
  }
});

test("the original BOLT11 needs fresh provider verification, and is withdrawn for good once any receipt is seen", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  const reply = async () => (await status(w, { request: token })).body.invoice;
  let seen = await reply();
  assert.deepEqual([seen.lightning, seen.bolt11, typeof seen.expires], ["unavailable", null, "number"], "no provider evidence, no code");
  const verify = () => w.ctx.storage.sql.exec("UPDATE ra_invoices SET bolt11_verified_at = ? WHERE invoice = ?", w.platform.now(), invoice);
  verify();
  seen = await reply();
  assert.deepEqual([seen.lightning, seen.bolt11], ["available", BOLT11]);
  // The verification ageing out is a committed change, at a newer revision.
  w.platform.advance(61_000);
  const aged = await reply();
  assert.deepEqual([aged.lightning, aged.bolt11], ["unavailable", null], "stale verification");
  assert.ok(aged.revision > seen.revision);
  verify();
  read(w, ledger, invoice, [pay(1, "invalid")]);
  seen = await reply();
  assert.deepEqual([seen.lightning, seen.bolt11], ["unavailable", null], "an invalid receipt still withdraws it, verified or not");
  // Expiry too is a committed change, heard as an invoiceStatus once a receipt exists.
  const page = await w.connectPage();
  w.platform.advance(900_000);
  const expired = await reply();
  assert.equal(expired.lightning, "expired");
  assert.ok(expired.revision > seen.revision);
  assert.ok(typed(page, "invoiceStatus").some((f) => f.replay === false && f.invoice.revision === expired.revision));
  assert.equal((await reply()).revision, expired.revision, "nothing more to commit");
  const limited = await seed(w, ledger, { invoice: "LimitInv01", token: TOKEN(0xc3), lightning: "limit", bolt11: null, addresses: [4] });
  const limit = (await status(w, { request: limited.token })).body.invoice;
  assert.deepEqual([limit.lightning, limit.bolt11], ["limit", null]);
});

test("a mapping without whole original metadata is closed until an operator reconciles it, never guessed", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  // A row as a pre-activation core could have left it, with no metadata.
  w.ctx.storage.sql.exec("UPDATE ra_invoices SET expires = NULL, lightning = NULL, bolt11 = NULL WHERE invoice = ?", invoice);
  const before = [feedCount(w), revision(w, invoice)];
  assert.deepEqual((await status(w, { request: token })).body, { error: "closed" });
  assert.deepEqual([(await status(w, { request: token })).status, (await history(w, {}, OWNER)).status], [503, 503]);
  assert.deepEqual([feedCount(w), revision(w, invoice)], before, "closing changes nothing");
  assert.deepEqual((await status(w, { request: TOKEN(0xb2) })).body, { error: "unknown" }, "access is still checked first");
  assert.equal(w.object.accountingCapability().reconciliation, "review");
  // The operator's reviewed metadata, once; whole metadata is never replaced.
  const meta = { expires: Math.floor(w.platform.now() / 1000) + 300, lightning: "unavailable", bolt11: null };
  assert.throws(() => ledger.reconcileInvoiceMetadata(invoice, meta, ""));
  assert.deepEqual(ledger.reconcileInvoiceMetadata(invoice, { ...meta, expires: null }, "reviewed"), { error: "invalid" });
  assert.deepEqual(ledger.reconcileInvoiceMetadata(invoice, meta, "reviewed against the provider"), { ok: true });
  assert.deepEqual(ledger.reconcileInvoiceMetadata(invoice, meta, "again"), { error: "complete" });
  const reconciled = (await status(w, { request: token })).body.invoice;
  assert.deepEqual([reconciled.expires, reconciled.lightning, reconciled.bolt11], [meta.expires, "unavailable", null]);
  assert.ok(reconciled.revision > before[1]);
});

test("cursors are bound to their kind, invoice, reader and revision", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  const other = await seed(w, ledger, { invoice: "OtherInv01", token: TOKEN(0xe5), addresses: [6, 7, 8] });
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)]);
  read(w, ledger, other.invoice, [{ ...pay(4), destination: syntheticAddress(6) }, { ...pay(5), destination: syntheticAddress(6) }, { ...pay(6), destination: syntheticAddress(6) }]);
  const first = (await status(w, { request: token })).body;
  const cases = [
    [{ request: token, cursor: first.nextAddress }, 400, "cursor", "an address cursor as a receipt cursor"],
    [{ request: token, addressCursor: first.next }, 400, "cursor", "a receipt cursor as an address cursor"],
    [{ invoice, cursor: first.next }, 400, "cursor", "the token holder's cursor used by the owner"],
    [{ request: other.token, cursor: first.next }, 400, "cursor", "another invoice's cursor"],
    [{ request: token, cursor: "r.1.1.1.00000000" }, 400, "cursor", "a forged cursor"],
    [{ request: token, cursor: 5 }, 400, "cursor", "not a string"],
  ];
  for (const [body, code, error, why] of cases) {
    const got = await status(w, body, body.invoice ? OWNER : null);
    assert.deepEqual([got.status, got.body], [code, { error }], why);
  }
  assert.equal((await status(w, { request: token, cursor: first.next })).status, 200, "still valid");
  await ledger.bindAddress(invoice, syntheticAddress(9));
  assert.deepEqual((await status(w, { request: token, cursor: first.next })).status, 409, "a new binding moves the revision");
  w.platform.advance(601_000);
  const late = (await status(w, { request: token })).body;
  w.platform.advance(601_000);
  assert.deepEqual((await status(w, { request: token, cursor: late.next })).body, { error: "cursor" }, "expired");
});

test("history is the owner's own, newest first, revision-scoped, through sign-out and rename", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  for (const [n, owner] of [[1, 4242], [2, 4242], [3, 777], [4, 4242], [5, null]]) {
    await seed(w, ledger, { invoice: `HistoryIn${n}`, token: TOKEN(0x100 + n), owner, login: owner === 777 ? "someone-else" : owner === null ? null : "ooga-dev", addresses: [10 + n] });
  }
  const page = await history(w, {}, OWNER);
  assert.equal(page.status, 200);
  assert.deepEqual(Object.keys(page.body), ["revision", "invoices", "next"]);
  assert.deepEqual(page.body.invoices.map((i) => i.id), ["HistoryIn4", "HistoryIn2"]);
  assert.deepEqual(Object.keys(page.body.invoices[0]),
    ["id", "accounting", "createdAt", "handle", "due", "received", "credited", "review", "left", "state", "revision", "expires"]);
  const rest = await history(w, { cursor: page.body.next }, OWNER);
  assert.deepEqual([rest.body.invoices.map((i) => i.id), rest.body.next], [["HistoryIn1"], null]);
  const text = JSON.stringify([page.body, rest.body]);
  for (const secret of [TOKEN(0x101), syntheticAddress(11)]) assert.equal(text.includes(secret), false, "no tokens or addresses");
  assert.equal(JSON.stringify(page.body.invoices).includes('"owner"'), false, "no account id field");
  // A rename keeps the same stable id, so the same history; another account sees only its own.
  assert.deepEqual((await history(w, {}, donor("new-login", 4242))).body.invoices.map((i) => i.id), ["HistoryIn4", "HistoryIn2"]);
  assert.deepEqual((await history(w, {}, donor("someone-else", 777))).body.invoices.map((i) => i.id), ["HistoryIn3"]);
  assert.deepEqual((await history(w, {}, donor("nobody-here", 31337))).body.invoices, []);
  // Signed out, or logged out since, is 401.
  assert.deepEqual([(await history(w, {}, null)).status, (await history(w, {}, null)).body], [401, { error: "signin" }]);
  // Any change to any of the account's invoices fences its cursors.
  read(w, ledger, "HistoryIn1", [{ ...pay(7), destination: syntheticAddress(11) }]);
  assert.deepEqual((await history(w, { cursor: page.body.next }, OWNER)).status, 409);
  assert.deepEqual((await history(w, { cursor: page.body.next }, donor("someone-else", 777))).body, { error: "cursor" }, "another account's cursor");
  assert.deepEqual((await history(w, { extra: 1 }, OWNER)).body, { error: "invalid" });
});

test("issued mappings keep their reads, with the saved settings, whatever configuration says after a restart", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)], { left: 7000, destination: syntheticAddress(1), capabilities: { destination: true } });
  const first = (await status(w, { request: token })).body;
  // Restarts: issuance off, no policy, and every read setting removed from, or set
  // differently in, the Worker's environment. The saved settings still govern reads.
  for (const env of [{ ...w.env }, { ...w.env, STATUS_PAGE_SIZE: "50", READ_FRESHNESS_SECONDS: "1", RECEIPT_REPLAY_MAX: undefined }]) {
    const restarted = new DonationsObject(w.ctx, env, w.platform);
    assert.equal(restarted.receipts.issuance, false);
    assert.equal(restarted.receiptsReadable(), true);
    assert.deepEqual(restarted.receipts.readSettings(), READ);
    const capability = restarted.statusMessage(false).accounting;
    assert.deepEqual([capability.issuance, capability.receipts, capability.history, capability.coverage, capability.spends], [false, true, true, "invoice", false]);
    assert.equal(restarted.receipts.modeOf(invoice), "receipt-v1", "never switched to legacy");
  }
  // Same revision, same answer: nothing about freshness moved with the configuration.
  const again = (await status(w, { request: token })).body;
  assert.deepEqual(again, first);
  assert.equal((await status(w, { request: token, cursor: first.next })).status, 200, "its cursors are still good");
  // A mapping without saved settings, as a pre-activation core could leave it, is closed for
  // review until an operator adopts a reviewed set, once.
  w.ctx.storage.sql.exec("DELETE FROM ra_read_settings");
  assert.equal(w.object.receiptsReadable(), false);
  assert.deepEqual([(await status(w, { request: token })).status, w.object.accountingCapability().reconciliation], [503, "review"]);
  assert.throws(() => w.object.receipts.adoptReadSettings({ ...READ, freshnessMs: null }, "reviewed"));
  assert.deepEqual(w.object.receipts.adoptReadSettings(READ, "reviewed against the deployment record"), { ok: true });
  assert.deepEqual(w.object.receipts.adoptReadSettings({ ...READ, statusPageSize: 9 }, "again"), { error: "saved" });
  assert.equal((await status(w, { request: token })).status, 200);
  // An issuer configured differently from the saved settings refuses, rather than drift.
  assert.deepEqual(provider(w, { statusPageSize: 9 }).issueInvoice({ invoice: "DriftInv01", network: "regtest", provider: "btcpay", store: "store-a",
    owner: null, login: null, handle: "x", messageMinSats: 1000, due: 10_000, requestHash: "d".repeat(64),
    expires: Math.floor(w.platform.now() / 1000) + 900, lightning: "unavailable", bolt11: null }), { error: "closed" });
});

test("a page connecting gets recent receipts and the replay marker every time, and only later frames live", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1), pay(2)]);
  w.object.pushReceiptFrames();
  const through = w.ctx.storage.sql.exec("SELECT max(seq) AS seq FROM ra_feed").one().seq;
  // No cursor: recent receipts and the marker, nothing replayed, nothing live.
  const fresh = await w.connectPage();
  const types = fresh.messages().map((m) => m.type);
  assert.deepEqual(types.slice(-2), ["recentReceipts", "replay"]);
  assert.equal(typed(fresh, "receipt").length, 0);
  assert.deepEqual(typed(fresh, "replay")[0], { type: "replay", after: null, through, complete: true });
  assert.equal(typed(fresh, "recentReceipts")[0].entries.length, 2);
  assert.ok(types.indexOf("status") < types.indexOf("recentReceipts"), "the legacy stream comes first, unchanged");
  assert.equal(typed(fresh, "status")[0].accounting.receipts, true);
  // From cursor 0: every frame, replayed, then the marker.
  const behind = await w.connectPage(undefined, "visitor-q", 0);
  const replayed = behind.messages().filter((m) => m.type === "receipt" || m.type === "invoiceStatus");
  assert.ok(replayed.length > 0 && replayed.every((f) => f.replay === true), "no historical animation");
  assert.deepEqual(typed(behind, "replay")[0], { type: "replay", after: 0, through, complete: true });
  // Later frames arrive live, after the marker, with a newer seq, once each.
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)]);
  w.object.pushReceiptFrames();
  w.object.pushReceiptFrames();
  for (const page of [fresh, behind]) {
    const all = page.messages();
    const isLive = (m) => (m.type === "receipt" || m.type === "invoiceStatus") && m.replay === false;
    const live = all.filter(isLive);
    assert.ok(live.length > 0 && live.every((f) => f.seq > through));
    assert.equal(new Set(live.map((f) => f.seq)).size, live.length, "at most once each here");
    assert.ok(all.findIndex((m) => m.type === "replay") < all.findIndex(isLive), "the marker comes before anything live");
  }
  // A cursor past the mark, or too far behind the bound, gets no frames and must resync.
  const ahead = await w.connectPage(undefined, "visitor-r", through + 100);
  assert.deepEqual(typed(ahead, "replay")[0].complete, false);
  const tight = await world(SETTINGS);
  const tightLedger = provider(tight, { replayMax: 1 });
  const seeded = await seed(tight, tightLedger);
  read(tight, tightLedger, seeded.invoice, [pay(1), pay(2)]);
  tight.object.pushReceiptFrames();
  const gap = await tight.connectPage(undefined, "visitor-s", 0);
  assert.deepEqual([typed(gap, "receipt").length, typed(gap, "replay")[0].complete], [0, false]);
  // Invalid cursors are refused at the front door.
  assert.equal((await w.socket(undefined, "visitor-t", "-1")).status, 400);
  assert.equal((await w.socket(undefined, "visitor-t", "abc")).status, 400);
});

test("what time withdraws on a status read reaches every page live, once, without private fields", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { left: 9000, destination: syntheticAddress(1), capabilities: { destination: true } });
  w.object.pushReceiptFrames();
  const page = await w.connectPage();
  w.platform.advance(61_000);
  const reply = (await status(w, { request: token })).body;
  assert.deepEqual([reply.invoice.left, reply.payableAddress], [null, null]);
  const live = typed(page, "invoiceStatus").filter((f) => f.replay === false);
  assert.equal(live.length, 1);
  assert.deepEqual([live[0].invoice.left, live[0].invoice.revision], [null, reply.invoice.revision]);
  assert.equal(JSON.stringify(page.messages()).includes(syntheticAddress(1)), false);
  await status(w, { request: token });
  assert.equal(typed(page, "invoiceStatus").filter((f) => f.replay === false).length, 1, "nothing new to say");
});

test("legacy paid and seen for a receipt-mode invoice change nothing and make no donation", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const before = page.messages().length;
  await w.relaySays(relay, { type: "seen", invoice, sats: 1000, left: 0 });
  await w.relaySays(relay, { type: "paid", invoice, sats: 10_000, method: "onchain" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice, result: "rejected" });
  assert.equal(page.messages().length, before, "no seen, donation, pile or tally");
  assert.equal(w.env.DB.db.prepare("SELECT count(*) AS n FROM donations").get().n, 0);
});

test("with receipt reads on and no anchor, the pile is still pending and health is never current", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { capabilities: { complete: true } });
  w.object.pushReceiptFrames();
  const page = await w.connectPage();
  assert.deepEqual([typed(page, "pile")[0].bananas, typed(page, "pile")[0].cutover], [null, "pending"]);
  // Nothing drains the projection outbox yet, so reconciliation can't be current.
  assert.equal(typed(page, "status")[0].accounting.reconciliation, "behind");
});

test("recent receipts follow first observation, so a late credit or correction never displaces a newer receipt", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1, "observed")]);
  w.platform.advance(1_000);
  read(w, ledger, invoice, [pay(1, "observed"), pay(2)]);
  w.platform.advance(1_000);
  // The first-observed receipt is credited last.
  read(w, ledger, invoice, [pay(1), pay(2)]);
  const ids = ledger.rows("SELECT id FROM ra_receipts ORDER BY ord").map((r) => r.id);
  assert.deepEqual(ledger.recentReceipts(10).map((r) => r.id), [ids[1], ids[0]], "newest first observed first");
  assert.deepEqual(ledger.recentReceipts(1).map((r) => r.id), [ids[1]], "the late credit doesn't push it out");
  // A credited receipt now under review stays, with its review state.
  read(w, ledger, invoice, [pay(1), pay(2, "observed")]);
  assert.deepEqual(ledger.recentReceipts(10).map((r) => [r.id, r.state]), [[ids[1], "review"], [ids[0], "credited"]]);
  // Never-credited receipts aren't recent donations.
  read(w, ledger, invoice, [pay(1), pay(2, "observed"), pay(3, "observed")]);
  assert.equal(ledger.recentReceipts(10).length, 2);
});

test("a live backlog goes out in bounded batches from a durable mark, resumed by the alarm, with nothing skipped", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w, { replayMax: 2 });
  const { invoice } = await seed(w, ledger);
  // Frames made while nobody listens aren't held for later as live.
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  const page = await w.connectPage();
  const mark = typed(page, "replay")[0].through;
  read(w, ledger, invoice, [pay(1), pay(2), pay(3), pay(4)]);
  const committed = ledger.rows("SELECT seq FROM ra_feed WHERE seq > ? ORDER BY seq", mark).map((r) => r.seq);
  assert.ok(committed.length > 2);
  const live = () => page.messages().filter((m) => (m.type === "receipt" || m.type === "invoiceStatus") && m.replay === false).map((m) => m.seq);
  w.object.pushReceiptFrames();
  assert.deepEqual(live(), committed.slice(0, 2), "one bounded batch");
  assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), "the rest is due at once");
  // A restart keeps the mark; the alarm continues from it.
  w.object = new DonationsObject(w.ctx, w.env, w.platform);
  for (let i = 0; i < committed.length && live().length < committed.length; i++) await w.fireAlarm();
  assert.deepEqual(live(), committed, "every frame once, in order, after the page's mark");
});

test("the alarm is due when a remaining amount goes stale, and withdraws it from open pages on time", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { left: 9000, destination: syntheticAddress(1), capabilities: { destination: true } });
  const leftAt = w.ctx.storage.sql.exec("SELECT left_at FROM ra_invoices WHERE invoice = ?", invoice).one().left_at;
  w.object.pushReceiptFrames();
  const page = await w.connectPage();
  await w.ctx.settle();
  const alarm = await w.ctx.storage.getAlarm();
  assert.ok(alarm <= leftAt + READ.freshnessMs + 1, "sooner than the five-minute price check");
  w.platform.advance(alarm - w.platform.now());
  await w.fireAlarm();
  const withdrawn = typed(page, "invoiceStatus").filter((f) => f.replay === false);
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].invoice.left, null);
  assert.ok(await w.ctx.storage.getAlarm() > w.platform.now(), "the next deadline, not a busy loop");
});

test("with no page open the alarm does nothing; the next authorized read commits what time changed", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice, token } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)], { left: 9000 });
  const before = (await status(w, { request: token })).body.invoice;
  w.platform.advance(61_000);
  await w.fireAlarm();
  assert.equal(revision(w, invoice), before.revision, "an idle object changes nothing on its own");
  const after = (await status(w, { request: token })).body.invoice;
  assert.deepEqual([after.left, after.revision > before.revision], [null, true]);
});

test("incomplete metadata closes only its own status and history page; nothing is omitted, guessed or payable", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  // Five of the owner's invoices; with two a page, newest first: [5, 4], [3, 2], [1].
  for (const n of [1, 2, 3, 4, 5]) await seed(w, ledger, { invoice: `PagedInv0${n}`, token: TOKEN(0x200 + n), addresses: [20 + n] });
  // Invoice 1 has fresh payment evidence: a payable address and a remaining amount.
  read(w, ledger, "PagedInv01", [{ ...pay(1), destination: syntheticAddress(21) }], { left: 9000, destination: syntheticAddress(21), capabilities: { destination: true } });
  const ids = (body) => body.invoices.map((i) => i.id);
  const all = async () => {
    const first = await history(w, {}, OWNER);
    const second = await history(w, { cursor: first.body.next }, OWNER);
    const third = await history(w, { cursor: second.body.next }, OWNER);
    return [first, second, third];
  };
  const intact = await all();
  assert.deepEqual(intact.map((p) => [p.status, ids(p.body)]), [[200, ["PagedInv05", "PagedInv04"]], [200, ["PagedInv03", "PagedInv02"]], [200, ["PagedInv01"]]]);
  // A pre-activation row on the last page: only that page closes.
  w.ctx.storage.sql.exec("UPDATE ra_invoices SET expires = NULL WHERE invoice = 'PagedInv01'");
  const broken = await all();
  assert.deepEqual(broken.map((p) => p.status), [200, 200, 503]);
  assert.deepEqual(broken[2].body, { error: "closed" });
  assert.deepEqual([ids(broken[0].body), ids(broken[1].body)], [ids(intact[0].body), ids(intact[1].body)], "intact pages are whole and unchanged");
  assert.equal(broken[0].body.next, (await history(w, {}, OWNER)).body.next, "cursors are stable while nothing changes");
  for (const page of broken.slice(0, 2)) {
    for (const entry of page.body.invoices) assert.ok(Number.isSafeInteger(entry.expires) && entry.expires > 0, "never a null or zero expiry");
  }
  // Its status is closed, so its fresh evidence offers no address and no amount.
  const closed = await status(w, { request: TOKEN(0x201) });
  assert.deepEqual([closed.status, closed.body], [503, { error: "closed" }]);
  assert.equal(JSON.stringify(closed.body).includes(syntheticAddress(21)), false);
  assert.equal((await status(w, { request: TOKEN(0x203) })).status, 200, "other invoices are unaffected");
  // The global capabilities stay on; health asks for review.
  const capability = w.object.accountingCapability();
  assert.deepEqual([capability.receipts, capability.history, capability.reconciliation], [true, true, "review"]);
  // On the first page instead: that page closes, the later pages still answer by their cursors.
  ledger.reconcileInvoiceMetadata("PagedInv01", { expires: Math.floor(w.platform.now() / 1000) + 600, lightning: "unavailable", bolt11: null }, "reviewed");
  const reconciled = await all();
  w.ctx.storage.sql.exec("UPDATE ra_invoices SET lightning = NULL WHERE invoice = 'PagedInv05'");
  assert.deepEqual((await history(w, {}, OWNER)).body, { error: "closed" });
  assert.deepEqual(ids((await history(w, { cursor: reconciled[0].body.next }, OWNER)).body), ["PagedInv03", "PagedInv02"]);
  assert.deepEqual(ids((await history(w, { cursor: reconciled[1].body.next }, OWNER)).body), ["PagedInv01"]);
  // Every record kept: five invoices, none deleted or hidden by the gate.
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_invoices WHERE owner = 4242").one().n, 5);
});

test("private pages are capped at the wire bound of 100 rows; no size is chosen in code", async () => {
  const w = await world(SETTINGS);
  for (const key of ["statusPageSize", "addressPageSize", "historyPageSize"]) {
    // An issuer configured over the bound can't save its settings, so it can't issue.
    await assert.rejects(seed(w, provider(w, { [key]: 101 }), { invoice: "TooBigInv1", token: TOKEN(0x301) }), /read settings/, key);
  }
  assert.equal(w.ctx.storage.sql.exec("SELECT count(*) AS n FROM ra_invoices").one().n, 0);
  // At the bound is a valid reviewed choice.
  const ledger = provider(w, { statusPageSize: 100, addressPageSize: 100, historyPageSize: 100 });
  const { invoice, token } = await seed(w, ledger);
  assert.equal((await status(w, { request: token })).status, 200);
  // The saved row itself refuses an oversized page, and so does adopting one.
  assert.throws(() => w.ctx.storage.sql.exec("UPDATE ra_read_settings SET history_page_size = 101"));
  w.ctx.storage.sql.exec("DELETE FROM ra_read_settings");
  assert.throws(() => ledger.adoptReadSettings({ ...READ, addressPageSize: 101 }, "reviewed"), /read settings/);
  // And the core never cuts a larger page, whoever asks.
  assert.throws(() => ledger.privateStatus(invoice, { requestHash: null, donorId: 4242, receiptLimit: 101, addressLimit: 1, ttlMs: 1 }), RangeError);
  assert.throws(() => ledger.accountHistory(4242, { limit: 101, ttlMs: 1 }), RangeError);
});

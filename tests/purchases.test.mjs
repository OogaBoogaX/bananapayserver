// Purchases, of fireworks and of whatever OBL sells next: an ordinary Lightning invoice down the
// same line as a donation, for the catalogue's price, recorded apart from donations and announced
// to every page. Fireworks, the first category, also launch on every page at the same moment.
// See decisions 0028 and 0029.

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOGUE, CATEGORY_NAME, ITEM_NAME } from "../shared/catalogue.mjs";
import { FIREWORK } from "../shared/firework.mjs";
import { DonationsObject, PURCHASE_BOARD_SIZE } from "../worker/object.mjs";
import { until } from "./helpers/cloudflare.mjs";
import { bolt11For, INVOICE } from "./helpers/values.mjs";
import { call, donor, EXPIRES, world } from "./helpers/world.mjs";

const PRICES = { pop: 10, bolt: 69, mega: 100, show: 300 };
const LEAD = 3_000;
const HOUR = 3_600_000;
const firework = (item, extra = {}) => ({ category: "firework", item, ...extra });
const typed = (page, type) => page.messages().filter((m) => m.type === type);
const rows = (w, sql) => w.env.DB.db.prepare(sql).all().map((row) => ({ ...row }));
// The start of the earliest hour of the seven days the tally and the counts cover.
const weekOf = (now) => now - (now % HOUR) - (7 * 24 - 1) * HOUR;
const pendingCount = (w) => w.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pending").one().n;

let made = 0;
const nextInvoice = () => `Purchase${String(++made).padStart(4, "0")}`;

// Asks to buy something and answers on the relay's behalf, with a Lightning invoice for whatever
// it was asked unless `answer` says otherwise.
async function ask(w, relay, body, { answer, ...options } = {}) {
  const before = relay.sent.length;
  const pending = w.post("/purchases/buy", body, options);
  await until(() => relay.sent.length > before);
  const asked = JSON.parse(relay.sent.at(-1));
  const id = nextInvoice();
  const reply = answer ? answer(asked) : { invoice: { id, bolt11: bolt11For(asked.sats), expires: EXPIRES } };
  await w.relaySays(relay, { type: "invoice", request: asked.request, ...reply });
  return { asked, id, response: await pending };
}

// Buys something and pays for it over Lightning. The invoice id is the purchase's id.
async function buy(w, relay, body, options = {}) {
  const { asked, id, response } = await ask(w, relay, body, options);
  assert.equal(response.status, 200);
  await w.relaySays(relay, { type: "paid", invoice: id, sats: asked.sats, method: "lightning" });
  await w.ctx.settle();
  return id;
}

async function donate(w, relay, id, sats = 1000) {
  await w.invoice(relay, { sats }, () => ({ id, bolt11: bolt11For(sats), expires: EXPIRES }));
  await w.relaySays(relay, { type: "paid", invoice: id, sats, method: "lightning" });
  await w.ctx.settle();
}

// What a donor has bought, as OBL's Worker asks for it.
async function bought(w, who, body = {}) {
  const response = await w.post("/purchases/mine", body, { donor: who });
  return [response.status, await response.json()];
}

test("every item in the catalogue fits D1's records and has a whole price", () => {
  for (const [category, { items, buyers, announce, board, counts, slots }] of Object.entries(CATALOGUE)) {
    assert.ok(slots === undefined || Number.isSafeInteger(slots) && slots > 0, category);
    assert.match(category, CATEGORY_NAME);
    assert.ok(["signed-in", "everyone"].includes(buyers), category);
    assert.equal(typeof announce, "boolean");
    assert.equal(typeof board, "boolean");
    assert.equal(typeof counts, "boolean");
    for (const [item, { sats }] of Object.entries(items)) {
      assert.match(item, ITEM_NAME);
      assert.ok(Number.isSafeInteger(sats) && sats > 0, `${category} ${item}`);
      if (slots) assert.ok(Number.isSafeInteger(items[item].slots ?? 1) && (items[item].slots ?? 1) <= slots, `${category} ${item} fits its slots`);
    }
  }
  assert.deepEqual(Object.fromEntries(Object.entries(CATALOGUE.firework.items).map(([item, { sats }]) => [item, sats])), PRICES);
});

test("a purchase asks the relay for the catalogue's price, the same way a donation does, and answers with the invoice alone", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  for (const item of Object.keys(PRICES)) {
    const { asked, id, response } = await ask(w, relay, firework(item), { donor: donor("secret-login") });
    assert.deepEqual(asked, { type: "invoice", request: asked.request, sats: PRICES[item] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      request: asked.request,
      invoice: { id, bolt11: bolt11For(PRICES[item]), expires: EXPIRES },
      lightning: "available",
    }, "no bananas, rate or pricing");
  }
  assert.ok(relay.sent.every((text) => !text.includes("secret") && !/firework|pop|bolt|mega|show/.test(text)), "the relay learns neither who nor what");
  assert.equal(w.platform.fetched.length, 0, "a purchase looks up no price");
  assert.deepEqual(w.ctx.storage.sql.exec("SELECT category, item, sats, handle, message, github_id, github_login FROM pending ORDER BY sats").toArray().map((row) => ({ ...row })),
    Object.entries(PRICES).map(([item, sats]) => ({ category: "firework", item, sats, handle: "", message: "", github_id: 4242, github_login: "secret-login" })));
});

test("the Worker refuses anything not for sale, any other key, a price from the page, or a bad slot, nth or before", async () => {
  const w = await world({ PURCHASE_RATE_PER_IP: "20" });
  const relay = await w.connectRelay();
  const cases = [
    [firework("nuke"), 400, "invalid"],
    [firework("Pop"), 400, "invalid"],
    [firework("toString"), 400, "invalid"],
    [{ category: "costume", item: "pop" }, 400, "invalid"],
    [{ category: "toString", item: "pop" }, 400, "invalid"],
    [{ category: ["firework"], item: "pop" }, 400, "invalid"],
    [{ item: "pop" }, 400, "invalid"],
    [{ category: "firework" }, 400, "invalid"],
    [{ kind: "pop" }, 400, "invalid"],
    [firework("pop", { sats: 1 }), 400, "invalid"],
    [firework("mega", { sats: 100 }), 400, "invalid"],
    [firework("pop", { handle: "ooga", message: "hi" }), 400, "invalid"],
    [firework("pop", { github: { id: 7, login: "forged" } }), 400, "invalid"],
    [firework("pop", { quantity: 2 }), 400, "invalid"],
    [firework("pop", { slot: 6 }), 400, "invalid"],
    [firework("pop", { slot: -1 }), 400, "invalid"],
    [firework("pop", { slot: 1.5 }), 400, "invalid"],
    [firework("pop", { slot: "1" }), 400, "invalid"],
    [firework("pop", { slot: null }), 400, "invalid"],
    [firework("show", { slot: 4 }), 400, "invalid"],
    [firework("pop", { nth: 0 }), 400, "invalid"],
    [firework("pop", { nth: 1000 }), 400, "invalid"],
    [firework("pop", { nth: 1.5 }), 400, "invalid"],
    [firework("pop", { nth: "1" }), 400, "invalid"],
    [firework("pop", { nth: null }), 400, "invalid"],
    [firework("pop", { before: "2" }), 400, "invalid"],
    [firework("pop", { before: "7+" }), 400, "invalid"],
    [firework("pop", { before: 1 }), 400, "invalid"],
    [firework("pop", { before: null }), 400, "invalid"],
    ["[\"pop\"]", 400, "invalid"],
    ["{not json", 400, "invalid"],
    [`{"category": "firework", "item": "pop", "before": "${"x".repeat(2000)}"}`, 413, "too large"],
  ];
  for (const [body, status, error] of cases) {
    const response = await w.post("/purchases/buy", body, { donor: donor() });
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 60));
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal((await w.post("/purchases/buy", firework("pop"), { donor: donor(), type: "text/plain" })).status, 415);
  for (const who of [undefined, {}, "ooga-dev", { id: "4242", login: "ooga-dev" }, { id: 4242, login: "-ooga" }, { id: 4242, login: "ooga-dev", admin: true }]) {
    assert.equal((await w.page.purchase(call("/purchases/buy", firework("pop")), who, "visitor-a")).status, 400, JSON.stringify(who));
  }
  assert.equal((await w.page.purchase(call("/purchases/buy", firework("pop")), donor(), "")).status, 400, "no visitor");
  assert.equal((await w.page.purchase("{\"category\":\"firework\",\"item\":\"pop\"}", donor(), "visitor-a")).status, 400, "a bare body");
  assert.equal(relay.sent.length, 0, "none of them reached the relay");
  for (const body of [firework("pop", { nth: 1, before: "none" }), firework("show", { nth: 999, before: "6+" }), firework("bolt", { before: "2-5" }), firework("mega", { nth: 7, before: "1" }),
    firework("pop", { slot: 0 }), firework("mega", { slot: 5 }), firework("show", { slot: 3 })]) {
    const { asked, response } = await ask(w, relay, body, { donor: donor() });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(asked.sats, PRICES[body.item]);
  }
});

test("while only signed-in donors may buy, a purchase without one is refused and an anonymous donation still works", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(page.messages()[0].catalogue, { firework: { buyers: "signed-in", prices: PRICES, slots: 6 } }, "the stand knows to show Sign in to launch");
  const refused = await w.post("/purchases/buy", firework("pop"));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "sign-in" });
  const bypass = await w.object.purchase({ category: "firework", item: "pop", nth: null, before: null, github: null, client: "visitor-a" });
  assert.equal(bypass.status, 403, "the object enforces it even without the front door");
  assert.equal(relay.sent.length, 0);
  assert.equal((await w.invoice(relay, { sats: 1000 })).response.status, 200, "an anonymous donation is unaffected");
  assert.equal((await ask(w, relay, firework("pop"), { donor: donor() })).response.status, 200);
});

test("once everyone may buy, an anonymous purchase and a donation both work, and status says so", async () => {
  const w = await world({ FIREWORK_BUYERS: "everyone" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(page.messages()[0].catalogue, { firework: { buyers: "everyone", prices: PRICES, slots: 6 } });
  assert.equal((await ask(w, relay, firework("pop", { nth: 1, before: "none" }))).response.status, 200);
  assert.equal((await w.invoice(relay, { sats: 1000 })).response.status, 200);
});

test("purchases close on their own settings and leave donations open", async () => {
  for (const [overrides, catalogue] of [
    [{ FIREWORK_BUYERS: "all" }, {}],
    [{ FIREWORK_BUYERS: "" }, {}],
    [{ PURCHASE_RATE_PER_IP: undefined }, null],
    [{ PURCHASE_RATE_GLOBAL: "0" }, null],
  ]) {
    const w = await world(overrides);
    const relay = await w.connectRelay();
    const page = await w.connectPage();
    assert.deepEqual(page.messages()[0].catalogue, catalogue, JSON.stringify(overrides));
    assert.notEqual(page.messages()[0].limits, null);
    const response = await w.post("/purchases/buy", firework("pop"), { donor: donor() });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "closed" });
    assert.equal((await w.invoice(relay, { sats: 1000 })).response.status, 200, "donations stay open");
  }
  const w = await world({ RATE_PER_IP: "" });
  await w.connectRelay();
  assert.equal(w.object.statusMessage(true).catalogue, null, "a deployment with donations closed sells nothing either");
  assert.equal((await w.post("/purchases/buy", firework("pop"), { donor: donor() })).status, 503);
});

test("a paid purchase is recorded apart from donations, announced once to every page, and never a donation", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const pages = [await w.connectPage(), await w.connectPage(undefined, "visitor-q")];
  await w.ctx.settle();
  const joined = pages.map((page) => page.messages().length);
  const pile = { ...w.ctx.storage.sql.exec("SELECT * FROM pile").one() };
  const tally = { ...w.env.DB.db.prepare("SELECT * FROM tally").get() };
  const fetched = w.platform.fetched.length;
  const { id } = await ask(w, relay, firework("mega", { nth: 2, before: "1" }), { donor: donor() });
  await w.relaySays(relay, { type: "paid", invoice: id, sats: 100, method: "lightning" });
  await w.ctx.settle();
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: id, result: "recorded" });
  const now = w.platform.now();
  assert.deepEqual(rows(w, "SELECT * FROM purchases"), [
    { seq: 1, id, sats: 100, at: now, method: "lightning", github_id: 4242, login: "ooga-dev", nth: 2, before: "1" },
  ]);
  assert.deepEqual(rows(w, "SELECT * FROM purchase_items"), [{ purchase: id, line: 1, category: "firework", item: "mega", quantity: 1, sats: 100, options: null }]);
  assert.deepEqual(rows(w, "SELECT * FROM donations"), [], "no donation is recorded");
  assert.deepEqual(rows(w, "SELECT * FROM handle_totals"), []);
  assert.deepEqual({ ...w.env.DB.db.prepare("SELECT * FROM tally").get() }, tally, "the tally doesn't move");
  assert.deepEqual({ ...w.ctx.storage.sql.exec("SELECT * FROM pile").one() }, pile, "nor does the pile");
  assert.equal(w.platform.fetched.length, fetched, "settling takes no price");
  for (const [i, page] of pages.entries()) {
    assert.deepEqual(page.messages().slice(joined[i]), [
      { type: "purchase", id, category: "firework", item: "mega", quantity: 1, at: now, login: "ooga-dev", slot: 0, launchAt: now + LEAD },
      { type: "purchaseBoard", category: "firework", entries: [{ login: "ooga-dev", quantity: 1, sats: 100 }] },
      { type: "purchaseCounts", category: "firework", days: 7, since: weekOf(now), items: { pop: 0, bolt: 0, mega: 1, show: 0 } },
    ], "no donation, pile, board, tally or recent list");
  }
  assert.equal(pendingCount(w), 0);

  await w.relaySays(relay, { type: "paid", invoice: id, sats: 100, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: id, result: "duplicate" });
  assert.equal(typed(pages[0], "purchase").length, 1, "a repeated notice announces nothing");
  assert.equal(rows(w, "SELECT * FROM purchases").length, 1);
  assert.equal(rows(w, "SELECT * FROM purchase_items").length, 1);
});

test("a new category sells through the same call, record and messages, with nothing else to wire", async () => {
  CATALOGUE.costume = { items: { "banana-suit": { sats: 2_000 } }, buyers: "signed-in", announce: false, board: false, counts: false };
  try {
    const w = await world();
    const relay = await w.connectRelay();
    const page = await w.connectPage();
    assert.deepEqual(page.messages()[0].catalogue.costume, { buyers: "signed-in", prices: { "banana-suit": 2_000 } });
    assert.deepEqual(typed(page, "purchaseBoard").map((m) => m.category), ["firework"], "only a category with a board gets one");
    assert.deepEqual(typed(page, "purchaseCounts").map((m) => m.category), ["firework"], "and only one that keeps counts gets them");
    assert.equal((await w.post("/purchases/buy", { category: "costume", item: "banana-suit" })).status, 403, "its own buyers rule");
    assert.equal((await w.post("/purchases/buy", { category: "costume", item: "banana-suit", slot: 0 }, { donor: donor() })).status, 400, "no slot where the category has none");
    const id = await buy(w, relay, { category: "costume", item: "banana-suit" }, { donor: donor() });
    const now = w.platform.now();
    assert.deepEqual(typed(page, "purchase"), [{ type: "purchase", id, category: "costume", item: "banana-suit", quantity: 1, at: now, login: null }],
      "the buyer's page finds its own id; a category that doesn't announce its buyers names nobody");
    assert.deepEqual(typed(page, "purchaseBoard").length, 1, "and with no board, none goes out");
    assert.deepEqual(typed(page, "purchaseCounts").length, 1, "nor any counts");
    assert.deepEqual(rows(w, "SELECT category, item, quantity, sats FROM purchase_items"), [{ category: "costume", item: "banana-suit", quantity: 1, sats: 2_000 }]);
    assert.deepEqual(await bought(w, donor()), [200, { items: { costume: { "banana-suit": { quantity: 1, sats: 2_000 } } } }]);
    assert.deepEqual(rows(w, "SELECT category, item, created, paid FROM purchase_funnel"), [{ category: "costume", item: "banana-suit", created: 1, paid: 1 }]);
    await buy(w, relay, firework("pop"), { donor: donor() });
    assert.equal(typed(page, "purchase").at(-1).slot, 0, "a costume takes no slot of sky");

    // Something bought before its category left the catalogue is still recorded and announced.
    const { id: last } = await ask(w, relay, { category: "costume", item: "banana-suit" }, { donor: donor() });
    delete CATALOGUE.costume;
    await w.relaySays(relay, { type: "paid", invoice: last, sats: 2_000, method: "lightning" });
    assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: last, result: "recorded" });
    assert.equal(typed(page, "purchase").at(-1).id, last);
    assert.equal(typed(page, "purchase").at(-1).login, null);
    assert.deepEqual(await bought(w, donor(), { category: "costume" }), [200, { items: { costume: { "banana-suit": { quantity: 2, sats: 4_000 } } } }],
      "what was bought stays readable");
  } finally {
    delete CATALOGUE.costume;
  }
});

test("the counts give each item sold in the last seven days, anyone's, once per purchase", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world({ FIREWORK_BUYERS: "everyone", PURCHASE_RATE_PER_IP: "20" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const start = w.platform.now();
  const counts = (items, now = start) => ({ type: "purchaseCounts", category: "firework", days: 7, since: weekOf(now), items });
  const types = page.messages().map((m) => m.type);
  assert.equal(types[types.indexOf("purchaseBoard") + 1], "purchaseCounts", "sent on connect, after the leaderboards");
  assert.deepEqual(typed(page, "purchaseCounts"), [counts({ pop: 0, bolt: 0, mega: 0, show: 0 })], "every item, at 0 before any sale");

  await buy(w, relay, firework("pop"));
  const repeated = await buy(w, relay, firework("pop"), { donor: donor() });
  await w.relaySays(relay, { type: "paid", invoice: repeated, sats: 10, method: "lightning" });
  await ask(w, relay, firework("mega"), { donor: donor() });
  await buy(w, relay, firework("show"), { donor: donor() });
  assert.equal(typed(page, "purchaseCounts").length, 4, "one on connect and one per purchase, none for a repeat or an unpaid invoice");
  assert.deepEqual(typed(page, "purchaseCounts").at(-1), counts({ pop: 2, bolt: 0, mega: 0, show: 1 }),
    "anonymous and signed-in alike, and a show counts once");

  w.platform.advance(7 * 24 * HOUR - 1);
  assert.deepEqual(typed(await w.connectPage(undefined, "visitor-q"), "purchaseCounts"), [typed(page, "purchaseCounts").at(-1)].map((m) => ({ ...m, since: weekOf(w.platform.now()) })),
    "still within seven days of the last hour");
  w.platform.advance(1);
  assert.deepEqual(typed(await w.connectPage(undefined, "visitor-r"), "purchaseCounts"), [counts({ pop: 0, bolt: 0, mega: 0, show: 0 }, w.platform.now())],
    "read again once the seven days have moved on an hour, and the old sales are gone");

  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    if (sql.includes("sum(paid)")) throw new Error("D1 is down");
    return prepare(sql);
  };
  const kept = typed(page, "purchaseCounts").length;
  await buy(w, relay, firework("bolt"));
  assert.ok(errors.mock.calls.some((c) => /reading the firework counts failed/.test(c.arguments[0])));
  assert.equal(typed(page, "purchaseCounts").length, kept + 1);
  assert.deepEqual(typed(page, "purchaseCounts").at(-1).items, { pop: 0, bolt: 0, mega: 0, show: 0 }, "the last counts read are kept");
  w.env.DB.prepare = prepare;
  await buy(w, relay, firework("bolt"));
  assert.deepEqual(typed(page, "purchaseCounts").at(-1).items, { pop: 0, bolt: 2, mega: 0, show: 0 });
});

test("a page is never sent a purchase it missed, nor finds one among the donations", async () => {
  const w = await world({ FIREWORK_BUYERS: "everyone" });
  const relay = await w.connectRelay();
  await donate(w, relay, INVOICE);
  const id = await buy(w, relay, firework("pop"));
  await donate(w, relay, "Donation02");
  const page = await w.connectPage(INVOICE);
  assert.deepEqual(typed(page, "donation").map((m) => m.donation.id), ["Donation02"]);
  assert.deepEqual(typed(page, "purchase"), []);
  assert.deepEqual(typed(page, "recent")[0].entries.map((entry) => entry.id), ["Donation02", INVOICE]);
  const named = await w.connectPage(id, "visitor-q");
  assert.deepEqual([...typed(named, "donation"), ...typed(named, "purchase")], [], "a purchase's id replays nothing");
});

test("a purchase D1 recorded before the object stopped is still announced, once", async (t) => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const { id } = await ask(w, relay, firework("pop"), { donor: donor() });
  // The purchase and its item land in D1, and then the object stops before it does anything else.
  const batch = w.env.DB.batch;
  w.env.DB.batch = async (statements) => {
    await batch(statements);
    throw new Error("stopped");
  };
  const sent = relay.sent.length;
  await w.relaySays(relay, { type: "paid", invoice: id, sats: 10, method: "lightning" });
  assert.equal(relay.sent.length, sent, "no acknowledgement, so the relay sends it again");
  assert.deepEqual(typed(page, "purchase"), []);
  w.env.DB.batch = batch;
  await w.relaySays(relay, { type: "paid", invoice: id, sats: 10, method: "lightning" });
  assert.equal(typed(page, "purchase").length, 1);
  await w.relaySays(relay, { type: "paid", invoice: id, sats: 10, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: id, result: "duplicate" });
  assert.equal(typed(page, "purchase").length, 1);
  assert.equal(rows(w, "SELECT * FROM purchase_totals")[0].quantity, 1);
  assert.equal(rows(w, "SELECT * FROM purchase_items").length, 1);
});

test("a purchase is Lightning only: no on-chain switch, no details to edit, and no sale without Lightning", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.ctx.settle();
  const { asked, id } = await ask(w, relay, firework("pop"), { donor: donor() });
  const sent = relay.sent.length;
  const onchain = await w.post("/donations/onchain", { request: asked.request });
  assert.equal(onchain.status, 400);
  assert.deepEqual(await onchain.json(), { error: "invalid" });
  for (const details of [{ handle: "ooga" }, { message: "hi" }]) {
    assert.equal((await w.post("/donations/note", { request: asked.request, ...details })).status, 404, "a purchase has no handle or message");
  }
  assert.deepEqual({ ...w.ctx.storage.sql.exec("SELECT handle, message FROM pending").one() }, { handle: "", message: "" });
  assert.equal(relay.sent.length, sent, "the relay is never asked for an address");
  const fetched = w.platform.fetched.length;
  await w.relaySays(relay, { type: "seen", invoice: id, sats: 10, left: 0 });
  assert.deepEqual(typed(page, "seen"), [], "nothing of a purchase is seen on-chain");
  assert.equal(w.platform.fetched.length, fetched);
  for (const [answer, why] of [
    [() => ({ invoice: { id: "NoLightning1", bolt11: null, expires: EXPIRES } }), "Lightning wasn't made in time"],
    [(a) => ({ invoice: { id: "WrongAmount1", bolt11: bolt11For(a.sats + 1), expires: EXPIRES } }), "the wrong amount"],
    [() => ({ error: "unavailable" }), "the relay couldn't make one"],
    [() => ({ error: "cap" }), "under the relay's own minimum"],
  ]) {
    const { response } = await ask(w, relay, firework("bolt"), { donor: donor(), answer });
    assert.equal(response.status, 503, why);
    assert.deepEqual(await response.json(), { error: "closed" });
  }
  assert.match(errors.mock.calls.at(-1).arguments[0], /MIN_SATS/);
  assert.equal(pendingCount(w), 1, "only the first purchase is still waiting");

  const narrow = await world({ LIGHTNING_MAX_SATS: "200" });
  const narrowRelay = await narrow.connectRelay();
  const show = await narrow.post("/purchases/buy", firework("show"), { donor: donor() });
  assert.equal(show.status, 503, "a show over the Lightning threshold isn't sold on-chain instead");
  assert.equal(narrowRelay.sent.length, 0);
  assert.equal((await ask(narrow, narrowRelay, firework("mega"), { donor: donor() })).response.status, 200);
});

test("the totals count each signed-in purchase once per account and item, under the latest login, and anonymous ones nowhere", async () => {
  const w = await world({ FIREWORK_BUYERS: "everyone", PURCHASE_RATE_PER_IP: "20" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(typed(page, "purchaseBoard"), [{ type: "purchaseBoard", category: "firework", entries: [] }], "an empty plaque on connect");
  const first = donor("first-name", 1), renamed = donor("new-name", 1), second = donor("second", 2);
  await buy(w, relay, firework("pop"), { donor: first });
  const repeated = await buy(w, relay, firework("pop"), { donor: first });
  await w.relaySays(relay, { type: "paid", invoice: repeated, sats: 10, method: "lightning" });
  await buy(w, relay, firework("mega"), { donor: first });
  await buy(w, relay, firework("show"), { donor: second });
  await buy(w, relay, firework("bolt"), { donor: renamed });
  await buy(w, relay, firework("mega"));
  await buy(w, relay, firework("pop", { nth: 3, before: "6+" }));
  assert.deepEqual(rows(w, "SELECT * FROM purchase_totals ORDER BY github_id, item"), [
    { github_id: 1, login: "new-name", category: "firework", item: "bolt", quantity: 1, sats: 69 },
    { github_id: 1, login: "new-name", category: "firework", item: "mega", quantity: 1, sats: 100 },
    { github_id: 1, login: "new-name", category: "firework", item: "pop", quantity: 2, sats: 20 },
    { github_id: 2, login: "second", category: "firework", item: "show", quantity: 1, sats: 300 },
  ]);
  assert.deepEqual(rows(w, "SELECT github_id, login FROM purchases JOIN purchase_items ON purchase = id WHERE item = 'mega' ORDER BY seq"),
    [{ github_id: 1, login: "first-name" }, { github_id: null, login: null }],
    "each purchase keeps the login it was bought under, and an anonymous one keeps none");
  const boards = typed(page, "purchaseBoard");
  assert.equal(boards.length, 6, "one on connect, then one per signed-in purchase, and none for a repeat or an anonymous one");
  assert.deepEqual(boards.at(-1).entries, [{ login: "second", quantity: 1, sats: 300 }, { login: "new-name", quantity: 4, sats: 189 }]);
  assert.deepEqual(typed(page, "purchase").map((m) => m.login), ["first-name", "first-name", "first-name", "second", "new-name", null, null]);
  const joined = await w.connectPage(undefined, "visitor-q");
  const types = joined.messages().map((m) => m.type);
  assert.equal(types[types.indexOf("board") + 1], "purchaseBoard", "sent on connect, right after the donations' board");
  assert.deepEqual(typed(joined, "purchaseBoard"), [boards.at(-1)]);

  const fireworks = { bolt: { quantity: 1, sats: 69 }, mega: { quantity: 1, sats: 100 }, pop: { quantity: 2, sats: 20 } };
  assert.deepEqual(await bought(w, renamed), [200, { items: { firework: fireworks } }]);
  assert.deepEqual(await bought(w, renamed, { category: "firework" }), [200, { items: { firework: fireworks } }]);
  assert.deepEqual(await bought(w, renamed, { category: "costume" }), [200, { items: {} }]);
  assert.deepEqual(await bought(w, second), [200, { items: { firework: { show: { quantity: 1, sats: 300 } } } }], "only that donor's own");
  assert.deepEqual(await bought(w, donor("never-bought", 3)), [200, { items: {} }]);
  assert.deepEqual(await bought(w, null), [200, { items: {} }], "nobody signed in has bought anything to show");
  for (const body of [{ category: "Firework" }, { category: 7 }, { category: null }, { item: "pop" }]) {
    assert.equal((await w.post("/purchases/mine", body, { donor: renamed })).status, 400, JSON.stringify(body));
  }
  for (const who of [undefined, {}, { id: "1", login: "first-name" }, { id: 1, login: "first-name", admin: true }]) {
    assert.equal((await w.page.purchases(call("/purchases/mine", {}), who, "visitor-a")).status, 400, JSON.stringify(who));
  }
  assert.equal((await w.page.purchases(call("/purchases/mine", {}), renamed, "")).status, 400, "no visitor");
});

test("a leaderboard ranks the top buyers by sats, ties by login, and keeps the last one when D1 can't be read", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world();
  const purchase = w.env.DB.db.prepare("INSERT INTO purchases (id, sats, at, method, github_id, login) VALUES (?, ?, 1, 'lightning', ?, ?)");
  const item = w.env.DB.db.prepare("INSERT INTO purchase_items (purchase, line, category, item, quantity, sats) VALUES (?, 1, ?, ?, 1, ?)");
  const buyers = Array.from({ length: PURCHASE_BOARD_SIZE + 2 }, (_, i) => ({ id: i + 1, login: `buyer-${i + 1}`, sats: 100 * ((i % 4) + 1) }));
  for (const { id, login, sats } of buyers) {
    purchase.run(`Purchase${String(id).padStart(4, "0")}x`, sats, id, login);
    item.run(`Purchase${String(id).padStart(4, "0")}x`, "firework", "pop", sats);
  }
  // Something else bought counts on no firework plaque.
  purchase.run("Costume0001", 50_000, 1, "buyer-1");
  item.run("Costume0001", "costume", "banana-suit", 50_000);
  const expected = buyers.map(({ login, sats }) => ({ login, quantity: 1, sats }))
    .sort((a, b) => b.sats - a.sats || (a.login < b.login ? -1 : 1)).slice(0, PURCHASE_BOARD_SIZE);
  const page = await w.connectPage();
  assert.deepEqual(typed(page, "purchaseBoard")[0].entries, expected);

  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    if (sql.includes("FROM purchase_totals")) throw new Error("D1 is down");
    return prepare(sql);
  };
  const relay = await w.connectRelay();
  await buy(w, relay, firework("pop"), { donor: donor("buyer-5", 5) });
  assert.ok(errors.mock.calls.some((c) => /reading the firework board failed/.test(c.arguments[0])));
  assert.deepEqual(typed(page, "purchaseBoard").at(-1).entries, expected, "the last board is kept");
  assert.equal((await w.post("/purchases/mine", {}, { donor: donor("buyer-5", 5) })).status, 503);

  const woken = new DonationsObject(w.ctx, w.env, w.platform);
  w.env.DONATIONS.get = () => ({ fetch: (input, init) => woken.fetch(new Request(input, init)) });
  const fresh = await w.connectPage(undefined, "visitor-q");
  assert.deepEqual(fresh.messages().map((m) => m.type), ["status", "pile", "board", "purchaseCounts", "tally", "recent"], "with nothing kept, the plaque is skipped");
});

test("every page launches a firework at the lead after settlement, a busy slot waits, and a show takes three neighbouring slots", async () => {
  const w = await world({ FIREWORK_BUYERS: "everyone", PURCHASE_RATE_PER_IP: "20" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const start = w.platform.now();
  const launched = async (item, wait = 0) => {
    w.platform.advance(wait);
    const id = await buy(w, relay, firework(item));
    const message = typed(page, "purchase").at(-1);
    assert.equal(message.id, id);
    assert.equal(rows(w, `SELECT at FROM purchases WHERE id = '${id}'`)[0].at, message.at, "at is the settlement");
    return [message.slot, message.at - start, message.launchAt - start];
  };
  const { pop, show } = FIREWORK.items;
  assert.deepEqual(await launched("pop"), [0, 0, LEAD], "the lead after settlement");
  assert.deepEqual(await launched("show", 1_000), [1, 1_000, 1_000 + LEAD], "slots 1 to 3");
  assert.deepEqual(await launched("pop", 1_000), [4, 2_000, 2_000 + LEAD]);
  assert.deepEqual(await launched("pop"), [5, 2_000, 2_000 + LEAD], "two shows launch together in different slots");
  assert.deepEqual(await launched("pop"), [0, 2_000, LEAD + pop.holdMs], "round to slot 0, which waits for the first pop");
  assert.deepEqual(await launched("show"), [1, 2_000, 1_000 + LEAD + show.holdMs], "waits for the first show's slots");
  assert.deepEqual(await launched("show"), [0, 2_000, 1_000 + LEAD + 2 * show.holdMs],
    "a show never starts past slot 3, so it starts again from slot 0 and waits for every slot it needs");

  const later = await world({ FIREWORK_LEAD_MS: "5000" });
  const laterRelay = await later.connectRelay();
  const laterPage = await later.connectPage();
  await buy(later, laterRelay, firework("pop"), { donor: donor() });
  assert.equal(typed(laterPage, "purchase")[0].launchAt, later.platform.now() + 5_000);
});

test("a buyer may choose where a firework bursts: it launches there, waits while it's busy, and leaves the round alone", async () => {
  const w = await world({ FIREWORK_BUYERS: "everyone", PURCHASE_RATE_PER_IP: "20" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const start = w.platform.now();
  const launched = async (item, slot) => {
    const id = await buy(w, relay, firework(item, slot === undefined ? {} : { slot }));
    const message = typed(page, "purchase").at(-1);
    assert.equal(message.id, id);
    return [message.slot, message.launchAt - start];
  };
  const { pop, mega } = FIREWORK.items;
  assert.deepEqual(await launched("pop", 4), [4, LEAD], "the chosen slot, at the lead");
  assert.deepEqual(await launched("pop"), [0, LEAD], "the round starts where it was");
  assert.deepEqual(await launched("mega", 4), [4, LEAD + pop.holdMs], "a busy chosen slot waits rather than moves");
  assert.deepEqual(await launched("show", 3), [3, LEAD + pop.holdMs + mega.holdMs], "a show waits for every slot it fills");
  assert.deepEqual(await launched("pop"), [1, LEAD], "and the round goes on from where it was");
  assert.deepEqual(rows(w, "SELECT item, options FROM purchase_items ORDER BY rowid"), [
    { item: "pop", options: '{"slot":4}' },
    { item: "pop", options: null },
    { item: "mega", options: '{"slot":4}' },
    { item: "show", options: '{"slot":3}' },
    { item: "pop", options: null },
  ], "each kept with what was bought");
});

test("the funnel counts each purchase invoice once as made and once as paid, by item and hour", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world({ PURCHASE_RATE_PER_IP: "20" });
  const relay = await w.connectRelay();
  const start = w.platform.now();
  const paid = await buy(w, relay, firework("pop"), { donor: donor() });
  await w.relaySays(relay, { type: "paid", invoice: paid, sats: 10, method: "lightning" });
  await ask(w, relay, firework("pop"), { donor: donor() });
  await ask(w, relay, firework("mega"), { donor: donor(), answer: () => ({ error: "unavailable" }) });
  await buy(w, relay, firework("mega"), { donor: donor() });
  await donate(w, relay, INVOICE);
  w.platform.advance(HOUR);
  await buy(w, relay, firework("show"), { donor: donor() });
  await w.ctx.settle();
  assert.deepEqual(rows(w, "SELECT * FROM purchase_funnel ORDER BY hour, item"), [
    { hour: start, category: "firework", item: "mega", created: 1, paid: 1 },
    { hour: start, category: "firework", item: "pop", created: 2, paid: 1 },
    { hour: start + HOUR, category: "firework", item: "show", created: 1, paid: 1 },
  ]);

  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    if (sql.startsWith("INSERT INTO purchase_funnel")) throw new Error("D1 is down");
    return prepare(sql);
  };
  assert.equal((await ask(w, relay, firework("bolt"), { donor: donor() })).response.status, 200, "the buyer never waits on the count");
  await w.ctx.settle();
  assert.match(errors.mock.calls.at(-1).arguments[0], /counting a purchase invoice failed/);
});

test("purchase invoices count against their own rate limits, never the donations'", async () => {
  const w = await world({ RATE_PER_IP: "2", RATE_GLOBAL: "3", PURCHASE_RATE_PER_IP: "2", PURCHASE_RATE_GLOBAL: "3" });
  const launch = (visitor) => w.post("/purchases/buy", firework("pop"), { visitor, donor: donor() });
  const give = (visitor) => w.post("/donations/invoice", { sats: 1000 }, { visitor });
  assert.equal((await launch("a")).status, 503, "counted, though closed for want of a relay");
  assert.equal((await launch("a")).status, 503);
  assert.equal((await launch("a")).status, 429, "third from one visitor");
  assert.equal((await launch("b")).status, 503);
  assert.equal((await launch("c")).status, 429, "fourth overall");
  assert.equal((await give("a")).status, 503, "the donations' budgets are untouched");
  assert.equal((await give("a")).status, 503);
  assert.equal((await give("a")).status, 429);
  assert.equal((await give("b")).status, 503);
  assert.equal((await give("c")).status, 429);
  const counts = Object.fromEntries(w.ctx.storage.sql.exec("SELECT key, count FROM rate").toArray().map((row) => [row.key, row.count]));
  assert.equal(counts.total, 3);
  assert.equal(counts["purchase total"], 3);
  w.platform.advance(60_000);
  assert.equal((await launch("a")).status, 503, "a new minute");
});

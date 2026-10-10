// The Worker and its object together, through the fakes in helpers/cloudflare.mjs: a page asks
// for an invoice, the relay answers on its line, a payment lands on every page.

import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject, ONCHAIN_FEE_ALLOWANCE, PAGE_SOCKETS_MAX, REPLAY_MAX, visitorGroup, visitorKey } from "../worker/object.mjs";
import { until } from "./helpers/cloudflare.mjs";
import { ADDRESS, BOLT11, INVOICE, bolt11For } from "./helpers/values.mjs";
import { call, donor, EXPIRES, TOKEN, upgrade, world } from "./helpers/world.mjs";

test("an invoice goes from the page to the relay and back, with its bananas", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked, response } = await w.invoice(relay, { sats: 1000, message: "for the cave" });
  assert.deepEqual(Object.keys(asked).sort(), ["request", "sats", "type"]);
  assert.equal(asked.sats, 1000);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    request: asked.request,
    invoice: { id: INVOICE, bolt11: BOLT11, expires: EXPIRES },
    bananas: { exact: 1, rounded: 1 },
    rate: { usdPerBtc: 100_000, satsPerBanana: 1000, at: w.platform.now(), stale: false },
  });
});

test("who gave it and the message never reach the relay", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000, message: "secret message" }, undefined, { donor: donor("secret-login") });
  assert.ok(relay.sent.every((text) => !text.includes("secret")));
});

test("a payment is recorded once, acknowledged, and pushed to every page", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const pages = [await w.connectPage(), await w.connectPage()];
  await w.invoice(relay, { sats: 1000, message: "<b>for</b> the cave" });
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "recorded" });
  const donation = { id: INVOICE, sats: 1000, handle: "", message: "bforb the cave", at: w.platform.now() };
  for (const page of pages) {
    assert.deepEqual(page.messages().filter((m) => m.type === "donation"), [{ type: "donation", donation, bananas: { exact: 1, rounded: 1 } }]);
  }
  assert.deepEqual(w.env.DB.db.prepare("SELECT id, sats, handle, message, at FROM donations").all().map((row) => ({ ...row })), [donation]);
  assert.equal(w.env.DB.db.prepare("SELECT method FROM donations").get().method, "lightning", "how it was paid is recorded too");

  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "duplicate" });
  assert.equal(pages[0].messages().filter((m) => m.type === "donation").length, 1);
});

test("the message can follow the amount, but who gave it can't change", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const noted = await w.post("/donations/note", { request: asked.request, message: "<i>hi</i>" });
  assert.equal(noted.status, 204);
  const renamed = await w.post("/donations/note", { request: asked.request, handle: "someone-else" });
  assert.equal(renamed.status, 400);
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  const [{ donation }] = page.messages().filter((m) => m.type === "donation");
  assert.equal(donation.handle, "");
  assert.equal(donation.message, "ihii");
  const unknown = await w.post("/donations/note", { request: "f".repeat(32), message: "x" });
  assert.equal(unknown.status, 404);
});

test("donations are closed when no relay is connected", async () => {
  const w = await world();
  const response = await w.post("/donations/invoice", { sats: 1000 });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "closed" });
});

test("a relay that doesn't answer in time closes donations, and the request is forgotten", async () => {
  const w = await world({ INVOICE_TIMEOUT_MS: "20" });
  await w.connectRelay();
  const response = await w.post("/donations/invoice", { sats: 1000 });
  assert.equal(response.status, 503);
  assert.equal(w.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pending").one().n, 0);
});

test("when the line drops, waiting pages hear at once and every page sees donations close", async () => {
  const w = await world({ INVOICE_TIMEOUT_MS: "60000" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(page.messages()[0], { type: "status", open: true, network: "regtest" });
  const pending = w.post("/donations/invoice", { sats: 1000 });
  await until(() => relay.sent.length === 1);
  relay.close(1006, "");
  await w.object.webSocketClose(relay, 1006, "", false);
  assert.equal((await pending).status, 503);
  assert.deepEqual(page.messages().at(-1), { type: "status", open: false, network: "regtest" });
});

test("an invoice for the wrong amount or network never reaches the donor", async () => {
  for (const bolt11 of [bolt11For(999), bolt11For(1000, "lnbc")]) {
    const w = await world();
    const relay = await w.connectRelay();
    const { response } = await w.invoice(relay, { sats: 1000 }, () => ({ id: INVOICE, bolt11, expires: EXPIRES }));
    assert.equal(response.status, 503, bolt11.slice(0, 12));
  }
});

test("the relay's own cap reaches the page as an amount error", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { response } = await w.invoice(relay, { sats: 1000 }, () => ({ error: "cap" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "amount" });
});

test("a missing or inconsistent limit closes donations", async () => {
  for (const overrides of [{ MAX_SATS: undefined }, { RATE_PER_IP: "" }, { MIN_SATS: "5000", MAX_SATS: "100" }, { NETWORK: undefined }]) {
    const w = await world(overrides);
    await w.connectRelay();
    const response = await w.post("/donations/invoice", { sats: 50 });
    assert.equal(response.status, 503, JSON.stringify(overrides));
  }
});

test("the Worker checks amounts and bodies before anything reaches the object", async () => {
  const w = await world();
  const cases = [
    [{ sats: 0 }, 400, "amount"],
    [{ sats: 100_001 }, 400, "amount"],
    [{ sats: "1000" }, 400, "invalid"],
    [{ sats: 10.5 }, 400, "invalid"],
    [{ sats: 1000, extra: true }, 400, "invalid"],
    [{ sats: 1000, handle: "typed-in" }, 400, "invalid"],
    [{ sats: 1000, message: 7 }, 400, "invalid"],
    [{ sats: 1000, anon: "yes" }, 400, "invalid"],
    [{}, 400, "invalid"],
    ["[1000]", 400, "invalid"],
    ["{not json", 400, "invalid"],
    [`{"sats": 1000, "message": "${"x".repeat(2000)}"}`, 413, "too large"],
  ];
  for (const [body, status, error] of cases) {
    const response = await w.post("/donations/invoice", body);
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 40));
    assert.deepEqual(await response.json(), { error });
  }
  const wrongType = await w.post("/donations/invoice", { sats: 1000 }, { type: "text/plain" });
  assert.equal(wrongType.status, 415);
  // A request id that only prints like one, such as a list holding it, never reaches the object.
  for (const path of ["/donations/note", "/donations/onchain"]) {
    const listed = await w.post(path, { request: ["e".repeat(32)] });
    assert.equal(listed.status, 400, path);
  }
});

test("the public address takes only the relay's line; pages come through OBL's Worker", async () => {
  const w = await world();
  await w.connectRelay();
  const publicCalls = [
    new Request("https://bananapayserver/donations/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"sats\":1000}" }),
    new Request("https://bananapayserver/donations/invoice", { method: "OPTIONS" }),
    upgrade("/donations/socket"),
    new Request("https://bananapayserver/auth/github"),
  ];
  for (const request of publicCalls) assert.equal((await w.send(request)).status, 404, `${request.method} ${request.url}`);
  assert.equal(w.ctx.getWebSockets("page").length, 0);
  const relayThroughBinding = await w.page.fetch(upgrade("/relay", { Authorization: `Bearer ${TOKEN}` }));
  assert.equal(relayThroughBinding.status, 404, "the entrypoint's fetch is for the socket alone");
});

test("who gave it is only ever OBL's signed-in donor, in exactly the expected shape", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const malformed = [undefined, {}, "ooga-dev", [4242, "ooga-dev"], { id: "4242", login: "ooga-dev" }, { id: 0, login: "ooga-dev" },
    { id: 4242, login: "-ooga" }, { id: 4242, login: "o".repeat(40) }, { id: 4242, login: "ooga dev" }, { id: 4242, login: "ooga-dev", admin: true }];
  for (const who of malformed) {
    const response = await w.page.invoice(call("/donations/invoice", { sats: 1000 }), who, "visitor-a");
    assert.equal(response.status, 400, JSON.stringify(who));
    assert.deepEqual(await response.json(), { error: "invalid" });
  }
  assert.equal(relay.sent.length, 0, "none of them reached the relay");
  const notARequest = await w.page.invoice("{\"sats\":1000}", null, "visitor-a");
  assert.equal(notARequest.status, 400, "a call carries a request, never a bare body");
});

test("the object itself refuses a line without the relay's token, however it's reached", async () => {
  const w = await world();
  const object = w.env.DONATIONS.get(w.env.DONATIONS.idFromName("donations"));
  const bare = await object.fetch("https://object/relay", { headers: { Upgrade: "websocket" } });
  assert.equal(bare.status, 401, "another Worker binding the object can't open a line");
  const wrong = await object.fetch("https://object/relay", { headers: { Upgrade: "websocket", Authorization: "Bearer wrong-token-wrong-token-wrong-token" } });
  assert.equal(wrong.status, 401);
  assert.equal(w.ctx.getWebSockets("relay").length, 0);
  await w.connectRelay();
  assert.equal(w.ctx.getWebSockets("relay").length, 1, "the relay, through the front door, still gets in");
});

test("a call without the visitor's address is refused, not counted with every other", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  for (const visitor of [undefined, "", 42]) {
    const calls = [
      w.page.invoice(call("/donations/invoice", { sats: 1000 }), null, visitor),
      w.page.note(call("/donations/note", { request: "e".repeat(32) }), visitor),
      w.page.onchain(call("/donations/onchain", { request: "e".repeat(32) }), visitor),
    ];
    for (const response of await Promise.all(calls)) assert.equal(response.status, 400, JSON.stringify(visitor));
  }
  const socket = await w.page.fetch(upgrade("/donations/socket"));
  assert.equal(socket.status, 400, "a socket without X-Client");
  assert.equal(relay.sent.length, 0);
});

test("an older GitHub username, with a hyphen at the end, still gives as itself", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 1000 }, undefined, { donor: donor("old--name-", 99) });
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  const [{ donation }] = page.messages().filter((m) => m.type === "donation");
  assert.equal(donation.handle, "old--name-");
});

test("a signed-in donation carries the GitHub login, unless the donor gives anonymously", async () => {
  const longest = "o".repeat(39);
  for (const [who, anon, handle, githubId] of [
    [donor("ooga-dev", 4242), false, "ooga-dev", 4242],
    [donor("ooga-dev", 4242), true, "", null],
    [null, false, "", null],
    [donor(longest, 7), false, longest, 7],
  ]) {
    const w = await world();
    const relay = await w.connectRelay();
    const page = await w.connectPage();
    await w.invoice(relay, { sats: 1000, anon }, undefined, { donor: who });
    await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
    const [{ donation }] = page.messages().filter((m) => m.type === "donation");
    assert.equal(donation.handle, handle, "a GitHub username arrives whole, up to its 39 characters");
    assert.equal(w.env.DB.db.prepare("SELECT github_id FROM donations").get().github_id, githubId);
  }
});

test("the relay's line opens only with its token", async () => {
  const w = await world();
  for (const headers of [{}, { Authorization: "Bearer wrong-token-wrong-token-wrong-token" }, { Authorization: `Basic ${TOKEN}` }]) {
    assert.equal((await w.send(upgrade("/relay", headers))).status, 401);
  }
  const noUpgrade = await w.send(new Request("https://api.example.org/relay", { headers: { Authorization: `Bearer ${TOKEN}` } }));
  assert.equal(noUpgrade.status, 426);
  const unset = await world({ RELAY_TOKEN_SHA256: undefined });
  assert.equal((await unset.send(upgrade("/relay", { Authorization: `Bearer ${TOKEN}` }))).status, 401);
  assert.equal(w.ctx.getWebSockets("relay").length, 0);
});

test("a relay that redials replaces its old line", async () => {
  const w = await world();
  const first = await w.connectRelay();
  const second = await w.connectRelay();
  assert.deepEqual(first.closedWith, { code: 4000, reason: "replaced" });
  assert.equal(w.object.line(), second);
  const page = await w.connectPage();
  await w.object.webSocketClose(first, 4000, "replaced", true);
  assert.deepEqual(page.messages().filter((m) => m.type === "status"), [{ type: "status", open: true, network: "regtest" }], "the old line closing doesn't close donations");
});

test("rate limits apply per visitor and overall, per minute", async () => {
  const w = await world({ RATE_PER_IP: "2", RATE_GLOBAL: "3" });
  const ask = (visitor) => w.post("/donations/invoice", { sats: 1000 }, { visitor });
  assert.equal((await ask("a")).status, 503);
  assert.equal((await ask("a")).status, 503);
  assert.equal((await ask("a")).status, 429, "third from one visitor");
  assert.equal((await ask("b")).status, 503);
  assert.equal((await ask("c")).status, 429, "fourth overall");
  w.platform.advance(60_000);
  assert.equal((await ask("a")).status, 503, "a new minute");
});

test("rate limits hold when the object sleeps and wakes within the minute, and keep no address", async () => {
  const w = await world({ RATE_PER_IP: "2", RATE_GLOBAL: "3" });
  const ask = (visitor) => w.post("/donations/invoice", { sats: 1000 }, { visitor });
  assert.equal((await ask("198.51.100.7")).status, 503, "counted, though closed for want of a relay");
  assert.equal((await ask("198.51.100.7")).status, 503);
  assert.equal((await ask("198.51.100.7")).status, 429);
  const woken = new DonationsObject(w.ctx, w.env, w.platform);
  w.env.DONATIONS.get = () => ({ fetch: (input, init) => woken.fetch(new Request(input, init)) });
  assert.equal((await ask("198.51.100.7")).status, 429, "the visitor's count held");
  assert.equal((await ask("198.51.100.8")).status, 503);
  assert.equal((await ask("198.51.100.9")).status, 429, "and so did everyone's");
  assert.equal(w.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM rate WHERE key LIKE '%198.51%'").one().n, 0, "no address is kept");
  w.platform.advance(60_000);
  assert.equal((await ask("198.51.100.7")).status, 503, "a new minute starts over");
  assert.equal(w.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM rate").one().n, 2, "last minute's counts are gone");
});

test("the object checks every notice the relay sends", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.relaySays(relay, { type: "paid", invoice: "NeverAsked1", sats: 1000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: "NeverAsked1", result: "unknown" });
  await w.invoice(relay, { sats: 1000 });
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 999_999, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "rejected" });
  const sent = relay.sent.length;
  await w.object.webSocketMessage(relay, "not the protocol");
  await w.object.webSocketMessage(relay, JSON.stringify({ type: "paid", invoice: INVOICE, sats: 1000, method: "lightning", extra: 1 }));
  assert.equal(relay.sent.length, sent, "dropped without a reply");
  await w.object.webSocketMessage(page, JSON.stringify({ type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }));
  assert.equal(relay.sent.length, sent, "pages can't report payments");
  assert.equal(page.messages().filter((m) => m.type === "donation").length, 0);
});

test("if recording fails, the payment isn't acknowledged and stays pending", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = () => {
    throw new Error("D1 is down");
  };
  const sent = relay.sent.length;
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  assert.equal(relay.sent.length, sent);
  w.env.DB.prepare = prepare;
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  assert.equal(JSON.parse(relay.sent.at(-1)).result, "recorded");
});

test("a page that reconnects gets what it missed, and no more than the cap", async () => {
  const w = await world();
  const insert = w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method) VALUES (?, ?, '', '', ?, 'lightning')");
  for (let i = 1; i <= REPLAY_MAX + 5; i++) insert.run(`Donation${String(i).padStart(4, "0")}`, i, i);
  const page = await w.connectPage("Donation0002");
  const replayed = page.messages().filter((m) => m.type === "donation").map((m) => m.donation.id);
  assert.equal(replayed.length, REPLAY_MAX);
  assert.equal(replayed[0], "Donation0003");
  const fresh = await w.connectPage("UnknownId1");
  assert.deepEqual(fresh.messages().filter((m) => m.type === "donation"), []);
  assert.deepEqual(fresh.messages()[0], { type: "status", open: false, network: "regtest" });
  const invalid = await w.page.fetch(upgrade("/donations/socket?after=../x", { "X-Client": "visitor-p" }));
  assert.equal(invalid.status, 400);
});

test("a donor who switches gets an on-chain address for the same invoice", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const pending = w.post("/donations/onchain", { request: asked.request });
  await until(() => JSON.parse(relay.sent.at(-1)).type === "onchain");
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "onchain", request: asked.request, invoice: INVOICE });
  await w.relaySays(relay, { type: "onchain", request: asked.request, address: ADDRESS, sats: 1000 });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { address: ADDRESS, sats: 1000 });
});

test("an on-chain switch is refused for a wrong address, an unknown request, or an expired invoice", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const pending = w.post("/donations/onchain", { request: asked.request });
  await until(() => JSON.parse(relay.sent.at(-1)).type === "onchain");
  await w.relaySays(relay, { type: "onchain", request: asked.request, address: "bc1qexampleexampleexample", sats: 1000 });
  assert.equal((await pending).status, 503, "a mainnet address on regtest");
  assert.equal((await w.post("/donations/onchain", { request: "e".repeat(32) })).status, 404);
  w.platform.advance(16 * 60_000);
  assert.equal((await w.post("/donations/onchain", { request: asked.request })).status, 410);
});

test("an on-chain amount far above the invoice is refused, while room for a network fee isn't", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const switchTo = async (sats) => {
    const before = relay.sent.length;
    const pending = w.post("/donations/onchain", { request: asked.request });
    await until(() => relay.sent.length > before);
    await w.relaySays(relay, { type: "onchain", request: asked.request, address: ADDRESS, sats });
    return pending;
  };
  assert.equal((await switchTo(1000 + ONCHAIN_FEE_ALLOWANCE + 1)).status, 503, "a mistake in units, say");
  assert.equal((await switchTo(1000 + 5_000)).status, 200, "a network fee the store adds");
});

test("the object cleans the text again, whoever reaches it", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  // Straight to the object, as another Worker in the account could, past the front door.
  const pending = w.env.DONATIONS.get().fetch("https://object/invoice", {
    method: "POST",
    body: JSON.stringify({ sats: 1000, message: "<img src=x onerror=alert(1)> hi", github: { id: 7, login: "<b>x</b>" }, client: "198.51.100.7" }),
  });
  await until(() => relay.sent.length > 0);
  const row = w.ctx.storage.sql.exec("SELECT handle, message FROM pending").one();
  assert.doesNotMatch(`${row.handle} ${row.message}`, /[<>=()/]/);
  await pending;
});

test("pending requests are forgotten after the retention period", async () => {
  const w = await world({ PENDING_DAYS: "7" });
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  w.platform.advance(8 * 86_400_000);
  await w.invoice(relay, { sats: 1000 }, () => ({ id: "Inv0ice5678", bolt11: BOLT11, expires: EXPIRES }));
  assert.equal((await w.post("/donations/note", { request: asked.request, message: "x" })).status, 404);
});

test("notices that arrive together record and push the donation once", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 1000 });
  const sent = relay.sent.length;
  await Promise.all([
    w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }),
    w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" }),
  ]);
  assert.equal(page.messages().filter((m) => m.type === "donation").length, 1);
  assert.equal(w.env.DB.db.prepare("SELECT COUNT(*) AS n FROM donations").get().n, 1);
  const results = relay.sent.slice(sent).map((text) => JSON.parse(text).result).sort();
  assert.deepEqual(results, ["duplicate", "recorded"]);
});

test("a double click on the on-chain switch shares one answer", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const first = w.post("/donations/onchain", { request: asked.request });
  const second = w.post("/donations/onchain", { request: asked.request });
  await until(() => relay.sent.some((text) => JSON.parse(text).type === "onchain"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(relay.sent.filter((text) => JSON.parse(text).type === "onchain").length, 1);
  await w.relaySays(relay, { type: "onchain", request: asked.request, address: ADDRESS, sats: 1000 });
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { address: ADDRESS, sats: 1000 });
  }
});

test("a page that sends anything is closed", async () => {
  const w = await world();
  const page = await w.connectPage();
  await w.object.webSocketMessage(page, "hello?");
  assert.deepEqual(page.closedWith, { code: 1008, reason: "pages don't send" });
});

test("page loads have a budget of their own and can't close donations", async () => {
  const w = await world({ RATE_PER_IP: "2", RATE_GLOBAL: "2" });
  await w.connectPage(undefined, "crowd-1");
  await w.connectPage(undefined, "crowd-1");
  const third = await w.socket(undefined, "crowd-1");
  assert.equal(third.status, 429, "a visitor's own page budget");
  for (let i = 2; i <= 6; i++) await w.connectPage(undefined, `crowd-${i}`);
  const asked = await w.post("/donations/invoice", { sats: 1000 }, { visitor: "donor" });
  assert.equal(asked.status, 503, "closed for want of a relay, not busy");
});

test("a visitor can hold only so many pages open at once, an IPv6 one by its /48", async () => {
  const w = await world({ SOCKETS_PER_IP: "2", RATE_PER_IP: "20" });
  assert.notEqual(visitorGroup("198.51.100.7"), visitorGroup("198.51.100.8"));
  const first = await w.connectPage(undefined, "198.51.100.7");
  await w.connectPage(undefined, "198.51.100.7");
  assert.equal((await w.socket(undefined, "198.51.100.7")).status, 429);
  await w.connectPage(undefined, "198.51.100.8");
  first.close(1001, "going away");
  await w.connectPage(undefined, "198.51.100.7");
  await w.connectPage(undefined, "2001:db8:1:1::1");
  await w.connectPage(undefined, "2001:db8:1:2::1");
  assert.equal((await w.socket(undefined, "2001:db8:1:3::1")).status, 429, "another /64 in the same /48");
});

test("pages stop short of the platform's socket limit, leaving room for the relay", async () => {
  const w = await world();
  const real = w.ctx.getWebSockets;
  w.ctx.getWebSockets = (tag) => (tag === "page" ? { length: PAGE_SOCKETS_MAX } : real(tag));
  const refused = await w.socket(undefined, "late");
  assert.equal(refused.status, 429);
  w.ctx.getWebSockets = real;
  await w.connectRelay();
});

test("notes are rate limited too", async () => {
  const w = await world({ RATE_PER_IP: "2" });
  const note = () => w.post("/donations/note", { request: "e".repeat(32), message: "x" }, { visitor: "noter" });
  assert.equal((await note()).status, 404);
  assert.equal((await note()).status, 404);
  assert.equal((await note()).status, 429);
});

test("donations close even when the closing line still reads as open", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.object.webSocketClose(relay, 1006, "", false);
  assert.deepEqual(page.messages().at(-1), { type: "status", open: false, network: "regtest" });
});

test("a chunked body is cut off at the cap without being read whole", async () => {
  const w = await world();
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 100) return controller.close();
      controller.enqueue(new TextEncoder().encode("x".repeat(512)));
    },
  });
  const request = new Request("https://bananapayserver/donations/invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  });
  const response = await w.page.invoice(request, null, "visitor-a");
  assert.equal(response.status, 413);
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test("IPv6 visitors count by their /64", () => {
  assert.equal(visitorKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(visitorKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(visitorKey("2001:DB8:0001:0002::ffff"), "2001:db8:1:2::/64");
  assert.equal(visitorKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(visitorKey("::1"), "0:0:0:0::/64");
  assert.equal(visitorKey("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(visitorKey("192.0.2.1"), "192.0.2.1");
  assert.equal(visitorKey(""), "");
  assert.equal(visitorKey("2001:db8:1:2::1", 48), "2001:db8:1::/48", "pages' sockets count by the /48");
  for (const bad of ["1:2:3:4:5:6:7:8:9::1", "1::2::3", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(visitorKey(bad), bad, "something that isn't an address counts as itself");
  }
});

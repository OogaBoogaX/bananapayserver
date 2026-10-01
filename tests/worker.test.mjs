// The Worker and its object together, through the fakes in helpers/cloudflare.mjs: a page asks
// for an invoice, the relay answers on its line, a payment lands on every page.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handle } from "../worker/front.mjs";
import { PAGE_SOCKETS_MAX, REPLAY_MAX, visitorKey } from "../worker/object.mjs";
import { fakeWorld, until } from "./helpers/cloudflare.mjs";
import { ADDRESS, BOLT11, INVOICE, bolt11For } from "./helpers/values.mjs";

const ORIGIN = "https://oogabooga.land";
const TOKEN = `relay-token-${"x".repeat(30)}`;
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const EXPIRES = Math.floor(Date.UTC(2026, 9, 1, 12, 15) / 1000);

const post = (path, body, { origin = ORIGIN, visitor = "visitor-a", type = "application/json" } = {}) =>
  new Request(`https://api.example.org${path}`, {
    method: "POST",
    headers: { "Content-Type": type, "CF-Connecting-IP": visitor, ...(origin ? { Origin: origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const upgrade = (path, headers = {}) =>
  new Request(`https://api.example.org${path}`, { headers: { Upgrade: "websocket", ...headers } });

async function world(overrides = {}) {
  const w = fakeWorld({ RELAY_TOKEN_SHA256: TOKEN_SHA256, ...overrides });
  w.send = (request) => handle(request, w.env);
  w.connectRelay = async () => {
    const response = await w.send(upgrade("/relay", { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(response.status, 101);
    return w.ctx.getWebSockets("relay").at(-1);
  };
  w.connectPage = async (after, visitor = "visitor-p") => {
    const query = after ? `?after=${after}` : "";
    const response = await w.send(upgrade(`/donations/socket${query}`, { Origin: ORIGIN, "CF-Connecting-IP": visitor }));
    assert.equal(response.status, 101);
    return w.ctx.getWebSockets("page").at(-1);
  };
  w.relaySays = (relay, message) => w.object.webSocketMessage(relay, JSON.stringify(message));
  // Asks for an invoice and answers it on the relay's behalf.
  w.invoice = async (relay, body, answer = (request) => ({ id: INVOICE, bolt11: BOLT11, expires: EXPIRES })) => {
    const before = relay.sent.length;
    const pending = w.send(post("/donations/invoice", body));
    await until(() => relay.sent.length > before);
    const asked = JSON.parse(relay.sent.at(-1));
    const invoice = answer(asked.request);
    await w.relaySays(relay, invoice.error ? { type: "invoice", request: asked.request, error: invoice.error } : { type: "invoice", request: asked.request, invoice });
    return { asked, response: await pending };
  };
  return w;
}

test("an invoice goes from the page to the relay and back", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked, response } = await w.invoice(relay, { sats: 1000, handle: "<b>Ooga</b>", message: "for the cave" });
  assert.deepEqual(Object.keys(asked).sort(), ["request", "sats", "type"]);
  assert.equal(asked.sats, 1000);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.deepEqual(await response.json(), { request: asked.request, invoice: { id: INVOICE, bolt11: BOLT11, expires: EXPIRES } });
});

test("the handle and message never reach the relay", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000, handle: "secret-handle", message: "secret message" });
  assert.ok(relay.sent.every((text) => !text.includes("secret")));
});

test("a payment is recorded once, acknowledged, and pushed to every page", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const pages = [await w.connectPage(), await w.connectPage()];
  await w.invoice(relay, { sats: 1000, handle: "<b>Ooga</b>", message: "for the cave" });
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "recorded" });
  const donation = { id: INVOICE, sats: 1000, handle: "bOogab", message: "for the cave", at: w.platform.now() };
  for (const page of pages) assert.deepEqual(page.messages().at(-1), { type: "donation", donation });
  assert.deepEqual(w.env.DB.db.prepare("SELECT id, sats, handle, message, at FROM donations").all().map((row) => ({ ...row })), [donation]);

  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "duplicate" });
  assert.equal(pages[0].messages().filter((m) => m.type === "donation").length, 1);
});

test("the handle and message can follow the amount", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const noted = await w.send(post("/donations/note", { request: asked.request, handle: "Late Ooga", message: "<i>hi</i>" }));
  assert.equal(noted.status, 204);
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 });
  const { donation } = page.messages().at(-1);
  assert.equal(donation.handle, "Late Ooga");
  assert.equal(donation.message, "ihii");
  const unknown = await w.send(post("/donations/note", { request: "f".repeat(32), handle: "x" }));
  assert.equal(unknown.status, 404);
});

test("donations are closed when no relay is connected", async () => {
  const w = await world();
  const response = await w.send(post("/donations/invoice", { sats: 1000 }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "closed" });
});

test("a relay that doesn't answer in time closes donations, and the request is forgotten", async () => {
  const w = await world({ INVOICE_TIMEOUT_MS: "20" });
  await w.connectRelay();
  const response = await w.send(post("/donations/invoice", { sats: 1000 }));
  assert.equal(response.status, 503);
  assert.equal(w.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pending").one().n, 0);
});

test("when the line drops, waiting pages hear at once and every page sees donations close", async () => {
  const w = await world({ INVOICE_TIMEOUT_MS: "60000" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(page.messages()[0], { type: "status", open: true });
  const pending = w.send(post("/donations/invoice", { sats: 1000 }));
  await until(() => relay.sent.length === 1);
  relay.close(1006, "");
  await w.object.webSocketClose(relay, 1006, "", false);
  assert.equal((await pending).status, 503);
  assert.deepEqual(page.messages().at(-1), { type: "status", open: false });
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
    const response = await w.send(post("/donations/invoice", { sats: 50 }));
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
    [{ sats: 1000, handle: 7 }, 400, "invalid"],
    [{}, 400, "invalid"],
    ["[1000]", 400, "invalid"],
    ["{not json", 400, "invalid"],
    [`{"sats": 1000, "message": "${"x".repeat(2000)}"}`, 413, "too large"],
  ];
  for (const [body, status, error] of cases) {
    const response = await w.send(post("/donations/invoice", body));
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 40));
    assert.deepEqual(await response.json(), { error });
  }
  const wrongType = await w.send(post("/donations/invoice", { sats: 1000 }, { type: "text/plain" }));
  assert.equal(wrongType.status, 415);
});

test("only the allowed origins get an answer a browser will read", async () => {
  const w = await world();
  const foreign = await w.send(post("/donations/invoice", { sats: 1000 }, { origin: "https://elsewhere.example" }));
  assert.equal(foreign.status, 403);
  const preflight = await w.send(new Request("https://api.example.org/donations/invoice", { method: "OPTIONS", headers: { Origin: ORIGIN } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const foreignSocket = await w.send(upgrade("/donations/socket", { Origin: "https://elsewhere.example" }));
  assert.equal(foreignSocket.status, 403);
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
  assert.deepEqual(page.messages(), [{ type: "status", open: true }], "the old line closing doesn't close donations");
});

test("rate limits apply per visitor and overall, per minute", async () => {
  const w = await world({ RATE_PER_IP: "2", RATE_GLOBAL: "3" });
  const ask = (visitor) => w.send(post("/donations/invoice", { sats: 1000 }, { visitor }));
  assert.equal((await ask("a")).status, 503);
  assert.equal((await ask("a")).status, 503);
  assert.equal((await ask("a")).status, 429, "third from one visitor");
  assert.equal((await ask("b")).status, 503);
  assert.equal((await ask("c")).status, 429, "fourth overall");
  w.platform.advance(60_000);
  assert.equal((await ask("a")).status, 503, "a new minute");
});

test("the object checks every notice the relay sends", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.relaySays(relay, { type: "paid", invoice: "NeverAsked1", sats: 1000 });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: "NeverAsked1", result: "unknown" });
  await w.invoice(relay, { sats: 1000 });
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 999_999 });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "rejected" });
  const sent = relay.sent.length;
  await w.object.webSocketMessage(relay, "not the protocol");
  await w.object.webSocketMessage(relay, JSON.stringify({ type: "paid", invoice: INVOICE, sats: 1000, extra: 1 }));
  assert.equal(relay.sent.length, sent, "dropped without a reply");
  await w.object.webSocketMessage(page, JSON.stringify({ type: "paid", invoice: INVOICE, sats: 1000 }));
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
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 });
  assert.equal(relay.sent.length, sent);
  w.env.DB.prepare = prepare;
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 });
  assert.equal(JSON.parse(relay.sent.at(-1)).result, "recorded");
});

test("a page that reconnects gets what it missed, and no more than the cap", async () => {
  const w = await world();
  const insert = w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at) VALUES (?, ?, '', '', ?)");
  for (let i = 1; i <= REPLAY_MAX + 5; i++) insert.run(`Donation${String(i).padStart(4, "0")}`, i, i);
  const page = await w.connectPage("Donation0002");
  const replayed = page.messages().filter((m) => m.type === "donation").map((m) => m.donation.id);
  assert.equal(replayed.length, REPLAY_MAX);
  assert.equal(replayed[0], "Donation0003");
  const fresh = await w.connectPage("UnknownId1");
  assert.deepEqual(fresh.messages(), [{ type: "status", open: false }]);
  const invalid = await w.send(upgrade("/donations/socket?after=../x", { Origin: ORIGIN }));
  assert.equal(invalid.status, 400);
});

test("a donor who switches gets an on-chain address for the same invoice", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  const pending = w.send(post("/donations/onchain", { request: asked.request }));
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
  const pending = w.send(post("/donations/onchain", { request: asked.request }));
  await until(() => JSON.parse(relay.sent.at(-1)).type === "onchain");
  await w.relaySays(relay, { type: "onchain", request: asked.request, address: "bc1qexampleexampleexample", sats: 1000 });
  assert.equal((await pending).status, 503, "a mainnet address on regtest");
  assert.equal((await w.send(post("/donations/onchain", { request: "e".repeat(32) }))).status, 404);
  w.platform.advance(16 * 60_000);
  assert.equal((await w.send(post("/donations/onchain", { request: asked.request }))).status, 410);
});

test("pending requests are forgotten after the retention period", async () => {
  const w = await world({ PENDING_DAYS: "7" });
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000 });
  w.platform.advance(8 * 86_400_000);
  await w.invoice(relay, { sats: 1000 }, () => ({ id: "Inv0ice5678", bolt11: BOLT11, expires: EXPIRES }));
  assert.equal((await w.send(post("/donations/note", { request: asked.request, handle: "x" }))).status, 404);
});

test("notices that arrive together record and push the donation once", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 1000 });
  const sent = relay.sent.length;
  await Promise.all([
    w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 }),
    w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000 }),
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
  const first = w.send(post("/donations/onchain", { request: asked.request }));
  const second = w.send(post("/donations/onchain", { request: asked.request }));
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
  const third = await w.send(upgrade("/donations/socket", { Origin: ORIGIN, "CF-Connecting-IP": "crowd-1" }));
  assert.equal(third.status, 429, "a visitor's own page budget");
  for (let i = 2; i <= 6; i++) await w.connectPage(undefined, `crowd-${i}`);
  const asked = await w.send(post("/donations/invoice", { sats: 1000 }, { visitor: "donor" }));
  assert.equal(asked.status, 503, "closed for want of a relay, not busy");
});

test("pages stop short of the platform's socket limit, leaving room for the relay", async () => {
  const w = await world();
  const real = w.ctx.getWebSockets;
  w.ctx.getWebSockets = (tag) => (tag === "page" ? { length: PAGE_SOCKETS_MAX } : real(tag));
  const refused = await w.send(upgrade("/donations/socket", { Origin: ORIGIN, "CF-Connecting-IP": "late" }));
  assert.equal(refused.status, 429);
  w.ctx.getWebSockets = real;
  await w.connectRelay();
});

test("notes are rate limited too", async () => {
  const w = await world({ RATE_PER_IP: "2" });
  const note = () => w.send(post("/donations/note", { request: "e".repeat(32), handle: "x" }, { visitor: "noter" }));
  assert.equal((await note()).status, 404);
  assert.equal((await note()).status, 404);
  assert.equal((await note()).status, 429);
});

test("donations close even when the closing line still reads as open", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.object.webSocketClose(relay, 1006, "", false);
  assert.deepEqual(page.messages().at(-1), { type: "status", open: false });
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
  const request = new Request("https://api.example.org/donations/invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body,
    duplex: "half",
  });
  const response = await w.send(request);
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
});

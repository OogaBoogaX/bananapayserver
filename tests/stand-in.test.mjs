// The stand-in for OBL's Worker in tools/stand-in, in front of this Worker and its object behind
// the fakes: it passes each of the page's calls on with the arguments OBL's Worker passes.

import assert from "node:assert/strict";
import test from "node:test";
import standIn from "../tools/stand-in/index.mjs";
import { until } from "./helpers/cloudflare.mjs";
import { bolt11For } from "./helpers/values.mjs";
import { EXPIRES, world } from "./helpers/world.mjs";

const DONOR = { "X-Test-Donor-Id": "4242", "X-Test-Donor-Login": "ooga-dev" };

// A call from the stand-in's own page, on this machine unless told otherwise.
const page = (env, path, body, { headers = {}, method = "POST", host = "localhost:8788" } = {}) => standIn.fetch(
  new Request(`http://${host}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  }),
  env,
);

// Asks for something through the stand-in and answers on the relay's behalf.
async function buy(w, env, relay, body, options) {
  const before = relay.sent.length;
  const pending = page(env, "/purchases/buy", body, options);
  await until(() => relay.sent.length > before);
  const asked = JSON.parse(relay.sent.at(-1));
  const invoice = { id: `StandIn${relay.sent.length}0`, bolt11: bolt11For(asked.sats), expires: EXPIRES };
  await w.relaySays(relay, { type: "invoice", request: asked.request, invoice });
  return { asked, invoice, response: await pending };
}

test("the stand-in passes purchases on with its test donor, under their own prefix", async () => {
  const w = await world();
  const env = { DONATIONS: w.page };
  const relay = await w.connectRelay();
  const { asked, invoice, response } = await buy(w, env, relay, { category: "firework", item: "mega" }, { headers: DONOR });
  assert.equal(response.status, 200);
  assert.equal(asked.sats, 100);
  assert.deepEqual({ ...w.ctx.storage.sql.exec("SELECT github_id, github_login FROM pending").one() }, { github_id: 4242, github_login: "ooga-dev" });
  await w.relaySays(relay, { type: "paid", invoice: invoice.id, sats: 100, method: "lightning" });
  await w.ctx.settle();
  const mine = await page(env, "/purchases/mine", {}, { headers: DONOR });
  assert.deepEqual(await mine.json(), { items: { firework: { mega: { quantity: 1, sats: 100 } } } });

  const chosen = await buy(w, env, relay, { category: "firework", item: "show", slot: 3 }, { headers: DONOR });
  assert.equal(chosen.response.status, 200);
  assert.equal(w.ctx.storage.sql.exec("SELECT options FROM pending").one().options, '{"slot":3}', "a chosen slot goes through as the page sent it");

  const nobody = await page(env, "/purchases/buy", { category: "firework", item: "pop" });
  assert.equal(nobody.status, 403, "no donor named is nobody signed in");
  const elsewhere = await page(env, "/purchases/buy", { category: "firework", item: "pop" }, { headers: DONOR, host: "stand-in.example" });
  assert.equal(elsewhere.status, 403, "a donor named anywhere but this machine counts for nothing");
  assert.deepEqual(await (await page(env, "/purchases/mine", {})).json(), { items: {} });

  for (const [path, options] of [["/donations/purchase", {}], ["/donations/purchases", {}], ["/purchases/buy", { method: "GET" }], ["/purchases/other", {}]]) {
    assert.equal((await page(env, path, { category: "firework", item: "pop" }, { headers: DONOR, ...options })).status, 404, `${options.method ?? "POST"} ${path}`);
  }
  const crossSite = await page(env, "/purchases/buy", { category: "firework", item: "pop" }, { headers: { ...DONOR, "Sec-Fetch-Site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.equal(relay.sent.filter((text) => JSON.parse(text).type === "invoice").length, 2, "only the two purchases reached the relay");
});

test("the stand-in still passes donations on as before", async () => {
  const w = await world();
  const env = { DONATIONS: w.page };
  const relay = await w.connectRelay();
  const before = relay.sent.length;
  const pending = page(env, "/donations/invoice", { sats: 1000, message: "via the stand-in" }, { headers: DONOR });
  await until(() => relay.sent.length > before);
  const asked = JSON.parse(relay.sent.at(-1));
  await w.relaySays(relay, { type: "invoice", request: asked.request, invoice: { id: "StandInGift1", bolt11: bolt11For(1000), expires: EXPIRES } });
  const response = await pending;
  assert.equal(response.status, 200);
  const { request } = await response.json();
  assert.equal(w.ctx.storage.sql.exec("SELECT github_login FROM pending").one().github_login, "ooga-dev");
  assert.equal((await page(env, "/donations/note", { request, message: "changed" })).status, 204);
  assert.equal((await page(env, "/donations/invoice", { sats: 1000, extra: true })).status, 400, "the body reaches this Worker whole, to be checked there");
});

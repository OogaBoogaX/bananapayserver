// A Worker and its object behind the fakes, with a relay line and pages to drive them. Shared by
// the Worker's tests and the stats tests.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handle, pageApi } from "../../worker/front.mjs";
import { fakeWorld, until } from "./cloudflare.mjs";
import { BOLT11, INVOICE } from "./values.mjs";

export const TOKEN = `relay-token-${"x".repeat(30)}`;
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
export const EXPIRES = Math.floor(Date.UTC(2026, 9, 1, 12, 15) / 1000);

// A donor signed in with GitHub, as OBL's Worker passes them on.
export const donor = (login = "ooga-dev", id = 4242) => ({ id, login });

// The request OBL's Worker builds for a call: the page's body and its type, nothing else.
export const call = (path, body, { type = "application/json" } = {}) =>
  new Request(`https://bananapayserver${path}`, {
    method: "POST",
    headers: { "Content-Type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export const upgrade = (path, headers = {}) =>
  new Request(`https://bananapayserver${path}`, { headers: { Upgrade: "websocket", ...headers } });

export async function world(overrides = {}, platformOptions = {}) {
  const w = fakeWorld({ RELAY_TOKEN_SHA256: TOKEN_SHA256, ...overrides }, platformOptions);
  // The public address, and the entrypoint OBL's Worker calls.
  w.send = (request) => handle(request, w.env);
  w.page = pageApi(w.env);
  // A page's call through OBL's Worker, from a visitor, signed in as `donor` or not.
  w.post = (path, body, { visitor = "visitor-a", donor: who = null, type } = {}) => {
    const request = call(path, body, { type });
    if (path === "/donations/invoice") return w.page.invoice(request, who, visitor);
    if (path === "/donations/note") return w.page.note(request, visitor);
    if (path === "/donations/onchain") return w.page.onchain(request, visitor);
    throw new Error(`no call for ${path}`);
  };
  w.socket = (after, visitor = "visitor-p") =>
    w.page.fetch(upgrade(`/donations/socket${after ? `?after=${after}` : ""}`, { "X-Client": visitor }));
  w.connectRelay = async () => {
    const response = await w.send(upgrade("/relay", { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(response.status, 101);
    return w.ctx.getWebSockets("relay").at(-1);
  };
  w.connectPage = async (after, visitor = "visitor-p") => {
    const response = await w.socket(after, visitor);
    assert.equal(response.status, 101);
    return w.ctx.getWebSockets("page").at(-1);
  };
  w.relaySays = (relay, message) => w.object.webSocketMessage(relay, JSON.stringify(message));
  // The runtime clears a due alarm, then runs the object's alarm(). Work the object left in the
  // background finishes before this returns.
  w.fireAlarm = async () => {
    await w.ctx.storage.deleteAlarm();
    await w.object.alarm();
    await w.ctx.settle();
  };
  // Asks for an invoice and answers it on the relay's behalf.
  w.invoice = async (relay, body, answer = (request) => ({ id: INVOICE, bolt11: BOLT11, expires: EXPIRES }), options = {}) => {
    const before = relay.sent.length;
    const pending = w.post("/donations/invoice", body, options);
    await until(() => relay.sent.length > before);
    const asked = JSON.parse(relay.sent.at(-1));
    const invoice = answer(asked.request);
    await w.relaySays(relay, invoice.error ? { type: "invoice", request: asked.request, error: invoice.error } : { type: "invoice", request: asked.request, invoice });
    return { asked, response: await pending };
  };
  return w;
}

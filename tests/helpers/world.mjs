// A Worker and its object behind the fakes, with a relay line and pages to drive them. Shared by
// the Worker's tests and the stats tests.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { seal } from "../../worker/auth.mjs";
import { handle } from "../../worker/front.mjs";
import { fakeWorld, until } from "./cloudflare.mjs";
import { BOLT11, INVOICE } from "./values.mjs";

export const ORIGIN = "https://oogabooga.land";
export const TOKEN = `relay-token-${"x".repeat(30)}`;
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
export const EXPIRES = Math.floor(Date.UTC(2026, 9, 1, 12, 15) / 1000);

export const SIGN_IN = { GITHUB_CLIENT_ID: "synthetic-client-id", GITHUB_CLIENT_SECRET: "synthetic-client-secret", SESSION_KEY: "k".repeat(40) };

export const post = (path, body, { origin = ORIGIN, visitor = "visitor-a", type = "application/json", cookie } = {}) =>
  new Request(`https://api.example.org${path}`, {
    method: "POST",
    headers: {
      "Content-Type": type,
      "CF-Connecting-IP": visitor,
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// The cookie a donor who signed in with GitHub carries.
export const sessionCookie = async (w, login = "ooga-dev", id = 4242) =>
  `__Host-bps_session=${await seal(w.env.SESSION_KEY, { typ: "session", id, login, exp: w.platform.now() + 86_400_000 })}`;

export const upgrade = (path, headers = {}) =>
  new Request(`https://api.example.org${path}`, { headers: { Upgrade: "websocket", ...headers } });

export async function world(overrides = {}, platformOptions = {}) {
  const w = fakeWorld({ RELAY_TOKEN_SHA256: TOKEN_SHA256, ...SIGN_IN, ...overrides }, platformOptions);
  w.send = (request) => handle(request, w.env, w.platform);
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
  w.invoice = async (relay, body, answer = (request) => ({ id: INVOICE, bolt11: BOLT11, expires: EXPIRES }), options = {}) => {
    const before = relay.sent.length;
    const pending = w.send(post("/donations/invoice", body, options));
    await until(() => relay.sent.length > before);
    const asked = JSON.parse(relay.sent.at(-1));
    const invoice = answer(asked.request);
    await w.relaySays(relay, invoice.error ? { type: "invoice", request: asked.request, error: invoice.error } : { type: "invoice", request: asked.request, invoice });
    return { asked, response: await pending };
  };
  return w;
}

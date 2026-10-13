// The Worker: the front door. It checks every browser request and the relay's credential, and
// passes what survives to the Durable Object. It never calls the relay; the relay dials in.

import { HANDLE_MAX, MESSAGE_MAX, sanitize } from "../shared/donation.mjs";
import { readLimits, readSettings } from "./config.mjs";

const MAX_BODY = 1024;
const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const REQUEST = /^[0-9a-f]{32}$/;

export async function handle(request, env) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  const settings = readSettings(env);

  if (route === "GET /relay") return relay(request, env);

  const cors = corsHeaders(request, settings.origins);
  if (!cors) return reply({ error: "origin" }, 403);
  if (request.method === "OPTIONS") return preflight(cors);

  switch (route) {
    case "POST /donations/invoice":
      return invoice(request, env, settings, cors);
    case "POST /donations/note":
      return note(request, env, cors);
    case "POST /donations/onchain":
      return onchain(request, env, cors);
    case "GET /donations/socket":
      return socket(request, env, url);
  }
  return reply({ error: "not found" }, 404, cors);
}

async function invoice(request, env, settings, cors) {
  const body = await readBody(request, ["sats", "handle", "message"], ["sats"]);
  if (body.error) return reply({ error: body.error }, body.status, cors);
  const limits = readLimits(env);
  if (!limits || !settings.network) return reply({ error: "closed" }, 503, cors);
  const { sats } = body.value;
  if (!Number.isSafeInteger(sats)) return reply({ error: "invalid" }, 400, cors);
  if (sats < limits.minSats || sats > limits.maxSats) return reply({ error: "amount" }, 400, cors);
  const text = cleanText(body.value);
  if (!text) return reply({ error: "invalid" }, 400, cors);
  return toObject(env, "/invoice", { sats, ...text, client: clientOf(request) }, cors);
}

async function note(request, env, cors) {
  const body = await readBody(request, ["request", "handle", "message"], ["request"]);
  if (body.error) return reply({ error: body.error }, body.status, cors);
  const text = cleanText(body.value);
  if (!REQUEST.test(String(body.value.request)) || !text) return reply({ error: "invalid" }, 400, cors);
  return toObject(env, "/note", { request: body.value.request, ...text, client: clientOf(request) }, cors);
}

async function onchain(request, env, cors) {
  const body = await readBody(request, ["request"], ["request"]);
  if (body.error) return reply({ error: body.error }, body.status, cors);
  if (!REQUEST.test(String(body.value.request))) return reply({ error: "invalid" }, 400, cors);
  return toObject(env, "/onchain", { request: body.value.request, client: clientOf(request) }, cors);
}

function socket(request, env, url) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "upgrade" }, 426);
  const after = url.searchParams.get("after");
  if (after !== null && !INVOICE_ID.test(after)) return reply({ error: "invalid" }, 400);
  const target = new URL("https://object/page");
  if (after) target.searchParams.set("after", after);
  return stub(env).fetch(target, { headers: forwarded(request) });
}

async function relay(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "upgrade" }, 426);
  if (!(await relayAuthorized(request, env))) return reply({ error: "unauthorized" }, 401);
  return stub(env).fetch("https://object/relay", { headers: forwarded(request) });
}

// The relay presents a random token; the Worker holds only its SHA-256, as a secret.
export async function relayAuthorized(request, env) {
  const expected = String(env.RELAY_TOKEN_SHA256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
  const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}

// The handle and message, cleaned with OBL's rules, or null when either isn't text.
function cleanText({ handle = "", message = "" }) {
  if (typeof handle !== "string" || typeof message !== "string") return null;
  return { handle: sanitize(handle, HANDLE_MAX), message: sanitize(message, MESSAGE_MAX) };
}

async function readBody(request, allowed, required) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) {
    return { error: "invalid", status: 415 };
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return { error: "too large", status: 413 };
  const bytes = await readCapped(request, MAX_BODY);
  if (!bytes) return { error: "too large", status: 413 };
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { error: "invalid", status: 400 };
  }
  const valid = value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
  return valid ? { value } : { error: "invalid", status: 400 };
}

// Reads the body a chunk at a time and stops past the cap, since a chunked request has no
// Content-Length to check first. Null when the body is too large.
async function readCapped(request, max) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The visitor's address goes to the object for rate limiting only. It's never stored.
const clientOf = (request) => request.headers.get("CF-Connecting-IP") ?? "";

function forwarded(request) {
  const headers = new Headers();
  for (const name of ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("X-Client", clientOf(request));
  return headers;
}

async function toObject(env, path, body, cors) {
  const response = await stub(env).fetch(`https://object${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(response.body, { status: response.status, headers: { ...JSON_HEADERS, ...cors } });
}

const stub = (env) => env.DONATIONS.get(env.DONATIONS.idFromName("donations"));

function corsHeaders(request, origins) {
  const origin = request.headers.get("Origin");
  if (origin === null) return {};
  return origins.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : null;
}

const preflight = (cors) => new Response(null, {
  status: 204,
  headers: {
    ...cors,
    "Access-Control-Allow-Methods": "POST, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  },
});

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const reply = (body, status, cors = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...cors } });

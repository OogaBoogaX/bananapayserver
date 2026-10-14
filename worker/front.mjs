// The Worker: the front door. Its public address takes only the relay's line, and checks the
// relay's credential. Pages reach it through OBL's Worker, over a service binding to the PageApi
// entrypoint, which the internet can't reach: OBL's Worker signs the donor in and passes who
// they are and where the call came from beside the page's own request. This checks each call and
// passes what survives to the Durable Object. It never calls the relay; the relay dials in.

import { MESSAGE_MAX, sanitize } from "../shared/donation.mjs";
import { readLimits, readSettings } from "./config.mjs";
import { relayAuthorized } from "./relay-token.mjs";

const MAX_BODY = 1024;
const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const REQUEST = /^[0-9a-f]{32}$/;
const VISITOR_MAX = 64;

// A GitHub username: letters, digits and hyphens, at most 39 characters. GitHub's rule today
// also forbids a hyphen at the end or two in a row, but older accounts still have them.
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

// The public address: the relay's line and nothing else.
export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/relay") return relay(request, env);
  return reply({ error: "not found" }, 404);
}

// The calls OBL's Worker passes on, as the PageApi entrypoint in index.mjs exposes them. Each
// takes a request carrying only the page's JSON body and its type, never the browser's own
// request. `donor` is the signed-in donor's GitHub `{ id, login }`, or null, and `visitor` is
// the address the call came from, for rate limits. See docs/protocol.md.
export const pageApi = (env) => ({
  invoice: (request, donor, visitor) => invoice(request, env, donor, visitorOf(visitor)),
  note: (request, visitor) => note(request, env, visitorOf(visitor)),
  onchain: (request, visitor) => onchain(request, env, visitorOf(visitor)),
  // The socket's upgrade, with the visitor's address in X-Client.
  fetch: (request) => socket(request, env),
});

// Who gave it comes from OBL's sign-in, never from the request body. A signed-in donor can
// still give anonymously.
async function invoice(request, env, donor, visitor) {
  if (!isDonor(donor) || !visitor) return reply({ error: "invalid" }, 400);
  const body = await readBody(request, ["sats", "message", "anon"], ["sats"]);
  if (body.error) return reply({ error: body.error }, body.status);
  const limits = readLimits(env);
  if (!limits || !readSettings(env).network) return reply({ error: "closed" }, 503);
  const { sats, anon = false } = body.value;
  if (!Number.isSafeInteger(sats) || typeof anon !== "boolean") return reply({ error: "invalid" }, 400);
  if (sats < limits.minSats || sats > limits.maxSats) return reply({ error: "amount" }, 400);
  const message = cleanMessage(body.value);
  if (message === null) return reply({ error: "invalid" }, 400);
  const github = anon || donor === null ? null : { id: donor.id, login: donor.login };
  return toObject(env, "/invoice", { sats, message, github, client: visitor });
}

async function note(request, env, visitor) {
  if (!visitor) return reply({ error: "invalid" }, 400);
  const body = await readBody(request, ["request", "message"], ["request"]);
  if (body.error) return reply({ error: body.error }, body.status);
  const message = cleanMessage(body.value);
  if (!isRequest(body.value.request) || message === null) return reply({ error: "invalid" }, 400);
  return toObject(env, "/note", { request: body.value.request, message, client: visitor });
}

async function onchain(request, env, visitor) {
  if (!visitor) return reply({ error: "invalid" }, 400);
  const body = await readBody(request, ["request"], ["request"]);
  if (body.error) return reply({ error: body.error }, body.status);
  if (!isRequest(body.value.request)) return reply({ error: "invalid" }, 400);
  return toObject(env, "/onchain", { request: body.value.request, client: visitor });
}

function socket(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/donations/socket") return reply({ error: "not found" }, 404);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "upgrade" }, 426);
  const after = url.searchParams.get("after");
  const visitor = visitorOf(request.headers.get("X-Client"));
  if ((after !== null && !INVOICE_ID.test(after)) || !visitor) return reply({ error: "invalid" }, 400);
  const target = new URL("https://object/page");
  if (after) target.searchParams.set("after", after);
  return stub(env).fetch(target, { headers: forwarded(request, visitor) });
}

async function relay(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "upgrade" }, 426);
  if (!(await relayAuthorized(request, env))) return reply({ error: "unauthorized" }, 401);
  // The object checks the token again, so it goes along.
  const headers = forwarded(request, "");
  headers.set("Authorization", request.headers.get("Authorization"));
  return stub(env).fetch("https://object/relay", { headers });
}

// Nobody, or a GitHub account exactly as OBL's sign-in knows it: the numeric id, which survives
// a rename, and the username.
const isDonor = (donor) =>
  donor === null ||
  (donor !== undefined && typeof donor === "object" && !Array.isArray(donor) &&
    Object.keys(donor).length === 2 &&
    Number.isSafeInteger(donor.id) && donor.id > 0 &&
    typeof donor.login === "string" && LOGIN.test(donor.login));

// The visitor's address goes to the object for rate limiting only. It's never stored. A call
// without one is refused, rather than counted with every other such call.
// A request id, as the invoice reply gave it: a string, never anything that only prints as one.
const isRequest = (value) => typeof value === "string" && REQUEST.test(value);

const visitorOf = (visitor) => (typeof visitor === "string" && visitor.length > 0 ? visitor.slice(0, VISITOR_MAX) : null);

// The message, cleaned with OBL's rules, or null when it isn't text.
const cleanMessage = ({ message = "" }) => (typeof message === "string" ? sanitize(message, MESSAGE_MAX) : null);

async function readBody(request, allowed, required) {
  if (!(request instanceof Request)) return { error: "invalid", status: 400 };
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

function forwarded(request, visitor) {
  const headers = new Headers();
  for (const name of ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("X-Client", visitor);
  return headers;
}

async function toObject(env, path, body) {
  const response = await stub(env).fetch(`https://object${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(response.body, { status: response.status, headers: JSON_HEADERS });
}

const stub = (env) => env.DONATIONS.get(env.DONATIONS.idFromName("donations"));

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const reply = (body, status) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

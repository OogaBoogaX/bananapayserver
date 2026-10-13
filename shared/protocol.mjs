// The messages on the relay's line, in both directions. Each end checks what it receives with
// these functions and drops anything that doesn't match exactly: the object checks the
// relay's messages, and the relay checks the object's. See docs/protocol.md.

export const MAX_MESSAGE = 8192;

const REQUEST = /^[0-9a-f]{32}$/;
const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const BOLT11 = /^ln[a-z0-9]{1,90}1[02-9ac-hj-np-z]{100,6000}$/;
const ADDRESS = /^[A-Za-z0-9]{14,90}$/;
const MAX_SATS = 2_100_000_000_000_000;

const isRequest = (v) => typeof v === "string" && REQUEST.test(v);
const isInvoiceId = (v) => typeof v === "string" && INVOICE_ID.test(v);
const isSats = (v) => Number.isSafeInteger(v) && v > 0 && v <= MAX_SATS;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const isOneOf = (values) => (v) => values.includes(v);

const isInvoice = (v) =>
  hasKeys(v, ["id", "bolt11", "expires"]) &&
  isInvoiceId(v.id) &&
  typeof v.bolt11 === "string" && BOLT11.test(v.bolt11) &&
  isTime(v.expires);

// Down: from the Durable Object to the relay.
const DOWN = {
  invoice: { request: isRequest, sats: isSats },
  onchain: { request: isRequest, invoice: isInvoiceId },
  ack: { invoice: isInvoiceId, result: isOneOf(["recorded", "duplicate", "unknown", "rejected"]) },
};

// Up: from the relay to the Durable Object. A reply carries either its result or an error.
const UP = [
  ["invoice", { request: isRequest, invoice: isInvoice }],
  ["invoice", { request: isRequest, error: isOneOf(["cap", "unavailable"]) }],
  ["onchain", { request: isRequest, address: (v) => typeof v === "string" && ADDRESS.test(v), sats: isSats }],
  ["onchain", { request: isRequest, error: isOneOf(["unavailable"]) }],
  ["paid", { invoice: isInvoiceId, sats: isSats, method: isOneOf(["lightning", "onchain", "mixed"]) }],
];

function hasKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function matches(message, type, fields) {
  return message.type === type &&
    hasKeys(message, ["type", ...Object.keys(fields)]) &&
    Object.entries(fields).every(([key, check]) => check(message[key]));
}

function parse(text) {
  if (typeof text !== "string" || text.length > MAX_MESSAGE) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseDown(text) {
  const message = parse(text);
  if (!message || typeof message.type !== "string" || !Object.hasOwn(DOWN, message.type)) return null;
  return matches(message, message.type, DOWN[message.type]) ? message : null;
}

export function parseUp(text) {
  const message = parse(text);
  if (!message) return null;
  return UP.some(([type, fields]) => matches(message, type, fields)) ? message : null;
}

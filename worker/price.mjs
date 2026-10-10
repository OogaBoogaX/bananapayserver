// Bitcoin's price in dollars, which sets what a banana costs: one banana is a dollar's worth of
// bitcoin. The price comes from 2140data's service, which combines the exchanges' prices into
// one: its REST API first, and its socket when the REST API doesn't answer. See decisions 0011
// and 0013 in docs/decisions/.

// A banana's price, in US cents.
export const BANANA_CENTS = 100;

export const PRICE_SOCKET = "wss://2140data.io";
export const PRICE_URL = "https://2140data.io/price";

// How long each way of asking gets before the next one is tried.
export const PRICE_TIMEOUT_MS = 2_000;

const PRICE = /^\d{1,12}(?:\.\d{1,8})?$/;
const MESSAGE_MAX = 8_192;

// Bitcoin's price in cents and which way it came, or null when neither answered.
// platform: { socket(url), fetch(url, init) }.
export async function fetchPrice(platform, { timeoutMs = PRICE_TIMEOUT_MS } = {}) {
  const fromRest = await priceFromRest(platform.fetch, timeoutMs);
  if (fromRest !== null) return { cents: fromRest, from: "rest" };
  const fromSocket = await priceFromSocket(platform.socket, timeoutMs);
  return fromSocket === null ? null : { cents: fromSocket, from: "socket" };
}

// The socket sends the price as soon as it connects, and every second after. The object takes
// the first one and closes the socket at once: an outbound socket left open would keep the
// object from hibernating.
export function priceFromSocket(open, timeoutMs) {
  return new Promise((resolve) => {
    let ws = null;
    let done = false;
    const finish = (cents) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close(1000);
      } catch {
        // Closing a socket that never opened can throw; there is nothing left to close.
      }
      resolve(cents);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      ws = open(PRICE_SOCKET);
    } catch {
      return finish(null);
    }
    ws.addEventListener("message", (event) => {
      const cents = toCents(parse(event.data)?.weightedPrice);
      if (cents !== null) finish(cents);
    });
    ws.addEventListener("close", () => finish(null));
    ws.addEventListener("error", () => finish(null));
  });
}

export async function priceFromRest(fetch, timeoutMs) {
  try {
    const response = await fetch(PRICE_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return toCents(parse(await readText(response, MESSAGE_MAX))?.price);
  } catch {
    return null;
  }
}

// The body as text, or null once it passes max bytes, without reading further.
async function readText(response, max) {
  if (Number(response.headers.get("Content-Length")) > max) return null;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(max);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(bytes.subarray(0, size));
    if (size + value.length > max) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, size);
    size += value.length;
  }
}

function parse(text) {
  if (typeof text !== "string" || text.length > MESSAGE_MAX) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The service writes prices as strings of dollars, such as "84626.08".
function toCents(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!PRICE.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents > 0 ? cents : null;
}

// Thousandths of a banana for an amount in sats, at a price in cents per bitcoin, rounded half
// up. Whole numbers all the way, so the same donation always counts the same.
export function milliBananas(sats, priceCents, bananaCents = BANANA_CENTS) {
  const numerator = BigInt(sats) * BigInt(priceCents);
  const denominator = 100_000n * BigInt(bananaCents);
  return Number((numerator * 2n + denominator) / (2n * denominator));
}

// What the donor is shown: the banana count, exact and rounded.
export const bananasOf = (milli) => (milli === null ? null : { exact: milli / 1000, rounded: Math.round(milli / 1000) });

// The rate behind a count: bitcoin's price, and what one banana costs in sats at that price.
export const rateOf = (priceCents, at, bananaCents = BANANA_CENTS) => ({
  usdPerBtc: priceCents / 100,
  satsPerBanana: Math.round((100_000_000 * bananaCents) / priceCents),
  at,
});

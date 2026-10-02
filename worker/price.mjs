// Bitcoin's price in dollars, which sets what a banana costs: one banana is a dollar's worth of
// bitcoin. Three public sources, the same ones OBL's page reads. A price counts only when at
// least two of them agree, so one wrong source can't move it. See
// docs/decisions/0011-bananas-in-dollars.md.

// A banana's price, in US cents.
export const BANANA_CENTS = 100;

// How far apart, as a share of the price, two sources can be and still agree.
export const AGREEMENT = 0.03;

export const SOURCES = [
  { name: "coinbase", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", read: (d) => d?.data?.amount },
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", read: (d) => d?.result?.XXBTZUSD?.c?.[0] },
  { name: "mempool.space", url: "https://mempool.space/api/v1/prices", read: (d) => d?.USD },
];

// Bitcoin's price in cents, or null when fewer than two sources answered and agreed.
export async function fetchPrice(fetch, { timeoutMs = 3_000 } = {}) {
  const answers = await Promise.all(SOURCES.map(async ({ url, read }) => {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const dollars = Number(read(await response.json()));
      return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
    } catch {
      return null;
    }
  }));
  return agreedPrice(answers.filter((value) => value !== null));
}

// The middle of the answers that sit within AGREEMENT of the middle of all of them, if at
// least two do.
export function agreedPrice(cents) {
  if (cents.length < 2) return null;
  const all = median(cents);
  const agreeing = cents.filter((value) => Math.abs(value - all) <= all * AGREEMENT);
  return agreeing.length >= 2 ? median(agreeing) : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
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

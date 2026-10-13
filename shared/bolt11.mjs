// Reads the two things about a BOLT11 invoice that can be checked without decoding all of it:
// the network it's for and the amount in its human-readable part. The object refuses to show
// a donor an invoice that fails either check.

const NETWORKS = { mainnet: "bc", testnet: "tb", signet: "tbs", regtest: "bcrt" };

// Millisatoshis per unit of each multiplier; a plain number with no multiplier is whole BTC.
const MSAT = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

export const isNetwork = (network) => Object.hasOwn(NETWORKS, network);

// The amount in msat, or null when the invoice is malformed, has no amount, or is for
// another network.
export function invoiceMsat(bolt11, network) {
  if (typeof bolt11 !== "string" || !isNetwork(network)) return null;
  const separator = bolt11.lastIndexOf("1");
  if (separator < 0) return null;
  const hrp = bolt11.slice(0, separator);
  // Longest prefix first: "lntbs" and "lnbcrt" would otherwise read as "lntb" and "lnbc".
  const currency = ["bcrt", "tbs", "bc", "tb"].find((prefix) => hrp.startsWith(`ln${prefix}`));
  if (currency !== NETWORKS[network]) return null;
  const amount = /^(\d+)([munp]?)$/.exec(hrp.slice(2 + currency.length));
  if (!amount || amount[1].startsWith("0")) return null;
  const value = BigInt(amount[1]);
  if (amount[2] === "p") return value % 10n === 0n ? value / 10n : null;
  return value * MSAT[amount[2]];
}

export const invoiceMatches = (bolt11, network, sats) =>
  invoiceMsat(bolt11, network) === BigInt(sats) * 1000n;

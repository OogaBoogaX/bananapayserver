// The Worker's settings. Deployment limits have no defaults: a missing or malformed limit
// closes donations. Bitcoin's supply bound is fixed by the protocol. See docs/configuration.md.

import { isNetwork } from "../shared/bolt11.mjs";
import { readLightningMaxSats } from "../shared/config.mjs";
import { MAX_SATS as MAX_MONEY } from "../shared/protocol.mjs";

const positiveInt = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
};

const wholeNumber = (value) => (value?.trim?.() === "0" ? 0 : positiveInt(value));

// The limits, or null when donations must stay closed.
export function readLimits(env) {
  const maxSats = MAX_MONEY;
  const lightningMaxSats = readLightningMaxSats(env);
  const ratePerIp = positiveInt(env.RATE_PER_IP);
  const noteRatePerIp = env.NOTE_RATE_PER_IP === undefined ? ratePerIp : positiveInt(env.NOTE_RATE_PER_IP);
  const rateGlobal = positiveInt(env.RATE_GLOBAL);
  const socketsPerIp = positiveInt(env.SOCKETS_PER_IP);
  // How many times the last price a new one may be, or the last divided by, before it's taken
  // for a fault; and how many sats an on-chain amount may exceed its invoice by.
  const priceJumpMax = positiveInt(env.PRICE_JUMP_MAX);
  const onchainFeeAllowance = wholeNumber(env.ONCHAIN_FEE_ALLOWANCE);
  const requestedMinSats = env.MIN_SATS === undefined ? 69 : positiveInt(env.MIN_SATS);
  const minSats = requestedMinSats === null ? null : Math.max(69, requestedMinSats);
  // The fewest sats a donation needs to carry a message, and to be listed among the recent ones,
  // so a run of tiny donations can neither speak nor flood the list; 0 lets every donation carry one.
  const messageMinSats = env.MESSAGE_MIN_SATS === undefined ? 1_000 : wholeNumber(env.MESSAGE_MIN_SATS);
  if (!ratePerIp || !noteRatePerIp || !rateGlobal || !socketsPerIp || !minSats || messageMinSats === null) return null;
  if (!lightningMaxSats || minSats > lightningMaxSats) return null;
  if (!priceJumpMax || priceJumpMax < 2 || onchainFeeAllowance === null) return null;
  return { minSats, maxSats, lightningMaxSats, messageMinSats, ratePerIp, noteRatePerIp, rateGlobal, socketsPerIp, priceJumpMax, onchainFeeAllowance };
}

// Settings that are not limits. A missing or unknown network also closes donations.
export function readSettings(env) {
  const network = isNetwork(env.NETWORK) ? env.NETWORK : null;
  return {
    network,
    invoiceTimeoutMs: positiveInt(env.INVOICE_TIMEOUT_MS) ?? 10_000,
    pendingDays: positiveInt(env.PENDING_DAYS) ?? 7,
    // The global pile: where it starts, and how many bananas the Oogas eat an hour. Both are
    // the team's to tune; these are placeholders.
    pileStart: wholeNumber(env.PILE_START) ?? 1_000,
    pileEatPerHour: wholeNumber(env.PILE_EAT_PER_HOUR) ?? 60,
  };
}

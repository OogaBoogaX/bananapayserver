// The Worker's settings. Every limit comes from the deployment's configuration, never from
// this repository, and a limit that is missing or malformed closes donations rather than
// falling back to a default. See docs/configuration.md.

import { isNetwork } from "../shared/bolt11.mjs";

const positiveInt = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
};

// The limits, or null when donations must stay closed.
export function readLimits(env) {
  const maxSats = positiveInt(env.MAX_SATS);
  const ratePerIp = positiveInt(env.RATE_PER_IP);
  const rateGlobal = positiveInt(env.RATE_GLOBAL);
  const minSats = env.MIN_SATS === undefined ? 1 : positiveInt(env.MIN_SATS);
  if (!maxSats || !ratePerIp || !rateGlobal || !minSats || minSats > maxSats) return null;
  return { minSats, maxSats, ratePerIp, rateGlobal };
}

// Settings that are not limits. A missing or unknown network also closes donations.
export function readSettings(env) {
  const network = isNetwork(env.NETWORK) ? env.NETWORK : null;
  const origins = String(env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return {
    network,
    origins,
    invoiceTimeoutMs: positiveInt(env.INVOICE_TIMEOUT_MS) ?? 10_000,
    pendingDays: positiveInt(env.PENDING_DAYS) ?? 7,
  };
}

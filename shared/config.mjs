// Both ends read the same Lightning threshold. An explicitly supplied canonical setting
// must be valid; only its absence permits the legacy deployment setting.

import { MAX_SATS } from "./protocol.mjs";

export function readLightningMaxSats(env) {
  const value = env.LIGHTNING_MAX_SATS === undefined ? env.MAX_SATS : env.LIGHTNING_MAX_SATS;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value.trim())) return null;
  const sats = Number(value.trim());
  return Number.isSafeInteger(sats) && sats <= MAX_SATS ? sats : null;
}

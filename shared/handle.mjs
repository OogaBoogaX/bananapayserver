import { HANDLE_MAX, sanitize } from "./donation.mjs";

// Prefixes do not count toward a display handle's length. Trim again after slicing so
// passing a cleaned handle through another boundary cannot change it.
export const cleanHandle = (handle) =>
  sanitize(handle, Infinity).replace(/^[@ ]+/, "").slice(0, HANDLE_MAX).trim() || "anon";

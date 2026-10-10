// The donation event and its text rules, copied from Ooga Booga Land's src/js/donations.js.
// OBL's scenes are built on this exact shape. tests/obl-contract.test.mjs checks this copy
// against a pinned snapshot of OBL's file; change both together or neither.

export const HANDLE_MAX = 39;
export const MESSAGE_MAX = 80;

export const sanitize = (text, max) =>
  String(text || "").replace(/[^\w .,!?'@#:-]/g, "").trim().slice(0, max);

// What every page receives: id is the BTCPay invoice id, at is milliseconds since the epoch.
export const donationEvent = ({ id, sats, handle, message, at }) => ({ id, sats, handle, message, at });

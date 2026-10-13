(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const config = {
    serverUrl: "https://btcpay.example.org",
    storeId: "REPLACE_WITH_STORE_ID",
    currency: "BTC",
    simulate: true
  };
  const HANDLE_MAX = 24;
  const MESSAGE_MAX = 80;
  const sanitize = (text, max) => String(text || "").replace(/[^\w .,!?'@#:-]/g, "").trim().slice(0, max);
  const randomId = () => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const createRequest = ({ handle = "", message = "" } = {}) => {
    const id = `banana-${randomId()}`;
    const url = new URL(`${config.serverUrl}/api/v1/invoices`);
    url.searchParams.set("storeId", config.storeId);
    url.searchParams.set("currency", config.currency);
    url.searchParams.set("orderId", id);
    const cleanHandle = sanitize(handle, HANDLE_MAX);
    const cleanMessage = sanitize(message, MESSAGE_MAX);
    if (cleanHandle) url.searchParams.set("handle", cleanHandle);
    if (cleanMessage) url.searchParams.set("message", cleanMessage);
    return { id, url: url.toString(), handle: cleanHandle, message: cleanMessage };
  };
  // Weights tuned so about half the draws cross the 1,000 sat crate threshold.
  const SIM_AMOUNTS = [300, 500, 800, 1200, 2500, 6000, 25000, 120000];
  const SIM_WEIGHTS = [3, 3, 2.5, 3, 2.5, 1.5, 0.6, 0.2];
  const pickAmount = () => {
    const total = SIM_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < SIM_AMOUNTS.length; i++) {
      r -= SIM_WEIGHTS[i];
      if (r <= 0) return SIM_AMOUNTS[i];
    }
    return SIM_AMOUNTS[0];
  };
  const subscribe = (onDonation, { identity = () => ({}) } = {}) => {
    if (!config.simulate) return () => { };
    let timer = 0;
    const schedule = (delayMs) => {
      timer = window.setTimeout(() => {
        const who = identity();
        onDonation({
          id: `sim-${randomId()}`,
          sats: pickAmount(),
          handle: sanitize(who.handle, HANDLE_MAX),
          message: sanitize(who.message, MESSAGE_MAX),
          at: Date.now()
        });
        schedule(15e3 + Math.random() * 20e3);
      }, delayMs);
    };
    schedule(6e3);
    return () => window.clearTimeout(timer);
  };
  BL.donations = { config, createRequest, subscribe, sanitize, HANDLE_MAX, MESSAGE_MAX };
})();

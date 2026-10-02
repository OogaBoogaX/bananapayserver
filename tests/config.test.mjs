// The settings on both ends: limits have no defaults, and a missing one keeps donations closed
// or the relay stopped.

import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../relay/config.mjs";
import { readLimits, readSettings } from "../worker/config.mjs";

const RELAY = {
  WORKER_URL: "wss://api.example.org/relay",
  RELAY_TOKEN: `relay-token-${"x".repeat(30)}`,
  TOR_SOCKS: "tor:9050",
  BTCPAY_URL: "http://btcpay.internal:23000",
  BTCPAY_STORE_ID: "Store1234",
  BTCPAY_API_KEY: "synthetic-api-key",
  BTCPAY_WEBHOOK_SECRET: "synthetic-webhook-secret",
  MAX_SATS: "50000",
};

test("the relay reads a complete configuration, with Tor and the defaults", () => {
  const config = readConfig(RELAY);
  assert.equal(config.workerUrl.href, "wss://api.example.org/relay");
  assert.deepEqual(config.socks, { host: "tor", port: 9050 });
  assert.deepEqual(config.listen, { host: "0.0.0.0", port: 8080 });
  assert.equal(config.minSats, 1);
  assert.equal(config.maxSats, 50_000);
  assert.equal(config.invoiceMinutes, 15);
  assert.deepEqual(config.methods, { lightning: "BTC-LN", onchain: "BTC-CHAIN" });
});

test("the relay won't start without its secrets, its cap, or Tor, and never prints them", () => {
  for (const name of ["RELAY_TOKEN", "TOR_SOCKS", "BTCPAY_API_KEY", "BTCPAY_WEBHOOK_SECRET", "MAX_SATS", "WORKER_URL"]) {
    assert.throws(() => readConfig({ ...RELAY, [name]: "" }), new RegExp(name), name);
  }
  assert.throws(() => readConfig({ ...RELAY, RELAY_TOKEN: "short" }), (error) => {
    assert.match(error.message, /RELAY_TOKEN/);
    assert.doesNotMatch(error.message, /short|synthetic/);
    return true;
  });
});

test("the relay connects without Tor only when told to", () => {
  assert.equal(readConfig({ ...RELAY, TOR_SOCKS: "", DIRECT: "yes" }).socks, null);
  assert.throws(() => readConfig({ ...RELAY, TOR_SOCKS: "", DIRECT: "true" }), /TOR_SOCKS/);
});

test("the line must be wss, except to this machine", () => {
  for (const url of ["ws://api.example.org/relay", "https://api.example.org/relay", "wss://user:pass@api.example.org/relay", "not a url"]) {
    assert.throws(() => readConfig({ ...RELAY, WORKER_URL: url }), /WORKER_URL/, url);
  }
  assert.equal(readConfig({ ...RELAY, WORKER_URL: "ws://localhost:8787/relay" }).workerUrl.protocol, "ws:");
});

test("numbers must be whole and in order", () => {
  for (const [name, value] of [["MAX_SATS", "1e5"], ["MAX_SATS", "0"], ["MAX_SATS", "-5"], ["MIN_SATS", "60000"], ["INVOICE_MINUTES", "1.5"], ["WEBHOOK_LISTEN", "0.0.0.0:99999"], ["TOR_SOCKS", "tor"]]) {
    assert.throws(() => readConfig({ ...RELAY, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test("the Worker's caps and rate limits have no defaults, and a bad one closes donations", () => {
  const limits = { MAX_SATS: "100000", RATE_PER_IP: "5", RATE_GLOBAL: "50" };
  assert.deepEqual(readLimits(limits), { minSats: 1, maxSats: 100_000, ratePerIp: 5, rateGlobal: 50 });
  for (const name of Object.keys(limits)) assert.equal(readLimits({ ...limits, [name]: undefined }), null, name);
  for (const bad of ["0", "-1", "1.5", "lots", " ", "1e3"]) assert.equal(readLimits({ ...limits, MAX_SATS: bad }), null, bad);
  assert.equal(readLimits({ ...limits, MIN_SATS: "100001" }), null);
});

test("the Worker's other settings", () => {
  assert.deepEqual(readSettings({ NETWORK: "signet", ALLOWED_ORIGINS: "https://a.example, https://b.example" }), {
    network: "signet",
    origins: ["https://a.example", "https://b.example"],
    invoiceTimeoutMs: 10_000,
    pendingDays: 7,
    pileStart: 1_000,
    pileEatPerHour: 60,
  });
  assert.equal(readSettings({ NETWORK: "liquid" }).network, null);
  const pile = readSettings({ PILE_START: "0", PILE_EAT_PER_HOUR: "0" });
  assert.deepEqual([pile.pileStart, pile.pileEatPerHour], [0, 0], "zero is allowed for the pile");
  assert.equal(readSettings({ PILE_EAT_PER_HOUR: "-3" }).pileEatPerHour, 60);
});

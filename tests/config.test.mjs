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
  LIGHTNING_MAX_SATS: "50000",
  RATE_PER_MINUTE: "60",
};

test("the relay reads a complete configuration, with Tor and the defaults", () => {
  const config = readConfig(RELAY);
  assert.equal(config.workerUrl.href, "wss://api.example.org/relay");
  assert.deepEqual(config.socks, { host: "tor", port: 9050 });
  assert.deepEqual(config.listen, { host: "0.0.0.0", port: 8080 });
  assert.equal(config.minSats, 1);
  assert.equal(config.maxSats, 2_100_000_000_000_000);
  assert.equal(config.lightningMaxSats, 50_000);
  assert.equal(config.ratePerMinute, 60);
  assert.equal(config.invoiceMinutes, 15);
  assert.deepEqual(config.methods, { lightning: "BTC-LN", onchain: "BTC-CHAIN" });
});

test("the relay won't start without its secrets, its limits, or Tor, and never prints them", () => {
  for (const name of ["RELAY_TOKEN", "TOR_SOCKS", "BTCPAY_API_KEY", "BTCPAY_WEBHOOK_SECRET", "LIGHTNING_MAX_SATS", "RATE_PER_MINUTE", "WORKER_URL"]) {
    assert.throws(() => readConfig({ ...RELAY, [name]: "" }), new RegExp(name), name);
  }
  assert.throws(() => readConfig({ ...RELAY, RELAY_TOKEN: "short" }), (error) => {
    assert.match(error.message, /RELAY_TOKEN/);
    assert.doesNotMatch(error.message, /short|synthetic/);
    return true;
  });
});

test("an API key with a space or a line break stops the relay, without the key in the error", () => {
  for (const key of ["synthetic-api-key\nX-Injected: yes", "synthetic api key", "synthetic-api-key\u0000"]) {
    assert.throws(() => readConfig({ ...RELAY, BTCPAY_API_KEY: key }), (error) => {
      assert.match(error.message, /BTCPAY_API_KEY/);
      assert.doesNotMatch(error.message, /synthetic/);
      return true;
    }, JSON.stringify(key));
  }
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
  for (const [name, value] of [["LIGHTNING_MAX_SATS", "1e5"], ["LIGHTNING_MAX_SATS", "0"], ["RATE_PER_MINUTE", "0"], ["RATE_PER_MINUTE", "1.5"], ["LIGHTNING_MAX_SATS", "-5"], ["MIN_SATS", "50001"], ["MIN_SATS", "2100000000000001"], ["INVOICE_MINUTES", "1.5"], ["WEBHOOK_LISTEN", "0.0.0.0:99999"], ["TOR_SOCKS", "tor"]]) {
    assert.throws(() => readConfig({ ...RELAY, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test("the Worker's caps and rate limits have no defaults, and a bad one closes donations", () => {
  const limits = { LIGHTNING_MAX_SATS: "100000", RATE_PER_IP: "5", RATE_GLOBAL: "50", SOCKETS_PER_IP: "4", PRICE_JUMP_MAX: "3", ONCHAIN_FEE_ALLOWANCE: "20000" };
  assert.deepEqual(readLimits(limits), {
    minSats: 1, maxSats: 2_100_000_000_000_000, lightningMaxSats: 100_000, messageMinSats: 1_000, ratePerIp: 5, noteRatePerIp: 5, rateGlobal: 50, socketsPerIp: 4, priceJumpMax: 3, onchainFeeAllowance: 20_000,
  });
  assert.equal(readLimits({ ...limits, MESSAGE_MIN_SATS: "0" }).messageMinSats, 0, "0 lets every donation carry a message");
  assert.equal(readLimits({ ...limits, MESSAGE_MIN_SATS: "2500" }).messageMinSats, 2500);
  assert.equal(readLimits({ ...limits, MESSAGE_MIN_SATS: "lots" }), null, "a bad message bar closes donations");
  for (const name of Object.keys(limits)) assert.equal(readLimits({ ...limits, [name]: undefined }), null, name);
  for (const bad of ["0", "-1", "1.5", "lots", " ", "1e3"]) assert.equal(readLimits({ ...limits, LIGHTNING_MAX_SATS: bad }), null, bad);
  assert.equal(readLimits({ ...limits, MIN_SATS: "100001" }), null);
  assert.equal(readLimits({ ...limits, MIN_SATS: "2100000000000001" }), null);
  assert.equal(readLimits({ ...limits, PRICE_JUMP_MAX: "1" }), null, "a factor of 1 would refuse every new price");
  assert.equal(readLimits({ ...limits, ONCHAIN_FEE_ALLOWANCE: "0" }).onchainFeeAllowance, 0, "no room for a fee is allowed");
});

test("the Worker's other settings", () => {
  assert.deepEqual(readSettings({ NETWORK: "signet" }), {
    network: "signet",
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

test("both ends accept legacy MAX_SATS only when the canonical Lightning threshold is absent", () => {
  const limits = { RATE_PER_IP: "5", RATE_GLOBAL: "50", SOCKETS_PER_IP: "4", PRICE_JUMP_MAX: "3", ONCHAIN_FEE_ALLOWANCE: "20000" };
  const readers = [
    (thresholds) => readLimits({ ...limits, ...thresholds }),
    (thresholds) => readConfig({ ...RELAY, LIGHTNING_MAX_SATS: undefined, ...thresholds }),
  ];
  for (const read of readers) {
    for (const thresholds of [
      { LIGHTNING_MAX_SATS: "1000" },
      { MAX_SATS: "1000" },
      { LIGHTNING_MAX_SATS: "1000", MAX_SATS: "2000" },
      { LIGHTNING_MAX_SATS: "1000", MAX_SATS: "invalid" },
    ]) assert.equal(read(thresholds).lightningMaxSats, 1000);
    assert.equal(read({ LIGHTNING_MAX_SATS: "1000", MIN_SATS: "1000" }).minSats, 1000);
  }
  for (const thresholds of [
    {},
    ...["", null, "0", "-1", "1e3", "1.5", "2100000000000001", "9007199254740992"].flatMap((bad) => [
      { LIGHTNING_MAX_SATS: bad, MAX_SATS: "1000" },
      { MAX_SATS: bad },
    ]),
  ]) {
    assert.equal(readers[0](thresholds), null);
    assert.throws(() => readers[1](thresholds), { message: "missing or invalid settings: LIGHTNING_MAX_SATS" });
  }
  for (const thresholds of [{ LIGHTNING_MAX_SATS: "1000" }, { MAX_SATS: "1000" }]) {
    assert.equal(readers[0]({ ...thresholds, MIN_SATS: "1001" }), null);
    assert.throws(() => readers[1]({ ...thresholds, MIN_SATS: "1001" }), /MIN_SATS/);
  }
});

test("note saves can have their own per-IP allowance, with invalid configuration closing donations", () => {
  const limits = { LIGHTNING_MAX_SATS: "1000", RATE_PER_IP: "5", RATE_GLOBAL: "50", SOCKETS_PER_IP: "4", PRICE_JUMP_MAX: "3", ONCHAIN_FEE_ALLOWANCE: "20000" };
  assert.equal(readLimits(limits).noteRatePerIp, 5);
  assert.equal(readLimits({ ...limits, NOTE_RATE_PER_IP: "20" }).noteRatePerIp, 20);
  for (const bad of ["", null, "0", "-1", "1.5", "1e3", "lots", "9007199254740992"]) {
    assert.equal(readLimits({ ...limits, NOTE_RATE_PER_IP: bad }), null);
  }
});

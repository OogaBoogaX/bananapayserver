// OBL's donation contract, copied in shared/donation.mjs, checked against a pinned snapshot of
// OBL's own file. When OBL changes the contract, refresh the snapshot with
// scripts/obl-contract.mjs, and this test says what no longer matches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { donationEvent, HANDLE_MAX, MESSAGE_MAX, sanitize } from "../shared/donation.mjs";

function loadObl() {
  const source = readFileSync(new URL("fixtures/obl-donations.js", import.meta.url), "utf8");
  const scheduled = [];
  const window = { setTimeout: (fn) => scheduled.push(fn), clearTimeout: () => {} };
  vm.runInNewContext(source, { window, crypto: globalThis.crypto, URL });
  return { donations: window.BL.donations, scheduled };
}

const SAMPLES = [
  "", "Ooga", "  padded  ", "<script>alert(1)</script>", "emoji 🍌 bananas", "café au lait",
  "it's #1 @ooga: yes!", "a-b_c.d,e?f", "tabs\tand\nnewlines", "x".repeat(200),
  "\u0000nul‮right-to-left", "<img src=x onerror=alert(1)>", "quote\"double", "back`tick",
  null, undefined, 0, 42, false,
];

test("HANDLE_MAX and MESSAGE_MAX match OBL", () => {
  const { donations } = loadObl();
  assert.equal(HANDLE_MAX, donations.HANDLE_MAX);
  assert.equal(MESSAGE_MAX, donations.MESSAGE_MAX);
});

test("sanitize gives OBL's result for every sample, at both lengths", () => {
  const { donations } = loadObl();
  for (const sample of SAMPLES) {
    for (const max of [HANDLE_MAX, MESSAGE_MAX]) {
      assert.equal(sanitize(sample, max), donations.sanitize(sample, max), `sample ${JSON.stringify(sample)}`);
    }
  }
});

test("the donation event has the keys OBL's scenes receive", () => {
  const { donations, scheduled } = loadObl();
  const received = [];
  donations.config.simulate = true;
  donations.subscribe((donation) => received.push(donation));
  scheduled.shift()();
  assert.equal(received.length, 1);
  const ours = donationEvent({ id: "inv1", sats: 1000, handle: "h", message: "m", at: 1 });
  assert.deepEqual(Object.keys(ours), Object.keys(received[0]));
  for (const key of Object.keys(ours)) assert.equal(typeof ours[key], typeof received[0][key], key);
});

test("donationEvent drops anything beyond the contract", () => {
  const event = donationEvent({ id: "inv1", sats: 1, handle: "", message: "", at: 2, seq: 7, extra: true });
  assert.deepEqual(event, { id: "inv1", sats: 1, handle: "", message: "", at: 2 });
});

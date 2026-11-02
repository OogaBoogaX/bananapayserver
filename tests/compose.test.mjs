// Every Compose file reads each value from one variable. An older Docker Compose, as some node
// platforms still ship, misreads a variable inside another's default and hands the container a
// stray "}": the relay then refuses to start, and donations stay closed.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const NESTED = /\$\{[^}]*\$\{/;

test("no Compose file puts one variable inside another", () => {
  const files = readdirSync(deploy, { recursive: true }).filter((file) => /(^|\/)compose[^/]*\.ya?ml$/.test(file));
  assert.ok(files.length >= 3, "finds the production and staging Compose files");
  for (const file of files) {
    assert.doesNotMatch(readFileSync(deploy + file, "utf8"), NESTED, `${file} nests one variable inside another`);
  }
});

test("the check catches the form that broke an older Compose", () => {
  assert.match("LIGHTNING_MAX_SATS: ${LIGHTNING_MAX_SATS-${MAX_SATS:-}}", NESTED);
  assert.doesNotMatch("TOR_SOCKS: ${TOR_FRONT_IP:?}:9050 ${OTHER:-}", NESTED);
});

// Static guards only: these do not run BTCPay or validate an operator's private .env.
const staging = readFileSync(deploy + "staging/compose.yaml", "utf8");
const example = readFileSync(deploy + "staging/.env.example", "utf8");
const rehearsal = readFileSync(deploy + "staging/compose.rehearsal.yaml", "utf8");

function assertDefaultDeny(compose, env) {
  const btcpay = compose.match(/^  btcpay:\n([\s\S]*?)(?=^  \w+:|^networks:)/m)?.[1];
  assert.ok(btcpay, "finds BTCPay's service settings");
  assert.deepEqual(btcpay.split("\n").filter((line) => /^\s+BTCPAY_.*SSRF/.test(line)).map((line) => line.trim()), [
    'BTCPAY_DISABLESSRFPROTECTION: "false"',
    'BTCPAY_SSRFEXCEPTIONS: "${BTCPAY_SSRFEXCEPTIONS:-}"',
  ], "SSRF protection stays on and exceptions have no automatic fallback");
  assert.deepEqual(env.split("\n").filter((line) => /^BTCPAY_.*SSRF/.test(line)), [
    "BTCPAY_SSRFEXCEPTIONS=",
  ], "the public template grants no private destination access");
}

test("staging keeps SSRF protection enabled with no default private exceptions", () => {
  assertDefaultDeny(staging, example);
});

test("the default-deny guard rejects broad exceptions and protection bypasses", () => {
  for (const value of ["0.0.0.0/0", "[::/0]", "192.0.2.0/24", "[2001:db8::/32]:443", "*.invalid", "example.invalid"]) {
    assert.throws(() => assertDefaultDeny(staging.replace("${BTCPAY_SSRFEXCEPTIONS:-}", value), example));
    assert.throws(() => assertDefaultDeny(staging, example.replace("BTCPAY_SSRFEXCEPTIONS=", `BTCPAY_SSRFEXCEPTIONS=${value}`)));
  }
  assert.throws(() => assertDefaultDeny(staging.replace('BTCPAY_DISABLESSRFPROTECTION: "false"', 'BTCPAY_DISABLESSRFPROTECTION: "true"'), example));
  assert.throws(() => assertDefaultDeny(staging.replace("${BTCPAY_SSRFEXCEPTIONS:-}", "${BTCPAY_SSRFEXCEPTIONS:-example.invalid}"), example));
});

test("rehearsal inherits the same SSRF protection without a bypass or separate allowlist", () => {
  assert.doesNotMatch(rehearsal.replace(/^\s*#.*$/gm, ""), /ssrf/i);
});

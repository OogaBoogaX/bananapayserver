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

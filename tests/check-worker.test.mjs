// Check destination selection without making any network requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = new URL("../scripts/check-staging.mjs", import.meta.url);
const staging = "https://bananapayserver-staging.synthetic.workers.dev";
const production = "https://bananapayserver-production.synthetic.workers.dev";

function check(args, env) {
  return spawnSync(process.execPath, [fileURLToPath(script), "--config-only", ...args], {
    env: { ...process.env, STAGING_WORKER_URL: "", PRODUCTION_WORKER_URL: "", ...env },
    encoding: "utf8",
  });
}

test("boundary checks select staging by default and production explicitly", () => {
  const env = { STAGING_WORKER_URL: staging, PRODUCTION_WORKER_URL: production };
  for (const args of [[], ["--production"]]) {
    const result = check(args, env);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("boundary checks never fall back to the other environment", () => {
  for (const [args, env] of [
    [[], { PRODUCTION_WORKER_URL: production }],
    [["--production"], { STAGING_WORKER_URL: staging }],
    [[], { STAGING_WORKER_URL: production }],
    [["--production"], { PRODUCTION_WORKER_URL: staging }],
  ]) assert.equal(check(args, env).status, 1);
});

test("production boundary checks require an HTTPS Worker base URL", () => {
  for (const url of [
    production.replace("https:", "http:"),
    "https://unrelated.synthetic.workers.dev",
    `${production}.example.org`,
    production.replace("https://", "https://synthetic:password@"),
    `${production}/relay`,
    `${production}?query`,
    `${production}#fragment`,
  ]) assert.equal(check(["--production"], { PRODUCTION_WORKER_URL: url }).status, 1, url);
});

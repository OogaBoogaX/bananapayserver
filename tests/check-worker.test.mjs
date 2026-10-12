// Check destination selection without making any network requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/check-staging.mjs", import.meta.url);
const staging = "https://bananapayserver-staging.synthetic.workers.dev";
const production = "https://bananapayserver-production.synthetic.workers.dev";

function check(args, env, cwd) {
  return spawnSync(process.execPath, [fileURLToPath(script), "--config-only", ...args], {
    env: { ...process.env, STAGING_WORKER_URL: "", PRODUCTION_WORKER_URL: "", ...env },
    encoding: "utf8",
    cwd,
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

test("boundary checks refuse another environment's Worker, network or database configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-check-"));
  try {
    for (const environment of ["staging", "production"]) {
      const name = `bananapayserver-${environment}`;
      const config = { name, vars: { NETWORK: environment === "staging" ? "signet" : "mainnet" },
        d1_databases: [{ database_name: name }] };
      const args = environment === "production" ? ["--production"] : [];
      const env = { STAGING_WORKER_URL: staging, PRODUCTION_WORKER_URL: production };
      const filename = join(cwd, `wrangler.${environment}.jsonc`);
      writeFileSync(filename, JSON.stringify(config));
      assert.equal(check(args, env, cwd).status, 0);
      for (const changed of [
        { ...config, name: "bananapayserver-other" },
        { ...config, vars: { NETWORK: environment === "staging" ? "mainnet" : "signet" } },
        { ...config, d1_databases: [{ database_name: "bananapayserver-other" }] },
      ]) {
        writeFileSync(filename, JSON.stringify(changed));
        assert.equal(check(args, env, cwd).status, 1);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

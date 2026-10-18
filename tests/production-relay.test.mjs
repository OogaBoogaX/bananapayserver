// The production relay's launch setup: token.sh makes the token once and shows only its hash,
// and the Compose file keeps the relay unpublished, read-only and on BTCPay's network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = (file) => fileURLToPath(new URL(`../deploy/production/${file}`, import.meta.url));

function withToken(env, check) {
  const folder = mkdtempSync(join(tmpdir(), "production-relay-"));
  try {
    copyFileSync(dir("token.sh"), join(folder, "token.sh"));
    if (env !== null) writeFileSync(join(folder, ".env"), env);
    const run = (env = process.env) => spawnSync("bash", [join(folder, "token.sh")], { encoding: "utf8", env });
    check({ run, env: () => readFileSync(join(folder, ".env"), "utf8"), mode: () => statSync(join(folder, ".env")).mode & 0o777 });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const tokenIn = (env) => /^RELAY_TOKEN=(.*)$/m.exec(env)?.[1];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("token.sh makes the token once, keeps it in .env, and prints only its hash", () => {
  withToken("WORKER_URL=wss://example.invalid/relay\nRELAY_TOKEN=\n", ({ run, env, mode }) => {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const token = tokenIn(env());
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(first.stdout.trim(), sha256(token));
    assert.ok(!first.stdout.includes(token), "the token itself is never printed");
    assert.equal(mode(), 0o600);
    const again = run();
    assert.equal(again.stdout.trim(), first.stdout.trim(), "run again, the same hash");
    assert.equal(tokenIn(env()), token, "and the same token");
  });
});

test("token.sh adds the token to an .env that has no line for it, and needs an .env", () => {
  withToken("WORKER_URL=wss://example.invalid/relay\n", ({ run, env }) => {
    assert.equal(run().status, 0);
    assert.match(tokenIn(env()), /^[0-9a-f]{64}$/);
  });
  withToken(null, ({ run }) => assert.equal(run().status, 1));
});

// Another program's arguments can be read by anyone on the machine through ps or /proc, so the
// token may only pass through bash's own built-ins. Every program token.sh could start is
// wrapped to note its arguments.
test("token.sh never puts the token in another program's arguments", () => {
  const bin = mkdtempSync(join(tmpdir(), "production-relay-bin-"));
  try {
    const log = join(bin, "argv.log");
    const found = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    for (const name of ["dirname", "chmod", "sed", "grep", "openssl", "rm", "tail", "cut", "sha256sum", "shasum"]) {
      if (!found(name).startsWith("/")) continue;
      const wrapper = `#!/usr/bin/env bash\nprintf '%s %s\\n' "\${0##*/}" "$*" >>"$ARGV_LOG"\nexport PATH="$REAL_PATH"\nexec "\${0##*/}" "$@"\n`;
      writeFileSync(join(bin, name), wrapper, { mode: 0o755 });
    }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_PATH: process.env.PATH, ARGV_LOG: log };
    for (const start of ["WORKER_URL=wss://example.invalid/relay\nRELAY_TOKEN=\nLIGHTNING_MAX_SATS=1\n", "LIGHTNING_MAX_SATS=1"]) {
      withToken(start, ({ run, env: read }) => {
        const result = run(env);
        assert.equal(result.status, 0, result.stderr);
        const token = tokenIn(read());
        assert.match(token, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(log) && readFileSync(log, "utf8").includes("sed "), "the wrappers ran");
        assert.ok(!readFileSync(log, "utf8").includes(token), "no program saw the token in its arguments");
        assert.match(read(), /^LIGHTNING_MAX_SATS=1$/m, "the other settings stay as they were");
        assert.equal(read().match(/^RELAY_TOKEN=/gm).length, 1);
      });
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the relay publishes no port, runs read-only, and only joins BTCPay's network", () => {
  const compose = readFileSync(dir("compose.yaml"), "utf8");
  const lines = compose.split("\n").filter((line) => !line.trim().startsWith("#"));
  const yaml = lines.join("\n");
  assert.doesNotMatch(yaml, /^\s*ports:/m);
  assert.doesNotMatch(yaml, /network_mode|privileged|docker\.sock|devices:/);
  assert.match(yaml, /read_only: true/);
  assert.match(yaml, /cap_drop: \[ALL\]/);
  assert.match(yaml, /no-new-privileges:true/);
  assert.match(yaml, /disable_ipv6: 1/);
  assert.match(yaml, /external: true/);
  const example = readFileSync(dir(".env.example"), "utf8");
  for (const name of new Set([...yaml.matchAll(/\$\{([A-Z_]+)/g)].map((m) => m[1]))) {
    const prefix = name === "MAX_SATS" ? "# " : ""; // Only the legacy fallback is commented out.
    assert.match(example, new RegExp(`^${prefix}${name}=`, "m"), `.env.example lists ${name}`);
  }
});

// Production uses staging's primitives with separate state and accepts only mainnet replies.
// Every invoice and address here is synthetic, driven through the existing in-memory fakes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { until } from "./helpers/cloudflare.mjs";
import { bolt11For, INVOICE } from "./helpers/values.mjs";
import { EXPIRES, world } from "./helpers/world.mjs";

// These configs use JSON with standalone line comments, and no other JSONC extensions.
const config = (name) => JSON.parse(readFileSync(new URL(`../wrangler.${name}.jsonc`, import.meta.url), "utf8")
  .replace(/^\s*\/\/.*$/gm, ""));
const production = config("production");
const staging = config("staging");
const invoice = (prefix = "lnbc") => ({ id: INVOICE, bolt11: bolt11For(1000, prefix), expires: EXPIRES });

test("production keeps staging's runtime primitives with separate state and the mainnet network", () => {
  assert.equal(production.name, "bananapayserver-production");
  assert.equal(staging.name, "bananapayserver-staging");
  for (const key of ["main", "compatibility_date", "durable_objects", "migrations", "observability"]) {
    assert.deepEqual(production[key], staging[key], key);
  }
  assert.deepEqual(production.durable_objects.bindings, [{ name: "DONATIONS", class_name: "Donations" }]);
  assert.ok(production.durable_objects.bindings.every((binding) => !Object.hasOwn(binding, "script_name")),
    "production's object belongs to its own Worker");
  assert.deepEqual(production.migrations, [{ tag: "v1", new_sqlite_classes: ["Donations"] }]);
  assert.equal(production.d1_databases.length, 1);
  assert.equal(staging.d1_databases.length, 1);
  const [database] = production.d1_databases;
  const [stagingDatabase] = staging.d1_databases;
  assert.equal(database.binding, "DB");
  assert.equal(database.binding, stagingDatabase.binding);
  assert.equal(database.migrations_dir, "migrations");
  assert.equal(database.migrations_dir, stagingDatabase.migrations_dir);
  assert.equal(database.database_name, production.name);
  assert.equal(stagingDatabase.database_name, staging.name);
  assert.notEqual(database.database_id, stagingDatabase.database_id, "production never binds staging's database");
  assert.match(database.database_id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, "production D1 is provisioned");
  assert.deepEqual(production.vars, { NETWORK: "mainnet" });
  assert.deepEqual(staging.vars, { NETWORK: "signet" });
  assert.equal(production.workers_dev, true, "the relay has an outbound destination");
  assert.equal(production.preview_urls, false);
  assert.equal(production.observability.logs.invocation_logs, false);
});

test("production returns a mainnet invoice and advertises mainnet through the page binding", async () => {
  const w = await world(production.vars);
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(page.messages()[0], { type: "status", open: true, network: "mainnet" });
  const { response } = await w.invoice(relay, { sats: 1000 }, () => invoice());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).invoice, invoice());
});

test("production refuses invoices from every test network before showing them to a donor", async () => {
  for (const prefix of ["lntbs", "lntb", "lnbcrt"]) {
    const w = await world(production.vars);
    const relay = await w.connectRelay();
    const { response } = await w.invoice(relay, { sats: 1000 }, () => invoice(prefix));
    assert.equal(response.status, 503, prefix);
    assert.deepEqual(await response.json(), { error: "closed" });
    assert.equal(w.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pending").one().n, 0);
  }
});

test("production's on-chain switch accepts mainnet and refuses test-network addresses", async () => {
  for (const [address, expected] of [
    ["bc1qexampleexampleexample", 200],
    ["tb1qexampleexampleexample", 503],
    ["bcrt1qexampleexampleexample", 503],
  ]) {
    const w = await world(production.vars);
    const relay = await w.connectRelay();
    const { asked, response } = await w.invoice(relay, { sats: 1000 }, () => invoice());
    assert.equal(response.status, 200);
    const pending = w.post("/donations/onchain", { request: asked.request });
    await until(() => JSON.parse(relay.sent.at(-1)).type === "onchain");
    await w.relaySays(relay, { type: "onchain", request: asked.request, address, sats: 1000 });
    const switched = await pending;
    assert.equal(switched.status, expected, address);
    assert.deepEqual(await switched.json(), expected === 200 ? { address, sats: 1000 } : { error: "closed" });
  }
});

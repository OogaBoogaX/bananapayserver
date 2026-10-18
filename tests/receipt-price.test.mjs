// Receipt-time pricing is fixed before confirmation or D1 retries, never supplied by a page.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject } from "../worker/object.mjs";
import { PRICE_SOCKET } from "../worker/price.mjs";
import { ENV, fakeCtx, fakeD1, fakePlatform } from "./helpers/cloudflare.mjs";
import { INVOICE } from "./helpers/values.mjs";
import { world } from "./helpers/world.mjs";

const paid = { type: "paid", invoice: INVOICE, sats: 1000, method: "onchain" };
const seen = (sats, left) => ({ type: "seen", invoice: INVOICE, sats, left });
const row = w => ({ ...w.env.DB.db.prepare("SELECT sats, price_cents, price_at, received_at, price_stale, pricing, milli FROM donations").get() });

test("only a full on-chain receipt freezes, including the fee; confirmation uses its snapshot after restart", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 1000, handle: "team" });
  const initial = w.platform.fetched.length;
  await w.relaySays(relay, seen(400, 615));
  await w.relaySays(relay, seen(1000, 15));
  assert.equal(w.platform.fetched.length, initial, "partial payment and missing network fee do not price");
  w.platform.advance(1000);
  const received = w.platform.now();
  w.platform.prices = { rest: 110_000, socket: 80_000 };
  await w.relaySays(relay, seen(1015, 0));
  const frozen = page.messages().filter(m => m.type === "seen").at(-1).pricing;
  assert.deepEqual(frozen, {
    receivedAt: received,
    rate: { usdPerBtc: 80_000, satsPerBanana: 1250, at: received, stale: false },
    bananas: { exact: 0.8, rounded: 1 },
  });
  assert.equal(w.platform.fetched.at(-1), PRICE_SOCKET, "receipt uses the socket's price first");
  assert.equal(w.env.DB.db.prepare("SELECT count(*) AS n FROM donations").get().n, 0, "not credited before confirmation");
  const asked = w.platform.fetched.length;
  w.platform.advance(3_600_000);
  w.platform.prices = { rest: 120_000, socket: 120_000 };
  w.object = new DonationsObject(w.ctx, w.env, w.platform);
  await w.relaySays(relay, seen(1015, 0));
  await w.relaySays(relay, paid);
  await w.relaySays(relay, paid);
  assert.equal(w.platform.fetched.length, asked, "neither repeat detection nor settlement reprices");
  assert.deepEqual(row(w), { sats: 1000, price_cents: 8_000_000, price_at: received, received_at: received, price_stale: 0, pricing: "receipt", milli: 800 });
  const board = page.messages().filter(m => m.type === "board").at(-1);
  assert.deepEqual(board.entries, [{ handle: "team", bananas: 0.8, sats: 1000 }]);
});

test("concurrent full detection and settlement share one receipt lookup", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  const asked = w.platform.fetched.length;
  w.platform.prices.socket = 90_000;
  await Promise.all([w.relaySays(relay, seen(1000, 0)), w.relaySays(relay, paid), w.relaySays(relay, paid)]);
  assert.equal(w.platform.fetched.length, asked + 1);
  assert.equal(row(w).milli, 900);
  assert.equal(w.object.receiving.size, 0);
});

test("a failed D1 write retries its stored receipt price rather than a new market price", async t => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  w.platform.prices.socket = 90_000;
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = sql => sql.startsWith("INSERT INTO donations")
    ? { bind: () => ({ first: async () => { throw new Error("D1 offline"); } }) } : prepare(sql);
  await w.relaySays(relay, { ...paid, method: "lightning" });
  const received = w.platform.now(), asked = w.platform.fetched.length;
  w.platform.advance(1000);
  w.platform.prices.socket = 120_000;
  w.env.DB.prepare = prepare;
  w.object = new DonationsObject(w.ctx, w.env, w.platform);
  await w.relaySays(relay, { ...paid, method: "lightning" });
  assert.equal(w.platform.fetched.length, asked);
  assert.equal(row(w).price_cents, 9_000_000);
  assert.equal(row(w).received_at, received);
});

test("unavailable receipt prices freeze the stale fallback, even if the service recovers before confirmation", async t => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  const priced = w.platform.now();
  w.platform.advance(1000);
  const received = w.platform.now();
  w.platform.prices = { rest: null, socket: null };
  await w.relaySays(relay, seen(1000, 0));
  w.platform.advance(120_000);
  w.platform.prices = { rest: 90_000, socket: 90_000 };
  await w.relaySays(relay, paid);
  assert.deepEqual(row(w), { sats: 1000, price_cents: 10_000_000, price_at: priced, received_at: received, price_stale: 1, pricing: "receipt", milli: 1000 });
});

test("without a detection notice an on-chain settlement samples at receipt and old donations keep their prices", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  w.platform.advance(1000);
  w.platform.prices.socket = 75_000;
  await w.relaySays(relay, paid);
  assert.equal(row(w).milli, 750);
  w.env.DB.db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, price_cents, milli) VALUES ('old', 1000, '', '', 1, 'lightning', 5000000, 500)").run();
  assert.deepEqual({ ...w.env.DB.db.prepare("SELECT price_cents, milli, received_at, pricing FROM donations WHERE id = 'old'").get() }, { price_cents: 5_000_000, milli: 500, received_at: null, pricing: "invoice" });
});

test("BTCPay's fully funded flag also freezes a mixed payment whose on-chain part is smaller", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  w.platform.prices.socket = 80_000;
  await w.relaySays(relay, seen(400, 0));
  w.platform.prices.socket = 120_000;
  await w.relaySays(relay, { ...paid, method: "mixed" });
  assert.equal(row(w).milli, 800);
});

test("no price at full detection stays unpriced even if the feed recovers before settlement", async t => {
  t.mock.method(console, "error", () => {});
  const w = await world({}, { prices: { rest: null, socket: null } });
  const relay = await w.connectRelay();
  await w.invoice(relay, { sats: 1000 });
  await w.relaySays(relay, seen(1000, 0));
  w.platform.advance(120_000);
  w.platform.prices = { rest: 90_000, socket: 90_000 };
  await w.relaySays(relay, paid);
  assert.equal(row(w).price_cents, null);
  assert.equal(row(w).milli, null);
});

for (const [schema, settling, priced, method] of [
  [4, 0, true, "lightning"],
  [4, 0, false, "onchain"],
  [5, 0, true, "onchain"],
  [5, 1, true, "lightning"],
  [5, 1, false, "onchain"],
]) {
  test(`schema ${schema} preserves ${priced ? "a priced" : "an unpriced"} legacy ${method} invoice with settling=${settling}`, async () => {
    const ctx = fakeCtx(), platform = fakePlatform(), env = { ...ENV, DB: fakeD1() };
    const sql = ctx.storage.sql;
    // The populated schema before receipt pricing, independent of the current migrations.
    sql.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE pending (
        request TEXT PRIMARY KEY, sats INTEGER NOT NULL, handle TEXT NOT NULL, message TEXT NOT NULL,
        invoice TEXT UNIQUE, expires INTEGER, created INTEGER NOT NULL, github_id INTEGER,
        price_cents INTEGER, price_at INTEGER, milli INTEGER
      );
      CREATE INDEX pending_created ON pending (created);
      CREATE TABLE price (id INTEGER PRIMARY KEY CHECK (id = 1), cents INTEGER NOT NULL, at INTEGER NOT NULL, failed INTEGER);
      CREATE TABLE pile (id INTEGER PRIMARY KEY CHECK (id = 1), milli INTEGER NOT NULL, at INTEGER NOT NULL, started INTEGER NOT NULL);
      CREATE TABLE finished (invoice TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX finished_at ON finished (at);
      CREATE TABLE tally_rate (id INTEGER PRIMARY KEY CHECK (id = 1), rate TEXT NOT NULL);
      CREATE TABLE rate (key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL);
    `);
    if (schema === 5) sql.exec("ALTER TABLE pending ADD COLUMN settling INTEGER NOT NULL DEFAULT 0");
    sql.exec("INSERT INTO meta (key, value) VALUES ('schema', ?)", schema);
    const original = { price_cents: priced ? 5_000_000 : null, price_at: priced ? platform.now() - 1000 : null, milli: priced ? 500 : null };
    sql.exec(
      "INSERT INTO pending (request, sats, handle, message, invoice, expires, created, price_cents, price_at, milli) VALUES (?, 1000, 'legacy', '', ?, ?, ?, ?, ?, ?)",
      "1".repeat(32), INVOICE, Math.floor(platform.now() / 1000) + 900, platform.now(),
      original.price_cents, original.price_at, original.milli,
    );
    if (settling) sql.exec("UPDATE pending SET settling = ?", settling);
    platform.advance(120_000);
    platform.prices = { rest: 90_000, socket: 90_000 };
    let object = new DonationsObject(ctx, env, platform);
    const snapshot = () => ({ ...sql.exec("SELECT price_cents, price_at, milli, pricing, price_frozen, received_at, settling FROM pending").one() });
    const expected = { ...original, pricing: "invoice", price_frozen: 1, received_at: null, settling };
    assert.deepEqual(snapshot(), expected, "migration preserves the issued invoice without inventing a receipt time");
    object = new DonationsObject(ctx, env, platform);
    if (method === "onchain") {
      await object.seen(seen(1000, 0));
      assert.deepEqual(snapshot(), expected, "full detection keeps the legacy invoice price after restart");
    }
    assert.equal(await object.paid({ ...paid, method }), "recorded");
    assert.equal(await object.paid({ ...paid, method }), "duplicate");
    assert.deepEqual(row({ env }), { sats: 1000, ...original, received_at: null, price_stale: null, pricing: "invoice" });
    assert.equal(platform.fetched.length, 0, "legacy settlement never looks up a new price");
  });
}

// Forward-only upgrades preserve recorded amounts and retire account-name aggregation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DonationsObject } from "../worker/object.mjs";
import { ENV, FakeSocket, fakeCtx, fakeD1, fakePlatform } from "./helpers/cloudflare.mjs";

const migration = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const rows = cursor => cursor.map(row => ({ ...row }));

test("D1 retires account totals and corrects unknown legacy freshness without changing receipt snapshots", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["0001_donations.sql", "0002_stats.sql", "0003_tally.sql", "0004_donor_sats.sql", "0005_handle_totals.sql", "0006_receipt_pricing.sql"]) db.exec(migration(name));
    const insert = db.prepare(
      "INSERT INTO donations (id, sats, handle, message, at, method, github_id, price_cents, price_at, banana_cents, milli, received_at, price_stale, pricing) " +
      "VALUES (?, 1000, ?, '', 1000, 'lightning', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    );
    insert.run("LegacyPriced", "old-login", 4242, 5_000_000, 900, 100, 500, null, 0, "invoice");
    insert.run("LegacyUnpriced", "", null, null, null, null, null, null, 0, "invoice");
    insert.run("ReceiptFresh", "fresh", null, 8_000_000, 990, 100, 800, 990, 0, "receipt");
    insert.run("ReceiptStale", "stale", null, 8_000_000, 900, 100, 800, 990, 1, "receipt");
    insert.run("ReceiptUnpriced", "unpriced", null, null, null, null, null, 990, 0, "receipt");
    const donations = () => rows(db.prepare("SELECT * FROM donations ORDER BY seq").all());
    const before = donations();
    const oldTotals = rows(db.prepare("SELECT * FROM totals ORDER BY github_id").all());

    db.exec(migration("0007_legacy_metadata.sql"));
    assert.deepEqual(donations(), before.map(row => ({ ...row, price_stale: row.pricing === "invoice" ? null : row.price_stale })));
    db.exec(migration("0008_verified_donations.sql"));
    assert.ok(donations().every(row => row.verified === 0), "old GitHub IDs alone do not prove their displayed names");
    insert.run("TypedHandle", "someone-else", 4242, 9_000_000, 1000, 100, 900, 1000, 0, "receipt");
    insert.run("NewAccount", "typed-team", 4343, 9_000_000, 1000, 100, 900, 1000, 0, "receipt");
    insert.run("TypedHandle", "someone-else", 4242, 9_000_000, 1000, 100, 900, 1000, 0, "receipt");
    assert.deepEqual(rows(db.prepare("SELECT * FROM totals ORDER BY github_id").all()), oldTotals, "typed names cannot rename an old account or create another account total");
    assert.deepEqual({ ...db.prepare("SELECT * FROM handle_totals WHERE handle = 'someone-else'").get() }, { handle: "someone-else", milli: 900, sats: 1000, donations: 1 });
    assert.deepEqual({ ...db.prepare("SELECT count, sats, milli FROM tally").get() }, { count: 7, sats: 7000, milli: 3900 });
  } finally {
    db.close();
  }
});

test("D1 records any kind of purchase apart from donations, and counts each recorded line once", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["0001_donations.sql", "0002_stats.sql", "0003_tally.sql", "0004_donor_sats.sql", "0005_handle_totals.sql",
      "0006_receipt_pricing.sql", "0007_legacy_metadata.sql", "0008_verified_donations.sql"]) db.exec(migration(name));
    db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, github_id) VALUES ('Donation01', 1000, 'ooga', '', 1, 'lightning', 7)").run();
    const untouched = ["donations", "totals", "handle_totals", "tally", "tally_hours"];
    const snapshot = () => untouched.map((table) => rows(db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    db.exec(migration("0009_purchases.sql"));
    const hour = 1_790_002_800_000;
    const purchase = db.prepare(
      "INSERT INTO purchases (id, sats, at, method, github_id, login, nth, before) VALUES (?, ?, ?, 'lightning', ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    );
    const line = db.prepare(
      "INSERT INTO purchase_items (purchase, line, category, item, quantity, sats) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (purchase, line) DO NOTHING",
    );
    purchase.run("Purchase01", 10, hour + 1, 7, "old-login", null, null);
    line.run("Purchase01", 1, "firework", "pop", 1, 10);
    purchase.run("Purchase01", 10, hour + 2, 7, "old-login", null, null);
    line.run("Purchase01", 1, "firework", "pop", 1, 10);
    purchase.run("Purchase02", 100, hour + 3, 7, "new-login", null, null);
    line.run("Purchase02", 1, "firework", "mega", 1, 100);
    // Things not sold yet need no migration: one payment for a costume and two of a shirt.
    purchase.run("Purchase03", 62_000, hour + 4, 8, "other", null, null);
    line.run("Purchase03", 1, "costume", "banana-suit", 1, 2_000);
    line.run("Purchase03", 2, "merch", "shirt-l", 2, 60_000);
    purchase.run("Purchase04", 10, hour + 3_600_000, null, null, 1, "none");
    line.run("Purchase04", 1, "firework", "pop", 1, 10);
    assert.deepEqual(rows(db.prepare("SELECT * FROM purchase_totals ORDER BY github_id, category, item").all()), [
      { github_id: 7, login: "new-login", category: "firework", item: "mega", quantity: 1, sats: 100 },
      { github_id: 7, login: "new-login", category: "firework", item: "pop", quantity: 1, sats: 10 },
      { github_id: 8, login: "other", category: "costume", item: "banana-suit", quantity: 1, sats: 2_000 },
      { github_id: 8, login: "other", category: "merch", item: "shirt-l", quantity: 2, sats: 60_000 },
    ], "once per line, per account and item, under the latest login, and nothing for an anonymous buyer");
    assert.deepEqual(rows(db.prepare("SELECT * FROM purchase_funnel ORDER BY hour, category, item").all()), [
      { hour, category: "costume", item: "banana-suit", created: 0, paid: 1 },
      { hour, category: "firework", item: "mega", created: 0, paid: 1 },
      { hour, category: "firework", item: "pop", created: 0, paid: 1 },
      { hour, category: "merch", item: "shirt-l", created: 0, paid: 1 },
      { hour: hour + 3_600_000, category: "firework", item: "pop", created: 0, paid: 1 },
    ]);
    assert.deepEqual(rows(db.prepare("SELECT id, sats, (SELECT sum(sats) FROM purchase_items WHERE purchase = id) AS lines FROM purchases ORDER BY seq").all()),
      [{ id: "Purchase01", sats: 10, lines: 10 }, { id: "Purchase02", sats: 100, lines: 100 }, { id: "Purchase03", sats: 62_000, lines: 62_000 }, { id: "Purchase04", sats: 10, lines: 10 }],
      "one row per invoice, its whole amount, and its lines adding up to it");
    assert.deepEqual(snapshot(), before, "no donation, total or tally moves");
    for (const [args, why] of [
      [["Purchase02", 2, "Firework", "pop", 1, 10], "a category is a lowercase name"],
      [["Purchase02", 2, "firework", "big pop", 1, 10], "so is an item"],
      [["Purchase02", 2, "firework", "", 1, 10], "and never empty"],
      [["Purchase02", 2, "firework", "pop", 0, 10], "at least one of it"],
      [["Purchase02", 0, "firework", "pop", 1, 10], "lines count from 1"],
    ]) assert.throws(() => line.run(...args), /CHECK constraint failed/, why);
    assert.throws(() => line.run("NeverPaid1", 1, "firework", "pop", 1, 10), /FOREIGN KEY constraint failed/, "an item belongs to a recorded purchase");
    assert.throws(() => purchase.run("Purchase05", 0, hour, null, null, null, null), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

// Schema 6 as it was deployed, written independently of the current migration array.
function schemaSix() {
  const ctx = fakeCtx(), sql = ctx.storage.sql;
  sql.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO meta VALUES ('schema', 6);
    CREATE TABLE pending (
      request TEXT PRIMARY KEY, sats INTEGER NOT NULL, handle TEXT NOT NULL, message TEXT NOT NULL,
      invoice TEXT UNIQUE, expires INTEGER, created INTEGER NOT NULL, github_id INTEGER,
      price_cents INTEGER, price_at INTEGER, milli INTEGER, settling INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER, price_frozen INTEGER NOT NULL DEFAULT 0,
      price_stale INTEGER NOT NULL DEFAULT 0, pricing TEXT NOT NULL DEFAULT 'receipt'
    );
    CREATE INDEX pending_created ON pending (created);
    CREATE TABLE price (id INTEGER PRIMARY KEY CHECK (id = 1), cents INTEGER NOT NULL, at INTEGER NOT NULL, failed INTEGER);
    CREATE TABLE pile (id INTEGER PRIMARY KEY CHECK (id = 1), milli INTEGER NOT NULL, at INTEGER NOT NULL, started INTEGER NOT NULL);
    CREATE TABLE finished (invoice TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE INDEX finished_at ON finished (at);
    CREATE TABLE tally_rate (id INTEGER PRIMARY KEY CHECK (id = 1), rate TEXT NOT NULL);
    CREATE TABLE rate (key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL);
  `);
  for (const [invoice, cents, milli, received, stale, pricing] of [
    ["LegacyPriced", 5_000_000, 500, null, 0, "invoice"],
    ["LegacyUnpriced", null, null, null, 0, "invoice"],
    ["ReceiptFresh", 8_000_000, 800, 990, 0, "receipt"],
    ["ReceiptStale", 8_000_000, 800, 990, 1, "receipt"],
    ["ReceiptUnpriced", null, null, 990, 0, "receipt"],
  ]) {
    sql.exec(
      "INSERT INTO pending (request, sats, handle, message, invoice, expires, created, github_id, price_cents, price_at, milli, settling, received_at, price_frozen, price_stale, pricing) " +
      "VALUES (?, 1000, 'synthetic', 'original note', ?, 2000, 800, 4242, ?, ?, ?, 1, ?, 1, ?, ?)",
      invoice, invoice, cents, cents === null ? null : 900, milli, received, stale, pricing,
    );
  }
  return ctx;
}

test("schema 6 upgrade preserves all frozen snapshots through restart, detection and settlement", async () => {
  const ctx = schemaSix(), sql = ctx.storage.sql, platform = fakePlatform();
  const env = { ...ENV, DB: fakeD1() };
  const pending = () => rows(sql.exec("SELECT * FROM pending ORDER BY invoice").toArray());
  const expected = pending().map(row => ({ ...row, price_stale: row.pricing === "invoice" ? null : row.price_stale, github_login: null, category: null, item: null, nth: null, before: null }));
  new DonationsObject(ctx, env, platform);
  assert.deepEqual(pending(), expected);
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, 9);
  assert.equal(sql.exec("PRAGMA table_info(pending)").toArray().find(column => column.name === "price_stale").notnull, 0);
  const object = new DonationsObject(ctx, env, platform);
  assert.deepEqual(pending(), expected, "restart does not repeat or alter the migration");
  const page = new FakeSocket();
  ctx.acceptWebSocket(page, ["page"]);
  for (const original of expected) {
    await object.seen({ invoice: original.invoice, sats: 1000, left: 0 });
    assert.equal(Object.hasOwn(page.messages().at(-1), "pricing"), original.pricing === "receipt", "legacy detection does not claim a fresh receipt price");
    assert.deepEqual({ ...sql.exec("SELECT * FROM pending WHERE invoice = ?", original.invoice).one() }, original);
    assert.equal(await object.paid({ invoice: original.invoice, sats: 1000, method: "onchain" }), "recorded");
    assert.equal(await object.paid({ invoice: original.invoice, sats: 1000, method: "onchain" }), "duplicate");
    assert.deepEqual({ ...env.DB.db.prepare("SELECT price_cents, price_at, milli, received_at, price_stale, pricing FROM donations WHERE id = ?").get(original.invoice) }, {
      price_cents: original.price_cents, price_at: original.price_at, milli: original.milli,
      received_at: original.received_at, price_stale: original.price_stale, pricing: original.pricing,
    });
  }
  assert.equal(platform.fetched.length, 0, "migration and frozen receipts never request another price");
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM donations").get().n, expected.length);
});

test("a failed schema 7 upgrade rolls back its column changes and can be retried", () => {
  const ctx = schemaSix(), sql = ctx.storage.sql, platform = fakePlatform();
  const env = { ...ENV, DB: fakeD1() };
  const before = rows(sql.exec("SELECT * FROM pending ORDER BY invoice").toArray());
  const exec = sql.exec;
  sql.exec = (query, ...bindings) => {
    const result = exec(query, ...bindings);
    if (query.includes("DROP COLUMN previous_price_stale")) throw new Error("synthetic interrupted upgrade");
    return result;
  };
  assert.throws(() => new DonationsObject(ctx, env, platform), /synthetic interrupted upgrade/);
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, 6);
  assert.deepEqual(rows(sql.exec("SELECT * FROM pending ORDER BY invoice").toArray()), before);
  sql.exec = exec;
  new DonationsObject(ctx, env, platform);
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, 9);
  assert.deepEqual(rows(sql.exec("SELECT * FROM pending ORDER BY invoice").toArray()), before.map(row => ({ ...row, price_stale: row.pricing === "invoice" ? null : row.price_stale, github_login: null, category: null, item: null, nth: null, before: null })));
});

// What a donation counts for: the rate recorded at receipt, the global pile, and
// the leaderboard of signed-in donors.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BOARD_SIZE, DonationsObject, PRICE_RETRY_MS } from "../worker/object.mjs";
import { PRICE_SOCKET, PRICE_URL } from "../worker/price.mjs";
import { fakeCtx, fakeD1, fakePlatform } from "./helpers/cloudflare.mjs";
import { bolt11For, INVOICE } from "./helpers/values.mjs";
import { donor, EXPIRES, world } from "./helpers/world.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const typed = (page, type) => page.messages().filter((m) => m.type === type);

// A paid donation of some sats, signed in as login unless login is null.
async function donate(w, relay, sats, { login = null, id = 1, handle, invoice = `Inv${String(w.platform.id()).slice(-8)}` } = {}) {
  await w.invoice(relay, { sats, ...(handle === undefined ? {} : { handle }) }, () => ({ id: invoice, bolt11: bolt11For(sats), expires: EXPIRES }), { donor: login ? donor(login, id) : null });
  await w.relaySays(relay, { type: "paid", invoice, sats, method: "lightning" });
  return invoice;
}

test("the quote is an estimate and the receipt's price is recorded with the donation", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const { response } = await w.invoice(relay, { sats: 25_000 }, () => ({ id: INVOICE, bolt11: bolt11For(25_000), expires: EXPIRES }));
  const reply = await response.json();
  assert.deepEqual(reply.bananas, { exact: 25, rounded: 25 });
  assert.deepEqual(reply.rate, { usdPerBtc: 100_000, satsPerBanana: 1000, at: w.platform.now(), stale: false });
  assert.deepEqual(w.platform.fetched, [PRICE_URL], "one ask, by REST");
  // Bitcoin halves before the donor pays; the donation counts at receipt.
  w.platform.advance(HOUR);
  w.platform.prices = { socket: 50_000, rest: 50_000 };
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 25_000, method: "lightning" });
  const row = w.env.DB.db.prepare("SELECT sats, price_cents, price_at, banana_cents, milli FROM donations").get();
  assert.deepEqual({ ...row }, { sats: 25_000, price_cents: 5_000_000, price_at: w.platform.now(), banana_cents: 100, milli: 12_500 });
});

test("every invoice gets a new price: from REST, or from the socket when REST doesn't answer", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  const answer = (id) => () => ({ id, bolt11: bolt11For(1000), expires: EXPIRES });
  await w.invoice(relay, { sats: 1000 });

  w.platform.advance(1_000);
  w.platform.prices = { rest: null, socket: 80_000 };
  const second = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0002"))).response.json();
  assert.deepEqual(second.rate, { usdPerBtc: 80_000, satsPerBanana: 1250, at: w.platform.now(), stale: false });
  assert.deepEqual(w.platform.fetched, [PRICE_URL, PRICE_URL, PRICE_SOCKET]);
  assert.match(warnings.mock.calls[0].arguments[0], /REST API didn't answer; its socket did/);

  w.platform.prices = { rest: 90_000, socket: 80_000 };
  const third = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0003"))).response.json();
  assert.equal(third.rate.usdPerBtc, 90_000, "back on REST");

  const asked = w.platform.fetched.length;
  await w.connectPage();
  assert.equal(w.platform.fetched.length, asked, "a page connecting doesn't ask");
});

test("when neither answers, invoices get the last price marked stale, and nobody waits on the service for a minute", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  const answer = (id) => () => ({ id, bolt11: bolt11For(1000), expires: EXPIRES });
  await w.invoice(relay, { sats: 1000 });
  const priced = w.platform.now();

  w.platform.advance(HOUR);
  w.platform.prices = { socket: null, rest: null };
  const second = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0002"))).response.json();
  assert.deepEqual(second.rate, { usdPerBtc: 100_000, satsPerBanana: 1000, at: priced, stale: true });
  assert.deepEqual(second.bananas, { exact: 1, rounded: 1 }, "counted at the last price");
  assert.equal(errors.mock.calls.length, 1);
  assert.match(errors.mock.calls[0].arguments[0], /answered neither by REST nor by socket.*the last price, from 2026-10-01T12:00:00.000Z, marked stale/);

  const asked = w.platform.fetched.length;
  const third = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0003"))).response.json();
  assert.equal(third.rate.stale, true);
  assert.equal(w.platform.fetched.length, asked, "no second attempt within the minute");

  w.platform.advance(PRICE_RETRY_MS + 1);
  w.platform.prices = { socket: 70_000, rest: 70_000 };
  const fourth = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0004"))).response.json();
  assert.deepEqual(fourth.rate, { usdPerBtc: 70_000, satsPerBanana: 1429, at: w.platform.now(), stale: false });
});

test("the minute without asking holds after the object sleeps, even with no price yet", async (t) => {
  t.mock.method(console, "error", () => {});
  const w = await world({}, { prices: { socket: null, rest: null } });
  const object = new DonationsObject(w.ctx, w.env, w.platform);
  assert.equal(await object.refreshPrice(), false);
  const asked = w.platform.fetched.length;
  const woken = new DonationsObject(w.ctx, w.env, w.platform);
  assert.equal(await woken.refreshPrice(), false);
  assert.equal(w.platform.fetched.length, asked, "no lookup within the minute, though nothing was in memory");
  w.platform.advance(PRICE_RETRY_MS + 1);
  await woken.refreshPrice();
  assert.ok(w.platform.fetched.length > asked, "after it, the service is asked again");
});

test("a price far from the last one is taken for a fault, until a day has gone by", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world();
  const relay = await w.connectRelay();
  const answer = (id) => () => ({ id, bolt11: bolt11For(1000), expires: EXPIRES });
  await w.invoice(relay, { sats: 1000 });
  const priced = w.platform.now();

  w.platform.advance(HOUR);
  w.platform.prices = { socket: 250_000, rest: 250_000 };
  const jumped = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0002"))).response.json();
  assert.deepEqual(jumped.rate, { usdPerBtc: 100_000, satsPerBanana: 1000, at: priced, stale: true });
  assert.match(errors.mock.calls[0].arguments[0], /gave \$250000, too far from the last price, \$100000/);

  w.platform.advance(PRICE_RETRY_MS + 1);
  w.platform.prices = { socket: 60_000, rest: 60_000 };
  const moved = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0003"))).response.json();
  assert.equal(moved.rate.usdPerBtc, 60_000, "a fall of 40% is the market");

  w.platform.advance(DAY);
  w.platform.prices = { socket: 250_000, rest: 250_000 };
  const later = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0004"))).response.json();
  assert.equal(later.rate.usdPerBtc, 250_000, "a day on, any price is taken");
});

test("how far a price may move is the deployment's setting", async () => {
  const w = await world({ PRICE_JUMP_MAX: "3" });
  const relay = await w.connectRelay();
  const answer = (id) => () => ({ id, bolt11: bolt11For(1000), expires: EXPIRES });
  await w.invoice(relay, { sats: 1000 });
  w.platform.advance(HOUR);
  w.platform.prices = { socket: 250_000, rest: 250_000 };
  const moved = await (await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0002"))).response.json();
  assert.equal(moved.rate.usdPerBtc, 250_000, "2.5 times is within 3");
});

for (const login of [null, "unpriced-donor"]) {
  test(`with no price anywhere, an ${login ? "identified" : "anonymous"} donation still goes through without bananas`, async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const w = await world({}, { prices: { socket: null, rest: null } });
    const relay = await w.connectRelay();
    const page = await w.connectPage();
    const { response } = await w.invoice(relay, { sats: 1000 }, undefined, { donor: login ? donor(login) : null });
    const reply = await response.json();
    assert.equal(reply.bananas, null);
    assert.equal(reply.rate, null);
    await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
    assert.equal(typed(page, "donation")[0].bananas, null);
    assert.equal(typed(page, "pile").length, 1, "the pile doesn't move");
    const expected = login ? [{ handle: login, bananas: 0, sats: 1000 }] : [];
    assert.deepEqual(typed(page, "board").at(-1).entries, [], "no unpriced donors on the banana list");
    assert.deepEqual(typed(page, "board").at(-1).satsEntries, expected);
    await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
    assert.deepEqual((await w.object.board({ refresh: true })).satsEntries, expected, "a repeated payment counts once");
    assert.deepEqual({ ...w.env.DB.db.prepare("SELECT sats, price_cents, milli FROM donations").get() }, { sats: 1000, price_cents: null, milli: null });
    assert.match(errors.mock.calls[0].arguments[0], /invoices get no price$/);
  });
}

test("everyone sees one pile: it starts full, the Oogas eat at a fixed rate, and donations add to it", async () => {
  const w = await world({ PILE_START: "1000", PILE_EAT_PER_HOUR: "60" });
  const relay = await w.connectRelay();
  const first = await w.connectPage();
  assert.deepEqual(typed(first, "pile"), [{ type: "pile", bananas: 1000, at: w.platform.now(), eatPerHour: 60 }]);

  w.platform.advance(HOUR / 2);
  const second = await w.connectPage();
  assert.equal(typed(second, "pile")[0].bananas, 970, "half an hour of eating");

  await donate(w, relay, 10_000);
  for (const page of [first, second]) {
    const [{ bananas }] = typed(page, "pile").slice(-1);
    assert.equal(bananas, 980, "970 left, plus 10 bananas for 10,000 sats at $100,000");
  }

  w.platform.advance(100 * HOUR);
  const late = await w.connectPage();
  assert.equal(typed(late, "pile")[0].bananas, 0, "an empty pile stays empty");
  await donate(w, relay, 2_500);
  assert.equal(typed(late, "pile").at(-1).bananas, 2.5, "and fills again from zero");
});

test("the pile keeps fractions, so small donations add up", async () => {
  const w = await world({ PILE_START: "0", PILE_EAT_PER_HOUR: "0" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  for (let i = 0; i < 3; i++) await donate(w, relay, 500);
  assert.equal(typed(page, "pile").at(-1).bananas, 1.5);
});

test("the leaderboard preserves recorded thousandths, ranks bananas and sats independently, and excludes anonymous donations", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  assert.deepEqual(typed(page, "board"), [{ type: "board", entries: [], satsEntries: [] }]);
  await donate(w, relay, 5_001, { login: "ooga-one", id: 1 });
  w.platform.prices = { socket: 50_000, rest: 50_000 };
  await donate(w, relay, 9_000, { login: "ooga-two", id: 2 });
  await donate(w, relay, 50_000);
  await donate(w, relay, 2_600, { login: "ooga-one", id: 1 });
  assert.deepEqual(typed(page, "board").at(-1).entries, [
    { handle: "ooga-one", bananas: 6.301, sats: 7601 },
    { handle: "ooga-two", bananas: 4.5, sats: 9000 },
  ]);
  assert.deepEqual(typed(page, "board").at(-1).satsEntries, [
    { handle: "ooga-two", bananas: 4.5, sats: 9000 },
    { handle: "ooga-one", bananas: 6.301, sats: 7601 },
  ]);
  const reconnected = await w.connectPage();
  assert.deepEqual(typed(reconnected, "board")[0], typed(page, "board").at(-1), "reconnecting gets both complete rankings");
  assert.equal(typed(page, "board").length, 4, "one board on connect, then one per signed-in donation");
  const after = page.messages().slice(-4).map((m) => m.type);
  assert.deepEqual(after, ["donation", "pile", "board", "tally"]);
});

test("different entered names keep separate totals even for the same account", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await donate(w, relay, 3_000, { login: "old-name", id: 7 });
  await donate(w, relay, 4_000, { login: "new-name", id: 7 });
  assert.deepEqual(typed(page, "board").at(-1).entries, [
    { handle: "new-name", bananas: 4, sats: 4000 },
    { handle: "old-name", bananas: 3, sats: 3000 },
  ]);
});

test(`the board shows the top ${BOARD_SIZE}`, async () => {
  const w = await world();
  const insert = w.env.DB.db.prepare(
    "INSERT INTO donations (id, sats, handle, message, at, method, github_id, price_cents, price_at, banana_cents, milli) VALUES (?, 1000, ?, '', 1, 'lightning', ?, 1, 1, 100, ?)",
  );
  for (let i = 1; i <= BOARD_SIZE + 5; i++) insert.run(`Donation${String(i).padStart(4, "0")}`, `donor-${i}`, i, i * 1000);
  const page = await w.connectPage();
  const { entries, satsEntries } = typed(page, "board")[0];
  assert.equal(entries.length, BOARD_SIZE);
  assert.equal(satsEntries.length, BOARD_SIZE);
  assert.deepEqual(satsEntries[0], { handle: "donor-1", bananas: 1, sats: 1000 }, "sat ties follow handle order");
  assert.ok(!entries.some((e) => e.handle === "donor-1"), "the sat leader is outside the banana list");
  assert.deepEqual(entries[0], { handle: `donor-${BOARD_SIZE + 5}`, bananas: BOARD_SIZE + 5, sats: 1000 });
});

test("an object made before the stats gets the new columns and tables in place", () => {
  const ctx = fakeCtx();
  ctx.storage.sql.exec(`CREATE TABLE pending (
    request TEXT PRIMARY KEY, sats INTEGER NOT NULL, handle TEXT NOT NULL, message TEXT NOT NULL,
    invoice TEXT UNIQUE, expires INTEGER, created INTEGER NOT NULL
  ); CREATE INDEX pending_created ON pending (created);`);
  ctx.storage.sql.exec("INSERT INTO pending (request, sats, handle, message, created) VALUES ('r', 1, '', '', 1)");
  const env = { DB: fakeD1() };
  new DonationsObject(ctx, env, fakePlatform());
  const row = ctx.storage.sql.exec("SELECT request, github_id, price_cents, milli FROM pending").one();
  assert.deepEqual({ ...row }, { request: "r", github_id: null, price_cents: null, milli: null });
  assert.equal(ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, 7);
  new DonationsObject(ctx, env, fakePlatform());
  assert.equal(ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pending").one().n, 1, "a second start changes nothing");
});

test("a donation D1 recorded before the object stopped is still pushed and piled, once", async () => {
  const w = await world({ PILE_START: "0", PILE_EAT_PER_HOUR: "0" });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.invoice(relay, { sats: 10_000 }, () => ({ id: INVOICE, bolt11: bolt11For(10_000), expires: EXPIRES }));

  // The insert lands in D1, and then the object stops before it does anything else.
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("INSERT INTO donations")) return statement;
    return { bind: (...args) => ({ first: async () => { await statement.bind(...args).first(); throw new Error("stopped"); } }) };
  };
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 10_000, method: "lightning" });
  w.env.DB.prepare = prepare;
  assert.equal(typed(page, "donation").length, 0);
  assert.equal(w.env.DB.db.prepare("SELECT COUNT(*) AS n FROM donations").get().n, 1, "D1 has it");

  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 10_000, method: "lightning" });
  assert.deepEqual(JSON.parse(relay.sent.at(-1)), { type: "ack", invoice: INVOICE, result: "duplicate" });
  assert.equal(typed(page, "donation").length, 1, "pushed now");
  assert.equal(typed(page, "pile").at(-1).bananas, 10, "and piled");
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 10_000, method: "lightning" });
  assert.equal(typed(page, "pile").at(-1).bananas, 10, "but only once");
});

test("the pile's clock never runs backwards when notices finish out of order", () => {
  const ctx = fakeCtx();
  const platform = fakePlatform();
  const object = new DonationsObject(ctx, { DB: fakeD1(), PILE_START: "1000", PILE_EAT_PER_HOUR: "3600" }, platform);
  const start = platform.now();
  object.pileMessage(start);
  assert.equal(object.addToPile(0, start + 10_000).bananas, 990, "a banana a second, for ten seconds");
  const late = object.addToPile(5_000, start);
  assert.equal(late.at, start + 10_000);
  assert.equal(late.bananas, 995, "those ten seconds are eaten once, not twice");
});

test("an older leaderboard read that answers last doesn't replace a newer one", async () => {
  const w = await world();
  const releases = [];
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    if (!sql.includes("FROM handle_totals")) return prepare(sql);
    const login = releases.length < 2 ? "older" : "newer";
    const entries = [{ handle: login, milli: 1000, sats: 1000 }];
    return { bind: () => ({ all: () => new Promise((resolve) => releases.push(() => resolve({ results: entries }))) }) };
  };
  const older = w.object.board({ refresh: true });
  const newer = w.object.board({ refresh: true });
  releases[3]();
  releases[2]();
  await newer;
  releases[1]();
  releases[0]();
  await older;
  const board = await w.object.board();
  assert.deepEqual(board.entries, [{ handle: "newer", bananas: 1, sats: 1000 }]);
  assert.deepEqual(board.satsEntries, board.entries);
});


test("the donor sats migration backfills history and keeps renamed, unpriced and repeated payments correct", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migration = (file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    for (const file of ["0001_donations.sql", "0002_stats.sql", "0003_tally.sql"]) db.exec(migration(file));
    const insert = db.prepare(
      "INSERT INTO donations (id, sats, handle, message, at, method, github_id, milli) " +
      "VALUES (?, ?, ?, '', 1, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    );
    insert.run("History0001", 1000, "old-name", "lightning", 7, 1000);
    insert.run("History0002", 2000, "new-name", "onchain", 7, null);
    insert.run("History0003", 3000, "unpriced-donor", "mixed", 8, null);
    insert.run("History0004", 9000, "", "lightning", null, 9000);
    const before = db.prepare("SELECT * FROM donations ORDER BY seq").all();
    db.exec(migration("0004_donor_sats.sql"));
    const totals = () => db.prepare("SELECT github_id, login, milli, donations, sats FROM totals ORDER BY github_id").all().map((r) => ({ ...r }));
    assert.deepEqual(totals(), [
      { github_id: 7, login: "new-name", milli: 1000, donations: 2, sats: 3000 },
      { github_id: 8, login: "unpriced-donor", milli: 0, donations: 1, sats: 3000 },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM donations ORDER BY seq").all(), before, "donation records are unchanged");
    insert.run("History0005", 500, "newest-name", "lightning", 7, 250);
    insert.run("History0005", 500, "newest-name", "lightning", 7, 250);
    insert.run("History0006", 700, "unpriced-donor", "onchain", 8, null);
    assert.deepEqual(totals(), [
      { github_id: 7, login: "newest-name", milli: 1250, donations: 3, sats: 3500 },
      { github_id: 8, login: "unpriced-donor", milli: 0, donations: 2, sats: 3700 },
    ]);
  } finally {
    db.close();
  }
});


test("matching handles combine guest and account donations at their individual receipt rates", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await donate(w, relay, 1234, { handle: "Team" });
  w.platform.prices = { socket: 50_000, rest: 50_000 };
  await donate(w, relay, 2001, { login: "account-one", id: 1, handle: "@team" });
  await donate(w, relay, 4000, { login: "account-two", id: 2, handle: "TEAM" });
  assert.deepEqual(typed(page, "board").at(-1).entries, [{ handle: "TEAM", bananas: 4.235, sats: 7235 }]);
  assert.deepEqual(typed(page, "board").at(-1).satsEntries, typed(page, "board").at(-1).entries);
  await donate(w, relay, 1000, { handle: "anon" });
  assert.ok(typed(page, "board").at(-1).entries.some((r) => r.handle === "anon"));
});

test("handle totals migration backfills names, keeps recorded fractions, and ignores duplicate settlements", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migration = (file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    for (const file of ["0001_donations.sql", "0002_stats.sql", "0003_tally.sql", "0004_donor_sats.sql"]) db.exec(migration(file));
    const insert = db.prepare("INSERT INTO donations (id, sats, handle, message, at, method, github_id, milli) VALUES (?, ?, ?, '', 1, 'lightning', ?, ?) ON CONFLICT (id) DO NOTHING");
    insert.run("History0001", 1234, "Team", 7, 1234);
    insert.run("History0002", 2001, "team", null, 1001);
    insert.run("History0003", 3000, "unpriced", null, null);
    insert.run("History0004", 9000, "", null, 9000);
    const before = db.prepare("SELECT * FROM donations ORDER BY seq").all();
    db.exec(migration("0005_handle_totals.sql"));
    const totals = () => db.prepare("SELECT * FROM handle_totals ORDER BY handle").all().map((r) => ({ ...r }));
    assert.deepEqual(totals(), [
      { handle: "team", milli: 2235, sats: 3235, donations: 2 },
      { handle: "unpriced", milli: 0, sats: 3000, donations: 1 },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM donations ORDER BY seq").all(), before);
    insert.run("History0005", 500, "TEAM", 8, 250);
    insert.run("History0005", 500, "TEAM", 8, 250);
    assert.deepEqual(totals()[0], { handle: "TEAM", milli: 2485, sats: 3735, donations: 3 });
  } finally { db.close(); }
});

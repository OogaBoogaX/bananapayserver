// The board's tally: what D1 holds of every donation, the last seven days by the hour, and the
// rate beside them, pushed to pages and kept fresh by the object's alarm while pages are open.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DonationsObject, PRICE_FRESH_MS, PRICE_RETRY_MS } from "../worker/object.mjs";
import { PRICE_URL } from "../worker/price.mjs";
import { bolt11For } from "./helpers/values.mjs";
import { donor, EXPIRES, world } from "./helpers/world.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 1, 12);
const typed = (page, type) => page.messages().filter((m) => m.type === type);
const tallies = (page) => typed(page, "tally");
const asks = (w) => w.platform.fetched.filter((url) => url === PRICE_URL).length;

async function donate(w, relay, sats, { login = null, id = 1 } = {}) {
  const invoice = `Inv${String(w.platform.id()).slice(-8)}`;
  await w.invoice(relay, { sats }, () => ({ id: invoice, bolt11: bolt11For(sats), expires: EXPIRES }), { donor: login ? donor(login, id) : null });
  await w.relaySays(relay, { type: "paid", invoice, sats, method: "lightning" });
  await w.ctx.settle();
  return invoice;
}

test("a page gets the tally on connect, after status, pile and board, and before any replay", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const first = await donate(w, relay, 10_000, { login: "ooga-dev" });
  await donate(w, relay, 2_500);
  const page = await w.connectPage(first);
  assert.deepEqual(page.messages().map((m) => m.type), ["status", "pile", "board", "tally", "donation"]);
  assert.deepEqual(tallies(page)[0], {
    type: "tally",
    count: 2,
    sats: 12_500,
    bananas: 12.5,
    last: 2_500,
    hours: [[START, 12_500, 12.5]],
    rate: { usdPerBtc: 100_000, satsPerBanana: 1000, at: START, stale: false },
  });
});

test("before any donation, the tally is empty, and with no price ever its rate is null", async (t) => {
  t.mock.method(console, "error", () => {});
  const w = await world({}, { prices: { socket: null, rest: null } });
  const page = await w.connectPage();
  await w.ctx.settle();
  assert.deepEqual(tallies(page), [{ type: "tally", count: 0, sats: 0, bananas: 0, last: null, hours: [], rate: null }]);
});

test("each donation pushes one tally to every page, and a repeated notice none", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const pages = [await w.connectPage(), await w.connectPage(undefined, "visitor-q")];
  await w.ctx.settle();
  // One on connect, and one when the first price came in, once, though both pages asked.
  for (const page of pages) assert.equal(tallies(page).length, 2);
  const invoice = await donate(w, relay, 4_000);
  for (const page of pages) {
    assert.equal(tallies(page).length, 3, "one for the donation");
    assert.deepEqual(tallies(page).at(-1).count, 1);
  }
  await w.relaySays(relay, { type: "paid", invoice, sats: 4_000, method: "lightning" });
  await w.ctx.settle();
  for (const page of pages) assert.equal(tallies(page).length, 3, "the repeat changes nothing");
});

test("a donation recorded without a price counts its sats and no bananas", async (t) => {
  t.mock.method(console, "error", () => {});
  const w = await world({}, { prices: { socket: null, rest: null } });
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await donate(w, relay, 3_000);
  assert.deepEqual(tallies(page).at(-1), { type: "tally", count: 1, sats: 3_000, bananas: 0, last: 3_000, hours: [[START, 3_000, 0]], rate: null });
});

test("the hours cover the last seven days by UTC hour, while the counts cover all time", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await donate(w, relay, 1_000);
  w.platform.advance(30 * MINUTE);
  await donate(w, relay, 2_000);
  w.platform.advance(2 * HOUR);
  await donate(w, relay, 5_000);
  let page = await w.connectPage();
  assert.deepEqual(tallies(page)[0].hours, [[START, 3_000, 3], [START + 2 * HOUR, 5_000, 5]]);

  // A week less an hour later, it's 13:30: the 14:00 hour is the oldest still shown.
  w.platform.advance(7 * DAY - HOUR);
  page = await w.connectPage();
  const [tally] = tallies(page);
  assert.deepEqual(tally.hours, [[START + 2 * HOUR, 5_000, 5]]);
  assert.deepEqual([tally.count, tally.sats, tally.bananas, tally.last], [3, 8_000, 8, 5_000]);
});

test("a page never waits for a price: an old one is refreshed afterwards, and pushed only if it changed", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  await donate(w, relay, 1_000);
  w.platform.advance(PRICE_FRESH_MS + MINUTE);
  w.platform.prices = { rest: 90_000, socket: 90_000 };
  const asked = asks(w);

  const page = await w.connectPage();
  assert.equal(tallies(page)[0].rate.usdPerBtc, 100_000, "connected with what the object had");
  await w.ctx.settle();
  assert.equal(asks(w), asked + 1, "then asked once");
  assert.deepEqual(tallies(page).at(-1).rate, { usdPerBtc: 90_000, satsPerBanana: 1111, at: w.platform.now(), stale: false });
  assert.equal(tallies(page).length, 2);

  await w.connectPage(undefined, "visitor-q");
  await w.ctx.settle();
  assert.equal(asks(w), asked + 1, "a fresh price isn't asked for again");
  assert.equal(tallies(page).length, 2, "and nothing new goes out");

  w.platform.advance(PRICE_FRESH_MS + MINUTE);
  await w.connectPage(undefined, "visitor-r");
  await w.ctx.settle();
  assert.equal(asks(w), asked + 2, "an old price is asked for again");
  assert.equal(tallies(page).length, 2, "but the same price doesn't go out twice");
});

test("an invoice's price lookup pushes the tally only when the rate changes", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  await w.ctx.settle();
  const shown = tallies(page).length;
  const answer = (id) => () => ({ id, bolt11: bolt11For(1000), expires: EXPIRES });

  await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0001"));
  await w.ctx.settle();
  assert.equal(tallies(page).length, shown, "the same price");

  w.platform.prices = { rest: 110_000, socket: 110_000 };
  await w.invoice(relay, { sats: 1000 }, answer("Inv0ice0002"));
  await w.ctx.settle();
  assert.equal(tallies(page).length, shown + 1);
  assert.equal(tallies(page).at(-1).rate.usdPerBtc, 110_000);
});

test("the alarm keeps the rate fresh while pages are open, and lets the object sleep when none are", async () => {
  const w = await world();
  await w.connectRelay();
  const page = await w.connectPage();
  await w.ctx.settle();
  assert.equal(await w.ctx.storage.getAlarm(), START + PRICE_FRESH_MS, "set when the first page connected");
  assert.equal(tallies(page).at(-1).rate.usdPerBtc, 100_000);

  w.platform.advance(PRICE_FRESH_MS);
  w.platform.prices = { rest: 95_000, socket: 95_000 };
  await w.fireAlarm();
  assert.equal(tallies(page).at(-1).rate.usdPerBtc, 95_000);
  assert.equal(await w.ctx.storage.getAlarm(), w.platform.now() + PRICE_FRESH_MS);

  // An invoice two minutes later gets a new price, so the next alarm waits until that one is
  // five minutes old instead of asking again.
  w.platform.advance(2 * MINUTE);
  const relay = w.ctx.getWebSockets("relay")[0];
  await w.invoice(relay, { sats: 1000 }, () => ({ id: "Inv0ice0001", bolt11: bolt11For(1000), expires: EXPIRES }));
  const priced = w.platform.now();
  w.platform.advance(3 * MINUTE);
  const asked = asks(w);
  await w.fireAlarm();
  assert.equal(asks(w), asked, "the price was only three minutes old");
  assert.equal(await w.ctx.storage.getAlarm(), priced + PRICE_FRESH_MS);

  // With every page gone, the relay's line alone doesn't keep the alarm going.
  page.close(1001, "gone");
  w.platform.advance(2 * MINUTE);
  await w.fireAlarm();
  assert.equal(asks(w), asked, "no page, no price");
  assert.equal(await w.ctx.storage.getAlarm(), null);
});

test("when the price service fails, the tally's rate turns stale, even after the object sleeps, and recovers", async (t) => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  await w.connectRelay();
  const page = await w.connectPage();
  await w.ctx.settle();

  w.platform.advance(PRICE_FRESH_MS);
  w.platform.prices = { rest: null, socket: null };
  await w.fireAlarm();
  assert.deepEqual(tallies(page).at(-1).rate, { usdPerBtc: 100_000, satsPerBanana: 1000, at: START, stale: true });
  const shown = tallies(page).length;

  // Woken again with nothing in memory, the object still knows the price is stale.
  const woken = new DonationsObject(w.ctx, w.env, w.platform);
  assert.equal((await woken.tally()).rate.stale, true);

  // Within 0013's minute nobody asks; after it, the price is back.
  const asked = asks(w);
  w.platform.advance(PRICE_RETRY_MS / 2);
  await w.fireAlarm();
  assert.equal(asks(w), asked);
  assert.equal(tallies(page).length, shown, "still stale: nothing new to send");
  w.platform.advance(PRICE_FRESH_MS);
  w.platform.prices = { rest: 80_000, socket: 80_000 };
  await w.fireAlarm();
  assert.deepEqual(tallies(page).at(-1).rate, { usdPerBtc: 80_000, satsPerBanana: 1250, at: w.platform.now(), stale: false });
});

test("when D1 can't be read, the tally is skipped and everything else still arrives", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const w = await world();
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    if (sql.includes("tally")) throw new Error("D1 is down");
    return prepare(sql);
  };
  const page = await w.connectPage();
  await w.ctx.settle();
  assert.deepEqual(page.messages().map((m) => m.type), ["status", "pile", "board"]);
  assert.match(errors.mock.calls[0].arguments[0], /reading the tally failed/);
});

test("a new rate the tally couldn't be read for goes out once D1 is back", async (t) => {
  t.mock.method(console, "error", () => {});
  const w = await world();
  const page = await w.connectPage();
  await w.ctx.settle();
  assert.equal(tallies(page).at(-1).rate.usdPerBtc, 100_000);

  // Woken with nothing in memory, a new price arrives while D1 can't be read.
  const woken = new DonationsObject(w.ctx, w.env, w.platform);
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (sql) => {
    if (sql.includes("tally")) throw new Error("D1 is down");
    return prepare(sql);
  };
  w.platform.advance(PRICE_FRESH_MS);
  w.platform.prices = { rest: 90_000, socket: 90_000 };
  await woken.alarm();
  await w.ctx.settle();
  assert.equal(tallies(page).at(-1).rate.usdPerBtc, 100_000, "nothing could go out");

  // D1 is back, and the price hasn't moved since; the pages still need it.
  w.env.DB.prepare = prepare;
  w.platform.advance(PRICE_FRESH_MS);
  await woken.alarm();
  await w.ctx.settle();
  assert.equal(tallies(page).at(-1).rate.usdPerBtc, 90_000);
});

test("the migration starts the tally from the donations already recorded, and the trigger counts each once", () => {
  const db = new DatabaseSync(":memory:");
  const migration = (file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
  db.exec(migration("0001_donations.sql"));
  db.exec(migration("0002_stats.sql"));
  const insert = db.prepare(
    "INSERT INTO donations (id, sats, handle, message, at, method, milli) VALUES (?, ?, '', '', ?, 'lightning', ?) ON CONFLICT (id) DO NOTHING",
  );
  insert.run("Donation0001", 1_000, START + 10 * MINUTE, 1_000);
  insert.run("Donation0002", 2_000, START + 50 * MINUTE, null);
  insert.run("Donation0003", 4_000, START + HOUR, 4_000);
  db.exec(migration("0003_tally.sql"));
  const read = () => ({
    tally: { ...db.prepare("SELECT count, sats, milli, last FROM tally").get() },
    hours: db.prepare("SELECT hour, sats, milli FROM tally_hours ORDER BY hour").all().map((r) => ({ ...r })),
  });
  assert.deepEqual(read(), {
    tally: { count: 3, sats: 7_000, milli: 5_000, last: 4_000 },
    hours: [{ hour: START, sats: 3_000, milli: 1_000 }, { hour: START + HOUR, sats: 4_000, milli: 4_000 }],
  });

  insert.run("Donation0004", 500, START + HOUR + MINUTE, 500);
  insert.run("Donation0004", 500, START + HOUR + MINUTE, 500);
  assert.deepEqual(read(), {
    tally: { count: 4, sats: 7_500, milli: 5_500, last: 500 },
    hours: [{ hour: START, sats: 3_000, milli: 1_000 }, { hour: START + HOUR, sats: 4_500, milli: 4_500 }],
  });
});

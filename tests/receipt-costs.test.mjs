// What the pile's snapshot path materializes: existence probes return at most one row, and the
// uncertain amount is read from the cursor row by row. Rows returned and held are measured
// here; rows SQLite examines are not, and neither is any cost in the runtime. Every value is
// synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { applyPileAnchor, pileView, savedPileSnapshot } from "../worker/pile.mjs";
import { ReceiptLedger } from "../worker/receipts.mjs";
import { pay, provider, read, RECEIPT_SETTINGS as SETTINGS, seed, TOKEN } from "./helpers/receipt-seed.mjs";
import { syntheticAddress } from "./helpers/synthetic-address.mjs";
import { world } from "./helpers/world.mjs";

const MAX = Number.MAX_SAFE_INTEGER;

// A cursor that reads lazily, like the runtime's, from a generator. It counts the rows it has
// yielded, and refuses toArray, so a method that collects rows first fails here.
function lazyCursor(rows) {
  const seen = { yielded: 0, toArray: 0 };
  function* each() {
    for (const r of rows) {
      seen.yielded += 1;
      yield r;
    }
  }
  return {
    seen,
    cursor: {
      [Symbol.iterator]: each,
      toArray: () => { seen.toArray += 1; throw new Error("reviewCredit must not collect rows"); },
      one: () => { throw new Error("reviewCredit must not ask for one row"); },
    },
  };
}

// reviewCredit run against the given review rows, through a lazy cursor.
function reviewCreditOver(rows) {
  const { seen, cursor } = lazyCursor(rows);
  const queries = [];
  const ledger = { sql: { exec: (query) => { queries.push(query); return cursor; } } };
  const result = ReceiptLedger.prototype.reviewCredit.call(ledger);
  return { result, seen, queries };
}

const row = (credit, milli = credit, sats = credit) => ({ sats, credit, milli });

test("reviewCredit reads the cursor row by row, never collects it, and adds exactly", () => {
  const { result, seen, queries } = reviewCreditOver([row(1000), row(2500, 2400), row(3000, null)]);
  assert.deepEqual(result, { sats: 6500, milli: 3400 }, "a missing price adds its sats and no bananas");
  assert.deepEqual(seen, { yielded: 3, toArray: 0 });
  assert.deepEqual(queries, ["SELECT sats, credit, milli FROM ra_receipts INDEXED BY ra_receipts_review WHERE state = 'review'"]);
  assert.deepEqual(reviewCreditOver([]).result, { sats: 0, milli: 0 });
});

test("reviewCredit skips review receipts that hold no credit, whatever their price", () => {
  const { result, seen } = reviewCreditOver([row(0, MAX, 5000), row(1000), { sats: 7000, credit: -1, milli: MAX }, row(0, null, 1)]);
  assert.deepEqual(result, { sats: 1000, milli: 1000 }, "credit <= 0 adds nothing, its milli included");
  assert.equal(seen.yielded, 4);
});

test("reviewCredit is exact up to MAX_SAFE_INTEGER, and null one past it, in either component", () => {
  // Exactly at the bound, in each component.
  assert.deepEqual(reviewCreditOver([row(MAX - 1000, 1), row(1000, 1)]).result, { sats: MAX, milli: 2 });
  assert.deepEqual(reviewCreditOver([row(1, MAX - 5), row(1, 5)]).result, { sats: 2, milli: MAX });
  // One past it: null, never rounded, capped or a float.
  assert.equal(reviewCreditOver([row(MAX - 1000, 1), row(1001, 1)]).result, null, "sats past the bound");
  assert.equal(reviewCreditOver([row(1, MAX - 5), row(1, 6)]).result, null, "milli past the bound");
  // An unsafe value on its own row is unsafe too.
  assert.equal(reviewCreditOver([row(1, MAX + 2)]).result, null);
});

test("reviewCredit stops reading at the first sum it can't represent", () => {
  for (const [name, rows, stop] of [
    ["sats", [row(10), row(MAX - 10, 1), row(1, 1), row(1, 1), row(1, 1)], 3],
    ["milli", [row(1, 10), row(1, MAX - 10), row(1, 1), row(1, 1)], 3],
    ["the first row", [row(1, MAX + 2), row(1), row(1)], 1],
  ]) {
    const { result, seen } = reviewCreditOver(rows);
    assert.equal(result, null, name);
    assert.deepEqual(seen, { yielded: stop, toArray: 0 }, `${name}: no row read past the overflow`);
  }
});

test("an overflow isn't sticky: once the review receipts sum safely again, the exact amount returns", () => {
  assert.equal(reviewCreditOver([row(MAX - 1, 1), row(5, 1)]).result, null);
  assert.deepEqual(reviewCreditOver([row(MAX - 1, 1)]).result, { sats: MAX - 1, milli: 1 }, "the next call starts from zero");
});

// Two review receipts that still hold credit, through the real core, then given synthetic
// amounts directly. credit must equal sats while credited.
async function reviewWorld() {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1), pay(2)]);
  read(w, ledger, invoice, [pay(1, "invalid"), pay(2, "invalid")]);
  const sql = w.ctx.storage.sql;
  const ids = sql.exec("SELECT id, state, credit FROM ra_receipts WHERE invoice = ? ORDER BY ord", invoice).toArray().map((r) => ({ ...r }));
  assert.deepEqual(ids.map((r) => [r.state, r.credit > 0]), [["review", true], ["review", true]]);
  const set = (i, { sats, milli }) => sql.exec("UPDATE ra_receipts SET sats = ?, credit = ?, milli = ? WHERE id = ?", sats, sats, milli, ids[i].id);
  return { w, ledger, set, ids, sql };
}

test("against real SQL rows: exact at the bound, null past it, and exact again once it sums safely", async () => {
  const { w, set, ids, sql } = await reviewWorld();
  const credit = () => w.object.receipts.reviewCredit();
  assert.deepEqual(credit(), { sats: 2000, milli: 2000 });
  set(0, { sats: MAX - 1000, milli: 7 });
  set(1, { sats: 1000, milli: MAX - 7 });
  assert.deepEqual(credit(), { sats: MAX, milli: MAX }, "both components exactly at the bound");
  set(1, { sats: 1001, milli: MAX - 7 });
  assert.equal(credit(), null, "sats one past");
  set(1, { sats: 1000, milli: MAX - 6 });
  assert.equal(credit(), null, "milli one past");
  // A review receipt with no credit is skipped, whatever its amount.
  sql.exec("UPDATE ra_receipts SET credit = 0 WHERE id = ?", ids[1].id);
  assert.deepEqual(credit(), { sats: MAX - 1000, milli: 7 });
  // Recovery below the bound.
  set(1, { sats: 5, milli: 5 });
  assert.deepEqual(credit(), { sats: MAX - 995, milli: 12 });
  // And what the pile shows from it: unrepresentable means review with no uncertain number.
  applyPileAnchor(w.ctx.storage, { anchor: "cost-anchor", expected: savedPileSnapshot(sql), milli: 0, boundary: 0, reason: "synthetic", evidence: "synthetic" }, w.platform.now());
  w.object.pushReceiptFrames();
  set(1, { sats: 1001, milli: 5 });
  assert.deepEqual([w.object.pileMessage().reconciliation, w.object.pileMessage().uncertain], ["review", null]);
});

// Every statement the core and the pile run through the object's storage, with how many rows
// each returned to JavaScript, and whether it was collected or iterated.
function instrument(sql) {
  const log = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...bindings) => {
    const result = exec(query, ...bindings);
    const entry = { query, returned: null, iterated: false };
    log.push(entry);
    return {
      toArray: () => { const rows = result.toArray(); entry.returned = rows.length; return rows; },
      one: () => { entry.returned = 1; return result.one(); },
      [Symbol.iterator]: () => { entry.iterated = true; return result[Symbol.iterator](); },
    };
  };
  return { log, restore: () => { sql.exec = exec; } };
}

const count = (sql, query) => sql.exec(query).one().n;

test("the snapshot's existence probes return at most one row however many records match, in every health state", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const sql = w.ctx.storage.sql;
  const probe = (name, fn) => {
    const { log, restore } = instrument(sql);
    const value = fn();
    restore();
    const probes = log.filter((e) => /^SELECT 1 FROM (ra_|pile_)/.test(e.query));
    for (const e of probes) assert.ok(e.returned <= 1, `${name}: ${e.query} returned ${e.returned} rows`);
    const review = log.filter((e) => e.query.includes("INDEXED BY ra_receipts_review"));
    for (const e of review) assert.deepEqual([e.iterated, e.returned], [true, null], `${name}: the review receipts are iterated, never collected`);
    return { value, probes: probes.length };
  };
  // Off: no receipt-mode invoice.
  assert.equal(probe("off", () => w.object.receipts.health()).value, "off");
  // Many invoices, each with unverified reads and undrained projection work: behind.
  const invoices = [];
  for (let n = 1; n <= 12; n++) {
    const { invoice } = await seed(w, ledger, { invoice: `CostInv${String(n).padStart(4, "0")}`, token: TOKEN(0x800 + n), addresses: [100 + n] });
    read(w, ledger, invoice, [{ ...pay(n), destination: syntheticAddress(100 + n) }]);
    invoices.push(invoice);
  }
  assert.ok(count(sql, "SELECT count(*) AS n FROM ra_invoices") >= 12);
  assert.ok(count(sql, "SELECT count(*) AS n FROM ra_outbox") >= 12, "many outbox rows match");
  const behind = probe("behind", () => [w.object.receipts.health(), w.object.receipts.hasMappings(), w.object.receipts.hasPendingProjection(), w.object.receipts.projectionConflict()]);
  assert.deepEqual(behind.value, ["behind", true, true, false]);
  assert.ok(behind.probes >= 4);
  // Current: every read verified complete and fresh, and D1 drained.
  for (const [i, invoice] of invoices.entries()) {
    read(w, ledger, invoice, [{ ...pay(i + 1), destination: syntheticAddress(101 + i) }], { capabilities: { complete: true } });
  }
  while (w.object.receipts.hasPendingProjection()) await w.object.projectReceipts();
  assert.equal(probe("current", () => w.object.receipts.health()).value, "current");
  // Review: many receipts held, and many pile exceptions, while the anchored pile is read.
  for (const [i, invoice] of invoices.entries()) {
    read(w, ledger, invoice, [{ ...pay(i + 1, "invalid"), destination: syntheticAddress(101 + i) }], { capabilities: { complete: true } });
  }
  assert.ok(count(sql, "SELECT count(*) AS n FROM ra_receipts WHERE state = 'review'") >= 12, "many review receipts match");
  w.object.pushReceiptFrames();
  applyPileAnchor(w.ctx.storage, { anchor: "cost-anchor", expected: savedPileSnapshot(sql), milli: 0, boundary: 0, reason: "synthetic", evidence: "synthetic" }, w.platform.now());
  for (let n = 1; n <= 12; n++) sql.exec("INSERT INTO pile_exceptions (source, reason, milli, at) VALUES (?, 'synthetic-review', NULL, 1)", `donation:CostExc${n}`);
  const review = probe("review", () => [w.object.receipts.health(), pileView(sql, w.object.pileAccounting()).reconciliation, w.object.receipts.reviewCredit()]);
  assert.deepEqual(review.value.slice(0, 2), ["review", "review"]);
  assert.equal(review.value[2].sats, 12 * 1000, "every review receipt's credit, exactly");
});

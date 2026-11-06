// Receipt ledger entries into the authoritative pile: each credit and reversal once, by its
// permanent identity, on top of the audited anchor. Through the real object, with receipt-mode
// mappings seeded through the core as provider ingestion would make them; issuance stays off.
// Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject, PRICE_FRESH_MS } from "../worker/object.mjs";
import { applyPileAnchor, savedPileSnapshot } from "../worker/pile.mjs";
import { pay, provider, read, RECEIPT_SETTINGS as SETTINGS, seed, TOKEN } from "./helpers/receipt-seed.mjs";
import { syntheticAddress } from "./helpers/synthetic-address.mjs";
import { world } from "./helpers/world.mjs";

const sql = (w) => w.ctx.storage.sql;
const rows = (w, query, ...args) => sql(w).exec(query, ...args).toArray().map((r) => ({ ...r }));
const deltas = (w) => rows(w, "SELECT seq, source, milli FROM pile_deltas ORDER BY seq");
const exceptions = (w) => rows(w, "SELECT source, reason, milli FROM pile_exceptions ORDER BY id");
const entries = (w) => rows(w, "SELECT seq, receipt, transition, kind, milli FROM ra_ledger ORDER BY seq");
const receiptsOf = (w, invoice) => rows(w, "SELECT id, state, credit FROM ra_receipts WHERE invoice = ? ORDER BY ord", invoice);
const meta = (w, key) => sql(w).exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
const restart = (w) => { w.object = new DonationsObject(w.ctx, w.env, w.platform); return w.object; };
const anchor = (w, fields) => applyPileAnchor(w.ctx.storage, {
  anchor: "cutover-1", expected: savedPileSnapshot(sql(w)), milli: 0, boundary: 0, reason: "synthetic review", evidence: "synthetic evidence", ...fields,
}, w.platform.now());
const pileOf = (w) => w.object.pileMessage();
const typed = (page, type) => page.messages().filter((m) => m.type === type);
const source = (e) => `receipt:${e.receipt}:${e.transition}`;

test("each receipt credit and reversal reaches the pile once, keyed by its ledger identity, and nothing repeats it", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  const [credit] = entries(w);
  assert.equal(credit.kind, "credit");
  assert.deepEqual(deltas(w).map(({ source, milli }) => ({ source, milli })), [{ source: source(credit), milli: 1000 }]);
  // A reversal, then a reconfirmation at the same frozen price: two more entries, each once.
  const [r] = receiptsOf(w, invoice);
  read(w, ledger, invoice, [pay(1, "invalid")]);
  ledger.reverse(r.id, "synthetic double spend");
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  const all = entries(w);
  assert.deepEqual(all.map((e) => [e.kind, e.milli]), [["credit", 1000], ["reversal", -1000], ["credit", 1000]]);
  assert.deepEqual(deltas(w).map(({ source, milli }) => ({ source, milli })), all.map((e) => ({ source: source(e), milli: e.milli })));
  // Pushing again, an alarm, and restarts add nothing.
  w.object.pushReceiptFrames();
  await w.fireAlarm();
  restart(w);
  restart(w).pushReceiptFrames();
  assert.equal(deltas(w).length, 3);
  assert.equal(meta(w, "receipt_pile_bridged"), all.at(-1).seq);
  assert.deepEqual(exceptions(w), []);
  // The receipt journal and the pile agree, entry for entry.
  assert.equal(deltas(w).reduce((s, d) => s + d.milli, 0), w.object.receipts.pileDelta().milli);
});

test("receipt credits fall on either side of the anchor's boundary and count exactly once", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  assert.equal(pileOf(w).cutover, "pending", "pending, with no number, until the anchor");
  assert.equal(pileOf(w).bananas, null);
  // The operator's reviewed level already includes the first credit.
  const [first] = deltas(w);
  assert.deepEqual(anchor(w, { milli: 50_000, boundary: first.seq }), { ok: true, duplicate: false });
  w.object.publishPile();
  assert.equal(pileOf(w).bananas, 50, "the boundary's credit isn't added again");
  // A later credit adds on top, once.
  read(w, ledger, invoice, [pay(1), pay(2, "settled", 2500)]);
  w.object.pushReceiptFrames();
  restart(w).pushReceiptFrames();
  assert.equal(pileOf(w).bananas, 52.5);
  // A reversal of the included credit takes it back on top of the reviewed level.
  const [r] = receiptsOf(w, invoice);
  read(w, ledger, invoice, [pay(1, "invalid"), pay(2, "settled", 2500)]);
  ledger.reverse(r.id, "synthetic double spend");
  w.object.pushReceiptFrames();
  assert.equal(pileOf(w).bananas, 51.5);
  assert.equal(deltas(w).length, 3);
});

test("a stop at every point of the bridge repeats and skips nothing", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  // Committed in the receipt ledger, and the object stops before bridging: the next start does it.
  read(w, ledger, invoice, [pay(1), pay(2)]);
  assert.equal(deltas(w).length, 0);
  restart(w);
  assert.equal(deltas(w).length, 2, "recovered at start");
  // A stop inside the bridge's transaction, after its delta and before its mark: all rolled back.
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)]);
  const exec = sql(w).exec;
  let stopped = false;
  sql(w).exec = (query, ...args) => {
    if (!stopped && query.startsWith("UPDATE meta SET value = ? WHERE key = 'receipt_pile_bridged'")) {
      stopped = true;
      throw new Error("synthetic stop inside the bridge");
    }
    return exec.call(sql(w), query, ...args);
  };
  assert.throws(() => w.object.pushReceiptFrames(), /synthetic stop/);
  sql(w).exec = exec;
  assert.equal(deltas(w).length, 2, "the delta rolled back with its mark");
  restart(w);
  assert.deepEqual(deltas(w).map((d) => d.source), entries(w).map(source), "each entry exactly once, in ledger order");
  // Sockets still open after the stop get the pile when receipts move on; a reconnect gets it at once.
  const page = await w.connectPage();
  const connected = typed(page, "pile").at(-1);
  assert.equal(connected.revision, pileOf(w).revision, "a reconnect gets the current pile");
});

test("retained receipt entries from before the bridge: added when no anchor existed, held when one did", async () => {
  for (const anchoredBefore of [false, true]) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    // The object as code without the bridge left it: receipt entries in the journal, none in the
    // pile, and no bridge mark.
    sql(w).exec("DELETE FROM meta WHERE key IN ('receipt_pile_bridged', 'receipt_pile_retained', 'receipt_pile_retained_anchored')");
    read(w, ledger, invoice, [pay(1), pay(2)]);
    if (anchoredBefore) {
      // Today's anchor refuses while the journal holds entries the bridge never moved.
      assert.deepEqual(anchor(w, { milli: 7_000 }), { error: "bridge" });
      // An anchor the earlier code, without that check, could have stored.
      sql(w).exec("INSERT INTO pile_anchor (id, anchor, expected, milli, boundary, included, reason, evidence, applied_at) VALUES (1, 'cutover-1', 'null', 7000, 0, 0, 'synthetic review', 'synthetic evidence', ?)",
        w.platform.now());
    }
    restart(w);
    const retained = entries(w);
    if (!anchoredBefore) {
      assert.deepEqual(deltas(w).map((d) => d.source), retained.map(source), "queued credits, before any anchor, reviewed with it later");
      assert.deepEqual(exceptions(w), []);
    } else {
      // Nobody can say whether the reviewed level already included them: held, never added.
      assert.deepEqual(deltas(w), []);
      assert.deepEqual(exceptions(w), retained.map((e) => ({ source: source(e), reason: "receipt-before-bridge", milli: e.milli })));
      assert.deepEqual([pileOf(w).bananas, pileOf(w).reconciliation], [7, "review"], "the level is the anchor's, and says review");
      // A credit after the bridge started adds as usual; the held ones stay held.
      read(w, ledger, invoice, [pay(1), pay(2), pay(3, "settled", 4000)]);
      w.object.pushReceiptFrames();
      assert.deepEqual(deltas(w).map((d) => d.milli), [4000]);
      assert.equal(pileOf(w).bananas, 11);
      assert.equal(exceptions(w).length, retained.length);
    }
  }
});

test("an invoice the pile knows as a legacy donation never also counts as receipts", async () => {
  for (const known of ["finished", "pile_legacy"]) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    if (known === "finished") sql(w).exec("INSERT INTO finished (invoice, at) VALUES (?, 1)", invoice);
    else sql(w).exec("INSERT INTO pile_legacy (source, reason) VALUES (?, 'in-checkpoint')", `donation:${invoice}`);
    read(w, ledger, invoice, [pay(1)]);
    w.object.pushReceiptFrames();
    assert.deepEqual(deltas(w), [], known);
    const [e] = entries(w);
    assert.deepEqual(exceptions(w), [{ source: source(e), reason: "legacy-and-receipt", milli: 1000 }], known);
  }
});

test("an entry whose amount can't be represented exactly is held, never rounded; a negative level reports review", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  read(w, ledger, invoice, [pay(1)]);
  // Synthetic damage to the journal: a non-integer amount.
  sql(w).exec("UPDATE ra_pile_deltas SET milli = 1000.5");
  w.object.pushReceiptFrames();
  assert.deepEqual(deltas(w), []);
  assert.deepEqual(exceptions(w).map((e) => [e.reason, e.milli]), [["unrepresentable-entry", null]]);
  // A reviewed level of zero that already included a credit, then its reversal: never clamped.
  const w2 = await world(SETTINGS);
  const ledger2 = provider(w2);
  const other = await seed(w2, ledger2);
  read(w2, ledger2, other.invoice, [pay(1)]);
  w2.object.pushReceiptFrames();
  anchor(w2, { milli: 0, boundary: deltas(w2)[0].seq });
  read(w2, ledger2, other.invoice, [pay(1, "invalid")]);
  ledger2.reverse(receiptsOf(w2, other.invoice)[0].id, "synthetic double spend");
  w2.object.pushReceiptFrames();
  assert.deepEqual([pileOf(w2).bananas, pileOf(w2).reconciliation, pileOf(w2).uncertain], [null, "review", null]);
});

test("the anchored pile in receipt mode says how sure it is: never current while the bridge or any read lags", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w, { milli: 10_000 });
  const page = await w.connectPage();
  await w.ctx.settle();
  // A verified complete read, and D1 holds the projection, but the bridge hasn't run yet.
  read(w, ledger, invoice, [pay(1)], { capabilities: { complete: true } });
  await w.object.projectReceipts();
  assert.equal(w.object.receipts.health(), "current");
  assert.equal(pileOf(w).reconciliation, "behind", "the bridge is behind: not current");
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  assert.deepEqual([pileOf(w).bananas, pileOf(w).reconciliation, pileOf(w).uncertain], [11, "current", { sats: 0, bananas: 0 }]);
  // A receipt held for review still carries its credit: counted, but uncertain, and review.
  const before = pileOf(w).revision;
  read(w, ledger, invoice, [pay(1, "invalid")], { capabilities: { complete: true } });
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  const held = typed(page, "pile").at(-1);
  assert.deepEqual([held.bananas, held.reconciliation, held.uncertain], [11, "review", { sats: 1000, bananas: 1 }]);
  assert.ok(held.revision > before, "a change in health alone gets a new revision");
  // Without a verified read, reads lag: never current.
  const w2 = await world(SETTINGS);
  const ledger2 = provider(w2);
  const other = await seed(w2, ledger2);
  anchor(w2, { milli: 10_000 });
  read(w2, ledger2, other.invoice, [pay(1)]);
  w2.object.pushReceiptFrames();
  await w2.object.projectReceipts();
  assert.equal(pileOf(w2).reconciliation, "behind");
});

test("the bridge moves at most the saved replay bound per step, and the alarm finishes it", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w, { replayMax: 1 });
  const { invoice } = await seed(w, ledger, { invoice: "BoundInv01", token: TOKEN(0x701), addresses: [1] });
  read(w, ledger, invoice, [pay(1), { ...pay(2), destination: syntheticAddress(1) }, { ...pay(3), destination: syntheticAddress(1) }]);
  w.object.pushReceiptFrames();
  assert.equal(deltas(w).length, 1, "one entry per step");
  assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), "the rest is due at once");
  for (let i = 0; i < 5 && deltas(w).length < 3; i++) await w.fireAlarm();
  assert.deepEqual(deltas(w).map((d) => d.source), entries(w).map(source));
});

test("a stop after the pile moved but before pages heard it: connected pages get it from the next start's alarm, once", async () => {
  for (const boundary of ["after the bridge", "after the receipt frames"]) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    anchor(w, { milli: 10_000 });
    const page = await w.connectPage();
    await w.ctx.settle();
    const heard = typed(page, "pile").at(-1);
    read(w, ledger, invoice, [pay(1)]);
    if (boundary === "after the bridge") w.object.bridgeReceipts();
    else {
      // The frames go out and their mark moves; the object stops before the pile is sent.
      w.object.publishPile = () => { throw new Error("synthetic stop before the pile"); };
      assert.throws(() => w.object.pushReceiptFrames(), /synthetic stop/);
      assert.ok(typed(page, "receipt").length > 0, `${boundary}: the receipt frames were heard`);
      // The stopped instance's background work ends with it, failing the same way.
      await assert.rejects(w.ctx.settle(), /synthetic stop/);
    }
    assert.equal(typed(page, "pile").at(-1).revision, heard.revision, `${boundary}: the page hasn't heard the pile`);
    // The page's socket survives the stop. Nothing about receipts changes after it.
    restart(w);
    await w.ctx.settle();
    assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), `${boundary}: the start schedules the alarm`);
    await w.fireAlarm();
    const recovered = typed(page, "pile").at(-1);
    assert.ok(recovered.revision > heard.revision, `${boundary}: the surviving page hears the newer pile`);
    assert.equal(recovered.bananas, 11);
    assert.deepEqual(recovered, w.object.pileMessage(), `${boundary}: exactly the current pile`);
    // Once heard, never again, and no alarm loop.
    const count = typed(page, "pile").length;
    await w.fireAlarm();
    restart(w);
    await w.fireAlarm();
    assert.equal(typed(page, "pile").length, count, `${boundary}: sent once`);
    assert.ok(await w.ctx.storage.getAlarm() > w.platform.now(), `${boundary}: no immediate alarm left`);
    // A page that reconnects is sent the current pile at once.
    const again = await w.connectPage(undefined, "visitor-again");
    assert.deepEqual(typed(again, "pile").at(-1), recovered);
  }
});

// Makes a page's pile sends fail as a stop would, while the page stays open, until released.
// Every attempt fails meanwhile, including the D1 projection's own publication in the
// background, so only the recovery path under test can deliver it.
function failPiles(page, error = "synthetic stop during the send") {
  const send = page.send.bind(page);
  let armed = true;
  page.send = (text) => {
    if (armed && JSON.parse(text).type === "pile") throw new Error(error);
    return send(text);
  };
  return () => { armed = false; };
}

test("the pile is acknowledged only after every open page took it: a stop before any send, or after some, is sent again", async () => {
  for (const [variant, recovery] of [["before any send", "alarm"], ["after some pages", "alarm"], ["before any send", "restart"], ["after some pages", "restart"]]) {
    const name = `${variant}, recovered by ${recovery}`;
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    anchor(w, { milli: 10_000 });
    const first = await w.connectPage(undefined, "visitor-1");
    const second = await w.connectPage(undefined, "visitor-2");
    await w.ctx.settle();
    const acked = meta(w, "pile_broadcast");
    // Before any send: no page takes it. After some: the first does, the second doesn't.
    const releases = (variant === "before any send" ? [first, second] : [second]).map((p) => failPiles(p));
    read(w, ledger, invoice, [pay(1)]);
    // A page's failure is never thrown at the caller, nor at the background publication.
    assert.doesNotThrow(() => w.object.pushReceiptFrames(), name);
    await w.ctx.settle();
    const current = pileOf(w);
    assert.equal(meta(w, "pile_broadcast"), acked, `${name}: never acknowledged`);
    assert.equal(typed(first, "pile").at(-1).revision === current.revision, variant === "after some pages", `${name}: the first page`);
    assert.notEqual(typed(second, "pile").at(-1)?.revision, current.revision, `${name}: the second didn't`);
    // No new payment and no receipt change: only the alarm, or a start, sends it again.
    for (const release of releases) release();
    if (recovery === "restart") {
      restart(w);
      await w.ctx.settle();
      assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), `${name}: the start sets the alarm`);
    } else {
      const at = await w.ctx.storage.getAlarm();
      assert.ok(at > w.platform.now() && at <= w.platform.now() + PRICE_FRESH_MS, `${name}: the existing alarm, never immediate`);
      w.platform.advance(at - w.platform.now());
    }
    await w.fireAlarm();
    for (const page of [first, second]) assert.deepEqual(typed(page, "pile").at(-1), current, `${name}: every page has it`);
    assert.equal(meta(w, "pile_broadcast"), current.revision, `${name}: acknowledged after delivery`);
    // At least once, by revision: a page that had it may hear it again, and dedupes it.
    const counts = [first, second].map((p) => typed(p, "pile").length);
    await w.fireAlarm();
    assert.deepEqual([first, second].map((p) => typed(p, "pile").length), counts, `${name}: not sent again once acknowledged`);
    assert.ok(await w.ctx.storage.getAlarm() > w.platform.now(), `${name}: no tight loop`);
  }
});

test("a page closing or closed never blocks the acknowledgement; only an open page's failure does", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w, { milli: 10_000 });
  const open = await w.connectPage(undefined, "visitor-1");
  const closing = await w.connectPage(undefined, "visitor-2");
  const vanishing = await w.connectPage(undefined, "visitor-3");
  await w.ctx.settle();
  closing.readyState = 2;
  // A page that closes during the send: its failure is the ordinary kind.
  const send = vanishing.send.bind(vanishing);
  vanishing.send = (text) => {
    if (JSON.parse(text).type === "pile") {
      vanishing.readyState = 3;
      throw new Error("socket is not open");
    }
    return send(text);
  };
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  const current = pileOf(w);
  assert.deepEqual(typed(open, "pile").at(-1), current);
  assert.equal(meta(w, "pile_broadcast"), current.revision, "acknowledged: every open page took it");
});

test("a failure right after a delta commits is recovered by the existing alarm in the same instance, with no new payment", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w);
  const { invoice } = await seed(w, ledger);
  anchor(w, { milli: 10_000 });
  const page = await w.connectPage();
  await w.ctx.settle();
  const alarm = await w.ctx.storage.getAlarm();
  assert.ok(alarm !== null && alarm > w.platform.now(), "a connected page keeps an alarm set");
  // The delta commits in the bridge; the pile's publication then fails in the same instance.
  const release = failPiles(page, "synthetic runtime failure after the delta");
  read(w, ledger, invoice, [pay(1)]);
  assert.doesNotThrow(() => w.object.pushReceiptFrames(), "the page's failure isn't the caller's");
  await w.ctx.settle();
  assert.equal(deltas(w).length, 1, "the delta is committed");
  assert.equal(w.object.receipts.hasPendingProjection(), false, "the work after the send still ran: D1 drained");
  assert.ok(typed(page, "receipt").length > 0, "and the receipt frames went out");
  assert.ok(meta(w, "pile_broadcast") < pileOf(w).revision, "its publication isn't acknowledged");
  let at = await w.ctx.storage.getAlarm();
  assert.ok(at > w.platform.now() && at <= w.platform.now() + PRICE_FRESH_MS, "the alarm stays on its cadence");
  // The alarm's own attempt fails too: it completes, and sets the next one on its cadence.
  w.platform.advance(at - w.platform.now());
  await w.fireAlarm();
  at = await w.ctx.storage.getAlarm();
  assert.ok(at > w.platform.now() && at <= w.platform.now() + PRICE_FRESH_MS, "rescheduled, never immediate");
  assert.ok(meta(w, "pile_broadcast") < pileOf(w).revision);
  release();
  w.platform.advance(at - w.platform.now());
  await w.fireAlarm();
  assert.deepEqual(typed(page, "pile").at(-1), pileOf(w));
  assert.equal(typed(page, "pile").at(-1).bananas, 11);
  assert.equal(meta(w, "pile_broadcast"), pileOf(w).revision);
});

test("the anchor is refused while receipt journal entries wait for the bridge, then accepted once they are all in", async () => {
  const w = await world(SETTINGS);
  const ledger = provider(w, { replayMax: 1 });
  const { invoice } = await seed(w, ledger, { invoice: "AnchorInv1", token: TOKEN(0x711), addresses: [1] });
  read(w, ledger, invoice, [pay(1), { ...pay(2), destination: syntheticAddress(1) }, { ...pay(3), destination: syntheticAddress(1) }]);
  w.object.pushReceiptFrames();
  assert.equal(deltas(w).length, 1, "one bounded batch moved, two entries wait");
  for (const boundary of [0, deltas(w)[0].seq]) assert.deepEqual(anchor(w, { milli: 5_000, boundary }), { error: "bridge" }, `boundary ${boundary}`);
  assert.equal(rows(w, "SELECT count(*) AS n FROM pile_anchor")[0].n, 0, "nothing stored");
  await w.fireAlarm();
  assert.equal(deltas(w).length, 2);
  assert.deepEqual(anchor(w, { milli: 5_000 }), { error: "bridge" }, "still one waiting");
  await w.fireAlarm();
  assert.equal(deltas(w).length, 3);
  // Every entry is a delta now: the reviewed level can name exactly what it includes.
  const last = deltas(w).at(-1).seq;
  assert.deepEqual(anchor(w, { milli: 5_000, boundary: last }), { ok: true, duplicate: false });
  assert.equal(pileOf(w).bananas, 5);
  // A later backlog never changes an existing anchor's replies.
  read(w, ledger, invoice, [pay(1), { ...pay(2), destination: syntheticAddress(1) }, { ...pay(3), destination: syntheticAddress(1) }, { ...pay(4), destination: syntheticAddress(1) }]);
  assert.deepEqual(anchor(w, { milli: 5_000, boundary: last }), { ok: true, duplicate: true });
  assert.deepEqual(anchor(w, { milli: 6_000, boundary: last }), { error: "anchored" });
  w.object.pushReceiptFrames();
  assert.equal(pileOf(w).bananas, 6, "the later credit adds on top");
  // A store whose journal the bridge never started on can't be anchored either.
  const w2 = await world(SETTINGS);
  const ledger2 = provider(w2);
  const other = await seed(w2, ledger2);
  read(w2, ledger2, other.invoice, [pay(1)]);
  sql(w2).exec("DELETE FROM meta WHERE key = 'receipt_pile_bridged'");
  assert.deepEqual(anchor(w2, { milli: 5_000 }), { error: "bridge" });
});

test("a held receipt's later reversal and reconfirmation stay held with it; other receipts go on", async () => {
  for (const held of ["receipt-before-bridge", "unrepresentable-entry"]) {
    const w = await world(SETTINGS);
    const ledger = provider(w);
    const { invoice } = await seed(w, ledger);
    if (held === "receipt-before-bridge") {
      sql(w).exec("DELETE FROM meta WHERE key IN ('receipt_pile_bridged', 'receipt_pile_retained', 'receipt_pile_retained_anchored')");
      read(w, ledger, invoice, [pay(1)]);
      sql(w).exec("INSERT INTO pile_anchor (id, anchor, expected, milli, boundary, included, reason, evidence, applied_at) VALUES (1, 'cutover-1', 'null', 7000, 0, 0, 'synthetic review', 'synthetic evidence', ?)",
        w.platform.now());
      restart(w);
    } else {
      sql(w).exec("INSERT INTO pile_anchor (id, anchor, expected, milli, boundary, included, reason, evidence, applied_at) VALUES (1, 'cutover-1', 'null', 7000, 0, 0, 'synthetic review', 'synthetic evidence', ?)",
        w.platform.now());
      read(w, ledger, invoice, [pay(1)]);
      sql(w).exec("UPDATE ra_pile_deltas SET milli = 1000.5");
      w.object.pushReceiptFrames();
    }
    assert.deepEqual(exceptions(w).map((e) => e.reason), [held], held);
    // The same receipt reversed, then reconfirmed: neither subtracts what was never added, nor
    // adds it without settling the first.
    const [r] = receiptsOf(w, invoice);
    read(w, ledger, invoice, [pay(1, "invalid")]);
    ledger.reverse(r.id, "synthetic double spend");
    read(w, ledger, invoice, [pay(1)]);
    w.object.pushReceiptFrames();
    restart(w).pushReceiptFrames();
    const lineage = entries(w).filter((e) => e.receipt === r.id);
    assert.deepEqual(lineage.map((e) => e.kind), ["credit", "reversal", "credit"], held);
    assert.deepEqual(exceptions(w).map((e) => [e.source, e.reason]),
      lineage.map((e, i) => [source(e), i === 0 ? held : "receipt-lineage-held"]), `${held}: the whole lineage held`);
    assert.deepEqual(deltas(w), [], `${held}: nothing of it in the pile`);
    assert.deepEqual([pileOf(w).bananas, pileOf(w).reconciliation], [7, "review"], `${held}: the anchor's level, in review`);
    // An unrelated receipt credits as usual.
    read(w, ledger, invoice, [pay(1), pay(2, "settled", 3000)]);
    w.object.pushReceiptFrames();
    const [, other] = receiptsOf(w, invoice);
    assert.deepEqual(deltas(w).map((d) => [d.source.startsWith(`receipt:${other.id}:`), d.milli]), [[true, 3000]], held);
    assert.equal(pileOf(w).bananas, 10);
  }
});

test("a legacy-only object's pile is exactly as before", async () => {
  const w = await world(SETTINGS);
  anchor(w, { milli: 3_000 });
  const pile = pileOf(w);
  assert.deepEqual({ ...pile, revision: 0 }, { type: "pile", bananas: 3, at: pile.at, eatPerHour: 0, revision: 0, basis: "credits",
    cutover: "done", reconciliation: "off", uncertain: { sats: 0, bananas: 0 } });
  assert.equal(meta(w, "receipt_pile_bridged"), 0);
});

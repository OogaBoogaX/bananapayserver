// Live receipt and invoiceStatus frames, per page, in order, at least once. "Sent" here means
// ws.send took the frame for the page without failing: an enqueue on the socket, never proof
// the page received it. Through the real object; mappings seeded through the core as provider
// ingestion would make them, issuance off. Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { DonationsObject, PRICE_FRESH_MS } from "../worker/object.mjs";
import { pay, provider, read, RECEIPT_SETTINGS as SETTINGS, seed } from "./helpers/receipt-seed.mjs";
import { world } from "./helpers/world.mjs";

const LIVE = new Set(["receipt", "invoiceStatus"]);
const live = (page) => page.messages().filter((m) => LIVE.has(m.type));
const seqs = (page) => live(page).map((m) => m.seq);
const position = (page) => page.deserializeAttachment().through;
const high = (w) => w.object.receipts.feedHighWater();
const restart = (w) => { w.object = new DonationsObject(w.ctx, w.env, w.platform); return w.object; };
const firstCredits = (page) => live(page).filter((m) => m.type === "receipt" && m.receipt.state === "credited" && m.seq === m.receipt.firstCreditedSeq);

// Makes a page's live frame sends fail while it stays open, after `after` more succeed, `times`
// times (every time by default), until released. Counts the attempts.
function failFrames(page, { after = 0, times = Infinity } = {}) {
  const send = page.send.bind(page);
  const state = { armed: true, left: after, failures: times, attempts: 0 };
  page.send = (text) => {
    if (state.armed && LIVE.has(JSON.parse(text).type)) {
      state.attempts += 1;
      if (state.left-- <= 0 && state.failures > 0) {
        state.failures -= 1;
        throw new Error("synthetic failure on an open page");
      }
    }
    return send(text);
  };
  state.release = () => { state.armed = false; };
  return state;
}

async function setup({ pages = 2, read: readSettings } = {}) {
  const w = await world(SETTINGS);
  const ledger = provider(w, readSettings);
  const { invoice } = await seed(w, ledger);
  const connected = [];
  for (let i = 0; i < pages; i++) connected.push(await w.connectPage(undefined, `visitor-${i}`));
  await w.ctx.settle();
  return { w, ledger, invoice, pages: connected };
}

test("before any send, or after some pages: no position moves past an untaken frame, and the retry sends exactly what was missed", async () => {
  for (const [variant, recovery] of [["before any send", "alarm"], ["after some pages", "alarm"], ["before any send", "restart"], ["after some pages", "restart"]]) {
    const name = `${variant}, recovered by ${recovery}`;
    const { w, ledger, invoice, pages: [first, second] } = await setup();
    const start = [position(first), position(second)];
    const failing = (variant === "before any send" ? [first, second] : [second]).map((p) => failFrames(p));
    read(w, ledger, invoice, [pay(1)]);
    w.object.pushReceiptFrames();
    await w.ctx.settle();
    const top = high(w);
    assert.equal(position(second), start[1], `${name}: the failing page's position didn't move`);
    assert.deepEqual(seqs(second), [], name);
    if (variant === "after some pages") {
      assert.equal(position(first), top, `${name}: the healthy page was sent everything`);
      assert.deepEqual(seqs(first), Array.from({ length: top - start[0] }, (_, i) => start[0] + 1 + i));
    } else {
      assert.equal(position(first), start[0]);
    }
    // Retried on the cadence, never at once: no new receipt, no new payment.
    for (const f of failing) f.release();
    if (recovery === "restart") {
      restart(w);
      await w.ctx.settle();
    }
    const at = await w.ctx.storage.getAlarm();
    assert.ok(at > w.platform.now() && at <= w.platform.now() + PRICE_FRESH_MS, `${name}: retried on the cadence, never immediately`);
    const sentBefore = seqs(first).length;
    w.platform.advance(at - w.platform.now());
    await w.fireAlarm();
    for (const page of [first, second]) {
      assert.equal(position(page), top, `${name}: every page sent everything`);
      assert.deepEqual(seqs(page), Array.from({ length: top - start[0] }, (_, i) => start[0] + 1 + i), `${name}: in order, each once`);
      assert.equal(firstCredits(page).length, 1, `${name}: one first-credit frame, so one animation`);
    }
    if (variant === "after some pages") assert.equal(seqs(first).length, sentBefore, `${name}: nothing sent again to the healthy page`);
  }
});

test("a failure in the middle of a page's batch stops it at that frame: never a later frame first", async () => {
  const { w, ledger, invoice, pages: [page] } = await setup({ pages: 1 });
  const start = position(page);
  // Only the second frame fails, once: the third would be taken if it were tried.
  const failing = failFrames(page, { after: 1, times: 1 });
  read(w, ledger, invoice, [pay(1), pay(2)]);
  assert.ok(high(w) - start >= 3);
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  assert.deepEqual(seqs(page), [start + 1], "the first frame, and nothing after the failed one");
  assert.equal(position(page), start + 1);
  failing.release();
  const at = await w.ctx.storage.getAlarm();
  w.platform.advance(at - w.platform.now());
  await w.fireAlarm();
  assert.deepEqual(seqs(page), Array.from({ length: high(w) - start }, (_, i) => start + 1 + i), "the rest, in order");
});

test("a stuck open page is retried once per cadence, never in a tight loop, and never holds healthy pages back", async () => {
  const { w, ledger, invoice, pages: [healthy, stuck] } = await setup();
  const failing = failFrames(stuck);
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  assert.equal(failing.attempts, 1);
  // More receipts while the stuck page waits: the healthy page hears each, live, at once.
  for (const n of [2, 3]) {
    read(w, ledger, invoice, Array.from({ length: n }, (_, i) => pay(i + 1)));
    w.object.pushReceiptFrames();
    assert.equal(position(healthy), high(w), `payment ${n}: the healthy page is current`);
  }
  assert.equal(failing.attempts, 1, "no retry before its time");
  await w.ctx.settle();
  assert.ok(await w.ctx.storage.getAlarm() > w.platform.now(), "no immediate alarm for the stuck page");
  // Each cadence, one more attempt.
  for (const expected of [2, 3]) {
    const at = await w.ctx.storage.getAlarm();
    w.platform.advance(at - w.platform.now());
    await w.fireAlarm();
    assert.equal(failing.attempts, expected);
    assert.ok(await w.ctx.storage.getAlarm() > w.platform.now());
  }
  assert.deepEqual(seqs(stuck), []);
});

test("closing and closed pages are skipped, and never hold the mark or healthy pages back", async () => {
  const { w, ledger, invoice, pages: [healthy, closing, vanishing] } = await setup({ pages: 3 });
  closing.readyState = 2;
  // A page that closes during its send fails the ordinary way: no retry is kept for it.
  const send = vanishing.send.bind(vanishing);
  vanishing.send = (text) => {
    if (LIVE.has(JSON.parse(text).type)) {
      vanishing.readyState = 3;
      throw new Error("socket is not open");
    }
    return send(text);
  };
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  await w.ctx.settle();
  assert.equal(position(healthy), high(w));
  assert.equal(w.object.receiptFramesDue(), null, "nothing is due: the open page is current");
  assert.deepEqual(seqs(closing), []);
});

test("each page hears live only frames after its own connect's mark, and the marker progresses per page", async () => {
  const { w, ledger, invoice, pages: [early] } = await setup({ pages: 1 });
  read(w, ledger, invoice, [pay(1)]);
  w.object.pushReceiptFrames();
  const afterFirst = high(w);
  // A page connecting now captured everything so far in its snapshot: nothing earlier is live.
  const late = await w.connectPage(undefined, "visitor-late");
  assert.equal(position(late), afterFirst);
  read(w, ledger, invoice, [pay(1), pay(2)]);
  w.object.pushReceiptFrames();
  assert.ok(seqs(late).every((s) => s > afterFirst) && seqs(late).length > 0, "only after its own mark");
  assert.deepEqual(seqs(early), Array.from({ length: high(w) }, (_, i) => i + 1));
  assert.ok(late.messages().filter((m) => LIVE.has(m.type) && m.replay === false).every((m) => m.seq > afterFirst));
  assert.deepEqual([position(early), position(late)], [high(w), high(w)]);
});

test("bounded batches per page, finished by the alarm, in order", async () => {
  const { w, ledger, invoice, pages: [page] } = await setup({ pages: 1, read: { replayMax: 2 } });
  read(w, ledger, invoice, [pay(1), pay(2), pay(3)]);
  w.object.pushReceiptFrames();
  assert.equal(seqs(page).length, 2, "at most the saved replay bound per call");
  assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), "the rest is due at once");
  for (let i = 0; i < 5 && position(page) < high(w); i++) await w.fireAlarm();
  assert.deepEqual(seqs(page), Array.from({ length: high(w) }, (_, i) => i + 1));
});

test("a page that stayed connected across a stop gets what it missed from the next start, with no new receipt", async () => {
  const { w, ledger, invoice, pages: [page] } = await setup({ pages: 1 });
  // An observation that credits nothing, so the pile doesn't move and only the frames are owed.
  // Committed, and the object stops before pushing anything.
  const pile = w.object.pileMessage().revision;
  read(w, ledger, invoice, [pay(1, "observed")]);
  assert.ok(high(w) > position(page));
  restart(w);
  assert.equal(w.object.pileMessage().revision, pile, "nothing owed on the pile");
  await w.ctx.settle();
  assert.equal(await w.ctx.storage.getAlarm(), w.platform.now(), "the start sets the alarm at once");
  await w.fireAlarm();
  assert.deepEqual(seqs(page), Array.from({ length: high(w) }, (_, i) => i + 1));
  await w.fireAlarm();
  assert.equal(seqs(page).length, high(w), "sent once");
  assert.ok(await w.ctx.storage.getAlarm() > w.platform.now(), "no tight loop");
});

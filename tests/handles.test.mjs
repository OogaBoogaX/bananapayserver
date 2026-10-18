import assert from "node:assert/strict";
import test from "node:test";
import { cleanHandle } from "../shared/handle.mjs";
import { BOLT11 } from "./helpers/values.mjs";
import { donor, EXPIRES, world } from "./helpers/world.mjs";

const HANDLES = [
  [" @".repeat(24) + "x".repeat(45), "x".repeat(39)],
  [" @ @ chosen ", "chosen"],
  ["\t<@🍌 @ chosen> ", "chosen"],
  ["@" + "x".repeat(38) + " y", "x".repeat(38)],
  [" @ @ ooga @ friend ", "ooga @ friend"],
  [" @ @ ", "anon"],
  ["", "anon"],
];

test("handle cleaning is idempotent, including a space at the length boundary", () => {
  for (const [handle, expected] of HANDLES) {
    assert.equal(cleanHandle(handle), expected);
    assert.equal(cleanHandle(cleanHandle(handle)), expected);
  }
});

test("invoice and note use the same handle after removing its prefix before truncation", async () => {
  for (const [handle, expected] of HANDLES) {
    const w = await world();
    const relay = await w.connectRelay();
    const { asked, response } = await w.invoice(relay, { sats: 1000, handle, message: "keep this" });
    assert.equal(response.status, 200);
    assert.equal(w.ctx.storage.sql.exec("SELECT handle FROM pending").one().handle, expected, `invoice ${JSON.stringify(handle)}`);
    const noted = await w.post("/donations/note", { request: asked.request, handle });
    assert.equal(noted.status, 204);
    assert.deepEqual({ ...w.ctx.storage.sql.exec("SELECT handle, message FROM pending").one() }, { handle: expected, message: "keep this" });
  }
});

test("omitted legacy handles preserve anonymous and account defaults", async () => {
  for (const [body, who, expected] of [
    [{ sats: 1000 }, null, ""],
    [{ sats: 1000 }, donor("account-login"), "account-login"],
    [{ sats: 1000, anon: true }, donor("account-login"), ""],
    [{ sats: 1000, handle: "" }, donor("account-login"), "anon"],
  ]) {
    const w = await world();
    const relay = await w.connectRelay();
    await w.invoice(relay, body, undefined, { donor: who });
    assert.equal(w.ctx.storage.sql.exec("SELECT handle FROM pending").one().handle, expected);
  }
});

test("autosaves have a separate note budget and a refused save keeps the last saved details", async () => {
  const w = await world({ RATE_PER_IP: "2", NOTE_RATE_PER_IP: "4" });
  const relay = await w.connectRelay();
  const { asked } = await w.invoice(relay, { sats: 1000, handle: "first" });
  for (let edit = 1; edit <= 4; edit++) {
    w.platform.advance(350);
    const response = await w.post("/donations/note", { request: asked.request, handle: `edit-${edit}`, message: `message ${edit}` });
    assert.equal(response.status, 204);
  }
  const refused = await w.post("/donations/note", { request: asked.request, handle: "not-saved", message: "not saved" });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: "busy" });
  assert.deepEqual({ ...w.ctx.storage.sql.exec("SELECT handle, message FROM pending WHERE request = ?", asked.request).one() }, { handle: "edit-4", message: "message 4" });

  const second = await w.invoice(relay, { sats: 1000 }, () => ({ id: "SecondInv123", bolt11: BOLT11, expires: EXPIRES }));
  assert.equal(second.response.status, 200, "notes do not consume the invoice budget");
  assert.equal((await w.post("/donations/invoice", { sats: 1000 })).status, 429, "the invoice budget is still enforced");
  w.platform.advance(60_000);
  assert.equal((await w.post("/donations/note", { request: asked.request, handle: "saved-after-reset" })).status, 204);
  assert.equal(w.ctx.storage.sql.exec("SELECT handle FROM pending WHERE request = ?", asked.request).one().handle, "saved-after-reset");
});

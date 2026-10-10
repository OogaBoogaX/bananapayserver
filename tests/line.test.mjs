// The line keeper: dials, passes on only protocol messages, pings, gives up on a silent line,
// and redials with a delay.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Line } from "../relay/line.mjs";
import { until } from "./helpers/cloudflare.mjs";
import { REQUEST } from "./helpers/values.mjs";

class FakeSocket extends EventEmitter {
  sent = [];
  pings = 0;
  terminated = false;
  send(text) {
    this.sent.push(text);
  }
  ping() {
    this.pings += 1;
    if (this.answers) queueMicrotask(() => this.emit("pong"));
  }
  close(code) {
    this.emit("close", { code, reason: "" });
  }
  terminate() {
    this.terminated = true;
    this.emit("close", { code: 1006, reason: "" });
  }
}

function setup({ answers = true, fail = 0, ...options } = {}) {
  const sockets = [];
  let failures = fail;
  const logs = [];
  const line = new Line({
    open: async () => {
      if (failures-- > 0) throw new Error("proxy unreachable");
      const socket = Object.assign(new FakeSocket(), { answers });
      sockets.push(socket);
      return socket;
    },
    pingMs: 5,
    deadMs: 25,
    maxDelayMs: 4,
    random: () => 0,
    log: (message) => logs.push(message),
    ...options,
  });
  return { line, sockets, logs };
}

test("the line passes on protocol messages and drops the rest", async (t) => {
  const { line, sockets, logs } = setup();
  t.after(() => line.stop());
  const messages = [];
  line.on("message", (m) => messages.push(m));
  line.start();
  await until(() => line.connected);
  sockets[0].emit("message", JSON.stringify({ type: "invoice", request: REQUEST, sats: 1000 }));
  sockets[0].emit("message", JSON.stringify({ type: "invoice", request: REQUEST, sats: 1000, extra: 1 }));
  assert.deepEqual(messages, [{ type: "invoice", request: REQUEST, sats: 1000 }]);
  assert.ok(logs.includes("line: dropped a message that isn't the protocol"));
  assert.equal(line.send({ type: "paid", invoice: "Inv0ice1234", sats: 1 }), true);
  assert.deepEqual(sockets[0].sent, ['{"type":"paid","invoice":"Inv0ice1234","sats":1}']);
});

test("a line that answers its pings stays up", async (t) => {
  // A wide window for each pong, so a busy test machine's pause doesn't read as a dead line.
  const { line, sockets } = setup({ answers: true, deadMs: 1_000 });
  t.after(() => line.stop());
  line.start();
  await until(() => sockets[0]?.pings >= 10);
  assert.equal(sockets[0].terminated, false);
});

test("a silent line is dropped and dialed again", async (t) => {
  const { line, sockets } = setup({ answers: false });
  t.after(() => line.stop());
  const downs = [];
  line.on("down", () => downs.push(true));
  line.start();
  await until(() => sockets.length === 2);
  assert.equal(sockets[0].terminated, true);
  assert.equal(downs.length, 1);
});

test("a failed dial is retried, and stop means stop", async () => {
  const { line, sockets, logs } = setup({ fail: 2 });
  line.start();
  await until(() => line.connected);
  assert.equal(logs.filter((m) => m.startsWith("line: could not connect")).length, 2);
  line.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sockets.length, 1);
  assert.equal(line.send({ type: "paid", invoice: "Inv0ice1234", sats: 1 }), false);
});

test("a line dropped as soon as it opens is dialed with growing delays, not every second", async (t) => {
  const { line, sockets } = setup({ firstDelayMs: 2, maxDelayMs: 1_000, steadyMs: 1_000 });
  t.after(() => line.stop());
  line.on("up", () => queueMicrotask(() => sockets.at(-1).emit("close", { code: 1011, reason: "" })));
  line.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Delays of 1, 2, 4, 8, 16, 32 and 64 ms: about seven dials in 100 ms, where a fixed first
  // delay would make dozens.
  assert.ok(sockets.length >= 3 && sockets.length <= 10, `${sockets.length} dials in 100 ms`);
});

test("a line that stays up long enough starts its delays over", async (t) => {
  const { line, sockets } = setup({ fail: 2, firstDelayMs: 40, maxDelayMs: 1_000, steadyMs: 10 });
  t.after(() => line.stop());
  line.start();
  await until(() => line.connected);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const dropped = Date.now();
  sockets[0].emit("close", { code: 1006, reason: "" });
  await until(() => sockets.length === 2);
  // Back to the first delay, 20 ms with this jitter, not the 80 ms two failures had reached.
  assert.ok(Date.now() - dropped < 60, `redialed after ${Date.now() - dropped} ms`);
});

test("a line replaced by another relay waits the longest delay before taking it back", async (t) => {
  const { line, sockets, logs } = setup({ maxDelayMs: 200 });
  t.after(() => line.stop());
  line.start();
  await until(() => line.connected);
  sockets[0].emit("close", { code: 4000, reason: "replaced" });
  assert.ok(logs.some((m) => m.includes("is a second relay running?")));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sockets.length, 1, "an ordinary redial would have come at 100 ms");
  await until(() => sockets.length === 2);
});

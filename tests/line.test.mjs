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
  const { line, sockets } = setup({ answers: true });
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

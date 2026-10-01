// Keeps the relay's line to the Worker open. It dials out, sends protocol pings, and redials
// with growing delays whenever the line drops. Nothing ever dials in.

import { EventEmitter } from "node:events";
import { parseDown } from "../shared/protocol.mjs";

// Events: "up", "down", and "message" with each message from the object that passes the
// protocol's checks.
export class Line extends EventEmitter {
  #socket = null;
  #running = false;
  #attempts = 0;
  #pinger = null;
  #retry = null;
  #lastHeard = 0;

  constructor({ open, pingMs = 25_000, deadMs = 70_000, maxDelayMs = 60_000, now = Date.now, random = Math.random, log = console.log }) {
    super();
    Object.assign(this, { open, pingMs, deadMs, maxDelayMs, now, random, log });
  }

  get connected() {
    return this.#socket !== null;
  }

  start() {
    this.#running = true;
    this.#dial();
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#retry);
    clearInterval(this.#pinger);
    this.#socket?.close(1000, "stopping");
  }

  send(message) {
    if (!this.#socket) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  async #dial() {
    if (!this.#running) return;
    try {
      const socket = await this.open();
      if (this.#running) this.#attach(socket);
      else socket.close(1000, "stopping");
    } catch (error) {
      this.log(`line: could not connect: ${error.message}`);
      this.#redial();
    }
  }

  #redial() {
    if (!this.#running) return;
    const delay = Math.min(this.maxDelayMs, 1_000 * 2 ** this.#attempts) * (0.5 + this.random() / 2);
    this.#attempts += 1;
    this.#retry = setTimeout(() => this.#dial(), delay);
  }

  #attach(socket) {
    this.#socket = socket;
    this.#attempts = 0;
    this.#lastHeard = this.now();
    const heard = () => {
      this.#lastHeard = this.now();
    };
    socket.on("pong", heard);
    socket.on("message", (text) => {
      heard();
      const message = parseDown(text);
      if (message) this.emit("message", message);
      else this.log("line: dropped a message that isn't the protocol");
    });
    socket.on("close", ({ code }) => {
      clearInterval(this.#pinger);
      this.#socket = null;
      this.log(`line: closed (${code})`);
      this.emit("down");
      this.#redial();
    });
    // The Worker's runtime answers protocol pings without waking the object.
    this.#pinger = setInterval(() => {
      if (this.now() - this.#lastHeard > this.deadMs) socket.terminate();
      else socket.ping();
    }, this.pingMs);
    this.log("line: open");
    this.emit("up");
  }
}

// A small WebSocket client (RFC 6455) for the relay's line: text messages, pings and closes,
// no extensions and no subprotocols. Written here rather than added as a package, so the one
// program on a node's machine has no dependencies; see docs/decisions/0009-toolchain.md.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { socksConnect } from "./socks.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEAD = 16 * 1024;
const DECODER = new TextDecoder("utf-8", { fatal: true });

// The stream under the line: TCP, through the SOCKS proxy when there is one, then TLS for wss.
export async function dial(url, { socks = null, timeoutMs = 30_000 } = {}) {
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol === "wss:" ? 443 : 80);
  const stream = socks
    ? await socksConnect({ proxy: socks, host, port, timeoutMs })
    : await connectDirect(host, port, timeoutMs);
  if (url.protocol !== "wss:") return stream;
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: stream, host, servername: host, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error("TLS handshake timed out"));
    }, timeoutMs);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectDirect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Upgrades an open stream to a WebSocket and resolves with the client once the server agrees.
export function handshake(stream, url, { headers = {}, timeoutMs = 30_000, maxMessage } = {}) {
  return new Promise((resolve, reject) => {
    const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
    if (lines.some((line) => /[\r\n]/.test(line))) {
      stream.destroy();
      return reject(new Error("a header contains a line break"));
    }
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("WebSocket handshake timed out")), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", fail);
      stream.off("close", onClose);
    }
    function fail(error) {
      cleanup();
      stream.destroy();
      reject(error);
    }
    function onClose() {
      fail(new Error("connection closed during the WebSocket handshake"));
    }
    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_HEAD) fail(new Error("WebSocket handshake response is too large"));
        return;
      }
      const [status, ...fieldLines] = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const fields = new Map(fieldLines.map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const code = /^HTTP\/1\.1 (\d{3})\b/.exec(status)?.[1];
      if (code !== "101") return fail(new Error(`WebSocket handshake refused: HTTP ${code ?? "?"}`));
      const upgraded = fields.get("upgrade")?.toLowerCase() === "websocket" &&
        /(^|,)\s*upgrade\s*(,|$)/i.test(fields.get("connection") ?? "") &&
        fields.get("sec-websocket-accept") === accept;
      if (!upgraded) return fail(new Error("WebSocket handshake response is invalid"));
      if (fields.has("sec-websocket-extensions") || fields.has("sec-websocket-protocol")) {
        return fail(new Error("WebSocket handshake agreed to something that wasn't asked for"));
      }
      cleanup();
      resolve(new WebSocketClient(stream, buffered.subarray(end + 4), { maxMessage }));
    }

    stream.on("data", onData);
    stream.on("error", fail);
    stream.on("close", onClose);
    stream.write([
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...lines,
      "",
      "",
    ].join("\r\n"));
  });
}

// Events: "message" (text), "pong", and "close" ({ code, reason }) exactly once.
export class WebSocketClient extends EventEmitter {
  #stream;
  #buffered;
  #max;
  #fragments = null;
  #closing = false;
  #done = false;

  constructor(stream, initial = Buffer.alloc(0), { maxMessage = 65_536 } = {}) {
    super();
    this.#stream = stream;
    this.#buffered = initial;
    this.#max = maxMessage;
    stream.on("data", (chunk) => {
      this.#buffered = Buffer.concat([this.#buffered, chunk]);
      this.#read();
    });
    stream.on("error", () => {});
    stream.on("close", () => this.#finish(1006, ""));
    // Bytes that arrived with the handshake response, once listeners are attached.
    setImmediate(() => this.#read());
  }

  get open() {
    return !this.#closing && !this.#done;
  }

  send(text) {
    this.#write(0x1, Buffer.from(text, "utf8"));
  }

  ping() {
    this.#write(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    if (this.#closing || this.#done) return;
    this.#closing = true;
    const status = Buffer.alloc(2);
    status.writeUInt16BE(code);
    this.#write(0x8, Buffer.concat([status, Buffer.from(reason, "utf8")]), true);
    setTimeout(() => this.#stream.destroy(), 5_000).unref();
  }

  terminate() {
    this.#stream.destroy();
  }

  // Client frames are always masked (RFC 6455, section 5.3).
  #write(opcode, payload, closing = false) {
    if (this.#done || (this.#closing && !closing)) return;
    const length = payload.length;
    let head;
    if (length < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length < 65_536) {
      head = Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
      head.writeUInt16BE(length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(length), 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.alloc(length);
    for (let i = 0; i < length; i++) body[i] = payload[i] ^ mask[i & 3];
    this.#stream.write(Buffer.concat([head, mask, body]));
  }

  #read() {
    while (!this.#done) {
      let frame;
      try {
        frame = readFrame(this.#buffered, this.#max);
      } catch (error) {
        return this.#fail(error.closeCode ?? 1002);
      }
      if (!frame) return;
      this.#buffered = this.#buffered.subarray(frame.size);
      this.#handle(frame);
    }
  }

  #handle({ fin, opcode, payload }) {
    if (opcode >= 0x8) return this.#control(opcode, payload);
    if (opcode === 0x2) return this.#fail(1003); // the line carries text only
    if (opcode === 0x1 && this.#fragments === null) this.#fragments = [];
    else if (opcode !== 0x0 || this.#fragments === null) return this.#fail(1002);
    this.#fragments.push(payload);
    if (this.#fragments.reduce((size, part) => size + part.length, 0) > this.#max) return this.#fail(1009);
    if (!fin) return;
    const data = Buffer.concat(this.#fragments);
    this.#fragments = null;
    let text;
    try {
      text = DECODER.decode(data);
    } catch {
      return this.#fail(1007);
    }
    this.emit("message", text);
  }

  #control(opcode, payload) {
    if (opcode === 0x9) return this.#write(0xa, payload);
    if (opcode === 0xa) return this.emit("pong");
    if (opcode !== 0x8) return this.#fail(1002);
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
    if (!this.#closing) {
      this.#closing = true;
      this.#write(0x8, payload.subarray(0, 2), true);
    }
    this.#stream.end();
    this.#finish(code, reason);
  }

  #fail(code) {
    if (!this.#closing) {
      this.#closing = true;
      const status = Buffer.alloc(2);
      status.writeUInt16BE(code);
      this.#write(0x8, status, true);
    }
    this.#stream.end();
    setTimeout(() => this.#stream.destroy(), 1_000).unref();
    this.#finish(code, "");
  }

  #finish(code, reason) {
    if (this.#done) return;
    this.#done = true;
    this.emit("close", { code, reason });
  }
}

// One frame from the start of the buffer, or null until the whole frame has arrived.
export function readFrame(buffer, max) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  // No extensions were negotiated, and a server never masks its frames.
  if (buffer[0] & 0x70 || buffer[1] & 0x80) throw closeWith(1002);
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(max)) throw closeWith(1009);
    length = Number(big);
    offset = 10;
  }
  if (opcode >= 0x8 && (!fin || length > 125)) throw closeWith(1002);
  if (length > max) throw closeWith(1009);
  if (buffer.length < offset + length) return null;
  return { fin, opcode, payload: buffer.subarray(offset, offset + length), size: offset + length };
}

function closeWith(code) {
  return Object.assign(new Error(`WebSocket protocol error ${code}`), { closeCode: code });
}

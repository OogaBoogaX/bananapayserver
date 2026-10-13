// A WebSocket server just good enough to test the relay's client against, plus a SOCKS5 proxy
// stub. Both listen on this machine only.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Server frames are never masked.
export function frame(opcode, payload, { fin = true, rsv = 0, mask = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = body.length;
  const first = (fin ? 0x80 : 0) | rsv | opcode;
  let head;
  if (length < 126) head = Buffer.from([first, (mask ? 0x80 : 0) | length]);
  else if (length < 65_536) {
    head = Buffer.from([first, (mask ? 0x80 : 0) | 126, 0, 0]);
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = first;
    head[1] = (mask ? 0x80 : 0) | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return mask ? Buffer.concat([head, Buffer.alloc(4), body]) : Buffer.concat([head, body]);
}

class Connection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.received = [];
    this.pongs = 0;
    this.answerPings = true;
    this.answerClose = true;
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (!(buffered[1] & 0x80)) throw new Error("client frame is not masked");
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffered = buffered.subarray(offset + 4 + length);
        this.#handle(opcode, payload);
      }
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", () => {});
  }

  #handle(opcode, payload) {
    if (opcode === 0x1) {
      this.received.push(payload.toString("utf8"));
      this.emit("message", payload.toString("utf8"));
    } else if (opcode === 0x9 && this.answerPings) {
      this.socket.write(frame(0xa, payload));
    } else if (opcode === 0xa) {
      this.pongs += 1;
      this.emit("pong");
    } else if (opcode === 0x8) {
      this.closeFrame = payload;
      if (this.answerClose) this.socket.end(frame(0x8, payload.subarray(0, 2)));
    }
  }

  send(text) {
    this.socket.write(frame(0x1, text));
  }

  raw(buffer) {
    this.socket.write(buffer);
  }

  close(code, reason = "") {
    const status = Buffer.alloc(2);
    status.writeUInt16BE(code);
    this.socket.write(frame(0x8, Buffer.concat([status, Buffer.from(reason)])));
  }
}

// respond(request, key) may return a custom response head to break the handshake on purpose.
export async function startServer({ respond } = {}) {
  const server = http.createServer((_, response) => response.writeHead(426).end());
  const connections = new EventEmitter();
  const sockets = track(server);
  server.on("upgrade", (request, socket, head) => {
    const key = request.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    const custom = respond?.(request, key);
    socket.write(custom ?? [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    const connection = new Connection(socket, request);
    if (head.length) socket.unshift(head);
    connections.emit("connection", connection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: new URL(`ws://localhost:${port}/relay`),
    next: () => new Promise((resolve) => connections.once("connection", resolve)),
    close: () => shut(server, sockets),
  };
}

// Upgraded and piped sockets keep a server open, so closing destroys them first.
function track(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return sockets;
}

function shut(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

// A SOCKS5 proxy stub. reply decides the REP code; requests records what the client asked for.
export async function startSocks({ reply = 0, greeting = [5, 0] } = {}) {
  const requests = [];
  const upstreams = new Set();
  const server = net.createServer((client) => {
    let stage = "greeting";
    let buffered = Buffer.alloc(0);
    client.on("error", () => {});
    client.on("data", function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 3) return;
        requests.push({ greeting: [...buffered.subarray(0, 3)] });
        buffered = buffered.subarray(3);
        client.write(Buffer.from(greeting));
        stage = "request";
      }
      if (stage === "request" && buffered.length >= 5 && buffered.length >= 5 + buffered[4] + 2) {
        const length = buffered[4];
        const host = buffered.subarray(5, 5 + length).toString("ascii");
        const port = buffered.readUInt16BE(5 + length);
        requests.push({ command: buffered[1], addressType: buffered[3], host, port });
        stage = "done";
        client.off("data", onData);
        if (reply !== 0) return client.end(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
        const upstream = net.connect(port, host, () => {
          upstreams.add(upstream);
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream).pipe(client);
        });
        upstream.on("error", () => client.destroy());
      }
    });
  });
  const sockets = track(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    proxy: { host: "127.0.0.1", port: server.address().port },
    requests,
    close: () => {
      for (const upstream of upstreams) upstream.destroy();
      return shut(server, sockets);
    },
  };
}

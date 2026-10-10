// The relay's WebSocket client and SOCKS5 dialer, over real sockets on this machine.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { socksConnect } from "../relay/socks.mjs";
import { dial, handshake } from "../relay/websocket.mjs";
import { frame, startServer, startSocks } from "./helpers/ws-server.mjs";

async function connected(options = {}, server) {
  server ??= await startServer(options.server);
  const accepted = server.next();
  const client = await handshake(await dial(server.url), server.url, options);
  const connection = await accepted;
  return { server, client, connection };
}

const closeOf = (client) => once(client, "close").then(([event]) => event);

test("the handshake carries the headers, and text goes both ways", async (t) => {
  const { server, client, connection } = await connected({ headers: { Authorization: "Bearer synthetic-token" } });
  t.after(() => server.close());
  assert.equal(connection.request.headers.authorization, "Bearer synthetic-token");
  assert.equal(connection.request.headers.host, server.url.host);
  assert.equal(connection.request.url, "/relay");
  client.send("hello object");
  await once(connection, "message");
  assert.deepEqual(connection.received, ["hello object"]);
  connection.send("hello relay");
  assert.deepEqual(await once(client, "message"), ["hello relay"]);
  client.terminate();
});

test("pings are answered, and the server's pongs are reported", async (t) => {
  const { server, client, connection } = await connected();
  t.after(() => server.close());
  client.ping();
  await once(client, "pong");
  connection.raw(frame(0x9, "are you there"));
  await once(connection, "pong");
  client.terminate();
});

test("fragmented messages and both extended lengths are reassembled", async (t) => {
  const { server, client, connection } = await connected({ maxMessage: 100_000 });
  t.after(() => server.close());
  connection.raw(Buffer.concat([frame(0x1, "frag", { fin: false }), frame(0x0, "men", { fin: false }), frame(0x0, "ted")]));
  assert.deepEqual(await once(client, "message"), ["fragmented"]);
  const medium = "m".repeat(300);
  connection.send(medium);
  assert.deepEqual(await once(client, "message"), [medium]);
  const large = "l".repeat(70_000);
  connection.send(large);
  assert.deepEqual(await once(client, "message"), [large]);
  client.terminate();
});

test("a close from the server ends the line with its code and reason", async (t) => {
  const { server, client, connection } = await connected();
  t.after(() => server.close());
  const closing = closeOf(client);
  connection.close(4000, "replaced");
  assert.deepEqual(await closing, { code: 4000, reason: "replaced" });
  assert.equal(client.open, false);
});

test("protocol violations close the line with the right code", async (t) => {
  const cases = [
    ["a message over the size limit", frame(0x1, "x".repeat(200)), 1009],
    ["binary data", frame(0x2, "bytes"), 1003],
    ["a masked frame from the server", frame(0x1, "hi", { mask: true }), 1002],
    ["a reserved bit", frame(0x1, "hi", { rsv: 0x40 }), 1002],
    ["text that isn't UTF-8", frame(0x1, Buffer.from([0xff, 0xfe])), 1007],
    ["a continuation with nothing to continue", frame(0x0, "orphan"), 1002],
    ["a fragmented ping", frame(0x9, "", { fin: false }), 1002],
  ];
  for (const [what, bytes, code] of cases) {
    const { server, client, connection } = await connected({ maxMessage: 100 });
    t.after(() => server.close());
    const closing = closeOf(client);
    connection.raw(bytes);
    assert.equal((await closing).code, code, what);
  }
});

test("the handshake fails on a refusal, a wrong accept key, or extras nobody asked for", async (t) => {
  const responses = [
    ["HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n", /HTTP 401/],
    ["HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm9wZQ==\r\n\r\n", /invalid/],
    [null, /asked for/, (accept) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`],
  ];
  for (const [fixed, error, build] of responses) {
    const server = await startServer({
      respond: (_, key) => fixed ?? build(acceptFor(key)),
    });
    t.after(() => server.close());
    await assert.rejects(handshake(await dial(server.url), server.url), error);
  }
  const server = await startServer();
  t.after(() => server.close());
  await assert.rejects(handshake(await dial(server.url), server.url, { headers: { "X-Bad": "a\r\nInjected: yes" } }), /line break/);
});

test("SOCKS5 sends the host name to the proxy, and the line works through it", async (t) => {
  const socks = await startSocks();
  const server = await startServer();
  t.after(() => Promise.all([socks.close(), server.close()]));
  const accepted = server.next();
  const client = await handshake(await dial(server.url, { socks: socks.proxy }), server.url);
  const connection = await accepted;
  assert.deepEqual(socks.requests[0], { greeting: [5, 1, 0] });
  assert.deepEqual(socks.requests[1], { command: 1, addressType: 3, host: "localhost", port: server.port });
  connection.send("through the proxy");
  assert.deepEqual(await once(client, "message"), ["through the proxy"]);
  client.terminate();
});

test("SOCKS5 failures say what went wrong", async (t) => {
  const refused = await startSocks({ reply: 5 });
  const noAuth = await startSocks({ greeting: [5, 0xff] });
  t.after(() => Promise.all([refused.close(), noAuth.close()]));
  await assert.rejects(socksConnect({ proxy: refused.proxy, host: "localhost", port: 9 }), /connection refused/);
  await assert.rejects(socksConnect({ proxy: noAuth.proxy, host: "localhost", port: 9 }), /refused the greeting/);
  await assert.rejects(socksConnect({ proxy: refused.proxy, host: "bad host!", port: 9 }), /not valid/);
});

const acceptFor = (key) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

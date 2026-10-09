// Read-only boundary checks: no invoices or payments, and no relay credential.
import assert from "node:assert/strict";
import { request } from "node:https";

assert.ok(process.env.STAGING_WORKER_URL, "Set the staging STAGING_WORKER_URL variable");
const url = new URL(process.env.STAGING_WORKER_URL);
assert.equal(url.protocol, "https:");
assert.match(url.hostname, /^bananapayserver-staging\.[a-z0-9-]+\.workers\.dev$/);
assert.equal(url.origin + "/", url.href, "Set STAGING_WORKER_URL to the Worker's base URL");

if (!process.argv.includes("--config-only")) {
  for (const [path, options, expected] of [
    ["/relay", {}, 426],
    ["/donations/invoice", { method: "POST" }, 404],
    ["/relay", { headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": Buffer.from("synthetic-ws-key").toString("base64"),
    } }, 401],
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(new URL(path, url), options, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      req.on("error", reject);
      req.setTimeout(15000, () => req.destroy(new Error("Staging check timed out")));
      req.end();
    });
    assert.equal(status, expected, `${options.method ?? "GET"} ${path}`);
    console.log(`${options.method ?? "GET"} ${path}: ${status}`);
  }
}

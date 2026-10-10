// Read-only boundary checks: no invoices or payments, and no relay credential.
// Staging by default; --production selects the separate PRODUCTION_WORKER_URL.
import assert from "node:assert/strict";
import { request } from "node:https";

const environment = process.argv.includes("--production") ? "production" : "staging";
const variable = `${environment.toUpperCase()}_WORKER_URL`;
assert.ok(process.env[variable], `Set the ${environment} ${variable} variable`);
const url = new URL(process.env[variable]);
assert.equal(url.protocol, "https:");
assert.match(url.hostname, new RegExp(`^bananapayserver-${environment}\\.[a-z0-9-]+\\.workers\\.dev$`));
assert.equal(url.origin + "/", url.href, `Set ${variable} to the Worker's base URL`);

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
      req.setTimeout(15000, () => req.destroy(new Error(`${environment} check timed out`)));
      req.end();
    });
    assert.equal(status, expected, `${options.method ?? "GET"} ${path}`);
    console.log(`${options.method ?? "GET"} ${path}: ${status}`);
  }
}

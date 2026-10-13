// Read-only boundary checks: no invoices or payments, and no relay credential.
// Staging by default; --production selects the separate PRODUCTION_WORKER_URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:https";

const environment = process.argv.includes("--production") ? "production" : "staging";
const variable = `${environment.toUpperCase()}_WORKER_URL`;
const filename = `wrangler.${environment}.jsonc`;
const worker = `bananapayserver-${environment}`;

// The staging token can deploy any Worker in the account. Keep the config guard when selecting
// production explicitly; the staging Action always uses the default. This catches a mistake,
// not malice: environment reviewers still check the branch. Whole-line comments only.
const config = JSON.parse(readFileSync(filename, "utf8")
  .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));
assert.equal(config.name, worker, `${filename} must deploy ${worker}`);
assert.equal(config.vars?.NETWORK, environment === "production" ? "mainnet" : "signet",
  `${filename} must use the ${environment} network`);
assert.deepEqual(config.d1_databases?.map((db) => db.database_name), [worker],
  `${filename} must use ${worker}'s database`);

assert.ok(process.env[variable], `Set the ${environment} ${variable} secret`);
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

// The relay's entry point. It reads its settings, listens for BTCPay's webhook on the internal
// network, finds its recent invoices again, and keeps the line to the Worker open.

import { BTCPay } from "./btcpay.mjs";
import { readConfig } from "./config.mjs";
import { Line } from "./line.mjs";
import { Relay } from "./relay.mjs";
import { createWebhookServer } from "./webhook.mjs";
import { dial, handshake } from "./websocket.mjs";

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

let config;
try {
  config = readConfig(process.env);
} catch (error) {
  log(error.message);
  process.exit(1);
}
if (!config.socks) log("line: DIRECT=yes, so the line doesn't go through Tor, and the Worker sees this machine's address");

const btcpay = new BTCPay(config.btcpay);
const line = new Line({
  log,
  open: async () => handshake(await dial(config.workerUrl, { socks: config.socks }), config.workerUrl, {
    headers: { Authorization: `Bearer ${config.token}`, "User-Agent": "bananapayserver-relay" },
  }),
});
const relay = new Relay({ btcpay, line, config, log });
line.on("message", (message) => relay.handle(message));
line.on("up", () => relay.flush());

const server = createWebhookServer({
  secret: config.webhookSecret,
  storeId: config.btcpay.storeId,
  onPayment: (invoiceId) => relay.check(invoiceId),
});
server.listen(config.listen.port, config.listen.host, () => log(`webhook: listening on port ${config.listen.port}`));

line.start();
relay.loadWhenReady();
const sweep = setInterval(() => relay.sweep().catch((error) => log(`sweep: ${error.message}`)), 60_000);

const stop = () => {
  clearInterval(sweep);
  line.stop();
  server.close();
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Sets up the staging stack's BTCPay. setup.sh runs it inside a one-off relay container, which
// reaches BTCPay on the stack's own network, so BTCPay's pages never need a published port.
//
// Reads LND's TLS certificate on stdin and an invoice-only macaroon from MACAROON. Creates the
// admin, the store, its Lightning connection pinned to that certificate, a watch-only on-chain
// wallet, the relay's key and the webhook, and the relay's token. Prints the settings for .env,
// then the token's SHA-256 for bananapayserver-staging, one KEY=value per line.

import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { text } from "node:stream/consumers";

const API = "http://btcpay:49392/api/v1";
const ADMIN = "admin@staging.invalid";
const STORE = "OBL donations (staging)";

const fail = (message) => {
  console.error(`setup: ${message}`);
  process.exit(1);
};
const secret = () => randomBytes(32).toString("hex");

async function api(method, path, { body, auth } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const reply = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${reply.slice(0, 300)}`);
  return reply ? JSON.parse(reply) : null;
}

const macaroon = process.env.MACAROON ?? "";
if (!/^[0-9a-f]{20,}$/.test(macaroon)) fail("no macaroon in MACAROON");
const thumbprint = new X509Certificate(await text(process.stdin)).fingerprint256.replaceAll(":", "").toLowerCase();

// BTCPay reports synchronized once NBXplorer has caught up with the chain.
for (let attempt = 0; ; attempt++) {
  const health = await api("GET", "/health").catch(() => null);
  if (health?.synchronized) break;
  if (attempt === 0) console.error("setup: waiting for BTCPay to catch up with the chain");
  if (attempt === 360) fail("BTCPay didn't catch up within an hour; run setup.sh again later");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

// The first user becomes the server's admin. Their password is kept in .env, for the rare time
// someone needs BTCPay's pages.
const password = secret();
await api("POST", "/users", { body: { email: ADMIN, password, isAdministrator: true } });
const basic = `Basic ${Buffer.from(`${ADMIN}:${password}`).toString("base64")}`;
const { apiKey: setupKey } = await api("POST", "/api-keys", {
  auth: basic,
  body: { label: "staging setup", permissions: ["unrestricted"] },
});
const auth = `token ${setupKey}`;

try {
  const { id: store } = await api("POST", "/stores", { auth, body: { name: STORE, defaultCurrency: "BTC" } });
  await api("PUT", `/stores/${store}/payment-methods/BTC-LN`, {
    auth,
    body: {
      enabled: true,
      config: { connectionString: `type=lnd-rest;server=https://lnd:8080/;macaroon=${macaroon};certthumbprint=${thumbprint}` },
    },
  });
  // A watch-only wallet whose seed is dropped here: signet coins are worthless, and the store
  // never needs to spend them.
  await api("POST", `/stores/${store}/payment-methods/BTC-CHAIN/wallet/generate`, {
    auth,
    body: { savePrivateKeys: false, importKeysToRPC: false, wordCount: 12, scriptPubKeyType: "Segwit" },
  });
  const { apiKey: relayKey } = await api("POST", "/api-keys", {
    auth,
    body: {
      label: "bananapayserver relay (staging)",
      permissions: [`btcpay.store.cancreateinvoice:${store}`, `btcpay.store.canviewinvoices:${store}`],
    },
  });
  const webhookSecret = secret();
  await api("POST", `/stores/${store}/webhooks`, {
    auth,
    body: {
      url: "http://relay:8080/btcpay",
      secret: webhookSecret,
      enabled: true,
      automaticRedelivery: true,
      authorizedEvents: { everything: false, specificEvents: ["InvoiceSettled"] },
    },
  });
  const token = secret();
  console.log(`RELAY_TOKEN=${token}`);
  console.log(`BTCPAY_STORE_ID=${store}`);
  console.log(`BTCPAY_API_KEY=${relayKey}`);
  console.log(`BTCPAY_WEBHOOK_SECRET=${webhookSecret}`);
  console.log(`BTCPAY_ADMIN_PASSWORD=${password}`);
  console.log(`RELAY_TOKEN_SHA256=${createHash("sha256").update(token).digest("hex")}`);
} finally {
  // The unrestricted key was for this setup only. If it can't go, someone has to remove it by
  // hand, so say so.
  await api("DELETE", "/api-keys/current", { auth }).catch((error) => {
    console.error(`setup: couldn't delete setup's unrestricted BTCPay key (${error.message}); delete it in BTCPay's API keys`);
  });
}

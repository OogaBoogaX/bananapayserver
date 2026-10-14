// The relay's settings, read once at start. Anything missing or malformed stops the relay, and
// the error names the settings, never their values. See docs/configuration.md.

const HOST_PORT = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
// BTCPay's API keys are hex. Anything with a space or a line break would end up in an error
// message, and so in the log, the first time it went into a header.
const API_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

export function readConfig(env) {
  const problems = [];
  const text = (name, fallback) => {
    const value = env[name]?.trim();
    if (value) return value;
    if (fallback === undefined) problems.push(name);
    return fallback;
  };
  const count = (name, fallback) => {
    const value = text(name, fallback === undefined ? undefined : String(fallback));
    if (value === undefined) return undefined;
    if (!/^[1-9]\d{0,15}$/.test(value)) problems.push(name);
    return Number(value);
  };
  const hostPort = (name, fallback) => {
    const value = text(name, fallback);
    const match = value === undefined ? null : HOST_PORT.exec(value);
    if (value !== undefined && (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)) problems.push(name);
    return match ? { host: match[1], port: Number(match[2]) } : null;
  };

  const workerUrl = parseWorkerUrl(text("WORKER_URL"));
  if (env.WORKER_URL?.trim() && !workerUrl) problems.push("WORKER_URL");
  const token = text("RELAY_TOKEN");
  if (token && !TOKEN.test(token)) problems.push("RELAY_TOKEN");
  // Tor unless someone explicitly says otherwise, so a missing setting never exposes the
  // machine's address.
  const socks = env.DIRECT === "yes" ? null : hostPort("TOR_SOCKS");
  const minSats = count("MIN_SATS", 1);
  const maxSats = count("MAX_SATS");
  if (minSats && maxSats && minSats > maxSats) problems.push("MIN_SATS");
  const ratePerMinute = count("RATE_PER_MINUTE");

  const config = {
    workerUrl,
    token,
    socks,
    btcpay: {
      url: text("BTCPAY_URL"),
      storeId: text("BTCPAY_STORE_ID"),
      apiKey: text("BTCPAY_API_KEY"),
    },
    webhookSecret: text("BTCPAY_WEBHOOK_SECRET"),
    listen: hostPort("WEBHOOK_LISTEN", "0.0.0.0:8080"),
    minSats,
    maxSats,
    ratePerMinute,
    invoiceMinutes: count("INVOICE_MINUTES", 15),
    methods: {
      lightning: text("LIGHTNING_METHOD", "BTC-LN"),
      onchain: text("ONCHAIN_METHOD", "BTC-CHAIN"),
    },
  };
  if (config.btcpay.storeId && !/^[A-Za-z0-9]{1,64}$/.test(config.btcpay.storeId)) problems.push("BTCPAY_STORE_ID");
  if (config.btcpay.apiKey && !API_KEY.test(config.btcpay.apiKey)) problems.push("BTCPAY_API_KEY");
  if (problems.length) throw new Error(`missing or invalid settings: ${[...new Set(problems)].join(", ")}`);
  return config;
}

// wss only, except ws to this machine for development.
function parseWorkerUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowed = url.protocol === "wss:" || (url.protocol === "ws:" && LOCAL.includes(url.hostname));
    return allowed && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

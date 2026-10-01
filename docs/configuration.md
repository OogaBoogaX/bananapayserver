# Configuration

Every setting the Worker and the relay read. Limits have no defaults: a limit that is missing
or malformed keeps donations closed on the Worker and stops the relay. Limits and secrets
are set in each deployment and never committed.

## The Worker

Set limits and the relay's token hash as secrets, so they stay out of `wrangler.jsonc`, for
example `wrangler secret put MAX_SATS`. For local development, copy
[`.dev.vars.example`](../.dev.vars.example) to `.dev.vars`.

| Setting | Kind | Meaning |
|---|---|---|
| `MAX_SATS` | limit, required | The largest donation the Worker accepts, in sats |
| `MIN_SATS` | limit, optional | The smallest; 1 when unset |
| `RATE_PER_IP` | limit, required | Invoice requests, on-chain switches and page sockets per visitor per minute |
| `RATE_GLOBAL` | limit, required | The same, for all visitors together |
| `RELAY_TOKEN_SHA256` | secret | The SHA-256, in hex, of the relay's token |
| `NETWORK` | variable | `mainnet`, `testnet`, `signet` or `regtest`; invoices and addresses for any other are refused |
| `ALLOWED_ORIGINS` | variable | The origins a browser may call from, separated by commas |
| `INVOICE_TIMEOUT_MS` | optional | How long a page waits for the relay before hearing donations are closed; 10,000 when unset |
| `PENDING_DAYS` | optional | How long a request is kept while unpaid; 7 when unset |

[`wrangler.jsonc`](../wrangler.jsonc) binds the Durable Object as `DONATIONS` and D1 as `DB`,
whose schema is in [`migrations/`](../migrations/).

## The relay

Set in the relay container's environment; [`relay/.env.example`](../relay/.env.example) lists
them.

| Setting | Kind | Meaning |
|---|---|---|
| `WORKER_URL` | required | The line's address, `wss://<api host>/relay` |
| `RELAY_TOKEN` | secret | 32 to 128 letters, digits, `-` or `_` |
| `TOR_SOCKS` | required | Tor's SOCKS proxy, as `host:port` |
| `DIRECT` | development only | `yes` connects without Tor, and `TOR_SOCKS` is then ignored |
| `BTCPAY_URL` | required | BTCPay's address on the machine's internal network |
| `BTCPAY_STORE_ID` | required | The one store the key can use |
| `BTCPAY_API_KEY` | secret | A key that can only create and view invoices on that store |
| `BTCPAY_WEBHOOK_SECRET` | secret | The webhook's secret, as set in BTCPay |
| `MAX_SATS` | limit, required | The relay's own cap, in sats, whatever the Worker allows |
| `MIN_SATS` | limit, optional | 1 when unset |
| `WEBHOOK_LISTEN` | optional | Where the webhook listener binds inside the container; `0.0.0.0:8080` when unset. Never publish this port |
| `INVOICE_MINUTES` | optional | How long an invoice stays payable; 15 when unset |
| `LIGHTNING_METHOD`, `ONCHAIN_METHOD` | optional | BTCPay's payment method ids; `BTC-LN` and `BTC-CHAIN` when unset. BTCPay 1.x calls them `BTC-LightningNetwork` and `BTC` |

A token and the hash the Worker keeps can be made with:

```bash
token=$(openssl rand -hex 32)
printf %s "$token" | shasum -a 256
```

The relay keeps the token; the Worker keeps only the hash.

## The relay's container

Build it from the repository root with [`relay/Dockerfile`](../relay/Dockerfile). In general
terms, the container needs:

- no published ports;
- no access to LND's files, and no LND credential of any kind;
- a network it shares with BTCPay, so each can reach the other, and a route to Tor's SOCKS
  proxy;
- its settings from an environment file kept out of version control.

[`architecture.md`](architecture.md#what-a-donating-node-needs) has the rest of what a
donating node needs.

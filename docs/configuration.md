# Configuration

Every setting the Worker and the relay read. The limits are the caps on amounts and the rate
limits, and they have no defaults: one that is missing or malformed keeps donations closed on
the Worker and stops the relay. Limits and secrets are set in each deployment and never
committed. The few settings with defaults are not limits; their defaults are below.

## The Worker

There are two deployments, each its own Worker with its own Durable Object, D1 database and
secrets: `bananapayserver-staging`, from
[`wrangler.staging.jsonc`](../wrangler.staging.jsonc), and `bananapayserver-production`, from
[`wrangler.production.jsonc`](../wrangler.production.jsonc).
Each binds the Durable Object as `DONATIONS` and D1 as `DB`, whose schema is in
[`migrations/`](../migrations/). Each file sets its own `NETWORK`, signet for staging and
mainnet for production, so staging refuses mainnet invoices even if its relay is pointed at
the wrong BTCPay.

Set limits and the relay's token hash as secrets, so they stay out of the config files, for
example `wrangler secret put MAX_SATS --config wrangler.staging.jsonc`. For local development,
copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars`, which also sets `NETWORK` to
regtest.

| Setting | Kind | Meaning |
|---|---|---|
| `MAX_SATS` | limit, required | The largest donation the Worker accepts, in sats |
| `MIN_SATS` | optional | The smallest; 1 when unset, the smallest invoice there is |
| `RATE_PER_IP` | limit, required | Per visitor and per minute: invoice requests and on-chain switches together, and separately each of notes and page sockets. An IPv6 visitor counts by its /64 |
| `RATE_GLOBAL` | limit, required | Invoice requests and on-chain switches per minute, for all visitors together. Notes and page sockets don't count, so a crowd of page loads can't close donations |
| `RELAY_TOKEN_SHA256` | secret | The SHA-256, in hex, of the relay's token |
| `NETWORK` | variable | `mainnet`, `testnet`, `signet` or `regtest`; invoices and addresses for any other are refused. Set in each config file |
| `INVOICE_TIMEOUT_MS` | optional | How long a page waits for the relay before hearing donations are closed; 10,000 when unset |
| `PENDING_DAYS` | optional | How long a request is kept while unpaid; 7 when unset |
| `PILE_START` | optional | Where the global pile starts, in bananas; 1,000 when unset, a placeholder for the team. It applies only when the pile is first made |
| `PILE_EAT_PER_HOUR` | optional | How many bananas the Oogas eat an hour; 60 when unset, a placeholder for the team |

There are no sign-in or origin settings. Pages reach the Worker only through OBL's Worker,
which signs donors in and checks origins; see
[decision 0014](decisions/0014-pages-through-obl.md).

### Deploying

By hand, never from CI, into the account OBL's Workers use; production only from `main`.
[`cloudflare.md`](cloudflare.md) has the steps for both environments, and for OBL's side of the
binding. The Worker's own log lines, such as the price service's failures, can be read in
Cloudflare's dashboard. Cloudflare's invocation logs are off, because they would keep each
request's headers, and so visitors' addresses and the relay's, for days.

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
| `MIN_SATS` | optional | 1 when unset |
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

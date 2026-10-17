# Configuration

Every setting the Worker and the relay read. Configured limits cover the Lightning threshold
and request rates, and they have no defaults: one that is missing or malformed keeps donations closed on
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
example `wrangler secret put LIGHTNING_MAX_SATS --config wrangler.staging.jsonc`. For local development,
copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars`, which also sets `NETWORK` to
regtest.

| Setting | Kind | Meaning |
|---|---|---|
| `MAX_SATS` | legacy alias | Lightning threshold when `LIGHTNING_MAX_SATS` is absent; no longer an on-chain cap |
| `LIGHTNING_MAX_SATS` | limit, required unless legacy alias is set | Largest Lightning donation, in sats. Above this, donations remain available on-chain. Advertised to kiosks |
| `MIN_SATS` | optional | The smallest; 1 when unset, the smallest invoice there is |
| `RATE_PER_IP` | limit, required | Per visitor and per minute: invoice requests and on-chain switches together, and separately each of notes and page sockets. An IPv6 visitor counts by its /64. Counts are kept for the minute under a 16-bit hash of the address, never the address, so a visitor shares theirs with the rare other in the same group |
| `SOCKETS_PER_IP` | limit, required | Page sockets one visitor may hold open at once. An IPv6 visitor counts by its /48. Visitors are counted in 65,536 groups by a hash of the address, so a visitor shares the limit with the few others in their group, and no address is ever kept |
| `PRICE_JUMP_MAX` | limit, required | A whole number, 2 or more. A price more than this many times the last one, or the last divided by it, within a day of it, is taken for a fault at the price service and refused; invoices get the last price, marked stale. Banana counts are kept for good, so a wrong price would stay on the pile and the board |
| `ONCHAIN_FEE_ALLOWANCE` | limit, required | How many sats more than its invoice the relay may ask a donor to pay on-chain, as room for a network fee the store adds. 0 allows none. Anything more is refused, as a mistake |
| `RATE_GLOBAL` | limit, required | Invoice requests and on-chain switches per minute, for all visitors together. Notes and page sockets don't count, so a crowd of page loads can't close donations |
| `RELAY_TOKEN_SHA256` | secret | The SHA-256, in hex, of the relay's token |
| `NETWORK` | variable | `mainnet`, `testnet`, `signet` or `regtest`; invoices and addresses for any other are refused. Set in each config file |
| `INVOICE_TIMEOUT_MS` | optional | How long a page waits for the relay before hearing donations are closed; 10,000 when unset |
| `PENDING_DAYS` | optional | How long a request is kept while unpaid; 7 when unset |
| `PILE_START` | optional | Where the global pile starts, in bananas; 1,000 when unset, a placeholder for the team. It applies only when the pile is first made |
| `PILE_EAT_PER_HOUR` | optional | How many bananas the Oogas eat an hour; 60 when unset, a placeholder for the team |

On-chain donations have no application maximum. Amounts must still be positive whole sats,
meet `MIN_SATS`, and fit Bitcoin's supply bound (21 million BTC). The advertised `maxSats`
is that fixed protocol bound, not a configurable donation cap. `LIGHTNING_MAX_SATS` controls
Lightning only; legacy `MAX_SATS` is its fallback alias. Either setting must be a positive
safe integer within the Bitcoin amount bound. Keep the Worker's Lightning threshold at or
below the relay's so the kiosk can warn before Continue accurately.

Deploy the compatible site first, then upgrade the Worker and relay together in a coordinated
rollout. An old relay rejects the new `onchainOnly` request shape and retains the old overall
cap, so larger on-chain donations require both updated components. Existing `MAX_SATS`
settings preserve the Lightning threshold but cease limiting on-chain amounts once both are
upgraded. Prefer `LIGHTNING_MAX_SATS` for new configuration. This feature requires a relay
rollout and two-maintainer review; it does not change credentials or expose a listener.

There are no sign-in or origin settings. Pages reach the Worker only through OBL's Worker,
which signs donors in and checks origins; see
[decision 0014](decisions/0014-pages-through-obl.md).

### Deploying

Into the account OBL's Workers use. Staging deploys through a manually dispatched GitHub
Action, from the selected branch ([decision 0018](decisions/0018-staging-github-action.md));
production deploys by hand, and only from `main`. [`cloudflare.md`](cloudflare.md) has the
steps for both environments, and for OBL's side of the binding. A setting that isn't in the
config file, such as `PILE_START`, is set with `wrangler secret put`: a deploy removes plain
variables set in the dashboard. The Worker's own log lines, such as the price service's
failures, can be read in Cloudflare's dashboard. Cloudflare's invocation logs are off, because
they would keep each request's headers, and so visitors' addresses and the relay's, for days.

## The relay

Set in the relay container's environment; [`relay/.env.example`](../relay/.env.example) lists
them.

| Setting | Kind | Meaning |
|---|---|---|
| `WORKER_URL` | required | The line's address, `wss://<api host>/relay` |
| `RELAY_TOKEN` | secret | 32 to 128 letters, digits, `-` or `_` |
| `TOR_SOCKS` | required | Tor's SOCKS proxy, as `host:port` |
| `DIRECT` | development only | `yes` connects without Tor, and `TOR_SOCKS` is then ignored. The relay says so in its log when it starts, since the Worker then sees the machine's address |
| `BTCPAY_URL` | required | BTCPay's address on the machine's internal network |
| `BTCPAY_STORE_ID` | required | The one store the key can use |
| `BTCPAY_API_KEY` | secret | A key that can only create and view invoices on that store |
| `BTCPAY_WEBHOOK_SECRET` | secret | The webhook's secret, as set in BTCPay |
| `MAX_SATS` | legacy alias | Lightning threshold when `LIGHTNING_MAX_SATS` is absent; no longer an on-chain cap |
| `LIGHTNING_MAX_SATS` | limit, required unless legacy alias is set | The relay's independently enforced Lightning threshold. Above this, create only the on-chain method and never activate Lightning |
| `RATE_PER_MINUTE` | limit, required | How many invoices and on-chain addresses the relay makes in a minute, whatever the Worker asks. At least the Worker's `RATE_GLOBAL`, so it only ever stops a Worker gone wrong |
| `MIN_SATS` | optional | 1 when unset |
| `WEBHOOK_LISTEN` | optional | Where the webhook listener binds inside the container; `0.0.0.0:8080` when unset. Never publish this port, and never run the relay with host networking, where this would listen on the machine itself |
| `INVOICE_MINUTES` | optional | How long an invoice stays payable; 15 when unset |
| `LIGHTNING_METHOD`, `ONCHAIN_METHOD` | optional | BTCPay's payment method ids; `BTC-LN` and `BTC-CHAIN` when unset. BTCPay 1.x calls them `BTC-LightningNetwork` and `BTC` |

A token and the hash the Worker keeps can be made with:

```bash
token=$(openssl rand -hex 32)
printf %s "$token" | shasum -a 256
```

It prints the hash, then `-`; the hash is the first field.

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

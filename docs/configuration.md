# Configuration

Every setting the Worker and the relay read. The Lightning threshold and request rates are
required: one that is missing or malformed keeps donations closed on the Worker and stops
the relay. Purchases' own request rates are required too, but keep only purchases closed. Deployment-specific limits and secrets are set in each deployment and never
committed. The shared public defaults are a 69-sat minimum and 1,000-sat message bar;
deployment settings can change either value. Deploy OBL's page
before a Worker that refuses sub-bar messages; [`protocol.md`](protocol.md) says why.

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
| `MIN_SATS` | optional | The smallest; 69 when unset. Any positive whole sat amount is valid up to the Lightning threshold |
| `MESSAGE_MIN_SATS` | optional | The fewest sats a donation needs to carry a message; the recent list shows every amount. 1,000 when unset, 0 lets every donation carry one. Advertised to kiosks as `messageMinSats` |
| `RATE_PER_IP` | limit, required | Per visitor and per minute: invoice requests and on-chain switches together, and separately each of notes and page sockets. An IPv6 visitor counts by its /64. Counts are kept for the minute under a 16-bit hash of the address, never the address, so a visitor shares theirs with the rare other in the same group |
| `NOTE_RATE_PER_IP` | optional limit | Separate per-visitor note autosave budget per minute. When absent, uses `RATE_PER_IP`; an explicitly empty or invalid value closes donations. Configure this for the site's typing debounce without raising the invoice or page-socket budget |
| `SOCKETS_PER_IP` | limit, required | Page sockets one visitor may hold open at once. An IPv6 visitor counts by its /48. Visitors are counted in 65,536 groups by a hash of the address, so a visitor shares the limit with the few others in their group, and no address is ever kept |
| `PRICE_JUMP_MAX` | limit, required | A whole number, 2 or more. A price more than this many times the last one, or the last divided by it, within a day of it, is taken for a fault at the price service and refused; invoices get the last price, marked stale. Banana counts are kept for good, so a wrong price would stay on the pile and the board |
| `ONCHAIN_FEE_ALLOWANCE` | limit, required | How many sats more than its invoice the relay may ask a donor to pay on-chain, as room for a network fee the store adds. 0 allows none. Anything more is refused, as a mistake |
| `RATE_GLOBAL` | limit, required | Invoice requests and on-chain switches per minute, for all visitors together. Notes and page sockets don't count, so a crowd of page loads can't close donations |
| `PURCHASE_RATE_PER_IP` | limit, required for purchases | Purchase invoices per visitor and per minute, for everything sold together, counted apart from `RATE_PER_IP` and kept the same way. A stand that asks for an invoice whenever an item stays selected, as the fireworks stand does, needs a few choices per sale. Missing or malformed, purchases stay closed and donations stay open |
| `PURCHASE_RATE_GLOBAL` | limit, required for purchases | Purchase invoices per minute, for all visitors together, counted apart from `RATE_GLOBAL`, so a run of purchases can't use up the budget that keeps donations open. Missing or malformed, purchases stay closed |
| `<CATEGORY>_BUYERS` | optional | Who may buy in a category of the catalogue, such as `FIREWORK_BUYERS` for fireworks: `signed-in`, donors signed in on OBL only, or `everyone`. The catalogue's own choice when unset, `signed-in` for fireworks; any other value closes that category. Set it with `wrangler secret put`, so moving to `everyone` changes a setting, not the code. Advertised to pages in `status.catalogue` |
| `FIREWORK_LEAD_MS` | optional | How long after a firework is recorded every page launches it, in milliseconds; 3,000 when unset. Pages count down through it |
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
safe integer within the Bitcoin amount bound, and `MIN_SATS` must not exceed it. An explicitly
empty canonical setting is invalid even if the legacy alias is valid. Keep the Worker's Lightning threshold at or
below the relay's so the kiosk can warn before Continue accurately.

Use this order when upgrading from the old overall-cap protocol, including a relay with
Lightning-failure fallback:

1. Deploy the compatible site, which understands null BOLT11 invoices and receipt estimates.
2. Let current invoice requests finish, then stop the relay. Keep its state and the Worker's
   pending invoices. Once its line closes, new invoice requests immediately report closed.
3. With the relay stopped, apply all D1 migrations through 0008 and deploy the compatible
   Worker. Migrations 0005 and 0006 already applied in an environment must not be rewritten.
   Set the same `MIN_SATS` in the Worker and relay (or leave both unset to use 69), keep it at
   or below both Lightning thresholds, and keep the Worker's threshold at or below the relay's.
   Set the canonical `LIGHTNING_MAX_SATS` in both deployments; the alias
   remains available for an existing deployment only when the canonical name is absent.
4. Upgrade and start the matching relay, retaining its state. Verify its authenticated line
   reconnects and check invoice creation below and above the threshold with synthetic or test
   funds. The restarted relay reconciles its tagged BTCPay invoices from the last 24 hours;
   older missed receipts need operator reconciliation with BTCPay. Preserve pending state and
   keep the rollout within that recovery window; never reset storage to complete an upgrade.

The closed interval is intentional: an old relay drops `onchainOnly`, and an old Worker drops
null BOLT11 replies, including a new relay's Lightning-failure fallback. Do not run either mixed
pair or change thresholds as a substitute for this stop/deploy/start sequence. For rollback,
stop the relay before changing either component and resume only a matching pair. The legacy
account totals are historical after 0007; rolling back to an account-based leaderboard does
not make it current. Existing `MAX_SATS` values cease limiting on-chain amounts after upgrade.
This feature needs two-maintainer review; it changes no credentials and exposes no listener.

Notes already have a separate counter from invoice work. Set `NOTE_RATE_PER_IP` for the site's
autosave rate (currently a 350 ms typing debounce), including repeated pauses and tabs, without
raising `RATE_PER_IP`. A 429 leaves the last successfully saved text unchanged. Clients must
show failed saves and retry/coalesce edits; only a successful save before settlement changes
the recorded attribution. No server budget can guarantee that an unsaved edit wins a payment.

There are no sign-in or origin settings. Pages reach the Worker only through OBL's Worker,
which signs donors in and checks origins; see
[decision 0014](decisions/0014-pages-through-obl.md).

### Purchases

Purchases are not donations ([decision 0028](decisions/0028-purchases-are-not-donations.md)).
What is for sale and every price are fixed in the catalogue,
[`shared/catalogue.mjs`](../shared/catalogue.mjs), never configured; fireworks cost 10 sats for
a Pop, 69 for a Bolt, 100 for a Mega and 300 for a show. `MIN_SATS` and `MESSAGE_MIN_SATS`
don't apply to them. Besides the two purchase rates, they need:

- **A Lightning threshold at or above the dearest item** in the Worker and the relay, 300 sats
  for fireworks. An item above the Worker's threshold isn't sold: purchases are Lightning
  only.
- **The relay's `MIN_SATS` at or below the cheapest item,** 10 sats for the Pop. The relay
  refuses any invoice under its own minimum, a purchase's too, and then the purchase answers
  `closed` and the Worker logs that the relay's minimum is above the price. With the relay's
  default of 69, the Pop can't be sold and the other fireworks can. Donations keep the
  Worker's own `MIN_SATS`, so lowering the relay's lets no smaller donation through. Changing
  the relay's settings is a deployment change and needs two maintainers.
- **The relay's `RATE_PER_MINUTE` at least `RATE_GLOBAL` plus `PURCHASE_RATE_GLOBAL`.** The
  relay counts every invoice it makes, purchase or donation, against one budget, so a lower
  value would let a run of purchases close donations at the relay.

Apply migration 0009 before deploying the Worker that sells them; see
[`protocol.md`](protocol.md). Opening fireworks to everyone is `FIREWORK_BUYERS=everyone`,
set as a secret, with no change of code.

### Deploying

Into the account OBL's Workers use. Staging deploys through a manually dispatched GitHub
Action, from the selected branch ([decision 0018](decisions/0018-staging-github-action.md));
production deploys by hand, and only from `rock`. [`cloudflare.md`](cloudflare.md) has the
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
| `MAX_SATS` | legacy alias | Lightning threshold when `LIGHTNING_MAX_SATS` is absent; no longer an on-chain cap. The Compose files always pass `LIGHTNING_MAX_SATS`, so a relay run with them never falls back to it |
| `LIGHTNING_MAX_SATS` | limit, required unless legacy alias is set | The relay's independently enforced Lightning threshold. Above this, create only the on-chain method and never activate Lightning |
| `RATE_PER_MINUTE` | limit, required | How many invoices and on-chain addresses the relay makes in a minute, whatever the Worker asks. At least the Worker's `RATE_GLOBAL`, plus its `PURCHASE_RATE_GLOBAL` where anything is sold, so it only ever stops a Worker gone wrong |
| `MIN_SATS` | optional | 69 when unset. Any positive whole sat amount is valid up to the Lightning threshold; match the Worker's value, or set it at or below the cheapest item for sale, 10 for the Pop firework (see "Purchases" above) |
| `WEBHOOK_LISTEN` | optional | Where the webhook listener binds inside the container; `0.0.0.0:8080` when unset. Never publish this port, and never run the relay with host networking, where this would listen on the machine itself |
| `INVOICE_MINUTES` | optional | How long an invoice stays payable; 15 when unset |
| `INVOICE_DEADLINE_MS` | optional | How long after an invoice ask the relay aims to answer, in milliseconds; 8000 when unset. Lightning gets whatever time making the invoice left, and if it isn't ready by then, the invoice goes back on-chain only. Keep it under the Worker's `INVOICE_TIMEOUT_MS` (10000 when unset), with room for the answer to cross Tor |
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

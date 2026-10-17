# Setting up Cloudflare

What has to be done on Cloudflare for donations to work, on both sides of the service binding:
this repository's Workers, and the binding Ooga Booga Land's Worker needs to reach them.
Staging first, on signet, where the coins are worthless. Production comes after staging passes,
with the same steps.

Pages never call bananapayserver directly. OBL's own Worker serves the site, signs visitors in
with GitHub, and passes donation calls on over a service binding; see
[decision 0014](decisions/0014-pages-through-obl.md). A binding works only between Workers in
one Cloudflare account, so bananapayserver's Workers go in the account OBL's Workers already
use. Each environment is its own Worker, with its own Durable Object, D1 database and secrets:

| Environment | bananapayserver's Worker | Called by | Network |
|---|---|---|---|
| Staging | `bananapayserver-staging`, from [`wrangler.staging.jsonc`](../wrangler.staging.jsonc) | OBL's staging Worker | signet |
| Production | `bananapayserver-production`, from [`wrangler.production.jsonc`](../wrangler.production.jsonc) | OBL's production Worker | mainnet |

## The account

Settled once, with the account's owners, before anything is deployed:

- **Team-owned:** at least two Super Administrators, each with their own login, and two-factor
  login required for every member. Nobody shares a login or a token.
- **Staging deploys through a manual GitHub Action; production by hand.** A maintainer chooses
  the branch to deploy; see [decision 0018](decisions/0018-staging-github-action.md). Production is
  deployed by a person signed in as themselves, and has no deploy token of its own. Staging's
  token can still deploy it, since Cloudflare can't limit a token to one Worker, so the
  `staging` environment's reviewers are what keep it to staging.
- **OBL's CI deploys with an account-wide token,** so it can deploy over bananapayserver's
  Workers too. OBL's workflow actions should be pinned to exact commits, and its production
  token kept in a GitHub environment that needs a reviewer.
- **The plan:** the free plan covers Durable Objects and D1, which is enough for staging.
  Production needs Workers Paid, because the free plan's daily requests are shared by every
  Worker in the account, OBL's included.

## What the person deploying needs

- Their own login to the account, with two-factor login on.
- The account's id, from its overview page in the dashboard. The config files don't name the
  account, so it's set for the terminal as `CLOUDFLARE_ACCOUNT_ID`.
- Node 22 or newer and git. Install Wrangler, Cloudflare's command-line tool, with
  `npm ci --prefix .github/deploy --ignore-scripts`. The deployment lockfile pins version
  4.146.0 and its dependencies with integrity hashes, without running install scripts.
- The environment's limits, from the team: the largest donation in sats (`MAX_SATS`), the
  invoice requests allowed per visitor and for everyone together each minute (`RATE_PER_IP`,
  `RATE_GLOBAL`), the page sockets one visitor may hold open (`SOCKETS_PER_IP`), how far a
  new price may be from the last (`PRICE_JUMP_MAX`), and the room for an on-chain fee
  (`ONCHAIN_FEE_ALLOWANCE`). They're typed at a prompt, and never go in a file, a commit or a
  chat. See
  [`configuration.md`](configuration.md) for every setting.

## Staging: bananapayserver's side

Once, from a checkout of the branch under review, with `CLOUDFLARE_ACCOUNT_ID` set. Reuse the
existing Worker, database and secrets when they are already configured. Before changing the
deployment method, disconnect the Worker's repository under Settings → Builds and let any
running build finish. There must be only one deployer at a time.
Run `node --test --test-timeout=60000` before applying migrations or deploying by hand.

1. **Sign in.** Run `node .github/deploy/node_modules/wrangler/bin/wrangler.js login`, then
   the same command with `whoami`, which should show the deployer's own email and OBL's account.
2. **Create the database, if missing.**
   This prints a `database_id`, which goes in `wrangler.staging.jsonc` and is committed;
   an id isn't a secret.

   ```bash
   node .github/deploy/node_modules/wrangler/bin/wrangler.js \
     d1 create bananapayserver-staging
   ```

3. **Create its tables.**
   Apply every pending migration, including `0001_donations.sql`, `0002_stats.sql` and
   `0003_tally.sql`. Migrations always precede the Worker that needs them; without them,
   payments can't be recorded and pile up unacknowledged at the relay.

   ```bash
   node .github/deploy/node_modules/wrangler/bin/wrangler.js \
     d1 migrations apply bananapayserver-staging --remote -c wrangler.staging.jsonc
   ```

4. **Deploy.** This should list three bindings, `DONATIONS`, `DB` and `NETWORK` set to
   `signet`, and print the Worker's address,
   `https://bananapayserver-staging.<account subdomain>.workers.dev`. Donations stay closed
   until the limits are set; with a limit missing, the Worker refuses donations rather than
   guess.

   ```bash
   node .github/deploy/node_modules/wrangler/bin/wrangler.js \
     deploy -c wrangler.staging.jsonc
   ```

5. **Set missing limits.** Run this for `MAX_SATS`, then repeat with `RATE_PER_IP`,
   `RATE_GLOBAL`, `SOCKETS_PER_IP`, `PRICE_JUMP_MAX` and `ONCHAIN_FEE_ALLOWANCE` in its place,
   typing each value at the prompt.

   ```bash
   node .github/deploy/node_modules/wrangler/bin/wrangler.js \
     secret put MAX_SATS -c wrangler.staging.jsonc
   ```

6. **Set the relay's token hash, once the staging relay exists.** Whoever sets up the signet
   stack on its machine generates the relay's token there and hands over only its
   SHA-256, which is set the same way as `RELAY_TOKEN_SHA256`; see [`staging.md`](staging.md).
   The token never leaves that machine. Until then the Worker has no relay, and staging says
   donations are closed.
7. **Check it.** The Worker's address should answer `426` at `/relay`, which wants a WebSocket,
   `401` to a WebSocket upgrade without the relay's credential, and `404` to a `POST` at
   `/donations/invoice`, because pages never reach it directly. In the dashboard, the Worker's
   invocation logs should be off: they would keep every request's
   headers, and so visitors' addresses and the relay's, for days. Its own log lines stay on.
8. **Configure the Action.** Create the GitHub environment `staging`, with:

   | Setting | Value |
   |---|---|
   | Secret `CLOUDFLARE_API_TOKEN` | A token with Workers Scripts → Edit and D1 → Edit, scoped to the target account, with an expiry |
   | Secret `CLOUDFLARE_ACCOUNT_ID` | That account's id |
   | Secret `STAGING_WORKER_URL` | The existing staging Worker's HTTPS `workers.dev` address, used for smoke checks |

   The account id and the address are secrets, not variables, because the Action's logs are
   public: GitHub hides secrets there, and the workflow hides the address's account
   subdomain wherever Wrangler prints it.

   The token can edit every Worker in that account, production's and OBL's included, and the
   workflow runs from whatever branch is chosen. So the environment needs these protections,
   which only GitHub's settings can give: required reviewers, with self-review prevented, a
   branch rule, and no bypass for administrators. Before approving a run, a reviewer checks
   what the branch changes against `main` in `.github/`, `scripts/` and
   `wrangler.staging.jsonc`. The workflow also refuses a config that isn't
   `bananapayserver-staging` on signet, which catches a mistake but not malice. Worker limits
   and `RELAY_TOKEN_SHA256` stay in Cloudflare. The Action preserves them and never needs their
   values in GitHub.

   [The workflow](../.github/workflows/cloudflare-staging.yml) becomes available for manual
   dispatch once its reviewed change reaches the default branch, `main`. In Actions, choose
   *Deploy Cloudflare staging*, then *Run workflow* and the branch to deploy, or run:

   ```bash
   gh workflow run cloudflare-staging.yml --ref donations/tally
   ```

   The selected branch must contain the workflow and deployment lockfile. Each run tests and
   deploys that run's exact commit (`github.sha`): Node 22 and 24 test jobs have no deployment
   credentials, then the deployment job installs the locked toolchain without scripts, applies
   pending D1 migrations, deploys with `wrangler.staging.jsonc`, and checks the three public
   responses above. One concurrency group serializes staging runs without cancelling an
   active deployment. Pushes and pull requests do not deploy.

   Until the workflow reaches `main`, a maintainer can use steps 1–7 from the reviewed branch
   with no Cloudflare build or Action deployment running. The deploy command always names the
   config file. Afterwards, the secret list should still include `MAX_SATS`, `RATE_PER_IP`,
   `RATE_GLOBAL`, `SOCKETS_PER_IP`, `PRICE_JUMP_MAX`, `ONCHAIN_FEE_ALLOWANCE` and
   `RELAY_TOKEN_SHA256`.

   ```bash
   node .github/deploy/node_modules/wrangler/bin/wrangler.js \
     secret list -c wrangler.staging.jsonc
   ```

## Staging: OBL's side

In OBL's repository and through its own process, only once `bananapayserver-staging` exists,
since a deploy with a binding to a missing Worker fails. OBL's staging deploys only when
someone runs its *Deploy Cloudflare staging* workflow by hand, from a branch in OBL's own
repository.

- **The binding,** in OBL's `wrangler.staging.jsonc`:

  ```jsonc
  "services": [{ "binding": "DONATIONS", "service": "bananapayserver-staging", "entrypoint": "PageApi" }]
  ```

- **`/donations/*` in `run_worker_first`,** so the Worker, not the static assets, answers those
  paths.
- **The Worker's handling of the page's calls and socket,** and the cave's real mode, as
  [`protocol.md`](protocol.md#how-obls-worker-passes-them-on) sets out. Until OBL's Worker has
  the binding, it treats donations as off.

## Production

Only what has passed staging, and only from `main`; see
[decision 0020](decisions/0020-staging-then-production.md).

1. **The relay's address.** Production's relay dials the Worker's own `workers.dev` address,
   which `wrangler.production.jsonc` turns on; see
   [decision 0019](decisions/0019-production-relay-address.md).
2. **Workers Paid** on the account.
3. **bananapayserver's side,** the staging steps with `production` in place of `staging`,
   except step 8: production has no Action and no deploy token, and a maintainer deploys it
   by hand from `main`. It has its own secrets: production limits and a separate relay
   token. Nothing from staging is reused.
4. **The relay,** beside the donations store's BTCPay, set up as
   [`production.md`](production.md) describes. Its operator hands over only the token's hash.
5. **OBL's side,** the binding to `bananapayserver-production` in OBL's production config, and
   OBL's production deploy, which is run by hand. That deploy is the launch.

The production D1 database is recorded in `wrangler.production.jsonc`. Reuse it, apply all
pending migrations before deploying, and never copy staging's rows or secrets into it. The
Worker uses the same source, `DONATIONS` Durable Object class, and `PageApi` entrypoint as
staging, with its own object namespace and `NETWORK=mainnet`.

Run the same read-only public checks after a production deploy, with `PRODUCTION_WORKER_URL`
set to its HTTPS base address in the terminal:

```bash
node scripts/check-staging.mjs --production
```

The checker first verifies the selected config names the matching Worker, network and database.
Staging remains the default; production requires `--production` and its separate URL. It then
expects `/relay` to return `426`, an unauthenticated WebSocket upgrade to return `401`, and
public `POST /donations/invoice` to return `404`. It creates no invoice or payment.

For OBL's launch, its production config needs:

```jsonc
"services": [{ "binding": "DONATIONS", "service": "bananapayserver-production", "entrypoint": "PageApi" }]
```

OBL also needs `/donations/*` in `run_worker_first` and the forwarding code described in
[`protocol.md`](protocol.md#how-obls-worker-passes-them-on). Before that launch, set the
production limits and the hash supplied by the production relay's operator through Wrangler's
secret prompts. Donations stay closed while required limits or the relay are absent; creating
the Cloudflare resources alone does not enable mainnet donations.

## Historical import accounting

The [production overview](production.md#donations-from-before-launch) records which
pre-launch donations were imported and how to find their BTCPay records. The corrections
below have already been completed. They are not steps to replay during a deployment.
Any future correction to production's D1 or the object's storage must be proposed in a
reviewed change before it is made.
Payment identifiers remain in the operational records; this public runbook identifies each
correction by the order id from the overview.

### D1 records and the live pile

Inserting a row into D1's `donations` table updates `totals`, `tally` and `tally_hours` through
the existing insert triggers. It does **not** add to the live pile, which lives in the
production Durable Object's SQLite `pile` table. Normal paid notices reach `paid()` and
`finish()`, which adds the bananas and inserts a `finished` marker in one storage transaction.
The historical imports used separate manual D1 inserts, pile updates and marker inserts.

### Initial on-chain correction

The team first agreed to start the pile at 10,000 bananas, then decided it should start from
donations alone. For order `test-OBL-ln-node-BTC-donos`, the manual correction **replaced**
that starting pile with the first import's bananas, rather than adding to it. `pile.at` was
set to the payment's first-confirmation time. The update required the previously observed
`milli`, `at` and `started` values to match and left `started` unchanged. The imported amounts
and balances remain in the operational records.

A separate conditional insert added the D1 record's id to `finished.invoice`, with the
import time in `finished.at`, only after the corrected pile row was present. It used
`ON CONFLICT (invoice) DO NOTHING`. For this record the marker key is the transaction id,
matching the D1 key described in the overview, rather than the BTCPay invoice id.

`PILE_START` was then disabled; consumption was already disabled with `PILE_EAT_PER_HOUR`.
Changing `PILE_START` alone cannot reset a pile that already exists.

### Historical Lightning correction

For order `test-OBL-ln-node-donos`, two newer live donations were already present. The manual
correction **added** the second import's bananas to the existing pile. The update required
the previously observed balance and `pile.at`, and no `finished` row for the imported record.
It moved `pile.at` to the import time and preserved `started`.

A separate conditional insert then added the D1 record's id to `finished.invoice`, with the
same import time in `finished.at`, only after the corrected balance and timestamp matched.
It also used `ON CONFLICT (invoice) DO NOTHING`. Here the marker key is the BTCPay invoice
id used by D1; its value is omitted from this public runbook.

The pile update and marker insert were separate manual statements, unlike the normal
transactional `finish()` path. The starting-pile and consumption settings stayed unchanged.

### Duplicate-credit protection and persistence

Both D1 inserts used `ON CONFLICT (id) DO NOTHING`. D1's unique `id` prevents a repeated
insert from running the donor-total and tally triggers again. Separately, each imported
record has a unique `finished.invoice` marker, so `finish()` cannot add that credit to the
pile again. These storage protections supplement the relay's order-id filtering described
in the overview. Neither manual import broadcast a donation event, so neither triggered the
falling-banana animation.

The 2026-10-16 audit found the active production Worker byte-for-byte identical to a local
dry-run build of `b7c9b27bba310f61d2fb43286becc2e54caaff49`, using pinned Wrangler 4.146.0.
The deployment worktree's archived snapshot was exactly that commit, with no source changes.
The manual SQLite corrections explain the pile changes; there was no additional
pile-accounting code in production.

Preserve the existing production D1 database, Durable Object namespace, `pile` row and
`finished` markers when deploying. Audit an import by comparing its D1 row and triggered
totals with the object's pile and corresponding marker, using the operational records to
identify it. The current pile can include later payments and consumption; do not restore
either historical balance or replay these corrections.

## Never

- Deploy production before staging passes, or from anywhere but `main`.
- Put a limit, a token or a token's hash in a file, a commit, a chat or a screenshot.
- Rename either Worker. OBL's bindings find them by name.
- Add routes, custom domains or preview URLs beyond what this page says, or turn invocation
  logs on.
- Create an API token for deploying bananapayserver, other than the staging Action's token.
- Connect either Worker to the repository through Workers Builds, or turn preview builds on.
- Deploy by hand or set a secret while another deployment is running, or change either
  Worker's code in the dashboard.

## Reporting back

On the pull request being deployed: the `database_id`, the Worker's `workers.dev` address, the
three status codes from the check, the deployed commit and workflow run's result (or manual
deploy result), and any error with its full output, excluding secrets.

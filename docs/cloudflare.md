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
- **Staging deploys on push; production by hand.** Once set up, staging is deployed by
  Cloudflare's Git connection on each push to its branch, with the one token that connection
  holds; see [decision 0015](decisions/0015-staging-deploys-on-push.md). Production is
  deployed by a person signed in as themselves, and has no deploy token.
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
- Node 22 or newer and git. Wrangler, Cloudflare's command-line tool, runs through `npx` at one
  exact version, 4.146.0.
- The environment's limits, from the team: the largest donation in sats (`MAX_SATS`), and the
  invoice requests allowed per visitor and for everyone together each minute (`RATE_PER_IP`,
  `RATE_GLOBAL`). They're typed at a prompt, and never go in a file, a commit or a chat. See
  [`configuration.md`](configuration.md) for every setting.

## Staging: bananapayserver's side

Once, from a checkout of the branch under review, with `CLOUDFLARE_ACCOUNT_ID` set. After step
8, pushes deploy staging.

1. **Sign in.** `npx wrangler@4.146.0 login`, then `npx wrangler@4.146.0 whoami`, which should
   show the deployer's own email and OBL's account.
2. **Create the database.** `npx wrangler@4.146.0 d1 create bananapayserver-staging` prints a
   `database_id`. It replaces `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.staging.jsonc` and is
   committed; an id isn't a secret.
3. **Create its tables.** `npx wrangler@4.146.0 d1 migrations apply bananapayserver-staging`,
   with `--remote -c wrangler.staging.jsonc`, should mark `0001_donations.sql` and
   `0002_stats.sql` done. Migrations are always applied before deploying a Worker that needs
   them; without them, payments can't be recorded and pile up unacknowledged at the relay.
4. **Deploy.** `npx wrangler@4.146.0 deploy -c wrangler.staging.jsonc` should list three
   bindings, `DONATIONS`, `DB` and `NETWORK` set to `signet`, and print the Worker's address,
   `https://bananapayserver-staging.<account subdomain>.workers.dev`. Donations stay closed
   until the limits are set; with a limit missing, the Worker refuses donations rather than
   guess.
5. **Set the limits.** `npx wrangler@4.146.0 secret put <name> -c wrangler.staging.jsonc` for
   each of `MAX_SATS`, `RATE_PER_IP` and `RATE_GLOBAL`, typing the value at the prompt.
6. **Set the relay's token hash, once the staging relay exists.** Whoever sets up the signet
   stack on its machine generates the relay's token there and hands over only its
   SHA-256, which is set the same way as `RELAY_TOKEN_SHA256`; see [`staging.md`](staging.md).
   The token never leaves that machine. Until then the Worker has no relay, and staging says
   donations are closed.
7. **Check it.** The Worker's address should answer `426` at `/relay`, which wants a WebSocket,
   and `404` to a `POST` at `/donations/invoice`, because pages never reach it directly. In the
   dashboard, the Worker's invocation logs should be off: they would keep every request's
   headers, and so visitors' addresses and the relay's, for days. Its own log lines stay on.
8. **Connect the repository.** On GitHub, the OogaBoogaX organisation's Cloudflare Workers and
   Pages app is given access to this repository. In the dashboard, the Worker's Settings →
   Builds → Connect, with:

   | Setting | Value |
   |---|---|
   | Git branch | the top of the stack until it merges, then `main` |
   | Preview builds | off |
   | Build command | `node --test --test-timeout=60000` |
   | Deploy command | `npx --yes wrangler@4.146.0 d1 migrations apply bananapayserver-staging --remote -c wrangler.staging.jsonc && npx --yes wrangler@4.146.0 deploy -c wrangler.staging.jsonc` |
   | Root directory | `/` |
   | API token | a new one, then given *D1 → Edit* under its owner's API tokens |
   | Build variable | `SKIP_DEPENDENCY_INSTALL` set to `1`, since there is no `package.json` |

   The deploy command always names the config file: the default `npx wrangler deploy` finds no
   config at the root and deploys something else. A push then runs the tests, applies
   migrations and deploys; `npx wrangler@4.146.0 secret list -c wrangler.staging.jsonc` should
   still list every secret afterwards. When the branch merges, move the Worker's branch to the
   next one down the stack: the repository deletes merged branches, and builds stop without
   saying so.

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

After staging passes, and from `main`:

1. **Decide where the production relay connects.** Either the Worker's `workers.dev` address,
   which means setting `workers_dev` to `true` in `wrangler.production.jsonc`, or a name on
   `oogabooga.land`. A name there needs that zone's Bot Fight Mode off, because it applies to
   the whole zone, can't exempt a path, and would challenge the relay's Tor connections. It
   also needs a rule turning off Browser Integrity Check for that name, and no rule blocking
   Tor, which Cloudflare labels as country `T1`.
2. **Workers Paid** on the account.
3. **bananapayserver's side,** the staging steps with `production` in place of `staging`,
   except step 8: production isn't connected to the repository. It has its own secrets: production limits and a separate relay token. Nothing from staging is
   reused.
4. **OBL's side,** the binding to `bananapayserver-production` in OBL's production config, and
   OBL's production deploy, which is run by hand. That deploy is the launch.

## Never

- Deploy production before staging passes, or from anywhere but `main`.
- Put a limit, a token or a token's hash in a file, a commit, a chat or a screenshot.
- Rename either Worker. OBL's bindings find them by name.
- Add routes, custom domains or preview URLs beyond what this page says, or turn invocation
  logs on.
- Create an API token for deploying bananapayserver, other than the one staging's Git
  connection holds.
- Connect production to the repository, turn preview builds on, or leave a build's deploy
  command at its default.
- Deploy staging by hand or set a secret while a build is running, or change either Worker's
  code in the dashboard.

## Reporting back

On the pull request being deployed: the `database_id`, the Worker's `workers.dev` address, the
two status codes from the check, the first build's result, and any error with its full output.

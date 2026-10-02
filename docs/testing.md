# Testing

Two kinds of test. `node --test` runs the automated tests, which put the Worker, the object
and the relay through stand-ins for BTCPay and Cloudflare. The end-to-end runs below put a real
BTCPay, real Lightning payments and, from stage 2, real Cloudflare and Tor behind the same
flow a donor uses.

Everything here runs on regtest or signet. Real funds are never part of testing: the first
mainnet donation is the launch, which belongs to the deployment decision.

## Automated tests

```bash
node --test
```

Node 22 or newer, nothing to install. They can't catch the Workers runtime, BTCPay or Tor
behaving differently from the stand-ins, which is what the stages below are for.

## Stage 1: one machine, regtest, no Tor

Proves the whole path end to end. You need Docker, Node 22 or newer, and a checkout of
BTCPay Server with what its contributor docs list for running it from source.

1. **A regtest Lightning network and BTCPay.** In BTCPay's repository, run
   `docker compose up dev` in `BTCPayServer.Tests`. That starts bitcoind on regtest,
   NBXplorer, Postgres, and two LND nodes: the merchant, which plays the donating node, and
   the customer, which plays the donor. Run BTCPay from source as its contributor docs
   describe; it serves at `https://localhost:14142`. Then open channels between the two with
   `./docker-lightning-channel-setup.sh`.
2. **The store.** In BTCPay, create a store with a regtest on-chain wallet, and connect its
   Lightning to the merchant LND. Create an API key for that store with only "View invoices"
   and "Create an invoice". Add a webhook for "An invoice has been settled" to
   `http://localhost:8080/btcpay`, with a secret.
3. **GitHub sign-in, if you're testing it.** Register a GitHub OAuth app for local testing,
   with `http://localhost:8787/auth/github/callback` as its callback. Its id and secret, and a
   session key, go in `.dev.vars` in the next step. Without them, every donation is anonymous.
4. **The Worker.** Copy `.dev.vars.example` to `.dev.vars` and fill in the limits and the
   relay token's hash ([`configuration.md`](configuration.md) shows how to make both). Then:

   ```bash
   npx wrangler@4.146.0 d1 migrations apply bananapayserver --local
   npx wrangler@4.146.0 dev
   ```

   Wrangler is Cloudflare's tool and comes from npm; use one exact version and say which in
   the PR. How it is pinned for deployment is still open.
5. **The relay.** Make `relay/.env` from `relay/.env.example` with
   `WORKER_URL=ws://localhost:8787/relay`, `DIRECT=yes`, the token, the BTCPay settings and a
   `MAX_SATS`, then run `node --env-file=relay/.env relay/main.mjs`. BTCPay's development
   server uses a self-signed certificate, so point `NODE_EXTRA_CA_CERTS` at it. The relay
   should log `line: open`.
6. **The stand-in page.** [`tools/donate.html`](../tools/donate.html) stands in for the cave
   until OBL's real mode exists. Serve it with `python3 -m http.server 8000 --directory tools`
   and open `http://localhost:8000/donate.html`. It should say donations are open and show the
   pile. The page and the API are both on `localhost`, so the sign-in cookie works between
   them.
7. **A donation.** Ask for 10,000 sats and check the rate and the banana counts it shows. Copy
   the invoice and pay it from the customer node:
   `./docker-customer-lncli.sh payinvoice --force <invoice>`.
8. **What to expect.** The page lists the donation and marks it as yours, the pile grows by
   its bananas, and D1 has one row:

   ```bash
   npx wrangler@4.146.0 d1 execute bananapayserver --local --command "SELECT * FROM donations"
   ```

Then the failure drills:

| Do this | Expect this |
|---|---|
| Stop the relay | The page says donations are closed within seconds, and asking for an invoice answers `closed` |
| Stop BTCPay, start the relay, then start BTCPay | The relay logs that it's trying again, then finds its invoices once BTCPay answers |
| Turn the webhook off and pay an invoice | The donation still arrives, within about a minute |
| Redeliver a webhook from BTCPay's list of deliveries | No second donation |
| Switch to on-chain, pay the address with `./docker-customer-lncli.sh sendcoins --addr <address> --amt <sats>`, and mine with `./docker-bitcoin-generate.sh 6` | The donation arrives once the store has the confirmations it requires, recorded with method `onchain` |
| Ask for more than the relay's `MAX_SATS` | The page shows the `amount` error |
| Restart the Worker while the page is open | The page reconnects and catches up on anything it missed |
| Sign in with GitHub and donate, then donate again with "Give anonymously" | The first appears on the leaderboard under your username; the second only adds to the pile |
| Open a second page and watch both for a few minutes | Both show the same pile, falling at the same rate |
| Stop the price sources answering, for example by taking the machine offline briefly, and donate | The donation still goes through, counted at the last price; `price_at` in D1 shows when that was |

## Stage 2: Cloudflare and Tor

The same steps against a real Worker, with the relay's line over Tor. Use regtest again, or
signet: BTCPay ships `docker-compose.mutinynet.yml`, a signet with 30-second blocks, for paying
from a wallet elsewhere.

1. **A test Worker** on a Cloudflare account the team owns; the free plan is enough. Create
   the database with `npx wrangler@4.146.0 d1 create bananapayserver` and put its id in your
   local copy of `wrangler.jsonc`, with `workers_dev` on for the test. Set the network,
   origins, limits and token hash as [`configuration.md`](configuration.md) describes, apply
   the migration with `--remote`, and deploy with `npx wrangler@4.146.0 deploy`.
2. **Tor** on the relay's machine, with its SOCKS proxy on the default port 9050. Point the
   relay at `wss://<test host>/relay` with `TOR_SOCKS=127.0.0.1:9050` and without `DIRECT`.
3. **The stand-in page**, with its API address set to the test host and its origin in
   `ALLOWED_ORIGINS`. Sign-in only works when the page and the API are on the same site, so
   with the API on a `workers.dev` address and the page on `localhost`, test sign-in in
   stage 1 instead.
4. **Stage 1's steps and drills** again.
5. **The Tor trial's numbers**, for [decision 0005](decisions/0005-relay-over-tor.md): the
   page shows how long each invoice took, and the relay logs every time the line closes. Keep
   both for a day.

## Stage 3: from the cave

This needs OBL's `donations.js` in real mode, built through OBL's own process against
[`protocol.md`](protocol.md). Serve OBL with its origin allowed, walk into the Lightning
Factory or the hub, and donate. Pay from the customer node on regtest or a wallet on signet.
Watch the pile and the Banana Cooker in two browsers; the donor's page should say thanks.

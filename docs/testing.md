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

Proves the whole path end to end, through the same service binding OBL's Worker uses. You need
Docker, Node 22 or newer, curl, jq and openssl, and a checkout of BTCPay Server with what its
contributor docs list for running it from source. BTCPay 2.4.4 needs the .NET 10 SDK.
[`scripts/regtest.sh`](../scripts/regtest.sh) does the setup; give it the checkout as
`BTCPAY_DIR`.

1. **A regtest Lightning network.** `scripts/regtest.sh up` starts BTCPay's development
   network: bitcoind on regtest, NBXplorer, Postgres, and two LND nodes. The merchant node
   plays the donating node, and the customer node plays the donor. It also gives the customer
   a channel to the merchant.
2. **BTCPay.** In the checkout's `BTCPayServer` folder, run
   `dotnet run --launch-profile Bitcoin`. That profile serves plain HTTP at
   `http://localhost:14142`, so there's no certificate to trust.
3. **The store.** `scripts/regtest.sh setup` creates the store, with Lightning on the merchant
   node and a watch-only regtest wallet, plus an API key that can only create and view invoices
   on it, and the webhook. It writes `.dev.vars` and `relay/.env` with fresh secrets. BTCPay's
   web pages take its development admin, from `setup-dev-basics.sh` in the checkout.
4. **The Worker,** under its staging name, so that bindings find it:

   ```bash
   npx wrangler@4.146.0 d1 migrations apply bananapayserver-staging --local -c wrangler.staging.jsonc
   npx wrangler@4.146.0 dev -c wrangler.staging.jsonc --port 8787
   ```

   Wrangler is Cloudflare's tool and comes from npm; use one exact version and say which in
   the PR. `.dev.vars` sets the network to regtest.
5. **The relay.** Run `node --env-file=relay/.env relay/main.mjs`. It should log `line: open`.
6. **A page,** in one of two ways:
   - **The stand-in** for OBL's page and Worker, in [`tools/stand-in/`](../tools/stand-in/).
     Run `npx wrangler@4.146.0 dev -c tools/stand-in/wrangler.jsonc --port 8788`, check its
     binding shows as `connected`, and open `http://localhost:8788`. It should say donations
     are open, on regtest, and show the pile. Name a GitHub id and username there to test a
     signed-in donation; OBL's Worker takes them from its sign-in.
   - **OBL's own page and Worker,** run locally from their repository with their binding to
     `bananapayserver-staging`.
7. **A donation.** Ask for 10,000 sats and check the rate and the banana counts it shows. Pay
   it with `scripts/regtest.sh pay <invoice>`.
8. **What to expect.** The page lists the donation and marks it as yours, the pile grows by its
   bananas, and D1 has one row:

   ```bash
   npx wrangler@4.146.0 d1 execute bananapayserver-staging --local -c wrangler.staging.jsonc --command "SELECT * FROM donations"
   ```

**After a restart,** start Docker and run `scripts/regtest.sh up` again, then BTCPay, the
Worker, the relay and the page. `up` mines a block, because the Lightning nodes wait for one
newer than the last they saw. Until then, BTCPay can't make Lightning invoices, and donations
read as closed. `scripts/regtest.sh reset` starts again from nothing.

Then the failure drills:

| Do this | Expect this |
|---|---|
| Stop the relay | The page says donations are closed within seconds, and asking for an invoice answers `closed` |
| Stop BTCPay, start the relay, then start BTCPay | The relay logs that it's trying again, then finds its invoices once BTCPay answers |
| Turn the webhook off and pay an invoice | The donation still arrives, within about a minute |
| Redeliver a webhook from BTCPay's list of deliveries | No second donation |
| Switch to on-chain, pay the address with `./docker-customer-lncli.sh sendcoins --addr <address> --amt <sats>` in the checkout's `BTCPayServer.Tests`, and mine with `scripts/regtest.sh mine 6` | The donation arrives once the store has the confirmations it requires, recorded with method `onchain` |
| Ask for more than `MAX_SATS` | The page shows the `amount` error |
| Restart the Worker while the page is open | The page reconnects and catches up on anything it missed |
| Stop the Worker while the stand-in is open | The stand-in answers `closed` for anything the page asks |
| Ask the Worker's own address, `http://localhost:8787`, for `/donations/invoice` | 404: only the relay's line is public |
| Name a test donor on the stand-in and donate, then donate again with "Give anonymously" | The first appears on the leaderboard under that name; the second only adds to the pile |
| Open a second page and watch both for a few minutes | Both show the same pile, falling at the same rate |
| Stop the price service answering, for example by taking the machine offline briefly, and donate | The donation still goes through, counted at the last price; the page shows an alert, and `price_at` in D1 shows when that price was fetched |

## Stage 2: staging, on signet and over Tor

The same steps against `bananapayserver-staging` on Cloudflare, called by OBL's staging
Worker, with a signet BTCPay and LND whose relay connects over Tor. Signet coins are
worthless, but the payments are real ones on a public test network.

1. **Deploy `bananapayserver-staging`** as [`cloudflare.md`](cloudflare.md) describes, with
   OBL's side of the binding.
2. **The staging stack:** a signet BTCPay and LND, isolated from anything that holds real
   funds, with the relay reaching `bananapayserver-staging` through Tor, as
   [`staging.md`](staging.md) describes.
3. **OBL adds its staging binding,** and its staging page goes live, labelled as test because
   the status message says `signet`.
4. **Stage 1's steps and drills** again, paying from a signet wallet.
5. **The Tor trial's numbers,** for [decision 0005](decisions/0005-relay-over-tor.md): the page
   shows how long each invoice took, and the relay logs every time the line closes. Keep both
   for a day.

## Stage 3: from the cave

OBL's `donations.js` in real mode, against [`protocol.md`](protocol.md). Run OBL's page and
Worker locally against stage 1, then on staging against stage 2. Walk into the Lightning
Factory or the hub, and donate. Watch the pile and the Banana Cooker in two browsers; the
donor's page should say thanks.

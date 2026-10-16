# Running the production relay

The production relay connects the BTCPay that serves the donations store to
`bananapayserver-production`. It runs beside that BTCPay, on the same machine and on BTCPay's
own Docker network, because everything it does goes through BTCPay: it asks BTCPay's API for
invoices, and BTCPay's webhook tells it when one is paid. It never touches LND. It dials the
Worker over Tor, publishes no port, and holds only a BTCPay key that can create and view
invoices on one store. The files are in [`deploy/production/`](../deploy/production/).

This is the launch setup. Its hardening follows after launch; see
[What follows launch](#what-follows-launch).

The machine's operator sets it up, by hand, from `main` only
([decision 0020](decisions/0020-staging-then-production.md)). Nothing pushes to the machine.

## Before you start

- **BTCPay can't read LND's data folder.** Some packaged BTCPay installs mount it, admin
  macaroon included, for an "internal node" option. Remove that mount and the internal-node
  connection, and check again after every BTCPay update:

  ```bash
  docker inspect <BTCPay's container> --format '{{range .Mounts}}{{.Destination}} {{end}}'
  ```

  Nothing in the list may be LND's data folder.
- **BTCPay reaches LND only with an invoice-only macaroon.** Decode the macaroon in the store's
  Lightning connection string with `lncli printmacaroon <hex>`. Its permissions must be exactly
  `info:read`, `invoices:read` and `invoices:write`.
- **BTCPay's pages are private.** Two-factor sign-in on every admin account, and public user
  registration off.
- **The store settles an on-chain payment only after at least one confirmation.** A payment
  that settles unconfirmed and is later double-spent would stay on the pile.
- **The machine has** Docker Engine, Docker Compose v2, git and openssl.

## Steps

1. **Get the code,** from `main`, into a folder of its own:

   ```bash
   git clone --branch main https://github.com/OogaBoogaX/bananapayserver.git .
   ```

   Then `cd deploy/production`. Every later step runs from there.

2. **Start `.env`:**

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   Fill in, finding BTCPay's values from its container. `docker ps` names it; it's the one
   running the `btcpayserver/btcpayserver` image.
   - **`WORKER_URL`:** `wss://bananapayserver-production.<account subdomain>.workers.dev/relay`.
   - **`BTCPAY_NETWORK`:** the network BTCPay's container is on:

     ```bash
     docker inspect <BTCPay's container> --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
     ```

   - **`BTCPAY_URL`:** `http://<BTCPay's container>:<port>`, with the port from its
     `BTCPAY_BIND` setting:

     ```bash
     docker exec <BTCPay's container> printenv BTCPAY_BIND
     ```

   - **`TOR_SOCKS`:** the Tor proxy BTCPay itself uses, as `host:port`:

     ```bash
     docker exec <BTCPay's container> printenv BTCPAY_SOCKSENDPOINT
     ```

   - **`MAX_SATS` and `RATE_PER_MINUTE`:** the team's production values. `RATE_PER_MINUTE` is at
     least twice the Worker's `RATE_GLOBAL`.

3. **In BTCPay,** signed in as the store's owner:
   - **The store's id,** from the store's settings, as `BTCPAY_STORE_ID`.
   - **An API key** under the account's API keys: label it `relay`, give it only "Create
     invoice" and "View invoices", limited to the donations store, and put it in `.env` as
     `BTCPAY_API_KEY`. Nothing else: no store settings, no payouts, no server access.
   - **The webhook,** in the store's settings:
     - URL `http://obl-relay:8080/btcpay`;
     - a secret from `openssl rand -hex 32`, also in `.env` as `BTCPAY_WEBHOOK_SECRET`;
     - specific events only: "An invoice has been settled", "An invoice received a payment"
       and "A payment has been settled" (`InvoiceSettled`, `InvoiceReceivedPayment`,
       `InvoicePaymentSettled`);
     - automatic redelivery on.

4. **Make the relay's token:**

   ```bash
   ./token.sh
   ```

   It writes the token to `.env` and prints only its SHA-256. Send the hash, and only the hash,
   to whoever deploys `bananapayserver-production`, who sets it as `RELAY_TOKEN_SHA256` after
   production has been deployed from `main`; see [`cloudflare.md`](cloudflare.md#production).
   The token stays in `.env` on this machine.

5. **Build and start:**

   ```bash
   docker compose -p obl-relay up -d --build
   ```

   `docker compose -p obl-relay logs relay` shows `line: open` once the hash is set on the
   Worker. Until then it shows refused connections, and keeps trying.

6. **Check it:**
   - **No published port:** `docker ps --format '{{.Names}} {{.Ports}}' | grep obl-relay` shows
     the relay with nothing after its name.
   - **Not on the machine's own network:**

     ```bash
     docker inspect obl-relay-relay-1 --format '{{.HostConfig.NetworkMode}}'
     ```

     It should print BTCPay's network, never `host`.
   - **No secrets in the log:** `docker compose -p obl-relay logs relay` shows no token, key
     or macaroon.

## Running it

- **Logs:** `docker compose -p obl-relay logs --tail 50 relay`.
- **After a reboot or a crash:** Docker starts the relay again by itself.
- **After a BTCPay update:** check again that BTCPay can't read LND's data folder.
- **Update:** `git pull` on `main`, then `docker compose -p obl-relay up -d --build`.
- **Stop:** `docker compose -p obl-relay stop`. Donations close until it's back.
- **Secrets:** `.env` holds the relay's token, BTCPay's key and the webhook's secret. It stays
  readable by its owner only, and is never copied off this machine.

## Donations from before launch

Production's D1 also holds two donations from the tests before launch. They're settled invoices
in the donations store like every other donation, but they were made in BTCPay directly, not by
the relay, and were added to D1 by hand at launch. Their order ids are `test-OBL-ln-node-donos`
and `test-OBL-ln-node-BTC-donos`, not the relay's `bananapayserver`, and the on-chain one is
recorded under its payment's transaction id rather than its invoice id.

- **They can't be counted twice:** the relay never acts on an invoice it didn't make.
- **A rebuild from BTCPay** has to include those two order ids as well as the relay's.

## What follows launch

The launch setup keeps the rules in [`AGENTS.md`](../AGENTS.md): nothing opens on the node, the
relay holds no credential that can spend or control it, and its line goes over Tor. What it
doesn't yet have, as staging does, is a fence at the network level:

- **A private network shared only with BTCPay.** On BTCPay's network the relay can reach
  whatever else is there, and anything there can reach its webhook port, which accepts only
  BTCPay's signed deliveries.
- **Tor as the only way out.** The relay goes over Tor because its settings say so; on a
  network with a route to the internet, nothing else enforces it.
- **Its own Tor container and firewall,** as in [`staging.md`](staging.md), with a job that
  keeps the firewall up and BTCPay attached after a reboot or a BTCPay update.

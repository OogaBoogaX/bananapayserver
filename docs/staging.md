# Running the staging stack

`bananapayserver-staging` takes donations on signet through a stack of its own: bitcoind on
mutinynet, NBXplorer, Postgres, BTCPay, LND, Tor, and the relay that connects them to the
Worker. For donation testing while the node is a proof of concept, it runs on a team member's
machine, beside a mainnet node that holds real funds, with its owner's agreement. It is fenced
off from that node and from the machine, and runs only while it's needed. After the proof of
concept, staging moves to a cloud server; see
[decision 0016](decisions/0016-staging-beside-the-node.md).
The files are in [`deploy/staging/`](../deploy/staging/).

The machine's operator deploys it, by hand. Nothing pushes to the machine, CI included.

## The fence

- **No published ports.** Nothing in the stack listens outside Docker.
- **Only Tor reaches the internet.** BTCPay, NBXplorer, Postgres, bitcoind and LND sit on a
  network with no way out, and the relay on another, shared only with BTCPay and Tor. bitcoind
  and LND reach signet's peers through Tor, and the relay reaches the Worker through Tor, so
  the machine's address stays hidden, as the mainnet node's is.
- **A firewall,** [`firewall.sh`](../deploy/staging/firewall.sh): Tor's network can't reach the
  machine or any private network, and no staging network can reach the machine's own addresses.
- **No IPv6:** the firewall fences IPv4, so no container in the stack has an IPv6 address.
- **Nothing shared with the mainnet node:** its own data, keys, wallets, macaroons and secrets.
  BTCPay reaches its own LND with a macaroon that can only make and read invoices.
- **Caps:** memory, CPU and process limits on every container, rotated logs, a pruned chain,
  and no container with extra privileges. Memory limits also need the kernel's memory
  controller, so bitcoind's caches and the .NET heaps have limits of their own.
- **Pinned:** every image by digest.
- **Nothing starts by itself,** not after a crash and not after a reboot. The firewall's rules
  don't outlive a reboot, so [`start.sh`](../deploy/staging/start.sh) puts them back up first,
  checks them against the stack's networks, and only then starts the stack.

## What the machine needs

- Linux with Docker Engine, Docker Compose v2, iptables, git and openssl.
- About 10 GB of free disk where Docker keeps its data: about 3 GB of images, a few GB for the
  pruned chain, and logs capped at 30 MB a container.
- About 3 GB of free memory. The caps add up to a little over 4 GB at the very most.
- The kernel's memory controller, or Docker ignores the memory caps: `docker info` warns
  `No memory limit support`. Raspberry Pi kernels ship with it off, and turning it on means
  changing the kernel's boot settings and rebooting. Without it, watch `free -h` while staging
  runs, and stop it if less than about 1 GB is available.
- A folder of its own for the stack, outside wherever the node's operating system keeps its
  apps.

## Steps

1. **Get the code** into that folder, on the branch being staged:

   ```bash
   git clone --branch <branch> https://github.com/OogaBoogaX/bananapayserver.git
   ```

   Then `cd bananapayserver/deploy/staging`. Every later step runs from there.

2. **Fill in `.env`,** from [`.env.example`](../deploy/staging/.env.example):

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   - **The subnets:** keep the defaults unless `ip route` shows a network on this machine
     already uses them.
   - **`SIGNET_PEER`:** mutinynet's seed node, as `host:port`, from mutinynet's own
     documentation. BTCPay Server's `BTCPayServer.Tests/docker-compose.mutinynet.yml` lists it
     as `addnode`.
   - **`BITCOIN_RPC_PASSWORD` and `POSTGRES_PASSWORD`:** fresh values, made here and used
     nowhere else, from `openssl rand -hex 24`.
   - **`WORKER_URL`:** `wss://bananapayserver-staging.<account subdomain>.workers.dev/relay`.
   - **`RELAY_MAX_SATS`:** the team's cap for staging.
   - **`RELAY_RATE_PER_MINUTE`:** the team's limit on invoices and on-chain addresses a
     minute, at least staging's `RATE_GLOBAL`.

3. **Put up the firewall,** as root, before anything starts. It works from the subnets in
   `.env`, so the stack's networks don't need to exist yet:

   ```bash
   sudo ./firewall.sh
   ```

   The rules last until the next reboot, unless the machine's own firewall tools save them.
   `start.sh`, next, puts them back every time the stack starts.

4. **Build and start everything but the relay,** which waits for step 6:

   ```bash
   docker compose -p obl-staging build relay
   ```

   ```bash
   ./start.sh tor bitcoind postgres nbxplorer lnd btcpay
   ```

   [`start.sh`](../deploy/staging/start.sh) is how the stack always starts. It puts the
   firewall's rules up, checks that the stack's networks use the subnets the rules guard, and
   only then starts anything.

   Then check the fence. From Tor's network, the machine and its LAN must be out of reach.
   This probe tries one address and port from one of the stack's networks, here the machine's
   LAN address and SSH's port:

   ```bash
   docker run --rm --network obl-staging_outside obl-staging-relay node -e "const s = require('net').connect(+process.argv[2], process.argv[1]); s.setTimeout(4000); const say = (what, code) => { console.log(what); process.exit(code); }; s.on('connect', () => say('REACHABLE: it connected', 1)); s.on('timeout', () => say('blocked: no answer', 0)); s.on('error', (e) => e.code === 'ECONNREFUSED' ? say('REACHABLE: it refused, so something answered', 1) : say('blocked: ' + e.code, 0));" <LAN address> 22
   ```

   Each one should print `blocked`, with no answer or no route. A refusal counts as reachable:
   it means the machine answered. The output names no address, so it can be shared as is.
   Try, from `obl-staging_outside`:

   - the machine's LAN address, on SSH's port, and on each port the mainnet node publishes
     there, such as its bitcoind RPC, LND gRPC and LND REST ports, by default 8332, 10009 and
     8080;
   - another device on the LAN, such as the router, on a port it answers, such as 80;
   - an address on one of the machine's other Docker networks, if it has any, on a port a
     container there listens on; `docker network ls` and `docker network inspect` list them.

   Then from `obl-staging_front` and `obl-staging_backend`, the machine's LAN address and each
   network's own gateway, on SSH's port:

   ```bash
   docker network inspect obl-staging_front --format '{{(index .IPAM.Config 0).Gateway}}'
   ```

   The firewall fences IPv4 only, so the stack's containers have no IPv6 at all. Tor sits on
   all three networks; this should print nothing:

   ```bash
   docker compose -p obl-staging exec tor cat /proc/net/if_inet6
   ```

5. **Wait for the chain.** bitcoind syncs mutinynet through Tor, which takes hours.

   ```bash
   docker compose -p obl-staging exec bitcoind bitcoin-cli -datadir=/data getblockchaininfo
   ```

   It's done when `initialblockdownload` is `false` and `blocks` matches mutinynet's height on
   its explorer. LND and BTCPay follow by themselves.

6. **Run the setup:**

   ```bash
   ./setup.sh
   ```

   It waits for LND and BTCPay to catch up, then gives BTCPay its admin, the store, its
   Lightning connection with an invoice-only macaroon, a watch-only on-chain wallet, the
   relay's key and the webhook. It adds the relay's settings to `.env` and prints the relay
   token's SHA-256. If it says it couldn't delete its unrestricted key, delete that key in
   BTCPay's API keys before going on. Send the hash, and only the hash, to whoever deploys
   `bananapayserver-staging`, who sets it as `RELAY_TOKEN_SHA256` while no build is running;
   see [`cloudflare.md`](cloudflare.md). The token stays in `.env` on this machine.

   If setup stops partway, after it made BTCPay's admin, it can't run again: the admin exists,
   and its password went with the run. Start BTCPay over, keeping the chain and LND, with
   `docker compose -p obl-staging rm -sf btcpay nbxplorer postgres`, then
   `docker volume rm obl-staging_btcpay obl-staging_nbxplorer obl-staging_postgres`, then
   step 4's `./start.sh` and `./setup.sh` again.

   LND's log should hold no macaroon. This should print `0`; anything else means a macaroon
   has been written to the log, and LND's volume has to be reset before going on:

   ```bash
   docker compose -p obl-staging logs lnd | grep -c 0201036c6e64
   ```

7. **Start the relay,** once the hash is set:

   ```bash
   ./start.sh relay
   ```

   `docker compose -p obl-staging logs relay` should show `line: open`. Staging then says
   donations are open, on signet. Requests now reach this machine, so tell the team to lower
   staging's `RATE_GLOBAL`.

8. **Fund LND** with a small on-chain balance, about 50,000 sats. LND only accepts a channel
   when it holds a reserve for fee bumping. Get an address:

   ```bash
   docker compose -p obl-staging exec lnd lncli -n signet newaddress p2wkh
   ```

   Send it signet coins from mutinynet's faucet, which needs a GitHub sign-in and caps what it
   gives a day across everything it does, so leave room for paying test invoices. Wait for
   `lncli -n signet walletbalance` to show them confirmed. Blocks come every 30 seconds.

9. **Make room to receive.** LND can only receive through a channel with balance on the other
   side. Ask the faucet to open one to LND, keeping the balance on its side. The faucet can't
   reach LND, so LND connects to the faucet's node first, staying connected. Use the node's
   onion address, which mutinynet's explorer lists on the node's page; the faucet's own page
   lists only its regular one. Through the onion address the connection stays inside Tor,
   with no exit relay to stall or drop it:

   ```bash
   docker compose -p obl-staging exec lnd lncli -n signet connect --perm <pubkey>@<onion address>:9735
   ```

   Once `lncli -n signet listpeers` shows it, fill in the faucet's channel form: a capacity
   above staging's cap, nothing pushed, and as the connection string LND's `identity_pubkey`
   alone, from `lncli -n signet getinfo`. Without a host, the faucet opens the channel over
   LND's own connection. It's usable once `lncli -n signet listchannels` shows it active, a
   few blocks later, and its `remote_balance` is the most LND can receive, so
   `RELAY_MAX_SATS` stays below it.

10. **Donate.** Once OBL's staging Worker has its binding, donate from OBL's staging page and
    pay the `lntbs…` invoice from a signet wallet, or the faucet's own Lightning payer. The
    donation should reach the page, marked as a test.

## Running it

- **Logs:** `docker compose -p obl-staging logs --tail 50 <service>`.
- **Payments fail at once with no route,** as `FailureReasonNoRoute` from the faucet: check the
  faucet's `ping_time` in `lncli -n signet listpeers` twice, a minute apart. If it doesn't
  change, a Tor stall has left LND's connection half closed. LND still lists the peer, but
  its pings have stopped, it won't redial, and even `disconnect` doesn't finish. To the
  faucet, LND is offline. Restart it with `docker compose -p obl-staging restart lnd`: the
  channels stay open, and new invoices fail for about a minute. LND may come back on the
  faucet's regular address; reconnect to the onion one, as in step 9, if it does.
- **Late payments:** an on-chain payment made after its invoice expired still counts, once
  it settles. BTCPay tells the relay through the webhook's `InvoiceReceivedPayment` and
  `InvoicePaymentSettled` events, beside `InvoiceSettled`. A stack set up before late
  payments counted has only `InvoiceSettled`; add the other two in the store's webhook, in
  BTCPay's pages, or the relay finds a late payment only when it restarts.
- **Between tests:** `docker compose -p obl-staging stop`, which frees the memory and keeps the
  chain, so the next test doesn't wait for a sync.
- **Start again,** after a stop, a crash or a reboot: `./start.sh`, which puts the firewall's
  rules back first and skips any that are already there.
- **Update:** pull the branch, then `docker compose -p obl-staging build relay` and
  `./start.sh`.
- **Remove,** when testing is done: `docker compose -p obl-staging down -v`, which deletes
  staging's chain, wallets and BTCPay. Signet only. The firewall's rules then guard nothing,
  and go at the next reboot.
- **Secrets:** `.env` holds the relay's token, BTCPay's keys and its admin's password. It stays
  readable by its owner only, and is never copied off this machine.
- **BTCPay's pages** aren't published, and setup doesn't need them. If someone ever does, a
  temporary forwarder on `127.0.0.1`, reached over SSH, removed afterwards:

  ```bash
  docker network create obl-staging-ui
  ```

  ```bash
  docker run -d --name obl-staging-ui --network obl-staging-ui --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:14142:14142 obl-staging-relay node -e "const net = require('net'); net.createServer((c) => { const b = net.connect(49392, 'btcpay'); c.pipe(b).pipe(c); c.on('error', () => b.destroy()); b.on('error', () => c.destroy()); }).listen(14142);"
  ```

  ```bash
  docker network connect obl-staging_front obl-staging-ui
  ```

  Docker Engines before 28 let other devices on the LAN reach a port published on
  `127.0.0.1`, so on an older Engine, keep the forwarder up only while it's in use. Then
  `ssh -L 14142:127.0.0.1:14142 <machine>` from a laptop, and `http://localhost:14142`,
  signing in as `admin@staging.invalid` with `BTCPAY_ADMIN_PASSWORD` from `.env`. Afterwards,
  `docker rm -f obl-staging-ui` and `docker network rm obl-staging-ui`.

## Rehearsing on a workstation

[`compose.rehearsal.yaml`](../deploy/staging/compose.rehearsal.yaml) runs the same stack on
regtest, with a payer node, and points the relay at a Worker running on the workstation. It
proves the wiring before anything touches the machine, in minutes rather than hours:

1. `.env` from the example, with any placeholder for `SIGNET_PEER` and `RELAY_MAX_SATS` set.
2. `export COMPOSE_FILE=compose.yaml:compose.rehearsal.yaml`, then step 4's build, and
   `docker compose -p obl-staging up -d` with step 4's services and `payer`. A workstation
   has no node to fence off, so it skips `start.sh` and the firewall.
3. Mine 101 blocks to an address from `payer`, using `generatetoaddress` with
   `bitcoin-cli -datadir=/data` in the `bitcoind` container.
4. `./setup.sh`, then put the printed hash in the workstation's `.dev.vars` as
   `RELAY_TOKEN_SHA256`. Run the local Worker and the stand-in as stage 1 of
   [`testing.md`](testing.md) describes, with its migrations applied.
5. `docker compose -p obl-staging up -d relay worker`. The relay should log `line: open`.
6. Open a channel from `payer` to `lnd`, mine 6 blocks, ask the stand-in for an invoice, and
   pay it from `payer`. The donation should land in the local D1.

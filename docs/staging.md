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
- **Nothing shared with the mainnet node:** its own data, keys, wallets, macaroons and secrets.
  BTCPay reaches its own LND with a macaroon that can only make and read invoices.
- **Caps:** memory, CPU and process limits on every container, rotated logs, a pruned chain,
  and no container with extra privileges.
- **Pinned:** every image by digest.
- **Nothing starts by itself,** not after a crash and not after a reboot. The firewall's rules
  don't outlive a reboot, so they go back up first, and only then the stack.

## What the machine needs

- Linux with Docker Engine, Docker Compose v2, iptables, git and openssl.
- About 10 GB of free disk where Docker keeps its data: about 3 GB of images, a few GB for the
  pruned chain, and logs capped at 30 MB a container.
- About 3 GB of free memory. The caps add up to a little over 4 GB at the very most.
- A folder of its own for the stack, outside wherever the node's operating system keeps its
  apps.

## Steps

1. **Get the code** into that folder, on the branch being staged:

   ```bash
   git clone https://github.com/OogaBoogaX/bananapayserver.git
   ```

   Then `cd bananapayserver/deploy/staging` and `git switch <branch>`.

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

3. **Put up the firewall,** as root, before anything starts. It works from the subnets in
   `.env`, so the stack's networks don't need to exist yet:

   ```bash
   sudo ./firewall.sh
   ```

   The rules last until the next reboot, unless the machine's own firewall tools save them. Run
   `firewall.sh` again after a reboot, before the stack starts.

4. **Build and start everything but the relay,** which waits for step 6:

   ```bash
   docker compose -p obl-staging build relay
   ```

   ```bash
   docker compose -p obl-staging up -d tor bitcoind postgres nbxplorer lnd btcpay
   ```

   Then check the firewall. From Tor's network, the machine and its LAN must be out of reach.
   With the machine's LAN address and a port it listens on, such as SSH's:

   ```bash
   docker run --rm --network obl-staging_outside obl-staging-relay node -e "const s = require('net').connect(+process.argv[2], process.argv[1]); s.setTimeout(4000); s.on('connect', () => { console.log('REACHABLE: the firewall is not working'); process.exit(1); }); s.on('error', () => console.log('blocked')); s.on('timeout', () => { console.log('blocked'); process.exit(0); });" <LAN address> 22
   ```

   It should print `blocked`. Repeat it on the stack's two other networks, `obl-staging_front`
   and `obl-staging_backend`, aimed at the same address and at each network's gateway:

   ```bash
   docker network inspect obl-staging_front --format '{{(index .IPAM.Config 0).Gateway}}'
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
   token's SHA-256. Send the hash, and only the hash, to whoever deploys
   `bananapayserver-staging`, who sets it as `RELAY_TOKEN_SHA256` while no build is running;
   see [`cloudflare.md`](cloudflare.md). The token stays in `.env` on this machine.

7. **Start the relay,** once the hash is set:

   ```bash
   docker compose -p obl-staging up -d relay
   ```

   `docker compose -p obl-staging logs relay` should show `line: open`. Staging then says
   donations are open, on signet. Requests now reach this machine, so tell the team to lower
   staging's `RATE_GLOBAL`.

8. **Fund LND.** Get an address:

   ```bash
   docker compose -p obl-staging exec lnd lncli -n signet newaddress p2wkh
   ```

   Send it signet coins from mutinynet's faucet, and wait for `lncli -n signet walletbalance`
   to show them confirmed. Blocks come every 30 seconds.

9. **Make room to receive.** LND can only receive through a channel with balance on the other
   side. Open one to a well-connected mutinynet node, such as the faucet's, whose
   `pubkey@host:port` its page lists, and push half of it across:

   ```bash
   docker compose -p obl-staging exec lnd lncli -n signet connect <pubkey>@<host>:<port>
   ```

   ```bash
   docker compose -p obl-staging exec lnd lncli -n signet openchannel --node_key <pubkey> --local_amt 1000000 --push_amt 500000
   ```

   It's usable once `lncli -n signet listchannels` shows it active, a few blocks later.

10. **Donate.** Once OBL's staging Worker has its binding, donate from OBL's staging page and
    pay the `lntbs…` invoice from a signet wallet, or the faucet's own Lightning payer. The
    donation should reach the page, marked as a test.

## Running it

- **Logs:** `docker compose -p obl-staging logs --tail 50 <service>`.
- **Between tests:** `docker compose -p obl-staging stop`, which frees the memory and keeps the
  chain, so the next test doesn't wait for a sync.
- **Start again,** after a stop, a crash or a reboot: `sudo ./firewall.sh`, then
  `docker compose -p obl-staging up -d`. `firewall.sh` skips rules that are already there.
- **Update:** pull the branch, then `docker compose -p obl-staging up -d --build`.
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
  docker run -d --name obl-staging-ui --network obl-staging-ui -p 127.0.0.1:14142:14142 obl-staging-relay node -e "const net = require('net'); net.createServer((c) => { const b = net.connect(49392, 'btcpay'); c.pipe(b).pipe(c); c.on('error', () => b.destroy()); b.on('error', () => c.destroy()); }).listen(14142);"
  ```

  ```bash
  docker network connect obl-staging_front obl-staging-ui
  ```

  Then `ssh -L 14142:127.0.0.1:14142 <machine>` from a laptop, and `http://localhost:14142`,
  signing in as `admin@staging.invalid` with `BTCPAY_ADMIN_PASSWORD` from `.env`. Afterwards,
  `docker rm -f obl-staging-ui` and `docker network rm obl-staging-ui`.

## Rehearsing on a workstation

[`compose.rehearsal.yaml`](../deploy/staging/compose.rehearsal.yaml) runs the same stack on
regtest, with a payer node, and points the relay at a Worker running on the workstation. It
proves the wiring before anything touches the machine, in minutes rather than hours:

1. `.env` from the example, with any placeholder for `SIGNET_PEER` and `RELAY_MAX_SATS` set.
2. `export COMPOSE_FILE=compose.yaml:compose.rehearsal.yaml`, then step 4's commands, adding
   `payer` to the services.
3. Mine 101 blocks to an address from `payer`, using `generatetoaddress` with
   `bitcoin-cli -datadir=/data` in the `bitcoind` container.
4. `./setup.sh`, then put the printed hash in the workstation's `.dev.vars` as
   `RELAY_TOKEN_SHA256`. Run the local Worker and the stand-in as stage 1 of
   [`testing.md`](testing.md) describes, with its migrations applied.
5. `docker compose -p obl-staging up -d relay worker`. The relay should log `line: open`.
6. Open a channel from `payer` to `lnd`, mine 6 blocks, ask the stand-in for an invoice, and
   pay it from `payer`. The donation should land in the local D1.

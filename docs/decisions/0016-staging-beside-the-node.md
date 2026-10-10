# 0016. Staging runs beside a mainnet node, fenced off

**Status:** accepted, 2026-10-05, for donation testing while the node is a proof of concept.

## Decision

For donation testing while the node is a proof of concept, staging's signet stack runs on a
team member's machine, beside a mainnet node that holds real funds, with its owner's
agreement. It runs as its own Docker project: bitcoind on mutinynet, NBXplorer, Postgres,
BTCPay, LND, Tor, and the relay that connects them to `bananapayserver-staging`. It is fenced
off from the node and the machine:

- **Nothing listens outside Docker.** No published ports.
- **Only Tor reaches the internet.** The other networks are internal to Docker, and bitcoind,
  LND and the relay go out through Tor, so the machine's address stays hidden.
- **A firewall** keeps Tor's network off the machine and its LAN, and every staging network off
  the machine's own addresses.
- **Nothing is shared with the mainnet node:** its own data, keys, wallets, macaroons and
  secrets. BTCPay reaches its LND with an invoice-only macaroon.
- **Caps** on memory, CPU, processes and logs, a pruned chain, no extra privileges, and images
  pinned by digest.
- **Nothing starts by itself,** so the firewall is always up before the stack is.

It runs only while it's needed: stopped between tests, and removed when testing is done. The
machine's operator deploys it, by hand. Nothing pushes to the machine. See
[`staging.md`](../staging.md). After the proof of concept, staging moves to a cloud server,
with the same compose file.

## Alternatives

- **The donating node's own machine,** which the team accepted first. It can't spare the
  memory.
- **A cloud server now.** The cheapest that fit were unavailable when this was decided, and
  testing shouldn't wait for them.
- **A virtual machine** beside the node.
- **Clearnet** for staging's bitcoind and LND.
- **Sharing the node's own bitcoind or BTCPay.**

## Why

Staging needs a real BTCPay and a real Lightning node on a public test network, and only for
donation testing. A machine that has the room, used only while testing, gets that done
soonest. Containers behind that fence are the lightest isolation that holds for worthless
coins. A virtual machine would isolate better, at a cost in memory the node needs. Clearnet
would tell every signet peer the machine's address, which the Tor-only fence exists to hide,
and would tie a team member's node to this project. Sharing anything with the mainnet node
would put its data or keys within staging's reach.

The stack was rehearsed on a workstation on regtest first: a donation went from the stand-in
page through the Worker and the fenced relay to BTCPay and LND, was paid, and came back. The
fences held from inside the containers.

## Consequences

- **Containers share the machine's kernel and Docker,** so whoever controls the staging stack
  is close to controlling the machine. The fence narrows what staging can reach, only the
  operator deploys it, and it runs only while testing.
- **The firewall needs root** and doesn't outlive a reboot. Nothing in the stack restarts by
  itself, not even after a crash, so after either the operator runs `firewall.sh` again before
  starting it.
- **Syncing over Tor is slow,** and depends on Tor exits that allow mutinynet's ports. If they
  stop, staging stops syncing. Clearnet would need a decision of its own.
- **Staging takes disk and memory from the machine,** within its caps: about 10 GB and 3 GB.
  It's stopped between tests, and work on the machine's own node comes first. Where the
  kernel doesn't enforce memory limits, only the programs' own limits hold, and the operator
  watches the machine's memory.
- **It ends with the proof of concept.** Staging then moves to a cloud server, with the same
  compose file. A cloud server has no node to hide, so that move is also when to revisit the
  Tor-only fence, the firewall and restarting by itself.

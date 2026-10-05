# 0016. Staging runs beside the node, fenced off

**Status:** accepted, 2026-10-05, for as long as the node is a proof of concept.

## Decision

While the node is a proof of concept, staging's signet stack runs on the same machine as the
mainnet node, as its own Docker project: bitcoind on mutinynet, NBXplorer, Postgres, BTCPay,
LND, Tor, and the relay that connects them to `bananapayserver-staging`. It is fenced off from
the node and the machine:

- **Nothing listens outside Docker.** No published ports.
- **Only Tor reaches the internet.** The other networks are internal to Docker, and bitcoind,
  LND and the relay go out through Tor, so the machine's address stays hidden.
- **A firewall** keeps Tor's network off the machine and its LAN, and every staging network off
  the machine's own addresses.
- **Nothing is shared with the mainnet node:** its own data, keys, wallets, macaroons and
  secrets. BTCPay reaches its LND with an invoice-only macaroon.
- **Caps** on memory, CPU, processes and logs, a pruned chain, no extra privileges, and images
  pinned by digest.

The machine's operator deploys it, by hand. Nothing pushes to the machine. See
[`staging.md`](../staging.md). When the node moves to production, staging moves off it, most
likely to a cloud server.

## Alternatives

- **A machine or server of its own.**
- **A virtual machine** on the node's machine.
- **Clearnet** for staging's bitcoind and LND.
- **Sharing the node's own bitcoind or BTCPay.**

## Why

There is no other machine, and staging needs a real BTCPay and a real Lightning node on a
public test network. Containers behind that fence are the lightest isolation that holds for
worthless coins. A virtual machine would isolate better, at a cost in memory the node needs.
Clearnet would tell every signet peer the machine's address, which the mainnet node's Tor-only
setup exists to hide. Sharing anything with the mainnet node would put its data or keys within
staging's reach.

The stack was rehearsed on a workstation on regtest first: a donation went from the stand-in
page through the Worker and the fenced relay to BTCPay and LND, was paid, and came back. The
fences held from inside the containers.

## Consequences

- **Containers share the machine's kernel and Docker,** so whoever controls the staging stack
  is close to controlling the machine. The fence narrows what staging can reach, and only the
  operator deploys it.
- **The firewall needs root** and has to survive reboots, through the machine's own firewall
  tools or by running `firewall.sh` again before the stack starts.
- **Syncing over Tor is slow,** and depends on Tor exits that allow mutinynet's ports. If they
  stop, staging stops syncing. Clearnet would need a decision of its own.
- **Staging takes disk and memory from the node,** within its caps: about 10 GB and 3 GB.
- **It ends when the node goes to production.** Staging then moves off the node's machine, most
  likely to a cloud server, with the same compose file. A cloud server has no node to hide, so
  that move is also when to revisit the Tor-only fence and the firewall.

# 0004. BTCPay stays on the node's machine and calls the relay by webhook

**Status:** accepted, 2026-09-30

## Decision

BTCPay Server runs on the node's machine, next to LND, and makes every invoice. When an
invoice settles, BTCPay calls the relay's webhook on the machine's internal network. The relay
checks `BTCPay-Sig` and confirms the invoice with BTCPay's API before trusting it. Once a
minute it also sweeps its open invoices, which catches any webhook it missed.

## Alternatives

- **BTCPay somewhere else**, off the node's machine.
- **The relay polling BTCPay** for its open invoices, with no webhook.
- **LND directly**: the relay asks LND for invoices, and there is no BTCPay.

## Why

BTCPay can't run in a Worker: it's a .NET server with PostgreSQL, and its on-chain support
needs NBXplorer and a Bitcoin node. Anywhere off the machine, it would need inbound
connections to LND, which [0002](0002-nodes-dial-out.md) rules out. LND directly would be
leaner, but it loses on-chain donations to the team's watch-only zpub, and the books, which
take BTCPay as their source of truth; it would also put an LND credential in the relay.
Polling needs no listener at all, but payments show up later. The webhook shows them as they
settle, and the sweep covers any it misses.

## Consequences

- The relay has one listener, for the webhook, reachable only on the machine's internal
  network.
- A webhook is trusted only after its signature checks out and BTCPay's API confirms the
  invoice.
- The relay holds a BTCPay key that can only create and view invoices on one store. It needs
  nothing from LND, and runs in its own container with no access to LND's files.
- On-chain payments take the same path, after the confirmations the store requires.
- BTCPay is the source of truth. The records here are a feed that can be rebuilt from it, not
  a ledger.

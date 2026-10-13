# Security policy

bananapayserver sits on the path that takes donations: it decides which invoice a donor pays
and what the pile credits. We would much rather hear about a problem from you than from a
donor whose payment went somewhere it shouldn't have.

## What it holds

bananapayserver runs no node and holds no funds. No part of it holds a seed, a macaroon or any
other credential that can spend from a node or control one; the most it holds is the relay's
BTCPay key, which can only create and view invoices on one store. Nothing opens on a node:
nodes dial out to it. That boundary is the design — see
[`docs/architecture.md`](docs/architecture.md) — and a way across it is the most serious kind
of report.

## Reporting a vulnerability

**Report privately. Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/OogaBoogaX/bananapayserver/security/advisories/new),
or Security → Report a vulnerability on the repository page. It opens a private thread visible
only to maintainers.

Helpful things to include, as far as you have them:

- What an attacker gains, not only what misbehaves.
- The smallest reproduction you can manage, and the versions involved.
- Whether it is already public or being exploited.
- How you would like to be credited, or that you would prefer not to be.

Please do not include API keys, tokens, macaroons, node addresses, pubkeys or channel points
in a report. If a reproduction seems to need them, say so and we will find another way.

## What we will do

This is a small project without a funded security team, so here is what is actually
realistic rather than a number that sounds reassuring:

- We aim to acknowledge a report within **three days**.
- We aim to give an initial assessment within **two weeks**.
- We will tell you plainly if a fix will take longer, or if we have decided not to fix
  something and why.

We ask for a reasonable window to ship a fix before public disclosure, and we will agree the
timing with you rather than impose it. If a problem is being actively exploited, disclosure
speed matters more than our schedule.

## Scope

**In scope:** anything in this repository. Especially:

- anything that sends a donor's payment anywhere but the node's own invoice, or credits the
  pile with a payment that never settled;
- forging, replaying or altering the relay's messages, BTCPay's webhooks or a node's event
  batches;
- anything that reveals where a node is, through the server, its logs or its replies;
- anything that joins donations to a node's feed, or one node's data to another's;
- any way for this server to reach a node, or for any part of it to gain a credential beyond
  the relay's BTCPay key;
- the deployment path and its credentials.

**Out of scope,** because they are upstream projects with their own processes:
vulnerabilities in BTCPay Server, LND, Tor or Cloudflare's platform. Please report those to
their maintainers. If the issue is that *bananapayserver uses them unsafely*, that is in scope
and we want to hear it.

Ooga Booga Land's page and Foundry's exporter live in their own repositories,
[`oogaboogaland`](https://github.com/OogaBoogaX/oogaboogaland) and
[`lightningfoundry`](https://github.com/OogaBoogaX/lightningfoundry/blob/main/SECURITY.md), and
reports about them belong there.

Also out of scope: attacks requiring physical access to a node's machine.

## Supported versions

None yet. Nothing from this repository is deployed, and nothing here has run against a real
node. This section becomes meaningful with the first deployment.

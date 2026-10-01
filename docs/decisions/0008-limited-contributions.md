# 0008. Limited contributions

**Status:** accepted, 2026-09-30

## Decision

Anyone can open issues and report vulnerabilities privately. Code from outside the maintainers
comes by agreement: the contributor opens an issue first, and a maintainer agrees there before
any pull request. A pull request without that agreement is closed. Every pull request needs a
code owner's approval, and changes to the relay, to credentials, to the relay's protocol or to
deployment need two maintainers. Write access stays with the maintainers who run nodes or the
Cloudflare account.

## Alternatives

- **Open contributions, as in Lightning Foundry:** anyone forks and opens a pull request
  without asking first.
- **No outside code at all:** issues and vulnerability reports only.

## Why

This code decides where donations go and what the pile credits. A small change on the invoice
path can send a donor's payment somewhere else and still look harmless in review, so judgment
has to start before the code does. Agreeing on an issue first means a maintainer has decided
whether a change belongs here before anyone writes it; open contributions would put that
judgment after the fact, on code already written. Closing the repository to outside code
entirely would turn away fixes from people who know BTCPay or Workers well. The relay,
credentials, the relay's protocol and deployment get a second maintainer because a mistake
there costs donations or exposes a node.

## Consequences

- A good pull request can still be closed if nobody agreed to it first. The issue is the way
  back.
- The pull request template asks contributors to confirm the license and, from outside the
  maintainers, to link the issue where a maintainer agreed.
- [`.github/CODEOWNERS`](../../.github/CODEOWNERS) names the code owners, and the ruleset on
  `main` requires their review.
- Opening contributions further takes a new record.

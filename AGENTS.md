# AGENTS.md

Guidelines for AI agents and human collaborators working on bananapayserver. Read this before
changing anything. The standard: small, readable code on a path that takes real money,
correct, tested, auditable, and verified before it lands.

This code decides where donations go and what the pile credits. Treat every change as though
it will run unattended in front of a funded node, because it will.

## What this is

The Lightning server side of Ooga Booga Land (OBL): donations, and the ingest and feeds for
Foundry's public events behind the Lightning Factory cave. Three parts: a relay on each
donating node's machine, a Cloudflare Worker with one Durable Object, and D1. See
[`docs/architecture.md`](docs/architecture.md).

It **runs no node, holds no funds, and never holds a credential that can spend from or control
a node.** The most it ever holds is the relay's BTCPay key, which can only create and view
invoices on one store. The Worker also runs GitHub sign-in, so it holds the GitHub app's secret
and the key that signs sessions; neither can reach a node. Every rule below protects that
boundary, or the people on either side of it.

## Ground rules

- Read a file before editing it. Edit what is on disk, not what you assume.
- **Nothing opens on a node.** The relay dials out and keeps its line open; the Worker can
  never call it. The relay's one listener is for BTCPay's webhook, on the machine's internal
  network, with the port never published. A change that needs a way in to a node's machine is
  the wrong change.
- **No credential that can spend from or control a node**, in any part, the relay included. No
  seed, no macaroon, no access to LND's files. The relay's BTCPay key creates and views
  invoices on one store, and nothing more.
- **Never log or return a node's address.** The page gets a BOLT11 invoice and, if the donor
  switches, an on-chain address. Never a BTCPay link, a host name or anything else that says
  where a node is.
- **Each node stands alone:** its own credential, its own `seq`, its own feed. Nothing
  correlates one node with another.
- **Donations and node feeds stay apart.** Exact donation amounts and times, joined to a
  channel's line, can expose its balance. Never join them, in a query, a reply or on a page.
  See "Never shown" in Foundry's
  [`docs/lightning-factory.md`](https://github.com/OogaBoogaX/lightningfoundry/blob/main/docs/lightning-factory.md#never-shown).
- **Check at the boundaries:** browser input at the Worker, the relay's messages at the
  Durable Object, and BTCPay's webhook at the relay. Inside them, trust the code.
- **BTCPay is the source of truth.** The records here are a feed that can be rebuilt from it,
  not a ledger.
- **Donors don't wait.** The invoice path is judged by the time from picking an amount to
  seeing the QR. A new step on that path needs a reason worth the wait, and no speed is worth
  crossing the boundary above. See
  [`docs/architecture.md`](docs/architecture.md#donors-dont-wait).
- **Every dependency must justify its existence.** A new dependency needs a written reason in
  the PR, a pinned version and hash, and no install scripts. Prefer what the platform
  provides. Prefer copying twenty lines over adding a package.
- **Never commit secrets or key material.** No API keys, tokens, webhook secrets, macaroons or
  `.env` contents, and no real node pubkeys, channel points or IP addresses — not in code,
  tests, fixtures, examples or commit messages. Fixtures use values that are obviously
  synthetic. Nothing may embed absolute paths, user names or machine names.
- **Limits are configuration.** The per-donation cap and every other limit live in a
  deployment's configuration and are never committed, and neither is anything that says what
  a node holds or who runs it. Describe what a node needs in general terms, never one
  machine's specifics.
- **Never test against real funds.** Fixtures, simulators, regtest and signet only.
- Smallest change that works. No refactors, reformatting or renames the task does not require.

## Contributing

Contributions are limited; see [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[decision 0008](docs/decisions/0008-limited-contributions.md). Anyone can open an issue or
report a vulnerability privately. Code from outside the maintainers comes by agreement: an
issue first, and a maintainer's agreement on it before any pull request. A pull request
without that agreement is closed. Contributions are made under
[The Ooga Booga License](LICENSE); see
[`CONTRIBUTING.md`](CONTRIBUTING.md#licensing-your-contribution).

Every pull request needs a code owner's approval. Changes to the relay, to credentials, to the
relay's protocol or to deployment need two maintainers.

## Testing

`node --test` runs every test, with Node 22 or newer and nothing to install, and CI runs them
on every pull request. The Worker and its object run against stand-ins for the Cloudflare
APIs in `tests/helpers/`, which can't catch the real runtime behaving differently; say so when
a change depends on runtime behavior.

New behavior needs a check. Run the tests covering what you touched before finishing, and say
in the PR what you ran and what the result was. Do not claim a suite passed that you did not
run; report failures with their output.

Tests are deterministic. Anything involving time, randomness or network conditions must be
injectable, so a check measures behavior rather than the host machine.

The donation event, `{ id, sats, handle, message, at }`, and the `sanitize`, `HANDLE_MAX` and
`MESSAGE_MAX` rules are copied from OBL's
[`src/js/donations.js`](https://github.com/OogaBoogaX/oogaboogaland/blob/rock/src/js/donations.js).
OBL's scenes are built on that exact shape, so `tests/obl-contract.test.mjs` checks the copy
against a pinned snapshot of OBL's file, and `scripts/obl-contract.mjs` says when OBL's file
has moved on. The shape never changes here alone. Node feeds follow the delivery contract
Foundry defines; it changes there, not here.

## Attribution

bananapayserver keeps Lightning Foundry's rule
([decision 0007](docs/decisions/0007-ai-assisted-commits.md)): **every commit is written with
AI assistance.** Which assistant is yours to choose — Claude, ChatGPT, or anything else that
does the job.

Because every commit is assisted, **every commit carries a `Co-Authored-By` trailer** naming
the model that did the work, using the vendor's own noreply address where one exists:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

A commit without a trailer is incomplete, the same as a commit without a message.

Name the specific model rather than a generic placeholder. A reviewer judging how a change
was produced learns nothing from "an AI", and knowing which model wrote a thing is useful
later, when a pattern of mistakes turns out to be a pattern. More than one trailer is fine
when more than one was used.

A pull request whose code was substantially AI-generated says so in its description and names
the tool. A footer line is the conventional form:

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Before you finish

1. Tests covering your change pass, and you have said which ones.
2. No new dependency without a written justification, a pinned version and a hash.
3. No secrets, key material, node addresses, limits, absolute paths or machine names anywhere
   in the diff.
4. Nothing new listens on a node's machine, and nothing here can reach one.
5. No part holds a credential it did not hold before.
6. Donations and node feeds are still apart, and no node's data meets another's.
7. The invoice path is no slower, or the PR says why the wait is worth it.
8. Your change is the smallest that does the job, and it reads like the code around it.

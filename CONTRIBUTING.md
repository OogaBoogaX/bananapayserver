# Contributing

Read [`AGENTS.md`](AGENTS.md) first — it holds the rules code is judged against. This document
covers the practical parts: how contributions work here, what to run, and what a reviewable
change looks like.

## How contributions work

Contributions are limited, because this code decides where donations go and what the pile
credits. [Decision 0008](docs/decisions/0008-limited-contributions.md) records why.

- **Anyone can open an issue:** a bug, a question, a gap in the design.
- **Anyone can report a vulnerability**, privately. See [`SECURITY.md`](SECURITY.md).
- **Outside code comes by agreement.** Open an issue first that says what you want to change
  and why, and wait for a maintainer to agree to it there. Then fork, and open a pull request
  that links the issue. A pull request without that agreement is closed.
- **Every pull request needs a code owner's approval.** The code owners are listed in
  [`.github/CODEOWNERS`](.github/CODEOWNERS). Some changes need two maintainers; see below.
- **Write access stays with the maintainers** who run nodes or the Cloudflare account.

## Licensing your contribution

bananapayserver uses [The Ooga Booga License](LICENSE), the same public-domain dedication as
the other OogaBoogaX projects. By contributing, you agree to release your contribution under
that license; the pull request template asks you to confirm this. The choice is recorded in
[decision 0006](docs/decisions/0006-ooga-booga-license.md).

This applies to everyone, maintainers included, and changes only by a later decision record.

## Setup

Nothing to install. There is no build and no dependencies.

```bash
git clone https://github.com/OogaBoogaX/bananapayserver.git
cd bananapayserver
node --test
```

Node 22 or newer. That is the whole toolchain for the tests; deploying the Worker needs
Wrangler.

**There is no `package.json` on purpose.** Nothing here depends on a package; see
[decision 0009](docs/decisions/0009-toolchain.md). Adding one is a decision, not a
convenience.

## What to run

`node --test` runs every test, and CI runs them on Node 22 and 24 for every pull request.
Run them before asking for review, and say in the PR what you ran and what happened. Report
failures with their output. Never claim a suite passed that you did not run. For a change the
stand-ins can't judge, run the end-to-end stages in [`docs/testing.md`](docs/testing.md) too.

Deterministic tests only. Anything involving time, randomness or network conditions must be
injectable, so a check measures your change rather than the machine it ran on. Never test
against real funds.

## What a change looks like

Small. One idea per pull request. A change that needs three paragraphs to explain what it is
doing probably wants to be three changes.

The description should say **what you verified**, not only what you wrote. "Added X" tells a
reviewer nothing about whether it works.

Every commit carries a `Co-Authored-By` trailer naming the model that helped write it — this
project requires AI assistance rather than merely permitting it. See
[`AGENTS.md`](AGENTS.md#attribution).

## Changes that need two maintainers

Two maintainers approve these, regardless of size:

- **The relay** — the one part that runs on a node's machine
- **Credentials** — the relay's BTCPay key, the credentials nodes use to reach the Worker, and
  how any of them is issued, checked, stored or revoked
- **The relay's protocol** — the messages between the relay and the Durable Object, whose two
  ends change together
- **Deployment** — anything that deploys, or holds or uses a deploy credential

If your change touches one of these, say so in the description. It speeds review rather than
slowing it.

## Decisions

Choices that are expensive to revisit — the toolchain, where the API is served, the relay's
protocol — belong in [`docs/decisions/`](docs/decisions/) as a short record: what was decided,
what the alternatives were, and why. Written at the time, while the reasoning is still in
someone's head.

A decision record is not a design document. Half a page is usually right.

## Reporting a vulnerability

Privately, never in a public issue. See [`SECURITY.md`](SECURITY.md).

# 0020. Production runs only what passed staging; releases are cut from main

**Status:** accepted, 2026-10-09.

## Decision

A change reaches production in this order: it is tested on staging from its branch, reviewed,
and merged to `main`. Production is then deployed by hand from `main`. Production never runs
code that hasn't passed staging, so `main` and production are always stable and tested.

A release is a tag on `main`, with notes on what changed, cut when the team decides. It names a
version, for the changelog and for node operators updating their relay. It doesn't gate
production's deploys, which come from `main` after staging either way.

## Alternatives

- **Deploying production only from release tags.**
- **Deploying production on each merge to `main`.**

## Why

Staging is where a change proves itself, on signet, end to end, so staging is the gate before
production, not a release. Tying every production deploy to a release would mean cutting one
for each fix. Deploying on every merge would put production, with the money path behind it, one
push away from a mistake. Releases still give the team named versions when it wants them.

## Consequences

- `main` has to stay deployable. Its ruleset requires review, and should also require the
  tests to pass.
- Staging runs one branch at a time, so changes wait their turn for it.
- A maintainer signed in as themselves deploys production, from `main`, as
  [`cloudflare.md`](../cloudflare.md#production) says.
- How releases are numbered and announced is settled when the first one is cut.

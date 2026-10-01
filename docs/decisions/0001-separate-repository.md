# 0001. A separate repository with a hard boundary

**Status:** accepted, 2026-09-30

## Decision

Ooga Booga Land's Lightning server side, donations and the ingest and feeds for nodes' public
events, lives in its own repository, `OogaBoogaX/bananapayserver`. It runs no node, holds no
funds, and never holds a credential that can spend from or control a node; the most it holds
is the relay's BTCPay key, which can only create and view invoices on one store. The relay
belongs here too: it runs on the node's machine, but it only receives payments and never
operates LND.

## Alternatives

- **A `server/` folder in Ooga Booga Land**, next to Zuzu's backend.
- **The relay in Lightning Foundry**, since it runs on the node's machine.

## Why

A `server/` folder would have been simpler: one repository, the donation contract next to the
scenes that consume it, and Zuzu's backend as precedent. A separate repository won on four
counts. It can have its own maintainers, the people who run nodes. The Worker and the relay
are two ends of one protocol and change together, so they belong in one place. A money service
needs rules that fit it, such as tests on every pull request and deploy credentials, not OBL's
game-engine rules. And the deploy key stays out of a busy repository.

The relay stays out of Foundry because Foundry is software that operates a node, and its
architecture deliberately keeps payment processing and any cloud component outside it. The
relay operates nothing: it takes payments, and the other end of its line is in the cloud.

## Consequences

- OBL's donation event, `{ id, sats, handle, message, at }`, and its `sanitize`, `HANDLE_MAX`
  and `MESSAGE_MAX` rules are copied here from OBL's `src/js/donations.js`, so a contract test
  has to keep the two in step.
- A change that spans the game and the server is two pull requests, one in each repository,
  each through its own process.
- The ingest that Lightning Foundry's integration docs give to OBL lives here instead.

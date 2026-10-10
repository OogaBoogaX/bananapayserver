# bananapayserver

The Lightning server side of Ooga Booga Land: donations, and the node event feeds behind the
Lightning Factory cave.

**It runs no node and holds no funds. Nodes dial out to it.** No part of it holds a seed, a
macaroon or any credential that can spend from a node or control one. The most it ever holds
is the relay's BTCPay key, which can only create and view invoices on one store.

## Status

**Pre-alpha. Nothing here is deployed.**

The design came first, so the boundaries were decided rather than discovered: the
architecture, the rules it keeps, and the decisions behind it. The donation path now follows
it: the relay, the Worker and its Durable Object, and D1's schema, with tests that run them
against stand-ins for BTCPay and Cloudflare. None of it has run against a real node yet. The
node feed ingest waits for Foundry to specify the signed batches its exporter sends. Do not
point anything here at a node holding funds you would mind losing.

## What it covers

- **Donations.** A visitor to Ooga Booga Land (OBL) picks an amount and gets a Lightning
  invoice from a node. When it settles, every open page sees the donation land.
- **Node event feeds.** The ingest for each operator's Foundry public events, and the feeds
  that render the Lightning Factory cave in OBL.
- **The pile and the leaderboard.** One banana pile that every visitor sees, and a leaderboard
  of donors who signed in with GitHub, both counted from the donations. A banana is a dollar's
  worth of bitcoin when the donor gives.
- **Every operator's node that joins later.** Each one stands alone, and nothing here
  correlates one node with another.

## How it works

A small program, the relay, runs beside BTCPay Server on each donating node's machine and dials
out a WebSocket to a Cloudflare Worker. A page asks its own Worker, Ooga Booga Land's, for an
invoice, and that Worker passes the call on over a service binding; the request goes down the
relay's line, BTCPay makes the invoice, and the reply carries it back to the page. When the
donor pays, BTCPay tells the relay, the relay tells the Worker's Durable Object, and the object
records the donation in D1 and pushes it to every page. Operators' Foundry exporters post their
public events to the same Worker. Nothing ever connects in to a node.

## What it is not

- **Not a cave.** It is infrastructure, not an island project. What a donation looks like,
  the pile and the Factory's scenes are OBL's.
- **Not node software.** Software that operates a node, including Foundry's event exporter,
  lives in [`lightningfoundry`](https://github.com/OogaBoogaX/lightningfoundry). The relay
  belongs here: it runs on the node's machine, but it only receives payments and never
  operates LND.
- **Not a ledger.** BTCPay is the source of truth, and the books are kept in
  [`bananacertifiedaccounting`](https://github.com/OogaBoogaX/bananacertifiedaccounting). The
  records here are a feed that can be rebuilt from BTCPay.

## Documentation

| Document | What it answers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Where each piece runs, what each may hold, and how an invoice and a payment travel |
| [`docs/protocol.md`](docs/protocol.md) | The page's calls, the relay's line, and what the relay needs from BTCPay |
| [`docs/configuration.md`](docs/configuration.md) | Every setting, which ones are limits and secrets, and what the relay's container needs |
| [`docs/cloudflare.md`](docs/cloudflare.md) | What has to be done on Cloudflare, for staging and production, on both sides of the binding |
| [`docs/staging.md`](docs/staging.md) | The signet staging stack beside a mainnet node: its fence, how to run it, and how to rehearse it |
| [`docs/testing.md`](docs/testing.md) | How to test end to end, from a payment on regtest to the cave |
| [`docs/decisions/`](docs/decisions/) | Choices that are expensive to revisit, and why they were made |

## Tests

No dependencies and no build. Node 22 or newer:

```bash
node --test
```

## Related repositories

- [`oogaboogaland`](https://github.com/OogaBoogaX/oogaboogaland), the game. Its
  `src/js/donations.js` holds the donation event this server emits.
- [`lightningfoundry`](https://github.com/OogaBoogaX/lightningfoundry), the node software. It
  defines the public event schemas and both sides of their contract: how events are delivered,
  and what a consumer may show.
- [`bananacertifiedaccounting`](https://github.com/OogaBoogaX/bananacertifiedaccounting), the
  books.

## Contributing

**Contributions are limited**, because this code decides where donations go and what the pile
credits. Anyone can open an issue or report a vulnerability privately. Code from outside the
maintainers comes by agreement: open an issue first, and wait for a maintainer to agree before
opening a pull request. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[decision 0008](docs/decisions/0008-limited-contributions.md).

Read [`AGENTS.md`](AGENTS.md) for the rules code is held to, including the requirement that
every commit is written with AI assistance and says which model did the work.

Found a vulnerability? Report it privately — see [`SECURITY.md`](SECURITY.md).

## License

[The Ooga Booga License](LICENSE), the same public-domain dedication as the other OogaBoogaX
projects — see [decision 0006](docs/decisions/0006-ooga-booga-license.md).

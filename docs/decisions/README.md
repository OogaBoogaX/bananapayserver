# Decisions

Choices that are expensive to revisit, written down when they are made, while the reasoning is
still in someone's head. A decision record is not a design document; half a page is usually
right.

## Format

One file per decision, numbered in order: `NNNN-short-title.md`.

- **Status** — proposed, accepted, or superseded by a later record, which links back.
- **Decision** — what was decided, in a sentence or two.
- **Alternatives** — what else was on the table.
- **Why** — the reasoning that won.
- **Consequences** — what it makes easier, harder or impossible.

Records are not edited after acceptance, except to mark them superseded. Changing a decision
means writing a new record.

## Records

| | Decision | Status |
|---|---|---|
| [0001](0001-separate-repository.md) | A separate repository with a hard boundary | accepted |
| [0002](0002-nodes-dial-out.md) | Nodes dial out; nothing opens on a node | accepted |
| [0003](0003-one-durable-object.md) | One Durable Object, D1, and pushes to pages | accepted |
| [0004](0004-btcpay-on-the-node.md) | BTCPay stays on the node's machine and calls the relay by webhook | accepted |
| [0005](0005-relay-over-tor.md) | The relay connects over Tor, on trial | accepted, on trial |
| [0006](0006-ooga-booga-license.md) | The Ooga Booga License | accepted |
| [0007](0007-ai-assisted-commits.md) | Every commit is AI-assisted and names the model | accepted |
| [0008](0008-limited-contributions.md) | Limited contributions | accepted |
| [0009](0009-toolchain.md) | Plain JavaScript, no dependencies | accepted |
| [0010](0010-handles-from-github.md) | Handles come from GitHub sign-in | accepted; where sign-in runs superseded by 0014 |
| [0011](0011-bananas-in-dollars.md) | A banana is a dollar's worth of bitcoin | accepted; its price source superseded by 0013 |
| [0012](0012-global-pile.md) | One global pile | accepted |
| [0013](0013-price-from-2140data.md) | Bitcoin's price comes from 2140data's service | accepted; added to by 0017 |
| [0014](0014-pages-through-obl.md) | Pages reach donations through OBL's Worker | accepted |
| [0015](0015-staging-deploys-on-push.md) | Staging deploys on push, through Cloudflare's Git connection | superseded by 0018 |
| [0016](0016-staging-beside-the-node.md) | Staging runs beside a mainnet node, fenced off | accepted, for donation testing while the node is a proof of concept |
| [0017](0017-tally-and-fresh-rate.md) | The board's tally, and a fresh rate while pages are open | accepted |
| [0018](0018-staging-github-action.md) | Staging deploys through a manual GitHub Action | accepted |
| [0019](0019-production-relay-address.md) | Production's relay dials the Worker's workers.dev address | accepted |
| [0020](0020-staging-then-production.md) | Production runs only what passed staging; releases are cut from main | accepted |

## Waiting for a record

- How pages get node feeds — see [`architecture.md`](../architecture.md#open-questions). Not
  needed for the donations launch.

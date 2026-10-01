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

## Waiting for a record

- The toolchain — see [`architecture.md`](../architecture.md#open-questions).
- Where the API is served, and the Cloudflare account that serves it — see
  [`architecture.md`](../architecture.md#open-questions).
- How pages get node feeds — see [`architecture.md`](../architecture.md#open-questions).

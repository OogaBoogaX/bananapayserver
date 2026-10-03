# Architecture

The intended shape, written before the code so the boundaries are decided rather than
discovered. Expect this document to change as the Worker and the relay land; expect the
boundaries not to.

## The boundary

Permanent, and not a matter of configuration:

- bananapayserver **runs no node and holds no funds.**
- It **never holds a credential that can spend from or control a node.** No seed, no macaroon,
  no access to LND or its files, in any part.
- **The most it ever holds is the relay's BTCPay key**, which can only create and view
  invoices on one store.
- **Nothing opens on a node.** Nodes dial out to it, and nothing here can call them.

## Where each piece runs

```text
┌─ node's machine ──────────────────┐     ┌─ Cloudflare ───────────────┐     ┌─ browser ──┐
│                                   │     │                            │     │            │
│  LND ◄── BTCPay ◄──► relay ───────┼────►│  Worker ◄──────────────────┼─────┤  OBL page  │
│                                   │     │   ▲   │                    │     │            │
│  Foundry exporter ────────────────┼─────┼───┘   ▼                    │     │            │
│                                   │     │  Durable Object ──► D1     │     │            │
│                                   │     │                            │     │            │
└───────────────────────────────────┘     └────────────────────────────┘     └────────────┘
```

Every arrow that crosses a box points the way its connection is opened, and none points into
the node's machine.

- **On the node's machine:** LND and BTCPay Server, and the relay, a small program that runs
  all the time in its own container and has no access to LND's files. Foundry's exporter runs
  there too, for an operator who publishes a feed.
- **On Cloudflare:** a Worker, the front door, which checks browser requests and checks the
  relay's credential when its line opens. One Durable Object, which holds the relay's line and
  every page's socket, and stores pending requests. D1, which keeps the donation records and
  the feed history.
- **In the browser:** OBL's page.

| Part | Holds | Responsibility |
|---|---|---|
| **Relay** | the BTCPay key, the webhook secret, its credential for the line | Keeps the line open, asks BTCPay for invoices, takes BTCPay's webhook, reports payments |
| **Worker** | what it needs to check credentials | The front door: checks browser requests and the relay's credential, and takes the exporters' batches |
| **Durable Object** | pending requests, until paid or expired | Holds the relay's line and every page's socket, matches payments to requests, pushes donations |
| **D1** | donation records, feed history | Keeps what the object replays when a page reconnects; a feed, not a ledger |

Nothing in that table can spend from a node, and nothing in it can reach one.

## Rules the design keeps

- **Nothing opens on a node.** This is Lightning Foundry's delivery rule, "the node listens on
  nothing", applied to the path that takes money. The relay dials out a WebSocket and keeps it
  open. The Worker can never call the relay. The relay's only listener is for BTCPay's
  webhook, on the machine's internal network, with the port never published.
- **The relay connects over Tor**, through the machine's Tor SOCKS proxy, so nobody on the way,
  Cloudflare included, learns where the machine is. This is on trial; see
  [decision 0005](decisions/0005-relay-over-tor.md).
- **Each node stands alone.** It has its own credential, its own `seq` and its own feed, and
  nothing in the server correlates one node with another.
- **Donations and node feeds stay apart.** Joined to a channel's line, exact donation amounts
  and times can expose its balance. See "Never shown" in Foundry's
  [`docs/lightning-factory.md`](https://github.com/OogaBoogaX/lightningfoundry/blob/main/docs/lightning-factory.md#never-shown).
- **Never log or return a node's address.** The page only ever gets the BOLT11 invoice and, if
  the donor switches, an on-chain address. It never gets a BTCPay link.
- **Checks happen at the boundaries:** browser input at the Worker, the relay's messages at the
  Durable Object, and BTCPay's webhook at the relay.

## Donors don't wait

**The time from picking an amount to seeing the QR is what the invoice path optimizes.** A
donor at the cave shouldn't be left waiting, for the QR or for the thanks after paying.
Several choices in the design are there for it:

- The relay's line is open before anyone asks, so no request waits for a connection.
- The page can ask for an invoice as soon as the donor picks an amount; the handle and message
  follow before the QR shows.
- BTCPay makes the Lightning invoice first, and an on-chain address only if the donor
  switches.
- The object holds the page's request open and answers it as soon as the invoice arrives.
- If the relay isn't connected, the page hears at once that donations are closed. If the relay
  doesn't answer in time, the wait ends there.
- BTCPay's webhook and the object's pushes show a payment as it settles, not at the next poll.

**Speed never buys a way in.** Nothing opens on a node to make an invoice faster, and no part
holds a node credential to skip a step. The relay's line over Tor is where speed and privacy
pull against each other, which is why its trial measures invoice times; see
[decision 0005](decisions/0005-relay-over-tor.md).

## The invoice

0. **The line opens.** Ahead of time, the relay opens its WebSocket to the Worker's address.
   The Worker checks the relay's credential and hands the socket to the Durable Object, which
   accepts it with the Hibernation API. The relay sends the keepalives, and redials whenever
   the line drops.
1. **Page → Worker.** An HTTPS request with the amount, handle and message. To save time, the
   page can ask as soon as the donor picks an amount; the handle and message then follow in a
   second request before the QR shows.
2. **Worker.** Checks the amount, sanitizes the text with OBL's rules, and calls the Durable
   Object.
3. **Durable Object.** Applies the rate limits, per visitor and overall, because it is the one
   place every request reaches. Page sockets have a budget of their own, so a crowd of page
   loads can't close donations. A visitor's address stays in memory for a minute at most and
   is never stored. It stores the handle, message and amount under a new request id, in its
   own storage, until the invoice is paid or expires. It sends `{ request id, sats }` down the
   relay's line and keeps the page's request open.
4. **Relay.** Checks the amount against its own cap, asks BTCPay on the machine for the
   invoice, and sends `{ request id, invoice }` up the line. BTCPay makes the Lightning invoice
   first, and an on-chain address only if the donor switches to on-chain.
5. **Durable Object → Worker → page.** The invoice comes back as the reply, and the page shows
   the QR. If the relay isn't connected or doesn't answer in time, the reply says donations
   are closed.

The handle and message never reach the node. The relay and BTCPay see a request id and an
amount.

## Paid

1. **The donor pays.** LND settles the invoice, and BTCPay marks it settled.
2. **BTCPay → relay.** BTCPay calls the relay's webhook, chosen over polling so payments show
   up faster. The relay listens only on the machine's internal network, with the port never
   published. It checks `BTCPay-Sig`, and confirms the invoice with BTCPay's API before
   trusting it. Once a minute it also sweeps its open invoices, which catches any webhook it
   missed.
3. **Relay → Durable Object.** The relay sends `{ invoice id, sats, method }` up the line,
   where the method says whether the donor paid over Lightning or on-chain, from the payments
   BTCPay lists. It keeps the message until the object acknowledges it, and resends it after a
   reconnect.
4. **Durable Object.** Records the donation in D1, ignoring repeats by invoice id, and
   acknowledges it. Then it pushes `{ id, sats, handle, message, at }` to every page socket,
   with the invoice id as `id`.
5. **The page plays it.** In real mode, OBL's `donations.js` reads its socket and passes each
   donation to the director, which hands it to the active scene's `onDonation`: the Banana
   Cooker in the Factory, the pile in the hub. The donor's page recognizes its own invoice id
   and says thanks.
6. **Reconnects.** When a page reconnects, it sends its last donation id, and the object
   replays anything newer from D1.
7. **On-chain** payments take the same path, after the confirmations the store requires.

The event a page receives is exactly OBL's donation contract,
`{ id, sats, handle, message, at }`, from
[`src/js/donations.js`](https://github.com/OogaBoogaX/oogaboogaland/blob/rock/src/js/donations.js).
OBL's scenes are built on that shape, so it is copied here, and a contract test keeps the copy
in step; see [decision 0001](decisions/0001-separate-repository.md). OBL's content policy
already allows `connect-src https: wss:`, so the page can reach the Worker and its socket as it
stands.

## Node event feeds

Each operator's Foundry exporter POSTs signed batches, as Foundry's delivery contract sets out
in the Delivery section of
[`docs/event-model.md`](https://github.com/OogaBoogaX/lightningfoundry/blob/main/docs/event-model.md#delivery):

- it authenticates with a per-node credential issued at enrollment;
- the server checks each batch's signature;
- each event is stored once, keyed by node and `seq`;
- the reply is the highest `seq` the server has accepted.

Publishing is opt-in for each operator. A node needs a relay only if it also takes donations.

The ingest isn't built yet. It waits for Foundry to specify the batch envelope its exporter
signs, which Foundry's docs say comes with the export implementation.

The browser side follows Foundry's consumer contract in
[`docs/lightning-factory.md`](https://github.com/OogaBoogaX/lightningfoundry/blob/main/docs/lightning-factory.md).

## Why BTCPay stays on the node's machine

- BTCPay can't run in a Worker. It's a .NET server with PostgreSQL, and its on-chain support
  needs NBXplorer and a Bitcoin node.
- Anywhere off the machine, BTCPay would need inbound connections to LND.
- Dropping BTCPay for LND directly would be leaner, but it loses on-chain donations to the
  team's watch-only zpub, and the books.

See [decision 0004](decisions/0004-btcpay-on-the-node.md).

## What a donating node needs

In general terms. The specifics of any one machine stay out of this repository.

- LND, and BTCPay Server with a store that reaches LND through a credential that can only
  receive. BTCPay has no access to LND's files.
- BTCPay isn't published to the internet: not its pages, its API or its login. Donors never
  visit it.
- The relay, in its own container with no access to LND's files, holding a BTCPay key that can
  only create and view invoices on that one store.
- A Tor SOCKS proxy the relay can use.
- A port for the webhook on the machine's internal network, which BTCPay can reach and which is
  never published.

## When a part fails

| Fails | Consequence |
|---|---|
| The relay, or its line | Donations close, and the page says so. Payment notices wait in the relay until the line is back. |
| BTCPay | No new invoices, so donations close. |
| The Worker or the Durable Object | Donations close and pages stop updating. Invoices already shown still pay, and the relay keeps their notices until the object acknowledges them. |
| D1 | Donations can't be recorded, so the object doesn't acknowledge them, and the relay keeps them. |
| A node's exporter | That node's feed goes quiet, and the Factory shows "no signal". |
| bananapayserver entirely | LND and BTCPay carry on. The node keeps routing. |

There is no failure in that table where this server takes a node down with it. The money is
never at risk here either: a payment settles on the node whatever happens to this server, and
the records can be rebuilt from BTCPay.

## Cloudflare: costs and settings

Checked against Cloudflare's documentation on 2026-09-30.

**Free plan:**

- Workers: 100,000 requests a day for the whole account, and 10 ms of CPU per request. Past
  any limit, requests fail with an error until the next day.
- Durable Objects: 100,000 requests a day and 13,000 GB-s a day, with SQLite storage only.
- SQLite storage, billed since January 2026, and D1: each allows 5 million rows read and
  100,000 rows written a day, and 5 GB in all.

**How Durable Objects are billed:**

- Every RPC call is a request, and so is opening a WebSocket.
- Messages the object sends are free, and so are incoming protocol pings. Other incoming
  messages are counted at 20 to one request.
- Duration is billed at 128 MB while the object is running, or idle but unable to hibernate.
  Calling `accept()` bills the whole time a socket is open: about 10,800 GB-s a day for the
  relay's line alone. The object uses the Hibernation API instead.

**Paid plan,** $5 a month minimum:

- Workers: 10 million requests a month included, then $0.30 per million.
- Durable Objects: 1 million requests and 400,000 GB-s a month included.

Development runs on the free plan, and the service goes live on the paid one. Every poll runs
the Worker, even when the answer comes from cache, which is why pages get pushes: about one
request per visit, against 360 per visitor-hour for polling every 10 seconds.

**Zone settings:**

- Bot Fight Mode stays off. It can challenge API traffic, and no rule can exempt a single
  path.
- Configuration rules turn off Browser Integrity Check and Under Attack mode for the relay's
  path.
- IP reputation alone no longer triggers challenges, because the threat score is always zero
  now.
- Tor shows up as country `T1` in IP Access Rules. Don't add an account-wide Tor rule; the
  relay's line arrives over Tor.

## Where the code is

| Directory | What it holds |
|---|---|
| [`shared/`](../shared/) | The line's messages and OBL's donation contract, used by both ends |
| [`worker/`](../worker/) | The Worker and its Durable Object |
| [`relay/`](../relay/) | The relay and its container |
| [`migrations/`](../migrations/) | D1's schema |
| [`tests/`](../tests/) | Everything `node --test` runs, and the stand-ins for BTCPay and Cloudflare |

The interfaces between them are in [`protocol.md`](protocol.md), and every setting is in
[`configuration.md`](configuration.md).

## Deliberately outside

- **Node software.** Anything that operates a node, including Foundry's event exporter, lives
  in [`lightningfoundry`](https://github.com/OogaBoogaX/lightningfoundry). The relay is here
  because it only receives payments and never operates LND, and Foundry's own architecture
  keeps payment processing and any cloud component outside Foundry.
- **The game.** What a donation looks like, the pile, the Banana Cooker and the Factory's
  scenes belong to [Ooga Booga Land](https://github.com/OogaBoogaX/oogaboogaland).
- **The books.** BTCPay is the source of truth, and the books live in
  [`bananacertifiedaccounting`](https://github.com/OogaBoogaX/bananacertifiedaccounting).
- **A node's own setup.** LND and BTCPay are the operator's. This repository says what a
  donating node needs, never how any one machine is built.

## Open questions

Not settled yet. Each gets a decision record when it is.

- **Where the API is served.** OBL is served by GitHub Pages, and its DNS isn't on Cloudflare
  yet. The plan: move the zone to a Cloudflare account the team owns, with the registration
  left where it is; keep the main domain on Pages; and serve the API on a subdomain such as
  `api.oogabooga.land`.
- **The Cloudflare account and the deploy rights.** They belong to the team, jointly, not to
  one person. Which account, and who holds what, is still open.
- **Missed donations.** Should a visitor who comes back get the donations they missed onto
  their pile? That's OBL's call; each pile lives in its own browser.
- **How pages get node feeds.** Foundry's docs say pages poll once a minute. With the object's
  sockets, pushing them is cheap too.

The toolchain was on this list until the code started; it is proposed in
[decision 0009](decisions/0009-toolchain.md).

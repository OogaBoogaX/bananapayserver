# Protocol

The two interfaces this repository defines: the page's calls, which reach the Worker through
Ooga Booga Land's own Worker, and the relay's line. Both are checked at the receiving end and
drop anything that doesn't match exactly. The flows they carry are in
[`architecture.md`](architecture.md).

Status: v0.2. Pages now reach the Worker through OBL's Worker; see
[decision 0014](decisions/0014-pages-through-obl.md). Until it has run against a real node,
expect changes, and change both ends together.

## The page's calls

The page calls its own Worker, OBL's, which signs donors in with GitHub and passes donation
calls on to this Worker over a service binding. The page sees the paths below on its own
origin, with the bodies, replies and errors below, unchanged. JSON in and out, at most 1 KiB
per request. An error is `{ "error": "<name>" }`:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid` | The request is malformed |
| 400 | `amount` | The amount is outside the Worker's limits or above the node's own cap |
| 404 | `unknown` | No such request |
| 410 | `expired` | The invoice has expired |
| 413 | `too large` | The body is over 1 KiB |
| 415 | `invalid` | The body isn't `application/json` |
| 429 | `busy` | Too many requests this minute; try again in the next one |
| 503 | `closed` | Donations are closed: the relay isn't connected, didn't answer in time, a limit isn't configured, or this Worker can't be reached |

### How OBL's Worker passes them on

OBL's Worker binds to this Worker's `PageApi` entrypoint, which a binding can reach and the
internet can't. Staging binds to `bananapayserver-staging` and production to
`bananapayserver-production`:

```jsonc
"services": [{ "binding": "DONATIONS", "service": "bananapayserver-staging", "entrypoint": "PageApi" }]
```

| The page calls | OBL's Worker calls | And returns |
|---|---|---|
| `POST /donations/invoice` | `invoice(request, donor, visitor)` | the `Response`, as it is |
| `POST /donations/note` | `note(request, visitor)` | the `Response`, as it is |
| `POST /donations/onchain` | `onchain(request, visitor)` | the `Response`, as it is |
| `GET /donations/socket` | `fetch(request)` | the socket's upgrade |

- **`request`** is a new request carrying only the page's body and its `Content-Type`, never
  the browser's own request, whose cookies carry OBL's session.
- **`donor`** is the signed-in donor's GitHub account, `{ "id": 4242, "login": "ooga-dev" }`:
  the numeric id, which survives a rename, and the username, exactly as GitHub gives them. It
  is null when nobody is signed in. Anything else is refused as `invalid`.
- **`visitor`** is the address the page's call came from, `CF-Connecting-IP`, for rate limits.
  It is never stored. A call without one is refused as `invalid`, rather than counted with
  every other such call.
- **The socket's request** goes to `/donations/socket`, with `after` when there is one, the
  WebSocket headers, and `X-Client` set to the visitor's address, replacing anything the
  browser sent. Without `X-Client` it is refused.

OBL's Worker also checks that the calls and the socket come from its own site, runs the
Worker first for `/donations/*`, answers `{ "error": "closed" }` with 503 when this Worker
throws or can't be reached, and treats donations as off while it has no binding. This Worker's
public address takes only the relay's line, until Foundry's exporters post there too.

[`tools/stand-in/index.mjs`](../tools/stand-in/index.mjs) does all of this for local testing,
except the sign-in.

### `POST /donations/invoice`

```json
{ "sats": 10000, "message": "for the cave", "anon": false }
```

`message` and `anon` are optional. Who gave it comes from OBL's sign-in, never from the body: a
signed-in donor gives as their GitHub username unless `anon` is true, and anyone else gives
anonymously. The Worker cleans the message with OBL's rules. A page can send the amount alone
as soon as the donor picks it, and the message afterwards.

```json
{
  "request": "3f0c…32 hex characters",
  "invoice": { "id": "BTCPay invoice id", "bolt11": "lnbc…", "expires": 1790000900 },
  "bananas": { "exact": 10, "rounded": 10 },
  "rate": { "usdPerBtc": 100000, "satsPerBanana": 1000, "at": 1790000000000, "stale": false }
}
```

`request` is the page's key to its own donation: only it can add the message or switch to
on-chain. Keep it in memory, never in a URL. `expires` is in unix seconds. A banana is a
dollar's worth of bitcoin at the price in `rate`, which is locked into this invoice: the donor
is shown the rate and both counts, and the donation counts `exact` bananas. `rate.at` is when
the price was fetched, in milliseconds. `rate.stale` is true when the price service didn't
answer and the count uses the last price it gave, from `rate.at`; the page shows an alert
saying so. `bananas` and `rate` are both null in the rare case that there has never been a
price, and the page shows an alert for that too. Either way, the donation still goes through.

### `POST /donations/note`

```json
{ "request": "3f0c…", "message": "for the cave" }
```

Replaces the message, any time before the invoice is paid. Who gave it can't change. Answers
204.

### `POST /donations/onchain`

```json
{ "request": "3f0c…" }
```

When the donor switches to on-chain. BTCPay makes the address only now.

```json
{ "address": "bc1q…", "sats": 1000 }
```

`sats` is what BTCPay expects on-chain, which is more than the invoice when the store adds a
network fee. Build the payment URI from these two. There is no BTCPay link.

### `GET /donations/socket?after=<invoice id>`

A WebSocket. The page sends nothing on it; a page that does is closed with code 1008. When it
connects, it receives the status, the pile, the leaderboard and the tally, then anything it
missed. After that:

- `{ "type": "status", "open": true, "network": "signet" }` whenever the relay's line opens or
  closes, so the page can say donations are closed before anyone tries. `network` is the
  network this deployment takes payments on, so a page can label test donations.
- `{ "type": "donation", "donation": { "id", "sats", "handle", "message", "at" }, "bananas": { "exact", "rounded" } }`
  for each payment. `donation` is OBL's contract exactly, with the invoice id as `id`, the
  GitHub username or `""` as `handle`, and `at` in milliseconds. A username arrives whole, up
  to GitHub's 39 characters. The donor's page recognizes its own invoice id.
- `{ "type": "pile", "bananas": 980.5, "at": 1790000000000, "eatPerHour": 60 }` after each
  donation that counts. Every page works the pile out the same way: `bananas`, less
  `eatPerHour` for each hour since the message arrived, never below zero. Show whole bananas.
- `{ "type": "board", "entries": [{ "handle": "ooga-dev", "bananas": 300 }] }` after each
  signed-in donation that counts bananas: the top 20 by total bananas, rounded. Anonymous
  donations are never on it. If D1 can't be read, the board is skipped until the next one.
- The tally, the donations board's figures, the same in every browser:

  ```json
  { "type": "tally", "count": 12, "sats": 120000, "bananas": 108.442, "last": 10000,
    "hours": [[1791280800000, 10000, 9.012], [1791295200000, 10000, 9.004]],
    "rate": { "usdPerBtc": 90000, "satsPerBanana": 1111, "at": 1791295200000, "stale": false } }
  ```

  - **`count`, `sats` and `bananas`** cover every donation recorded, all time, anonymous ones
    and on-chain ones included. `bananas` is exact, the sum of what each donation counted.
    One recorded without a price adds its sats and no bananas.
  - **`last`** is the most recently recorded donation's sats, with no handle, message or time,
    or null before the first.
  - **`hours`** is the last seven days by UTC hour, the current hour included, as
    `[hour's start in milliseconds, sats, bananas]`, listing only hours with donations. A
    page works out its own "today" and week from them, and drops hours older than seven days
    as its clock moves. In a time zone half an hour or 45 minutes off UTC, "today" can start
    up to 45 minutes off.
  - **`rate`** has the invoice reply's shape, from the last price the object has: null if it
    never had one, and `stale` while the price service isn't answering.

  It's sent after each donation that counts, and whenever the rate changes: after an
  invoice's price lookup, or when the object checks the price. While pages are open, the
  object checks every five minutes, so the rate is never much older than that; see
  [decision 0017](decisions/0017-tally-and-fresh-rate.md). A tally never goes out twice
  unchanged. A page that connects gets it at once, never held up for a price: an older one
  is asked for afterwards, and pages hear if it changed. If D1 can't be read, the tally is
  skipped, as the board is.

`after` is the last donation id the page saw. On reconnecting, the object replays up to 50
newer ones. Leave it out on a first visit. A donation recorded while a replay is on its way
can reach the page twice, so ignore an id the page has already played.

Donations are the record, so they stay when a donor deletes their OBL account, and a donor
who comes back keeps their history. Whether the leaderboard shows an account that is gone is
the page's choice.

The object keeps its page sockets below Cloudflare's limit for one object, so the relay's
line always has room. Past that, past the visitor's rate limit, or past the sockets one
visitor may hold open at once, a new socket is refused with 429.

## The relay's line

### Opening

The relay opens `wss://<the Worker's public address>/relay` with
`Authorization: Bearer <token>`. The Worker hashes the token with SHA-256 and compares it, in
constant time, with `RELAY_TOKEN_SHA256`, the only form in which it holds the token. The
Durable Object checks it again, since another Worker in the account could reach the object
without passing through the front door. A newer line replaces an older one, which the object
closes with code 4000.

### Keepalive

The relay sends a WebSocket protocol ping every 25 seconds, which Cloudflare answers without
waking the object. If nothing arrives for 70 seconds, the relay drops the line and dials
again, waiting 1 second at first and doubling up to a minute, with jitter. Over Tor, it
dials through the machine's SOCKS proxy and sends the host name unresolved.

### Messages

Each message is one JSON text frame of at most 8 KiB, with exactly the keys shown.
[`shared/protocol.mjs`](../shared/protocol.mjs) is the definition both ends use.

From the object to the relay:

| Message | Meaning |
|---|---|
| `{ "type": "invoice", "request", "sats" }` | Make an invoice for this amount |
| `{ "type": "onchain", "request", "invoice" }` | Add an on-chain address to this invoice |
| `{ "type": "ack", "invoice", "result" }` | The payment notice arrived; `result` is `recorded`, `duplicate`, `unknown` or `rejected` |

From the relay to the object:

| Message | Meaning |
|---|---|
| `{ "type": "invoice", "request", "invoice": { "id", "bolt11", "expires" } }` | The invoice |
| `{ "type": "invoice", "request", "error" }` | `cap` when the amount is over the relay's own cap, otherwise `unavailable` |
| `{ "type": "onchain", "request", "address", "sats" }` | The address, and what BTCPay expects on-chain |
| `{ "type": "onchain", "request", "error": "unavailable" }` | No address |
| `{ "type": "paid", "invoice", "sats", "method" }` | Settled, and how: `lightning`, `onchain`, or `mixed` for an invoice paid partly each way. Repeated until acknowledged |

The handle and message never go down the line: the relay sees a request id and an amount.

The object checks every reply before a page sees it. An invoice must be for the configured
network and exactly the requested amount, an address must be for the configured network, and
a payment must match its request's amount. A notice for an invoice the object never asked
for is acknowledged as `unknown` and recorded nowhere. Anything that fails to record isn't
acknowledged, so the relay sends it again.

## BTCPay

What the relay needs from the store on its machine:

- **An API key** with `btcpay.store.cancreateinvoice` and `btcpay.store.canviewinvoices` on
  that one store, and nothing else.
- **A webhook** for the "invoice settled" event, sent to `http://<relay>:8080/btcpay` on the
  machine's internal network, with a secret the relay also holds, and automatic redelivery
  on.

What the relay does with it:

- Each invoice is in BTC, carries `metadata.orderId` `bananapayserver`, and has lazy payment
  methods. The relay activates Lightning at once and on-chain only when the donor switches.
- A payment counts once BTCPay's API, not the webhook, says the invoice is `Settled` and it
  wasn't marked settled by hand. An invoice paid in full after it expired, `Expired` with
  `PaidLate`, which only an on-chain payment can be, counts too, once every payment on it is
  settled.
- The webhook sends the relay to look at an invoice when it settles and when it receives a
  payment, since a late payment settles nothing.
- Once a minute, the relay checks every open invoice of its own, which catches any webhook
  that never arrived. After a restart, it finds its invoices from the last day again, every
  page of BTCPay's list, late-paid ones included.

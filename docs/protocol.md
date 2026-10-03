# Protocol

The two interfaces this repository defines: the page's API, which Ooga Booga Land's
`donations.js` calls, and the relay's line. Both are checked at the receiving end and drop
anything that doesn't match exactly. The flows they carry are in
[`architecture.md`](architecture.md).

Status: v0.1, written with the first implementation. Until it has run against a real node,
expect changes, and change both ends together.

## The page's API

Served by the Worker. JSON in and out, at most 1 KiB per request. A browser may call it only
from an allowed origin, and every call is made with `credentials: "include"`, so the sign-in
cookie goes with it. An error is `{ "error": "<name>" }`:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid` | The request is malformed |
| 400 | `amount` | The amount is outside the Worker's limits or above the node's own cap |
| 401 | `signed out` | `/auth/me` only: nobody is signed in |
| 403 | `origin` | The page's origin isn't allowed |
| 404 | `unknown` | No such request |
| 410 | `expired` | The invoice has expired |
| 413 | `too large` | The body is over 1 KiB |
| 415 | `invalid` | The body isn't `application/json` |
| 429 | `busy` | Too many requests this minute; try again in the next one |
| 503 | `closed` | Donations are closed: the relay isn't connected, didn't answer in time, or a limit isn't configured |
| 503 | `sign-in unavailable` | `/auth/me` only: sign-in isn't set up on this deployment |

### Signing in

- **`GET /auth/github?return=<page>`** is a page to navigate to, not a call. It goes to GitHub
  and comes back to `return`, which must be on an allowed origin, signed in.
- **`GET /auth/me`** answers `{ "login": "ooga-dev" }`, or 401 when nobody is signed in.
- **`POST /auth/signout`** forgets the sign-in and answers 204.

The sign-in is a cookie on the API's own domain, so the API has to be served from the same
site as the page, such as a subdomain of `oogabooga.land`.

### `POST /donations/invoice`

```json
{ "sats": 10000, "message": "for the cave", "anon": false }
```

`message` and `anon` are optional. Who gave it comes from the sign-in, never from the body: a
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
connects, it receives the status, the pile and the leaderboard, then anything it missed. After
that:

- `{ "type": "status", "open": true }` whenever the relay's line opens or closes, so the page
  can say donations are closed before anyone tries.
- `{ "type": "donation", "donation": { "id", "sats", "handle", "message", "at" }, "bananas": { "exact", "rounded" } }`
  for each payment. `donation` is OBL's contract exactly, with the invoice id as `id`, the
  GitHub username or `""` as `handle`, and `at` in milliseconds. The donor's page recognizes
  its own invoice id.
- `{ "type": "pile", "bananas": 980.5, "at": 1790000000000, "eatPerHour": 60 }` after each
  donation that counts. Every page works the pile out the same way: `bananas`, less
  `eatPerHour` for each hour since the message arrived, never below zero. Show whole bananas.
- `{ "type": "board", "entries": [{ "handle": "ooga-dev", "bananas": 300 }] }` after each
  signed-in donation that counts bananas: the top 20 by total bananas, rounded. Anonymous
  donations are never on it. If D1 can't be read, the board is skipped until the next one.

`after` is the last donation id the page saw. On reconnecting, the object replays up to 50
newer ones. Leave it out on a first visit. A donation recorded while a replay is on its way
can reach the page twice, so ignore an id the page has already played.

GitHub usernames run to 39 characters, so OBL's `HANDLE_MAX` of 24 has to grow to 39 for
`handle` to arrive whole.

The object keeps its page sockets below Cloudflare's limit for one object, so the relay's
line always has room. Past that, and past the visitor's rate limit, a new socket is refused
with 429.

## The relay's line

### Opening

The relay opens `wss://<api host>/relay` with `Authorization: Bearer <token>`. The Worker
hashes the token with SHA-256 and compares it, in constant time, with `RELAY_TOKEN_SHA256`,
the only form in which it holds the token. A newer line replaces an older one, which the
object closes with code 4000.

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
  wasn't marked settled by hand.
- Once a minute, the relay checks every open invoice of its own, which catches any webhook
  that never arrived. After a restart, it finds its invoices from the last day again.

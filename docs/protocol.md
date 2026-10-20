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
| 400 | `message` | A nonempty message needs a donation at or above `messageMinSats` |
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
{ "sats": 10000, "handle": "ooga-dev", "message": "for the cave" }
```

`handle` and `message` are optional editable display text, available with or without sign-in.
The Worker sanitizes them with OBL's rules: at most 39 and 280 characters, respectively.
Leading `@` is removed from the handle, and an explicitly empty handle becomes `anon`.
OBL prepopulates the handle with the signed-in login, otherwise `anon`; either can be changed.
Account identity still comes only from OBL's authenticated service-binding argument, never
from the display handle. Without `handle`, older clients retain the signed-in login or an
empty anonymous name; `anon: true` still suppresses account identity for those clients.
The handle and message can be updated using `/donations/note` before settlement starts,
without replacing the invoice or its rate.
An invoice or note carrying a nonempty message below `messageMinSats` is refused with
400 `{ "error": "message" }`; a client must not claim that text was saved. A donation
without a message remains available from the configured minimum.

```json
{
  "request": "3f0c…32 hex characters",
  "invoice": { "id": "BTCPay invoice id", "bolt11": "lnbc…", "expires": 1790000900 },
  "bananas": { "exact": 10, "rounded": 10 },
  "rate": { "usdPerBtc": 100000, "satsPerBanana": 1000, "at": 1790000000000, "stale": false },
  "pricing": "receipt",
  "lightning": "available"
}
```

`request` is the page's key to its own donation: only it can update display details or switch to
on-chain. Keep it in memory, never in a URL. `expires` is in unix seconds. A banana is a
dollar's worth of bitcoin. With `pricing: "receipt"`, `bananas` and `rate` are estimates,
not locked amounts. OBL follows 2140data's live socket while a kiosk is open; the sats amount,
Lightning code and on-chain address never change with the market. An older reply without
`pricing: "receipt"` still means the legacy invoice-locked rule.

Lightning records a price when the backend receives the paid notice. On-chain records it
when the backend first sees `left: 0`: BTCPay has received the full amount, including any
required fee and payments made through another method. Partial payments keep floating. If the first notice is already settled,
that notice is the receipt. Confirmation credits the frozen amount; it never reprices it.
The server independently samples 2140data's socket, then REST on failure, and keeps its existing
jump guard and last-price fallback. It never trusts a price from the page.

`rate.at` is the server's price observation time in milliseconds; `rate.stale` identifies a
fallback. It does not measure delivery delay: a relay outage before the first notice means
sampling on reconnect, without reconstructing the price at BTCPay's payment timestamp.
D1 stores backend detection time as `received_at` separately from `price_at`, along with `price_cents`,
`price_stale`, `pricing` and `milli`. A missing price freezes a null price and zero credited
bananas, without blocking payment. Once stored, a receipt is never repriced by retries,
restarts or service recovery. Apply all migrations through 0008 before deploying. Historical
rows and totals keep their recorded invoice prices; legacy price freshness is unknown (NULL).
If the Worker runs before 0008, settlement inserts fail and the relay cannot receive an
acknowledgement; it retries those notices after the migration is applied.

Deploy the page before this Worker. A page older than OBL #242 sends whatever message the
donor typed at any amount, so against this Worker a tip under `messageMinSats` with a
message is refused with 400 `message` at creation and in `note`, which that page shows as a
problem it cannot explain. The page from #242 on blanks such messages itself, falls back to
a 1,000-sat bar when `status` names none, and shows an empty recent list and no check until
this Worker answers, so it runs correctly against either Worker. The order is therefore: the
page, then migration 0008, then this Worker.

`lightning` is `available`, `limit` (above the configured Lightning threshold), or
`unavailable` (BTCPay couldn't make Lightning in time, for example while LND is down or
slow). The last two have `invoice.bolt11: null` and still support `/donations/onchain`.
Amounts above `LIGHTNING_MAX_SATS` are accepted on-chain only, without an application cap.
The Worker asks the relay for `onchainOnly: true`; the relay also enforces its own threshold.
Invalid Bitcoin amounts or amounts below the configured minimum still return `amount`.
Legacy `MAX_SATS` supplies the Lightning threshold only when `LIGHTNING_MAX_SATS` is absent.

### `POST /donations/note`

```json
{ "request": "3f0c…", "handle": "chosen-name", "message": "for the cave" }
```

Updates optional `handle` and/or `message` before settlement starts. Omitted fields are
preserved; legacy calls with neither clear the message. A donation under `messageMinSats`
refuses a nonempty message with 400 `{ "error": "message" }`. Text uses the same sanitization as
invoice creation. The invoice, its payment code/address, sats, expiry, rate and authenticated
account identity stay fixed. Answers 204, or 404 once settlement has started or the request
is unknown, or 429 if the note autosave budget is exhausted. A failed save leaves the last
saved text unchanged; the client must show the failure and retry before settlement. Nothing
edits an already recorded donation.

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
  network this deployment takes payments on, so a page can label test donations. It also has
  `limits: { minSats, maxSats, lightningMaxSats, messageMinSats }`, the public payment policy. `messageMinSats` is the fewest sats a donation
  needs to carry a message, and to be listed among the recent ones: new nonempty messages below it are refused at creation and by
  `note`, and settlement strips one held by an older pending invoice, so tiny donations can neither speak nor flood the list. `maxSats` is the fixed Bitcoin supply bound, not an application
  cap. Kiosks warn about on-chain-only amounts before Continue and validate Bitcoin amounts. Legacy
  clients may ignore these extra fields.
- `{ "type": "donation", "donation": { "id", "sats", "handle", "message", "at" }, "bananas": { "exact", "rounded" }, "seq": 12, "verified": true }`
  for each payment. `donation` is OBL's contract exactly, with the invoice id as `id`, the
  chosen display handle (or `""` from an older anonymous client), and `at` in milliseconds.
  Handles run to 39 characters and messages to 280. The donor's page recognizes its own invoice id.
  `seq` is the D1 donation order. `verified` is true only when the donor was signed in with
  GitHub and the final display handle matched that account's login, ignoring case. Changing
  the handle before payment can remove the match. A typed matching name without sign-in
  never earns it.
- A signed-in donor's login is the one OBL stored at sign-in. After a GitHub rename,
  the new login cannot earn a check until they sign in to OBL again.
- `{ "type": "recent", "entries": [{ "seq": 12, "id": "invoice id", "sats": 1000, "handle": "ooga-dev", "message": "for the cave", "at": 1790000000000, "bananas": 1, "verified": true }] }`
  after the tally when a page connects, with up to ten newest donations of at least
  `messageMinSats` in descending `seq` order. `bananas` is each donation's recorded exact amount, zero when it had no price. Old
  donations without recorded GitHub login matches have `verified: false`. On reconnect, the
  usual `after` replay follows this snapshot; the page deduplicates matching invoice ids.
  Recent entries are compact list rows with a numeric banana amount; live and replayed
  `donation` messages retain the separate OBL event and banana estimate envelope.
- `{ "type": "seen", "id", "sats", "due", "left" }` when BTCPay sees an on-chain payment it
  hasn't yet settled, before the donation itself, which follows once BTCPay settles the
  invoice. `id` is the invoice id the donation will carry, `sats` is everything the invoice
  has received on-chain so far, `due` is the invoice's amount, and `left` is what BTCPay still
  wants on-chain, `0` once it's paid in full or overpaid. After a short payment, `left` can be more than
  `due − sats`: a store can add a network fee for a second payment, so `left` is the amount
  to ask the donor for. It names nobody and counts nothing. It's sent once per payment, as it
  happens, and is neither kept nor replayed; after the relay restarts, one may come again,
  which a page takes as harmless. When a receipt has frozen, this message also has
  `pricing: { receivedAt, rate, bananas }`: the receipt timestamp, the recorded rate (or null),
  and the recorded banana count (or null). Repeated notices return the same snapshot. The
  snapshot is durable, though the notice itself isn't replayed. Lightning payments never send it.
- `{ "type": "pile", "bananas": 980.5, "at": 1790000000000, "eatPerHour": 60 }` after each
  donation that counts. Every page works the pile out the same way: `bananas`, less
  `eatPerHour` for each hour since the message arrived, never below zero. Show whole bananas.
- `{ "type": "board", "entries": [{ "handle": "ooga-dev", "bananas": 300.125, "sats": 300000 }], "satsEntries": [{ "handle": "ooga-dev", "bananas": 300.125, "sats": 300000 }] }`
  after each named donation. `entries` is the top 20 by total bananas,
  excluding donors with no counted bananas; `satsEntries` is
  independently the top 20 by total sats, including unpriced donations. Each entry includes
  both totals. Banana totals preserve the recorded thousandths without rounding; clients may
  round for display. Matching handles combine case-insensitively across accounts and guests;
  the latest spelling is displayed. Ties in either ranking follow handle order. Sats are
  recorded amounts, never converted from bananas at today's price. A donation without a
  price adds its sats and zero bananas. Both lists include earlier donations after migration
  `0005_handle_totals.sql`, grouped by their recorded display names. Changing the name starts
  a separate total; old unnamed donations remain outside the ranking. `anon` is a regular
  entered handle whose donations combine like any other name. Display names are not verified identities.
  If D1 can't be read, the last cached board is kept, or skipped if none has been read.
  Older clients can continue reading `entries` alone.
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
| `{ "type": "invoice", "request", "sats" }` | Make an invoice for this amount; an optional `onchainOnly: true` creates only the on-chain method. When present it must be exactly `true` |
| `{ "type": "onchain", "request", "invoice" }` | Add an on-chain address to this invoice |
| `{ "type": "ack", "invoice", "result" }` | The payment notice arrived; `result` is `recorded`, `duplicate`, `unknown` or `rejected` |

From the relay to the object:

| Message | Meaning |
|---|---|
| `{ "type": "invoice", "request", "invoice": { "id", "bolt11", "expires" } }` | The invoice; `bolt11: null` for an on-chain-only invoice, or when Lightning couldn't be made in time |
| `{ "type": "invoice", "request", "error" }` | `cap` when the amount is over the relay's own cap, otherwise `unavailable` |
| `{ "type": "onchain", "request", "address", "sats" }` | The address, and what BTCPay expects on-chain |
| `{ "type": "onchain", "request", "error": "unavailable" }` | No address |
| `{ "type": "paid", "invoice", "sats", "method" }` | Settled, and how: `lightning`, `onchain`, or `mixed` for an invoice paid partly each way. Repeated until acknowledged |
| `{ "type": "seen", "invoice", "sats", "left" }` | An on-chain payment BTCPay hasn't settled yet: everything received on-chain so far, and what BTCPay still wants on-chain, network fee included. Once per payment, never acknowledged |

The handle and message never go down the line: the relay sees a request id and an amount.

The object checks every reply before a page sees it. An invoice must be for the configured
network and exactly the requested amount, an address must be for the configured network, and
a payment must match its request's amount. A notice for an invoice the object never asked
for is acknowledged as `unknown` and recorded nowhere. Anything that fails to record isn't
acknowledged, so the relay sends it again. A `seen` reaches pages only for an invoice the
object is still waiting on.

## BTCPay

What the relay needs from the store on its machine:

- **An API key** with `btcpay.store.cancreateinvoice` and `btcpay.store.canviewinvoices` on
  that one store, and nothing else.
- **A webhook** for the "invoice settled", "invoice received a payment" and "payment settled"
  events, sent to `http://<relay>:8080/btcpay` on the machine's internal network, with a
  secret the relay also holds, and automatic redelivery on.

What the relay does with it:

- Each invoice is in BTC, carries `metadata.orderId` `bananapayserver`, and has lazy payment
  methods. The relay activates Lightning at once and on-chain only when the donor switches.
- The relay aims to answer an invoice ask within `INVOICE_DEADLINE_MS` of receiving it, 8
  seconds when unset, so its answer reaches the Worker inside the Worker's own wait. Lightning
  gets whatever time making the invoice left. If BTCPay fails to make Lightning, or doesn't
  make it in time, the invoice goes back with `bolt11: null`, and the donor can still pay
  on-chain. How long Lightning took, or that it didn't, goes in the relay's log, durations
  only.
- A payment counts once BTCPay's API, not the webhook, says the invoice is `Settled` and it
  wasn't marked settled by hand. An invoice paid in full after it expired, `Expired` with
  `PaidLate`, which only an on-chain payment can be, counts too, once every payment on it is
  settled.
- The webhook sends the relay to look at an invoice when it settles and when it receives a
  payment, since a late payment settles nothing.
- When an invoice of its own is `Processing`, `New` with `PaidPartial`, or `Expired` with
  `PaidLate`, or a webhook says a payment arrived, whatever the invoice's status shows yet,
  the relay reads its payments and announces each new on-chain payment as `seen`. A short
  payment is announced even once it has confirmed, so the page learns what's left; a full
  payment that has already confirmed isn't, since the donation follows. The relay reads
  payments only then, so the invoices nobody has paid cost BTCPay nothing more each minute.
  Each `seen` it sends goes in its log, with the amounts and no names.
- Once a minute, the relay checks every open invoice of its own, which catches any webhook
  that never arrived. After a restart, it finds its invoices from the last day again, every
  page of BTCPay's list, late-paid ones included.

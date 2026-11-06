# Receipt accounting v1: shared contract, gates and proposed architecture

**Status:** proposal, draft. Nothing here is built, deployed, migrated or active, and nothing
in this document authorizes any of that. This is the bananapayserver side of OBL issue #492.
The page contract needs OBL's agreement. The relay line, credentials and deployment need two
maintainers. The storage design is a *proposed* architecture, not a description of code.
Open decisions are listed in [Activation gates](#activation-gates) and
[Open decisions](#open-decisions).

**Phase 1:** the durable core is in [`worker/receipts.mjs`](../worker/receipts.mjs), tested
in `tests/receipts.test.mjs`. Nothing calls it. The edit window, the message rule, the
pricing recovery and the freshness bound are explicit inputs, and the operations that need
them refuse without them, atomically. Provider capabilities are fixture inputs, never
verified claims.

- **Issuance:** off unless enabled. A new invoice needs a whole reviewed policy, and that
  policy is saved with the invoice. It has five parts:
  - the edit window;
  - the message rule;
  - the pricing-recovery rule for an interrupted lookup;
  - a reference to the provider confirmation policy settlements must be reported under;
  - a policy version.
- **Settlement trust:** a settled observation whose read reports any other confirmation
  policy, or none, is held as `confirmation-policy` and captures nothing. Only a reviewed
  release credits it.
- **Recovery:** an interrupted lookup is recovered by the invoice's saved rule, never by an
  argument supplied at startup.
- **Processing:** observing, pricing, recovering and releasing always use the invoice's saved
  policy, never the current configuration. Disabling issuance or changing the configured
  policy doesn't change how issued invoices count. An invoice without a whole saved policy
  is refused, never defaulted.

**Phase 2, first step:** the no-decay pile is in the runtime ([`worker/pile.mjs`](../worker/pile.mjs));
see [Cutover anchor](#cutover-anchor).

**Phase 2, second step: the read side is wired.** The object serves `POST /donations/status`,
`POST /donations/history`, and the socket's `recentReceipts`, receipt replay and marker from
the receipt core, through `PageApi.status` and `PageApi.history`.

- **Still not built:**
  - **Issuance:** receipt-mode issuance is off in this build. `accounting: 1` is answered 503
    `closed` before any provider call, and any other value is 400 `invalid`.
  - **Provider ingestion:** nothing creates a mapping or reads the provider yet.
  - **Reconciliation:** nothing reads the provider, so in a real deployment no read is ever
    verified complete and health is never `current`. The D1 projection is built; see
    [D1 projection](#d1-projection).
- **Real outputs:** the endpoint and socket outputs are in the shared fixture's `endpoints`
  section; see `tests/receipt-contract.test.mjs`.
  - **What they prove:** the producer's real shapes, statuses and cursors, generated through
    the actual front door, object and broadcast. They cover:
    - a status page and its next receipt and address pages;
    - two history pages reached through the generated cursor;
    - the cursor, unknown, resync and scoped metadata-closed errors;
    - the connect sequence and a replay from zero;
    - a genuine new first credit heard live, `replay: false`, by an already-connected socket.

    Each socket vector is the messages received at a stated point, so no later message can
    leak in.
  - **Three more sections, generated the same way:**
    - **`projection`:** what an open socket hears when the D1 projection publishes lifetime
      figures, through a first credit, a restart, a repeated refresh, a reversal and a
      reconfirmation.
    - **`pile`:** what an open page hears of the anchored pile as receipts move it. The anchor
      is applied through `applyPileAnchor` on storage, as an operator would. It covers:
      - credit, review with an uncertain amount, reversal and reconfirmation;
      - health from `behind` to `current` and `review`;
      - a pile bridged before a stop, heard by the surviving page from the next start's alarm;
      - a later reconnect.
    - **`payable`:** the positive payable path, from a complete synthetic snapshot read with
      destination capability. It covers:
      - a status naming a bound regtest payable address, with a fresh remainder;
      - its live withdrawal once stale, and the invoice's expiry, with the history kept;
      - a real gap marker from a reconnect further behind than that world's saved replay bound
        of 2, and a complete current reconnect;
      - the first page's whole connect output before any read or payment
        (`socket.initialConnect`);
      - the request the connect of `socket.initialConnect`, `socket.gapMarker` and
        `socket.currentReconnect` each actually sent through `PageApi` (`socket.requests`);
      - a gap a page can actually reach, from a second page's point of view:
        1. it connects with no cursor (`socket.earlyConnect`);
        2. it hears seq 1 live and goes away before the next frame (`socket.earlyLive`);
        3. after the expiry it comes back with `receipts=1`, the cursor it heard. More frames
           wait than the saved bound of 2, so it gets a gap marker and no frames
           (`socket.earlyGap`);
        4. it reconnects from that marker's high-water mark and is complete
           (`socket.earlyCurrent`).

        Each comes with the request it sent, and the private status and history at the same
        point.

      With no cursor and an empty feed, the connect's marker is `{ after: null, through: null,
      complete: true }`. It names no position, not 0. A page that has heard nothing reconnects
      with no cursor, so `socket.gapMarker`'s `receipts=0` request is the producer's own
      cursor-0 check, not a step a page reaches from that marker.

      Lightning is never available there, since no provider has verified the original code.
  - **What they don't prove:** provider ingestion, reconciliation (health is never `current` in
    a real deployment), real runtime behaviour, or that any consumer parses them. That needs the
    consumer's own run against these bytes.
- **Page bound:** a private page (status receipts, addresses, history) carries at most 100 rows.
  This is a wire bound agreed with the consumer, not a deployment choice. Read settings above it
  are refused when saved or adopted, the saved row's checks refuse it too, and the core never
  cuts a larger page. Each deployment still chooses its own sizes, at or under it.
- **How it behaves:**
  - **Read settings are saved, not configured.** The seven read bounds (replay bound, status,
    address and history page sizes, recent-receipts size, cursor lifetime and freshness) are a
    reviewed set. The first issuance saves them durably, in the same transaction as the first
    mapping, so no mapping exists without them. From then on every read uses the saved set.
    Removing or changing Worker configuration never closes reads, and never changes what is
    fresh at an unchanged revision. An issuer configured differently from the saved set refuses
    to issue, rather than drift. No values are chosen in code.
  - **Original metadata is required.** A new mapping needs its whole original metadata: the
    expiry in seconds, the Lightning offer, and the code exactly when Lightning was offered.
    `expires` in a status reply is always a number. Nothing is guessed, and the original target
    is never used as a remaining amount.
  - **`lightning` and `bolt11`:** `lightning` is `available`, with the original `bolt11`, only
    while no receipt has ever been observed and the provider has freshly verified the code. Nothing
    records that verification yet, so it is `unavailable`, `limit` or `expired`, with `bolt11`
    null.
  - **Time-driven changes are committed revisions.** The code's verification ageing out and the
    invoice's expiry are committed like a stale remaining amount or payable address: a newer
    revision and an invoiceStatus signal, before any cursor is judged. An unauthorized reader
    changes nothing.
  - **The alarm keeps time.** It is due at the earliest of the price check and the next receipt
    deadline, so an amount-bearing QR is withdrawn on time while pages are open. With none
    open, the next authorized read commits it.
  - **`recentReceipts`:** receipts that have been credited, whether still credited or now in
    review, newest first by when each was first observed. A late credit or a correction never
    displaces a newer receipt.
  - **Live frames:**
    - **Bounded batches:** they go out in batches of the saved replay bound, from a durable
      mark, and the alarm continues a backlog at once, so nothing loads unbounded and nothing
      is skipped.
    - **Never history as live:** a page hears live only frames after the high-water mark
      captured when it connected. Frames committed while no page is open aren't held for
      later as live.
    - **At least once:** a frame may reach a page in its replay and live, and pages deduplicate
      by revision.
  - **`status.accounting`** appears only once a receipt-mode mapping exists. Until then the
    status message is unchanged, and its absence means legacy, as from older Workers.
  - **Rate limits:** private reads share the per-visitor `RATE_PER_IP` budget, in their own
    bucket.
- **Pre-activation rows: explicit operator reconciliation.** A mapping a pre-activation core
  left without saved read settings, or without whole original metadata, is never filled in by
  a guess. Until reconciled:
  - **Missing read settings:** every receipt read is 503 `closed`, since nothing can be paged
    without them.
  - **Incomplete metadata:** only the affected reads are 503 `{ "error": "closed" }`, namely
    that invoice's private status and the one history page that holds it.
    - The record is kept, and the row is never omitted from its page.
    - No null, zero or guessed `expires` is ever sent.
    - Other pages, their cursors, other invoices and the global capabilities are unaffected.
    - With no status, there is no payable address or amount for that invoice, so no
      amount-bearing QR.
  - **Health:** `review`, a signal for the operator rather than a capability switch.
  - **Access:** still checked first.

  An operator reconciles once, through `adoptReadSettings` or `reconcileInvoiceMetadata`.
  Neither replaces what is already saved, and nothing in the Worker routes to them.
- **`expires` is always a number.** The pinned consumer requires it, and nothing here sends
  any other value. Showing such rows in some other way, rather than closing them until
  reconciled, would need a coordinated contract change, and none is proposed.

## Goal

Count every receipt BTCPay attaches to an invoice: partial, excess, split, late and repeat
payments. Credit each one once, to the attribution saved with the invoice. That attribution
is not proof of who sent the payment. Keep lifetime donations apart from the remaining pile,
and remove time-based decay.

## Safety boundaries

- **No new credential and no expanded scope.** The relay's BTCPay key stays limited to
  creating and viewing invoices on one store. There is no wallet API and no LND access.
  `coverage` is always `"invoice"`: v1 sees only what BTCPay attaches to invoices. Even a
  full sweep of every retained invoice is not complete monitoring of old addresses, and is
  never presented as one.
- **Spending stays inactive.** v1 chooses no treasury boundary, spend valuation or starting
  inventory. `spends` is always false.
- **Public streams never carry** an on-chain address, request token, account id, txid or
  outpoint, block identity, provider or store id, node address or BTCPay link.
- **Limits are deployment configuration.** Every new bound in this document is a required
  setting with no committed default: page sizes, the replay bound, the size of
  `recentReceipts`, reconciliation pacing, cursor lifetime and how long a provider read stays
  fresh. The proposed names are `RECEIPT_REPLAY_MAX`, `STATUS_PAGE_SIZE`,
  `ADDRESS_PAGE_SIZE`, `HISTORY_PAGE_SIZE`, `RECENT_RECEIPTS_SIZE`, `RECONCILE_PER_MINUTE`,
  `CURSOR_TTL_SECONDS` and `READ_FRESHNESS_SECONDS`. Existing legacy constants are not a
  choice of these values. The read bounds are given to the issuer, and saved durably with the
  first mapping; reads then use the saved set, never live configuration.

## Capabilities and accounting mode

Older Workers send no `status.accounting`, and a page treats its absence as legacy. A new
Worker sends:

```json
{ "version": 1, "issuance": false, "receipts": false, "history": false,
  "coverage": "invoice", "spends": false, "reconciliation": "off" }
```

- **`issuance`** gates new receipt-mode invoices and nothing else.
- **`receipts`** means the Worker can read, stream and replay receipt-mode invoices.
- **`history`** means the Worker can serve private account history.
- **`reconciliation`** is one of:
  - `off`: no receipt-mode invoice exists yet.
  - `current`: the last pass over every retained mapping completed, and nothing is in
    review.
  - `behind`: a pass is incomplete or overdue, the relay line is not on v1, the D1
    projection is lagging, or processing is suspended.
  - `review`: something is quarantined, or the pile has no cutover anchor.
- **The state is resent.** `status` goes out again whenever any field changes.
- **Service is permanent.** Once any receipt-mode invoice exists, `receipts` and `history`
  stay true.
  - Turning `issuance` off stops only new receipt-mode invoices. Reconciliation, reads,
    history, replay and truthful health go on, and existing addresses stay payable.
  - An emergency suspension of processing shows `behind` or `review` and keeps read access.
    It never reverts an invoice's mode.
- **`POST /donations/invoice`** accepts an optional `"accounting": 1`.
  - A page sends it only when `issuance` is true.
  - Any other value is 400 `invalid`.
  - If receipt mode can't be issued and saved, the answer is 503 `closed`. It is never
    downgraded to legacy.
  - Without the field, the invoice is legacy.
- **The reply's `invoice`** gains `"accounting": "receipt-v1" | "legacy"`. A missing field
  means legacy.
- **The mode is saved by the server and never changes.**
  - A legacy invoice publishes only the legacy `donation` event.
  - A receipt-mode invoice publishes only `receipt` revisions.
  - Pages handle both kinds concurrently, and neither kind suppresses the other.
  - A legacy `paid` notice can never credit a receipt-mode invoice. It is acknowledged
    `rejected`.

## Fences

Fences live in their own durable storage. No row is ever written into D1's `donations` as a
fence, because the existing triggers would add it to the aggregates.

- **Mode fence:** the saved mode of each invoice.
- **Legacy-invoice fence:** every invoice id found in `donations`, in `finished`, or in a
  `pending` row without a mode is legacy. If BTCPay returns one of these ids, receipt-mode
  issuance fails closed.
- **Imported-transaction fence:** loaded from the import records, never committed. It holds
  `(network, txid)`.
  - It fences every outpoint of each listed transaction.
  - A fenced outpoint goes to `review` with no credit. A reviewed mapping to an invoice is
    recorded, but a mapping is not money reconciliation: the funds may already be counted by
    a legacy import row, so the fence stays and nothing credits. Releasing imported funds
    needs a reconciled disposition against the legacy credit, which v1 doesn't define.
- **Release fence:** after the first receipt-mode invoice is issued, a rollback to a Worker
  that doesn't know these fences is forbidden.
- **Pile fence, earlier and independent of issuance:** once the no-decay pile migration
  (object schema step 9) has run, the delta journal is live, whether or not receipt issuance
  ever starts. Rolling back to the old decaying Worker after that point is forbidden. The old
  code would resume decay from the old checkpoint and miss every delta recorded since. A
  downgrade past that point needs its own reviewed reconciliation of the journal and the
  checkpoint first. Nothing here authorizes a deployment or a rollback.

## Attribution and ownership

### Saved at creation

These are saved in permanent storage, separate from `pending`, before the invoice reaches
the page:

- mode, network, provider and store scope;
- the stable account id from OBL's binding, or none when the donor is signed out or `anon`;
- the login OBL stored at sign-in;
- the saved handle and message;
- the message policy (`messageMinSats` at creation);
- the SHA-256 of the request token.

While edits are allowed, each `note` autosave updates `pending` and this durable record in
one transaction.

### Addresses

Each on-chain address is fully validated for the invoice's network and bound to
`(network, address)` and its invoice before it is returned. Segwit addresses are checked
against their bech32 or bech32m checksum and kept lowercase, so an uppercase spelling is
the same address; mixed case, a bad checksum or another network's prefix is refused. Base58
addresses keep their case, and their version and checksum are checked. An address already
bound to another invoice fails closed: 503, flagged for review, and never reassigned.

### Edit window (unresolved, blocks activation)

It is not decided when edits end for receipt mode. Both candidates are implemented as
explicit policy, and neither is a default:

- **`first-observation`:** the first observed receipt captures attribution and ends edits.
- **`settlement`:** the first observation the provider reports settled does, in the same
  transaction, before any price lookup, so a note during the lookup changes nothing.

Legacy behavior does not change. Once a receipt's attribution snapshot is captured, it never
changes.

### Ownership

- Ownership is OBL's stable numeric GitHub id, so it survives a rename.
- An editable handle never confers identity, and is never sender proof.

### Account deletion (unresolved, blocks activation)

OBL's `DELETE /api/me` today removes the player and sessions only. It sends no callback
here. Before activation, decide:

- deletion and redaction of history;
- what a donor who signs in again recovers.

Nothing here promises automatic deletion.

## Public receipt revision (page socket)

```json
{ "type": "receipt", "seq": 41, "replay": false,
  "receipt": {
    "id": "r3f0c…32 hex", "invoice": "BTCPay invoice id", "method": "onchain",
    "sats": 400, "credit": 400, "state": "credited", "revision": 2, "at": 1790000300000,
    "firstCreditedSeq": 41,
    "handle": "ooga-dev", "message": "", "verified": true,
    "pricing": { "receivedAt": 1790000100000,
                 "rate": { "usdPerBtc": 100000, "satsPerBanana": 1000, "at": 1790000100000, "stale": false },
                 "bananas": { "exact": 0.4, "rounded": 0 } } },
  "invoice": { "id": "BTCPay invoice id", "due": 10000, "received": 400, "credited": 400,
               "review": 0, "left": 9700, "state": "partial", "revision": 5 } }
```

### Feed and identity

- **`seq`:** the feed position of this revision. It always increases, and can have gaps.
- **`replay`:** true for catch-up frames.
- **`id`:** opaque and random, never derived from a transaction.
- **`revision`:** counts per receipt. A page applies a frame only when its revision is newer
  than the one it holds.
- **`at`:** when this revision was recorded, so a correction moves it. For a stable order,
  use the receipt's immutable first detection, `pricing.receivedAt`, never a correction's
  time.
- **No legacy events:** a receipt-mode invoice never emits a legacy `seen` or `donation`.

### Amounts and state

- **`sats`:** the actual amount received. A receipt below `minSats` still counts.
- **`credit`:** the sats this receipt currently has applied in the ledger: `0` or `sats`.
- **`state`:** one of
  - `confirming`: detected, not settled;
  - `credited`: settled, with credit applied;
  - `invalid`: invalid before any credit;
  - `reversed`: credit undone by an auditable reversal entry;
  - `review`: quarantined. A review receipt keeps whatever `credit` it had until an
    auditable reversal exists.

### Holds

A receipt can carry several holds at once, and any open hold keeps it in `review` without
new credit. Each is resolved on its own, so resolving one never credits while another
remains. Unverified identity, an import fence, an unbound destination and an alias that
disagrees with a canonical identity are never released by hand: only verified evidence
clears an unverified identity. A known payment's method, amount, destination, scope and
canonical outpoint or payment hash are immutable; a later observation that changes any of
them is held and not applied, and its evidence is recorded as not applied.

A snapshot is validated whole before anything applies. Exact repeats collapse, and two
aliases of one canonical payment that agree become one receipt. Entries for one payment that
disagree in anything reject the snapshot and flag the invoice, whatever their order.

### Animation

`firstCreditedSeq` is `null` until the first credit. Once set, it is durable through every
correction, reversal and reconfirmation. A page animates only when all of these hold:

- `replay === false`;
- `state === "credited"`;
- `seq === firstCreditedSeq`.

Snapshots, replays, `recentReceipts` and private replies never animate.

### Attribution fields

- `handle`, `message` and `verified` come from the receipt's immutable attribution snapshot.
  That is the invoice's saved attribution, not sender proof and not the current viewer.
- They are `""`, `""` and `false` while `firstCreditedSeq` is `null`.
- `message` obeys the threshold, which limits the message and never the credit. Which
  receipts carry the message is [unresolved](#open-decisions). Until it is decided, a
  receipt's `message` is `""` unless its own `sats` reach the saved policy.

### Pricing

- **`pricing: null`:** the pricing intent is unresolved, and the receipt can't credit yet.
- **`pricing` as an object:** frozen once, and never changed. A `rate` and `bananas` of
  `null` inside it mean permanently unpriced: sats counted, zero bananas.
- **Every freeze is a new revision,** even when the state stays the same. Credit waits for
  the freeze, and `firstCreditedSeq` is set only by an actual credit.

### Invoice totals

Totals are authoritative and cumulative. A page applies them only when `revision` is newer.

- **`due`:** the target requested at creation, with no fee.
- **`received`:** the sats of every receipt not `invalid` or `reversed`, `review` included.
- **`credited`:** the net sats actually applied to the ledger. This includes credit held by
  `review` receipts until a reversal exists. `credited ≤ received`.
- **`review`:** the sats of receipts in `review`. It is a subset of `received`, and can
  overlap `credited`. It describes uncertainty, and is never subtracted automatically. No
  snapshot implies a reversal that hasn't been performed. This net-credit meaning is decided,
  not an open choice.
- **`left`:** the provider's remaining amount, fee-aware, from the latest read with verified
  remaining-amount capability, within the configured freshness bound. It is `null` when
  unknown, unverified, out of date or no longer reported. Never derive it from
  `due − received`.
- **`state`**, in this order:
  1. `review` if any receipt is in review;
  2. `paid` if `left === 0`, nothing is confirming and `credited > 0`;
  3. `confirming` if `left === 0` and something is confirming;
  4. `partial` if `received > 0`;
  5. otherwise `unpaid`.

  A confirmed partial payment, or a `left` of `null`, is never `paid`.

Every receipt frame carries the invoice's final committed totals for the transaction that
made it, never totals from partway through a read.

### Invoice status frames

When an invoice's visible totals change without a receipt revision, the same feed carries:

```json
{ "type": "invoiceStatus", "seq": 42, "replay": false,
  "invoice": { "id": "BTCPay invoice id", "due": 10000, "received": 400, "credited": 400,
               "review": 0, "left": 9300, "state": "partial", "revision": 6 } }
```

- **When:** a remaining-amount or fee change, a quarantine flag, a remaining amount or
  payable address that goes stale with time, or a change only the private status shows: a
  rotated payable address, a newly bound address or a saved note. Each one carries a newer
  `revision`, and is the page's cue to refresh its private status. It carries public totals
  only, never the private change itself. A read that confirms nothing new sends nothing.
- **Only after receipts:** an invoice with no observed receipt publishes none. Private
  status is always authoritative.
- **No inference:** nothing about a receipt, accounting or animation is taken from it.
- **Shared feed:** it uses the same `seq`, high-water mark and replay as receipt frames.

### Connecting and replay

`GET /donations/socket?after=<invoice id>&receipts=<seq>`. `receipts` is an optional decimal
integer, 0 or more. When `receipts` is true, a page that connects gets, in order:

1. status, pile, board, tally and `recent`, as today;
2. `{ "type": "recentReceipts", "entries": [receipt…] }`, the newest credited receipts,
   bounded by configuration;
3. the legacy replay;
4. receipt and invoiceStatus frames with `cursor < seq ≤ through`, with `replay: true`;
5. `{ "type": "replay", "after": n|null, "through": H|null, "complete": true|false }`.

`through` is the high-water mark taken at connect, and every live frame afterwards has
`seq > through`.

- **Gap:** if more frames are waiting than the configured bound, or the cursor is above
  `through`, nothing is replayed and `complete` is `false`. The page then resyncs through
  private status, tally and pile, and takes `through` as its cursor.
- **No cursor:** on a first connection, the page gets `recentReceipts` and the replay marker,
  whose `through` is its starting cursor. Nothing historical is replayed or animated.

## Private status: `POST /donations/status`

OBL's Worker calls `status(request, donor, visitor)`. The body is exactly one of:

```json
{ "request": "3f0c…32 hex", "cursor": "optional opaque", "addressCursor": "optional opaque" }
{ "invoice": "BTCPay invoice id", "cursor": "optional opaque", "addressCursor": "optional opaque" }
```

### Access

- **`request`:** the bearer token, held only in page memory. The server keeps its hash, and
  nothing new stores or returns a token.
- **`invoice`:** needs a signed-in `donor` whose stable id equals the saved owner. This lets
  a signed-in donor recover an invoice without a token.
- **Signed-out donor after a reload:** cannot recover the invoice.

### Reply

```json
{ "invoice": { "id", "accounting": "receipt-v1", "due", "received", "credited", "review",
               "left", "state", "revision", "expires": 1790000900,
               "lightning": "available" | "limit" | "unavailable" | "expired",
               "bolt11": "lnbc…" | null },
  "payableAddress": "bcrt1q…" | null,
  "addresses": [ { "address": "bcrt1q…", "issuedAt": 1790000060000 } ],
  "nextAddress": "opaque" | null,
  "receipts": [ receipt… ],
  "next": "opaque" | null }
```

- **`addresses`:** every bound address, newest issued first, paged by `addressCursor` and
  `nextAddress`. An address carries no issuance amount, and none is ever dropped.
- **`payableAddress`:** present on every page. It is the address the provider currently
  offers, taken only from fresh evidence of a verified destination capability, and only when
  it is already bound to this invoice; otherwise `null`. An address in the history never
  implies it is payable now.
- **Amounts:** `left` is the only current, fee-aware amount. An amount-bearing QR is allowed
  only when the selected address equals `payableAddress` *and* `invoice.left` is a positive
  integer. Otherwise the page shows the bare address and says the remaining amount is
  unavailable. It never falls back to `due`, to `due − received`, or to the original amount.
- **Cursors:** `cursor` and `addressCursor` are each bound to their kind, the invoice, the
  reader (token holder or account) and the invoice's revision. Binding an address, saving a
  note, a flag, or any receipt revision bumps the revision.
- **Freshness is committed first.** For an authorized reader, a remaining amount or payable
  address that has gone stale is withdrawn, with a newer revision and one invoiceStatus
  signal, before the revision is read or any cursor judged. An unauthorized read changes
  nothing. Freshness counts from when the read began, not when its reply arrived. A reply
  that arrives after the bound is refused. So is one whose observation time falls before
  its read began or in the future.
- **`bolt11`:** the original invoice asks for the full target. In v1 it is `null` for good,
  and every page, active or reopened, hides it, once any receipt has ever been observed on
  the invoice. That holds whatever became of the receipt: invalid, reversed or netting to
  zero. v1 defines no verified replacement code for the remaining amount. Mixed receipts
  still count.
  - **Only a necessary guard:** `originalBolt11Allowed(invoice)` is true only while no receipt
    was ever observed. Showing the code also needs fresh provider-verified evidence that it
    is usable, unexpired and not yet paid, which the API wrapper must check. A page can never
    infer it from totals.
  - **Core view only:** `privateStatus` returns the core view: totals, payable address,
    addresses and receipts. The endpoint wrapper, still to come, adds
    `accounting: "receipt-v1"`, `expires` in seconds, the `lightning` value and the guarded
    `bolt11`. The core view isn't the endpoint's reply.
- **`/donations/onchain`** keeps its legacy reply. Its `sats` is the provider's amount at
  issuance, not a reusable amount later.
- **`receipts`:** newest first, bounded by `STATUS_PAGE_SIZE`.
- **`next`:** an opaque cursor for older receipts. Pages don't parse it.
- **No animation** comes from a status reply.

### Errors

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid` | A malformed body, or both or neither of `request` and `invoice` |
| 400 | `cursor` | The cursor is malformed, expired, or belongs to another invoice, endpoint or account |
| 404 | `unknown` | No such invoice, no access, a legacy invoice, or a signed-out call by `invoice`. One answer for all of these |
| 409 | `resync` | The invoice's revision changed since the cursor; restart without one |
| 429 | `busy` | Over the rate limit |
| 503 | `closed` | `receipts` is false |

## Private history: `POST /donations/history`

OBL's Worker calls `history(request, donor, visitor)`. The body is exactly `{}` or
`{ "cursor": "opaque" }`.

- **Signed in only:** a null `donor` gets 401 `{ "error": "signin" }`.
- **Ownership:** by stable account id only.

```json
{ "revision": 12,
  "invoices": [ { "id", "accounting": "receipt-v1", "createdAt", "handle", "due", "received",
                  "credited", "review", "left", "state", "revision", "expires" } ],
  "next": "opaque" | null }
```

- **Paging:** newest first, bounded by `HISTORY_PAGE_SIZE`. Each invoice's receipts come
  from status, called by `invoice`.
- **No tokens or addresses** appear in history.
- **`revision`:** the account's history revision. A cursor from an older revision gets
  409 `resync`, and the page discards what it holds and restarts. It never subtracts stale
  totals.
- **Errors:** `cursor` and the others work as in status, with 503 when `history` is false.

## Lifetime donations, pile and decay

### Lifetime figures

- `tally` and `board` add active receipt credit to the legacy figures, from separate
  projection tables. Legacy rows are never overwritten.
- A reversal entry corrects both lifetime figures and the pile. Ordinary spending never
  changes lifetime figures.

### Decay

Decay is removed from the new design entirely, whether or not issuance is on. There is no
decay path, no `PILE_EAT_PER_HOUR`, and no fallback legacy-decay branch. `PILE_START` is no
longer read either: no configured starting level is ever adopted. The Worker deployed today
stays unchanged until it is replaced. In code: [`worker/pile.mjs`](../worker/pile.mjs),
tested in `tests/pile.test.mjs`.

### Cutover anchor

The new Worker's pile needs one explicit, audited anchor. It is a compare-and-swap of the
stored checkpoint, that is its `milli` and `at`, against the expected values. It carries the
operator's reconciled level, the preserved evidence and a reason.

- **The saved checkpoint and everything already consumed stay as they are.**
  - Nothing is reset or rebuilt from donations.
  - Prior consumption is never revived.
  - Decay that elapsed after the saved `at` was never written down. Code never guesses
    it; the operator's reconciliation decides it.
- **No checkpoint at all.** When the old code never saved a pile, the expected checkpoint is
  `null`, and the pile is still pending until the anchor. No row is invented.
- **Credit while blocked.** Until the anchor exists, the stored checkpoint is left
  untouched. Every credit and reversal goes into a durable pile-delta ledger, and is
  applied on top of the anchor.
  - **Keyed for good:** each delta has a sequence and a permanent source key, such as
    `donation:<invoice id>`. It never depends on the finished marks the retention purge
    removes, so an old donation can't add twice.
  - **The boundary:** the anchor names a delta sequence, which must already exist (0 for
    none). Its reviewed level already includes every delta up to and including it, and
    every later delta is added on top. A queued credit is therefore counted exactly once,
    whichever side of the cutover it falls on.
  - **Idempotent:** applying the same anchor again is a harmless duplicate. Any different
    anchor once one exists is refused, as is one whose expected checkpoint no longer
    matches, or whose boundary isn't a delta that exists. A gap in the sequence doesn't
    count as one.
  - **Efficient:** each delta stores the running total up to it, checked when it is written,
    so the pile is read from two rows however long the history.
  - **Already in the checkpoint:** donations the old code had added are fenced from the
    finished marks retained when the new code first starts, so they never add again after
    the marks are purged. A donation the old code wrote to D1 but never finished carries no
    provenance, so it is unproven: it is held, with a manual import and any other unproven
    row, pending a reviewed reconciliation, and no credit is restored implicitly. Only a
    write whose durable provenance token matches the new code's own settlement finishes
    automatically.
  - **Unproven D1 rows:** a settlement credits an existing D1 row only when the row carries
    the provenance token the settlement saved before its insert (migration 0009). Any other
    existing row is refused and recorded as an exception for review: an older row, a manual
    import, or a pre-cutover write left unfinished by a crash. Timestamps are never proof.
    Nothing is credited, D1 and the lifetime figures stay unchanged, no donation event is
    sent, and pages get the pile's review state at once. Retrying records nothing new.
  - **The archive:** before its pending request is removed, in the same transaction, the
    settlement is archived privately in the object's `quarantined` table, so a payment that
    may belong to someone other than the D1 row's donor isn't lost. It keeps:
    - its handle, message and sats;
    - the signed-in account id and login, when there were any;
    - the method and the frozen price, receipt time and banana count;
    - its provenance token;
    - the D1 row it collided with.

    The request token is kept only as its SHA-256, and no network or owner evidence is
    invented. The archive is never purged, never overwritten by a retry or a racing notice,
    and never published.
  - **A safe false positive:** a pending request the old code left after finishing it (a
    crash between its pile credit and removing the request) also has no token. If it is
    retried, it is quarantined rather than credited, even though its credit is already in
    the checkpoint. That is harmless: nothing is added, and review shows it. It isn't told
    apart by timestamps.
  - **A conflicting delta:** the same delta source again with the same amount is a retry. With
    a different amount it is a conflict: the first amount stands, it is recorded as
    `delta-conflict`, and the pile reports review to every page.
  - **A reused invoice id:** an id the object already knows (credited, in the checkpoint,
    held for review, or still marked finished) is refused before any QR is shown. An id only
    D1 remembers is caught at payment by the provenance check.
- **Signed and exact.** Corrections may be negative.
  - An anchor whose level would be negative or unrepresentable is refused.
  - After the anchor, such a level is published as `bananas: null` with
    `reconciliation: "review"`, never clamped and never shown as healthy.
  - A running total that leaves the safe range blocks the pile in the same way, and is
    recorded as an exception.
- **Lifetime figures are separate.** Donations while pending still count in the tally and
  board at once. Only the current pile waits for the anchor.
- **The pending pile, published until then:**

  ```json
  { "type": "pile", "bananas": null, "at": null, "eatPerHour": 0, "revision": 3,
    "basis": "credits", "cutover": "pending", "reconciliation": "review", "uncertain": null }
  ```

  The stored checkpoint is never published as a current, reconciled balance.
- **The anchored pile:**

  ```json
  { "type": "pile", "bananas": 980.5, "at": 1790000000000, "eatPerHour": 0, "revision": 7,
    "basis": "credits", "cutover": "done", "reconciliation": "current",
    "uncertain": { "sats": 0, "bananas": 0 } }
  ```

  While no receipt-mode mapping exists, the anchored pile reports `"reconciliation": "off"`,
  with `uncertain` at zero: only legacy credits feed it, exactly as before.

  - **`basis: "credits"`** means the anchor, plus credits, minus reversals. It is not a
    verified wallet balance.
  - **`uncertain`** counts `review` receipts that still hold credit, in sats and bananas. Their
    credit stays in the level until a reversal takes it out.
- **Receipts into the pile.** Each receipt ledger entry, a credit or a reversal, becomes one
  pile delta:
  - **Keyed for good:** by `receipt:<receipt id>:<transition>`, the entry's permanent identity.
    It counts once, on whichever side of the anchor's boundary it falls, like
    `donation:<invoice id>`.
  - **Ordered and atomic:** the object moves entries from the receipt journal in ledger order,
    from a durable mark. Each delta and the mark's move are one transaction, so a stop at any
    point repeats or skips nothing.
  - **When it runs:** whenever receipt frames are pushed, on every alarm, and at every start.
    So a page that reconnects after a crash is sent a pile that already holds every committed
    entry.
  - **Pages that stay connected across a stop:** the pile revision last sent to pages is kept
    durably.
    - **On start:** if pages are connected and the pile has a newer revision, the alarm is set
      at once.
    - **The alarm:** it sends that revision through the normal path, so no new payment is
      needed to heal a stale page.
    - **Marked sent only after the attempt:** the mark moves only after `ws.send` was tried
      for every open page and none of them failed. That proves the pile was handed to each
      socket (an enqueue), not that any page received it. Nothing here hears back from a page.
      - **Pages going away:** a page closing or closed is skipped, and one that closes during
        the send fails in the ordinary way. Neither blocks the mark.
      - **Any other failure:** when an open page fails to take it, the mark stays where it was
        and the failure is raised. A connected page already keeps an alarm set, so that alarm
        sends it again, in the same instance, with no new payment.
      - **Backstop:** a failed send also brings the alarm forward to one price-check cadence
        away, never sooner.
      - **A failing alarm:** an alarm whose own work fails still sets the next one.
    - **At least once:** a page may hear a revision twice, and deduplicates by revision.
    - **No loop:** once sent, nothing more is scheduled for it.
  - **Bounded:** each step moves at most the saved replay bound of entries. The alarm finishes
    a longer backlog.
  - **Never both ways:** an entry for an invoice the pile knows as a legacy donation (finished,
    in the checkpoint, credited or held) is not added. It is held as `legacy-and-receipt`.
  - **Never rounded:** an entry whose amount or time can't be represented exactly is held as
    `unrepresentable-entry`.
  - **Entries from before the bridge existed:** the first run notes how far the receipt
    journal already went.
    - If no anchor existed then, those entries are added like any queued credit. The operator
      reviews them with the anchor's boundary.
    - If an anchor already existed, nobody can say whether its reviewed level included them, so
      each is held as `receipt-before-bridge`, never added or guessed.
  - **A held receipt stays held as a whole:** once any entry of a receipt is held, every later
    entry of the same receipt is held as `receipt-lineage-held`.
    - **Why:** a reversal would otherwise take away a credit the pile never took. A
      reconfirmation would add it without settling whether the anchor already had it.
    - **Other receipts:** they go on as usual.
  - **Held entries:** every held entry is a pile exception, so the pile reports `review`.
    Resolving one is the same open operator step as for the legacy exceptions.
  - **No anchor over a waiting journal:** in a store with receipt entries, the anchor is
    refused (`bridge`) while any entry hasn't reached the pile's deltas. This covers a journal
    the bridge has never started on.
    - **Why:** only then can the boundary name exactly what the reviewed level includes.
      Nothing is assumed about entries that haven't arrived.
    - **Unchanged:** an existing anchor's replies, duplicate or `anchored`, and stores without
      receipt entries.
  - **Lifetime figures are separate:** the D1 lifetime figures are projected separately (see
    [D1 projection](#d1-projection)) and never read the pile. No spending exists, and none is
    fabricated.
- **The anchored pile once receipt-mode mappings exist.** `reconciliation` is the receipt side's
  own health, never better than the bridge:
  - **`behind`:** while bridge entries wait, or while any read, price or projection lags. With
    no provider ingestion, no read is ever verified complete, so a real deployment never gets
    past `behind`.
  - **`review`:** while any receipt or projection review, or any pile exception, exists.
  - **`current`:** only when every read is verified complete and fresh, D1 holds every revision,
    and the bridge is done.

  The pile's `revision` also moves when only this health or the uncertain amount changes, so
  pages that deduplicate by revision see it. Coverage stays invoice-only.
- **What working this out costs.** Each pile message reads the receipt side's health and the
  uncertain amount.
  - **Bounded:** rows returned by each existence probe, and extra memory retained by
    `reviewCredit`. The number of rows handed to `reviewCredit` isn't bounded: it still iterates
    every review receipt while the sums are safe.
    - Every existence check on that path asks for at most one row (`LIMIT 1`), however many
      records match. That covers mappings, pending projection work, projection conflicts, the
      health checks and pile exceptions.
    - The uncertain amount is read from the cursor row by row, never collected into an array
      first. It stops at the first sum that can't be represented exactly, and is otherwise
      added exactly as before.
  - **Not bounded:** the rows SQLite examines, and the CPU.
    - A check that finds nothing still scans its whole table where no index narrows it:
      unresolved reviews, unresolved projection conflicts, and receipts waiting for a price.
    - When every invoice is healthy, the lagging-invoice check reads every invoice, with its
      latest read looked up for each.
    - Open holds and review receipts are read through partial indexes holding only those rows.
      The uncertain amount still reads every review receipt when the sums are safe.

    These costs grow with history.
  - **What's measured:** rows returned and the cursor's use come from the test stand-ins, and
    the scans from SQLite's query plans. Neither is evidence of what the Durable Object runtime
    reads or bills, and neither says anything about the object's start-up work.
- **`behind` on the pile:** an anchored pile may report `"reconciliation": "behind"`, the same
  value the status message already uses for receipt accounting. Pages show the level as not
  yet reconciled. The shared fixture's `pile` section shows what an open page hears through
  credit, review, reversal, reconfirmation and a restart.
  - **`revision`** always increases.
  - **`eatPerHour`** stays at 0 so legacy pages stop extrapolating.
- **Rollout blockers:**
  - The OBL page that handles `bananas: null` must be live before this Worker is deployed.
  - How the operator applies the anchor is undecided. The only constraint so far is that it
    adds no new public endpoint and nothing the relay can reach. `applyPileAnchor` works on
    the object's storage, and nothing in the Worker or the object routes to it.
  - The reviewed level is the operator's. Code picks no starting inventory, treasury
    boundary or spend valuation, and never infers decay that elapsed under the old code.

## Provider normalization (relay line v1, two maintainers)

### Handshake and fences

- The object sends `hello { accounting: 1 }`. A v1 relay answers
  `hello { accounting: 1, generation }`, where `generation` is random for each process.
- The object records a new line id each time it accepts a line.
- **Sequence first:** the object assigns each invoice's next durable `sequence` before any
  provider read, and sends `reconcile { invoice, sequence }`.
- **One read at a time per invoice:** the next read waits for an ack or a timeout.
- **What applies:** a reply applies only if it came on the current line, with the current
  generation and that outstanding sequence.
- **Restart reset:** a new line or a new generation abandons every outstanding sequence and
  reissues fresh ones. A newly randomized generation never permits applying a stale reply
  that was in flight.
- **Relay replays:** the relay replays no snapshots across a restart. It answers only
  current requests.

### Triggers

- **Webhooks:** a v1 relay turns each BTCPay webhook for its own invoices into
  `prompt { invoice }`, which carries no data. The object answers with a new `reconcile`.
- **Sweep:** the object also sweeps every retained receipt-mode mapping for life, paced by
  configuration.
- **No dependence on legacy paths:** recovery never relies on `paid` or `seen`, or on the
  relay's 24-hour and 7-day lists.

### Snapshots

- **Frames:** `begin`, then indexed `payment` frames, then `end { count }`. The object acks
  `applied`, `stale`, `incomplete` or `rejected`.
- **A full count proves only that the relay sent everything it read.** It doesn't prove the
  provider's data was complete.
- **Absence:** a missing record may be inferred only when the read used has *verified*
  complete-snapshot capability, meaning it is atomic and includes hidden or unaccounted
  records. Then the record goes to `review`. Otherwise:
  - absence changes nothing;
  - the invoice counts as `behind`;
  - partial, failed, paginated-but-not-atomic and default-accounted-only data never removes
    or downgrades a record.

### Evidence recorded privately per payment

- block identity: hash and height, where exposed;
- confirmations, and the version of the confirmation policy in force;
- provider state: `observed`, `settled`, `unaccounted` or `invalid`;
- provenance: webhook prompt, sweep or restart, plus the read attempt and observation time;
- the complete-snapshot capability of that read;
- whether the observation was applied: one that would change an immutable field is recorded
  and held, never applied.

Each read declares its capabilities as inputs: `complete`, `outpoints`, `lightningSuccess`,
`remaining` (a verified fee-aware remaining amount) and `destination` (a verified current
payment destination). None is assumed. A remaining amount or destination without its
capability is withdrawn. Health is `current` only while every invoice's latest read applied,
was complete and is within the freshness bound.

### Mapping provider states

| Provider | Receipt |
|---|---|
| `observed` | `confirming` |
| `settled` | `credited` |
| `unaccounted` | `review` |
| `invalid` | `invalid` before credit; `review`, then an auditable reversal, after |
| `settled` back to `observed` | `review`, keeping credit |

### Identity

- **On-chain:** a canonical `(network, txid, vout)` row, unique whichever invoice claims it.
  Provider and store evidence are aliases, kept in a separate table that points at it. A
  second invoice claiming the outpoint, a destination not bound to the invoice, or a changed
  amount goes to `review`.
- **Lightning:** needs a stable identity for a successful payment, such as the payment hash
  once verified, with provider ids as aliases. A provider id alone is not assumed to prove
  that. If the provider can't tell a complete successful payment from multipart fragments or
  duplicates, Lightning receipts go to `review` and are not credited.

## Proposed storage and crash boundaries (not implemented)

### Durable Object storage

The object's SQLite storage is the authority. `transactionSync` is atomic only within that
storage.

1. **Observation:** one transaction saves the receipt row, its evidence, and a pricing intent
   holding the stored last-price candidate, before any async lookup.
2. **Lookup:** freezes the price, if the intent is still open.
3. **After a crash during the lookup:** no new market sample is taken for that receipt. The
   stored candidate is frozen, marked stale, or the price is `null` if there was none.
4. **Transition:** one transaction writes the receipt state, the ledger entry (unique per
   receipt and transition), the revisions, the feed `seq`, the pile delta and the outbox rows.
   The relay is acked only after it commits.

### D1

D1 is a separate database, with no transaction shared with the object.

- **Projection:** each outbox item is applied in one D1 `batch`. The aggregate change is
  conditioned on a `(receipt, revision)` marker not existing yet, and the batch inserts that
  marker.
- **Outbox rows** are deleted only after the batch succeeds.
- **Lag** shows as `behind`.

### D1 projection

Built in [`worker/projection.mjs`](../worker/projection.mjs) and migration
`0010_receipt_projection.sql`, and tested in `tests/projection.test.mjs`.

- **What it applies:** one committed receipt revision per outbox row, in commit order:
  - receipt, invoice, revision, state and sats;
  - the credited sats, and the frozen banana thousandths;
  - the attribution handle, and the first-observation time;
  - the invoice's saved stable account id, or none.

  The account id goes only into D1's private account totals, never into a public table or
  frame. No address, provider id or outpoint is copied.
- **One atomic batch per revision.** The batch holds:
  - an idempotency marker `(receipt, revision)`, with the SHA-256 of exactly what is applied;
  - the receipt's newest projection, and its invoice's receipt-mode fence;
  - the change to the tally, the hourly figures, the handle totals and the account totals;
  - the tally's `last`, chosen again from what the batch leaves.

  The outbox row is removed only after the batch succeeds. A crash between the two finds the
  marker on the next drain, with the same hash, and removes the row without counting again.
- **Changes against what was applied last.** Each revision's change is worked out against the
  receipt's last applied revision:
  - a credit adds once, a reversal takes it back once, and a reconfirmation adds it again, at
    the same frozen price;
  - a revision that changes no credit changes no figure;
  - an older revision arriving after a newer one is marked, and never applied over it.
- **Counting:**
  - **Donations:** in receipt mode each credited receipt is one donation, while its credit
    stands, so partial and repeat payments to one invoice are distinct donations. This applies
    to `tally.count`, `handle_totals.donations` and the account totals. A legacy donation keeps
    its historical meaning: one invoice, one donation.
  - **Amounts:** sats and bananas follow each receipt's credit. The hour is the receipt's first
    observation. An unpriced receipt adds its sats and no bananas.
  - **`last`:** the sats of the newest valid donation, legacy or receipt. Legacy donations are
    ordered by when they were recorded, and receipts by when they were first observed. Neither
    a correction's time nor processing order can move it, and a reversed receipt is never it.
    Receipts first observed in the same millisecond are ordered by the feed sequence of their
    first observation. It is saved with the receipt's first projected row and never changed, so
    a reversal, a reconfirmation, or a newer revision reaching D1 first can't reorder them. At
    the same millisecond a receipt is newer than a legacy donation, and legacy donations keep
    their recorded order.
  - **Legacy inserts use the same rule.** Migration 0010 replaces the legacy insert trigger from
    0003. Its count, sats, bananas and hourly figures are unchanged. Its `last` is now chosen
    by the same query as the projection's, instead of taking the inserted donation's sats.
    - A late legacy donation with an older `at`, whether older than a receipt or another legacy
      donation, still counts, but never becomes `last`.
    - An ordinary legacy settlement is recorded now, so it stays the newest.
    - That trigger is the only one that writes the tally, so the result never depends on the
      order SQLite runs triggers in.
    - Existing figures aren't recomputed.
  - **Rankings:** named handles rank, combining across accounts as legacy handles do. An unnamed
    credit tallies but ranks nowhere.
- **Account totals:** `receipt_account_totals` holds each signed-in account's receipt-mode
  contributions, by the stable id saved at issuance, never by handle. A renamed handle stays
  one account, and one handle shared by two accounts stays two. It is private, and no page is
  sent it. The legacy `totals` table has been history since migration 0007, which dropped its
  trigger, and nothing reads it; it is left as it is.
- **Never through legacy donations.** Receipt credit never passes through the legacy insert
  triggers, and legacy rows, prices and markers are never changed. D1 triggers refuse an
  invoice id that is both legacy and receipt-mode, from either side, so invoice-level and
  receipt-level ingestion can't both credit one payment.
- **Exact or held.** Every total a batch moves is checked inside that batch, against the value
  it leaves:
  - **Which totals:** the tally's count, sats and bananas, the hour's sats and bananas, and the
    handle's and the account's sats, bananas and donations.
  - **What passes:** each must be an exact integer from 0 to 2^53 − 1. SQLite turns an
    overflowing sum into a non-integer, and that fails too.
  - **What fails:** the whole batch rolls back (marker, projection and every total), and the work
    is kept and held as `unsafe-total`.

  Legacy deliveries move the same totals and can land while a drain waits on D1, so a value
  read before the batch is never trusted. A legacy amount that landed in between is never
  overwritten, because every change is relative. Nothing is ever published rounded or negative.
- **Conflicts stop it, in order.** A marker whose hash differs, a batch the legacy fence
  refuses, or an unsafe total is recorded for review in the object. Draining stops, and the
  conflict is never drained again or given an alarm until resolved. It is never acknowledged
  silently. Health is `review` while a conflict waits. Resolving one is an operator step not
  built yet, and an [activation gate](#activation-gates).
  - **Recognising a conflict:** a refused batch is a conflict only when its error says so, using
    the fence's or guard's own message or a total's CHECK. The error's message is checked, and
    so are the errors it wraps (`cause`, a few levels deep), since a platform may wrap the
    database's error.
  - **Anything else** is a failure, retried on the cadence.
- **Publication is durable.** When a batch may have moved a figure, a note that pages need
  D1's current figures is recorded in the same step that removes the outbox row. A batch found
  applied on retry also sets it, since its effect isn't known there. The note is cleared only
  after the tally and board were read fresh from D1 and sent. A failed read keeps the note, and
  a cached figure is never taken for success. A restart finds the note and publishes to the
  sockets still open. Publishing credits nothing, so a retry only sends the same authoritative
  figures again.
- **Bounded, serialized, and never a tight loop.**
  - A drain applies at most the saved replay bound of rows; a full one continues at once.
  - A drain already running is shared, never overlapped.
  - A D1 failure, or a failed publication, is retried only after the existing five-minute alarm
    cadence (`PRICE_FRESH_MS`). The retry time is saved, so a restart keeps it.
  - Whenever projection work starts, a durable alarm is set one cadence later, so an instance
    that stops mid-way still comes back.
  - With no page open, only projection work schedules the alarm, never an overdue receipt
    deadline.
- **Receipt evidence first.** While pages are open, each alarm first commits and sends what time
  has withdrawn from receipt-mode invoices, synchronously, before anything waits on D1 or the
  network. With no page open nothing is shown, and the next authorized read commits it, as
  before. The projection then runs in the background, so a stalled D1 can't delay withdrawing
  a stale amount-bearing QR.
- **Public order.** Receipt frames go out live when committed. The tally and board are sent
  only after D1 holds the change.
- **Not the pile.** The remaining pile is its own journal and is never touched here, and
  nothing spent from the wallet ever reaches these tables.
- **Stand-in limits.** Tests run D1 through `node:sqlite`, with `batch` as one transaction that a
  trigger's `RAISE(ABORT)` rolls back. Cloudflare documents D1 batches as atomic in the same
  way. The stand-in can't show D1's limits on statements per batch, payload size or duration,
  how it behaves under real concurrency or network failure, or how a Durable Object alarm
  retries. Staging must confirm these on regtest or signet before activation.

### Pages

Broadcasts are at least once, after commit. Pages deduplicate by revision.

**Live receipt and invoiceStatus frames, per page:**

- **Position:** each page has its own position in the feed, kept in its socket's attachment,
  so it survives hibernation and a restart.
  - It starts at the high-water mark its connect captured. Anything at or below that was its
    snapshot or replay, and never arrives as live.
  - It moves to a frame's `seq` only once `ws.send` took that frame for the page without
    failing.
- **What "sent" means here:** an enqueue on the socket, not proof that the page received it.
  Nothing here hears back from a page.
- **In order:** a page is sent frames in feed order, at most the saved replay bound per step.
  A page left behind gets the rest from the alarm, at once.
- **Closing and closed pages:** skipped. A page that closes during its send fails the ordinary
  way. Neither holds back other pages or the mark.
- **A failure on an open page:**
  - the page stops at that frame, so it never gets a later frame first;
  - it is tried again no sooner than one price-check cadence later, never in a tight loop;
  - its retry time is kept with its position, and the alarm comes back for it;
  - healthy pages go on as before.
- **After a stop:** a start finds open pages that are behind, and the alarm sends them what
  they missed, with no new receipt needed.
- **Duplicates:** a frame may reach a page twice, across a failure or a stop, or also in its
  replay. Pages deduplicate by revision, so a first credit animates once.
- **`receipt_broadcast`:** the lowest position of any open page, or the feed's high-water mark
  when none is open.

### Uniqueness is not atomicity

Unique keys stop double application. Consistency across the two stores comes from the
outbox and the idempotent markers, not from uniqueness.

### Required failpoint tests

A restart at each of these points:

- after observation;
- during the lookup;
- after the price freeze;
- after the object's transaction;
- after the D1 batch;
- before the outbox row is deleted;
- after the broadcast;
- a relay restart in the middle of a snapshot;
- an object restart with a read outstanding;
- a duplicate or stale ack.

The stand-ins in `tests/helpers/` can't prove real runtime behavior. Staging must confirm it
on regtest or signet.

## Activation gates

Every gate stays closed until a separate decision clears it. None is authorized here.

1. **Undecided policy:**
   - the edit window: first observation, or the settlement lock;
   - the message policy;
   - account deletion, redaction and recovery after signing in again;
   - confirmation and pending display (issue decisions 4–5).
2. **Unverified live behavior:**
   - the BTCPay and NBXplorer versions;
   - payment id formats, and whether txid and vout are exposed;
   - Lightning success identity;
   - whether hidden or unaccounted payments can be listed, and whether any read is a
     complete snapshot;
   - whether payments are attached after expiry;
   - how reorgs and replacements are reported;
   - real store address uniqueness.
3. **Fences** loaded, and legacy and import fences reviewed.
4. **The pile cutover anchor** reviewed, along with any starting-inventory question it
   raises.
5. **Two maintainers** for the relay line, credentials and deployment, and OBL's agreement
   to the page contract.
6. **Projection conflict resolution:**
   - **Today:** a projection conflict (`marker-mismatch`, `legacy-collision` or `unsafe-total`)
     stops the D1 projection for good. Health stays `review`, and lifetime figures stop moving.
   - **Why it's a gate:** nothing here resolves one, and no administrative endpoint exists or is
     planned in this contract.
   - **To clear it:** a reviewed operator procedure for resolving a held conflict, decided and
     built separately.
7. **The D1 runtime confirmed on staging:**
   - batch atomicity with trigger aborts;
   - the guard's in-batch range check;
   - the error text the conflict classification matches, and where D1 puts it (message or
     `cause`);
   - the replaced legacy insert trigger on real D1;
   - the alarm and background-projection behaviour.

   The stand-ins can't show these.
8. **The rollout order:**
   1. the OBL page;
   2. the migrations, then the fence-aware Worker with `issuance` off;
   3. the anchor;
   4. the fences;
   5. the v1 relay;
   6. staging on regtest or signet;
   7. production, only on separate authorization.

Spend integration stays inactive, with no treasury boundary, spend valuation or starting
inventory chosen. Even after a full sweep of retained invoices, coverage stays
`"invoice"`.

## Open decisions

1. **Edit window:** freeze at the first observed receipt, or at the existing settlement
   lock. Blocks activation.
2. **Message:** carried once per invoice, or on every receipt that qualifies. Not approved,
   and it blocks activation. There is no default: without it, nothing credits.
3. **Account deletion:** deletion, redaction, and recovery after signing in again. Blocks
   activation.
4. **Price after a crash mid-lookup:** freeze the stale stored candidate, as proposed, or
   quarantine the receipt.
5. **Anchor:** how the operator applies it, without a new endpoint.
6. **Legacy invoices:** out of status and history in v1, as proposed.
7. **Signed-out recovery after a reload:** none is proposed.
8. **Settings:** the store-scope identifier and all the new limits, which are deployment
   configuration.

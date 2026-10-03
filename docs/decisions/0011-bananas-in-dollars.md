# 0011. A banana is a dollar's worth of bitcoin

**Status:** accepted, 2026-10-01. Where the price comes from is superseded by
[0013](0013-price-from-2140data.md).

## Decision

One banana is a dollar's worth of bitcoin, at bitcoin's price when the invoice is made. The
Durable Object keeps bitcoin's price from three public sources, Coinbase, Kraken and
mempool.space, and a price counts only when at least two of them agree within 3%. It refreshes
the price when a page connects and, in the background, once it's a minute old. An invoice waits
for a new price only when the one it has is more than five minutes old. The price is locked
into each invoice and shown to the donor with the banana count, exact and rounded. Each
donation records its sats, the price, when the price was fetched, a banana's price in cents,
and the bananas in thousandths. If no price is available at all, the donation still goes
through, with no bananas until someone works them out from its sats.

## Alternatives

- **A fixed rate,** OBL's `SATS_PER_BANANA = 400`.
- **The page's price,** which OBL already reads for its own displays.
- **BTCPay's rates,** read by the relay.
- **Closing donations when no price is fresh.**

## Why

The team chose a dollar rate, so a banana costs about the same whatever bitcoin does; Ooga Mine
already converts this way. The page's price can't be trusted, since a visitor could send any
number. BTCPay's rates would need a wider key for the relay, which should hold nothing beyond
creating and viewing invoices. With two sources having to agree, a single wrong answer can't
move the count. Refreshing when a page connects keeps the price fresh without a donor waiting
for it, since donors open the page before picking an amount. Locking the price into the invoice
means the donor's count is what they were shown, even for an on-chain payment that confirms an
hour later. Closing donations for want of a price would turn money away over a number that only
decides bananas.

## Consequences

- The object depends on three outside price services. With fewer than two answering and
  agreeing, donations use the last price it had and record when that price was fetched, and
  the object logs it and waits a minute before asking again. With no price ever, donations have
  no bananas.
- Any donation can be recounted from its sats under any rule, and each carries a dollar value
  for the books.
- OBL's 1-to-12 `bananasFor()` stays as the pile's drop animation; the counts come from here.
- OBL's `SATS_PER_BANANA` no longer decides real donations.

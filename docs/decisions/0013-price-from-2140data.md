# 0013. Bitcoin's price comes from 2140data's service

**Status:** accepted, 2026-10-02. Supersedes where [0011](0011-bananas-in-dollars.md) gets the
price.

## Decision

The Durable Object gets bitcoin's price from 2140data's price service, which combines a dozen
exchanges' prices into one. For each invoice, while the relay makes it, the object opens the
service's socket, takes the first price it sends and closes it. If the socket doesn't answer
within two seconds, the object asks the service's REST API. If neither answers, the invoice
uses the last price the service gave, and the reply marks the rate stale so the page shows an
alert. The object logs the failure and doesn't ask again for a minute. With no price ever,
donations count no bananas, as before.

## Alternatives

- **The three public sources of 0011,** Coinbase, Kraken and mempool.space, with two having to
  agree.
- **Keeping the socket open,** so the object always holds the latest price.
- **The REST API alone.**
- **The public sources as a further fallback.**

## Why

The service is the team's own, and it already combines the exchanges, so one answer replaces
three and the rule that two must agree.

The socket comes first, as the team asked. The service sends the price the moment the socket
connects, so taking that one message costs about what a REST call does. Keeping the socket open
would cost far more. An outbound socket keeps a Durable Object from hibernating, so the object
would be billed for every second of the day: about 10,800 GB-s a day at 128 MB, most of the
free plan's 13,000. Nor could it be counted on: an outbound socket on its own holds the object
in memory for 15 minutes at most.

Asking for each invoice gives the price at the moment the invoice is made, not one up to five
minutes old. The ask runs while the relay makes the invoice, so a donor waits for it only when
it's slower than the relay.

Using the last price when the service is down keeps donations open, as 0011 decided, and the
stale mark tells the donor their count isn't at the current price. Further fallbacks would be
more code for a rare case. Every donation keeps its sats and its price, so a count made at a
wrong price can be worked out again.

## Consequences

- One outside service decides the count. A wrong price from it changes the bananas, never the
  money, and the donation's sats and price let anyone recount it.
- The invoice reply's `rate` carries `stale`. OBL's page shows an alert when it's true, or when
  `rate` is null.
- When the socket is slow or down, an invoice can wait up to two seconds for it and two for the
  REST API, if the relay is faster. After both fail, nobody waits on the service for a minute.
- The object opens one outbound socket per invoice, shared by invoices asked for at the same
  moment, and no longer asks for a price when a page connects.
- The service sees when invoices are asked for, though not their amounts or who asks.
- The object logs a warning when the REST API had to answer and an error when neither did.
  Seeing them is up to whoever watches the Worker's logs; nothing alerts the team yet.

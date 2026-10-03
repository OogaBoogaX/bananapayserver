# 0013. Bitcoin's price comes from 2140data's service

**Status:** accepted, 2026-10-02. Supersedes where [0011](0011-bananas-in-dollars.md) gets the
price.

## Decision

The Durable Object gets bitcoin's price from 2140data's price service, which combines a dozen
exchanges' prices into one. For each invoice, while the relay makes it, the object asks the
service's REST API. If that doesn't answer within two seconds, the object opens the service's
socket, takes the first price it sends and closes it. If neither answers, the invoice uses the
last price the service gave, and the reply marks the rate stale so the page shows an alert. The
object logs the failure and doesn't ask again for a minute. With no price ever, donations count
no bananas, as before.

## Alternatives

- **The three public sources of 0011,** Coinbase, Kraken and mempool.space, with two having to
  agree.
- **The socket first,** with the REST API as its fallback.
- **Keeping the socket open,** so the object always holds the latest price.
- **The public sources as a further fallback.**

## Why

The service is the team's own, and it already combines the exchanges, so one answer replaces
three and the rule that two must agree.

The object needs one price per invoice, which is what a REST call is for: one request, one
answer, nothing to close. It's as quick as the socket: from a test machine, each answered in
0.25 to 0.3 seconds. The socket stays as the fallback, since it's a separate way into the
service and can answer when the REST API doesn't.

Keeping the socket open would hold the latest price without asking, but it would cost far more.
The sockets the object accepts, from the relay and from pages, use the Hibernation API:
Cloudflare holds them while the object sleeps and wakes it only for a message, and answers the
relay's pings itself. A socket the object opens to another server can't hibernate, so it would
keep the object awake and billed for every second of the day: about 10,800 GB-s a day at 128
MB, most of the free plan's 13,000. Nor could it be counted on: an outbound socket on its own
holds the object in memory for 15 minutes at most.

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
- When the REST API is slow or down, an invoice can wait up to two seconds for it and two for
  the socket, if the relay is faster. After both fail, nobody waits on the service for a
  minute.
- The object makes one request to the service per invoice, shared by invoices asked for at the
  same moment, and no longer asks for a price when a page connects.
- The service sees when invoices are asked for, though not their amounts or who asks.
- The object logs a warning when the socket had to answer and an error when neither did. Seeing
  them is up to whoever watches the Worker's logs; nothing alerts the team yet.

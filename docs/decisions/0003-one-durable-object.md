# 0003. One Durable Object, D1, and pushes to pages

**Status:** accepted, 2026-09-30

## Decision

One Durable Object holds the relay's line, every page's socket, and the pending requests, in
its own storage. D1 keeps the donation records and the feed history. Pages get donations
pushed over their socket rather than polling for them. The object accepts its sockets with the
Hibernation API.

## Alternatives

- **Worker memory**, with no object at all.
- **Polling D1**: pages ask every few seconds whether anything settled.
- **KV** for the shared state.

## Why

The relay's line, the page waiting for its invoice, and every page that should see a donation
have to meet in one place. Worker memory isn't shared across isolates or data centers, so a
request could land where the relay's line isn't. KV is cheap to read everywhere, but its
writes take a minute or more to reach other locations, too slow for a donor watching for their
own payment. Polling D1 would work, but it's slower and uses far more requests: every poll
runs the Worker, even when the answer comes from cache. A push costs about one request per
visit, against 360 per visitor-hour polling every 10 seconds.

A Durable Object is the one place: a single instance that every request reaches, with storage
of its own. With the Hibernation API an idle socket costs no duration. With `accept()`, the
relay's line alone would bill about 10,800 GB-s a day, most of the free plan's 13,000 GB-s.

## Consequences

- If the object is down, donations are closed and pages stop updating. Nothing on the node
  notices.
- Handles and messages wait in the object's storage until the invoice is paid or expires, and
  never reach the node: the relay sees a request id and an amount.
- A page that reconnects sends its last donation id, and the object replays anything newer
  from D1.
- Development fits the free plan. Going live is on the paid one, because past a free limit,
  requests fail until the next day.

# 0027. The relay's line proves itself end to end

**Status:** proposed, 2026-10-20. Not built yet.

## Decision

The relay sends a `heartbeat` on its line every 60 seconds. The object answers it through
`line()`, the same choice of socket an invoice request uses, not on the socket it arrived on.
A relay that hears no answer for 150 seconds closes the line and redials. The object also
closes a relay line that leaves an invoice request unanswered past `INVOICE_TIMEOUT_MS`, so the
relay redials within seconds. Each side logs why it closed a line, with codes and durations
only.

## Alternatives

- **Shorter ping intervals.** Cloudflare's runtime answers the relay's protocol pings without
  waking the object, so pings can succeed while nothing the object sends arrives.
- **A WebSocket auto-response.** Also answered by the runtime, so it has the same blind spot.
- **Answering on the socket the heartbeat came in on.** That always works, and it would miss an
  object still sending invoice requests on a stale socket.
- **Restarting the relay on a schedule, or a monitor that asks for real invoices.** The first
  hides the fault. The second makes invoices at BTCPay for nothing.

## Why

On 2026-10-19 the production line broke in one direction. The relay's pings kept succeeding
and pages were told donations were open, but no invoice request reached the relay. Each one
waited out the Worker's timeout and answered `closed`, which the kiosk shows as the node
resting. Nothing noticed until a donor did, and a relay restart fixed it. A heartbeat answered
by the object tests the path invoice requests take, so a line broken this way heals in about
two and a half minutes without a donor finding it. Closing a line that leaves a request
unanswered covers a donor who gets there first.

## Consequences

- The object wakes once a minute while the relay is connected, and hibernates again after a
  few idle seconds. That's about 1,440 incoming messages a day, billed as about 72 requests,
  plus the time it stays awake after each, inside Workers Paid's included use.
- A donor who meets a broken line still gets `closed` once; the next try works.
- `heartbeat` is a new message each way in `shared/protocol.mjs` and `protocol.md`, which
  needs two maintainers. Deploy the Worker before the relay: an older object drops an unknown
  `heartbeat` unanswered, and a newer relay would then redial every 150 seconds.
- The logs show how often lines break and on which side, which may explain the hourly `1006`
  drops seen since launch.
- Pages may also retry once when they get `closed` while the status says open; that is OBL's
  call.
- Until this is built, a relay restart is the fix: see
  [`production.md`](../production.md#running-it).

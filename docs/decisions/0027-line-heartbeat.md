# 0027. The relay's line proves itself end to end

**Status:** proposed, 2026-10-20; revised 2026-10-23 after review. Not built yet.

## Decision

Either end of the relay's line can send a `heartbeat`, and the other end answers it.

- The relay sends one every 60 seconds. The object answers through `line()`, the same choice
  of socket an invoice request uses, not on the socket the heartbeat arrived on. Only that
  answer counts as the line being alive: pongs, which Cloudflare's runtime sends without the
  object, don't reset this check. A relay that hears no answer for 150 seconds closes the line
  and redials.
- When an invoice request goes unanswered past `INVOICE_TIMEOUT_MS`, the object answers the
  donor `closed` as it does now, then sends the relay a heartbeat. It closes the line only if
  that goes unanswered for 5 seconds, so a relay that is only waiting on a slow BTCPay keeps its
  line. It closes with a code of its own, never 4000: that code tells a relay another one has
  taken its line, and makes it wait a minute before redialing.
- Each side logs why it closed a line, with codes and durations only.

## Alternatives

- **Shorter ping intervals.** Cloudflare's runtime answers the relay's protocol pings without
  waking the object, so pings can succeed while nothing the object sends arrives.
- **A WebSocket auto-response.** Also answered by the runtime, so it has the same blind spot.
- **Answering on the socket the heartbeat came in on.** That always works, and it would miss an
  object still sending invoice requests on a stale socket.
- **Closing the line on the first unanswered invoice request.** A working relay can miss the
  Worker's timeout while BTCPay is slow: its 8-second deadline covers only the Lightning part,
  and creating the invoice can take up to 10 seconds before that. Closing then would drop a
  healthy line, tell every page donations are closed and fail every other waiting donor, and
  repeat with each donation while BTCPay stays slow.
- **Closing after several unanswered requests in a row.** Slower to heal, and still a guess.
- **Restarting the relay on a schedule, or a monitor that asks for real invoices.** The first
  hides the fault. The second makes invoices at BTCPay for nothing.

## Why

On 2026-10-19 the production line broke in one direction. The relay's pings kept succeeding
and pages were told donations were open, but no invoice request reached the relay. Each one
waited out the Worker's timeout and answered `closed`, which the kiosk shows as the node
resting. Nothing noticed until a donor did, and a relay restart fixed it. A heartbeat answered
by the object tests the path invoice requests take, so a line broken this way heals in about
two and a half minutes without a donor finding it. A heartbeat never touches BTCPay, so the
probe after an unanswered request closes only a line that is actually dead, within seconds.

## Consequences

- The object wakes once a minute while the relay is connected, and hibernates again after
  about 10 idle seconds. That's about 1,440 incoming messages a day, billed as about 72
  requests, and roughly 1,800 GB-s awake a day, about 54,000 a month: inside the 400,000 a
  month Workers Paid includes, which every object on the account shares.
- The probe holds a timer for up to 5 seconds after a request times out, so the object can't
  hibernate during it. That only happens when something is already wrong.
- A donor who meets a broken line still gets `closed` once; the next try works.
- `heartbeat` is a new message each way in `shared/protocol.mjs` and `protocol.md`, which
  needs two maintainers. Deploy the Worker before the relay: an older object drops an unknown
  `heartbeat` unanswered, and a newer relay would then redial every 150 seconds.
- The logs show how often lines break and on which side, which may explain the hourly `1006`
  drops seen since launch.
- Separately, the relay's deadline should cover creating the invoice too, so a donor waits at
  most 8 seconds. That is a follow-up, not part of this.
- Pages may also retry once when they get `closed` while the status says open; that is OBL's
  call.
- Until this is built, a relay restart is the fix: see
  [`production.md`](../production.md#running-it).

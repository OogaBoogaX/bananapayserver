# 0017. The board's tally, and a fresh rate while pages are open

**Status:** proposed, 2026-10-08. Adds to [0013](0013-price-from-2140data.md): besides each
invoice, the object asks for bitcoin's price while pages are open.

## Decision

The page socket carries a `tally`, the figures for OBL's donations board: every donation
recorded, all time, the last seven days by UTC hour, and the rate the kiosk quotes. D1 keeps
the figures, updated by a trigger on `donations` like the leaderboard's totals. The object
pushes the tally after each donation and whenever the rate changes, and never twice
unchanged.

While pages are open, the object's alarm wakes it every five minutes. If the last price is
that old, the object asks 2140data's service again, the way an invoice does, and pages hear
if the rate changed. A page that connects gets the tally at once; an older price is asked for
afterwards. When no page is open, the alarm isn't set again, and the object sleeps.

## Alternatives

- **Each page counting what it has seen,** as OBL's board does today.
- **Summing the donations table** for each page and each alarm.
- **Keeping the figures in the object,** rebuilt from D1 whenever it starts.
- **Asking for the price when a page connects,** holding the page until it answers.
- **No refresh:** the rate as of the last invoice, with its age shown.
- **Keeping the service's socket open,** which 0013 rejected.

## Why

The board should read the same in every browser, so its figures come from D1, not from what
one page happened to see. A trigger counts each donation exactly once: it fires only when a
donation is actually recorded, and a repeated notice records nothing. It needs nothing
rebuilt, and reading it costs one row and at most 168 hours. Figures kept in the object would
be lost each time it hibernates, so rebuilding them would be constant.

A page connecting shouldn't wait on another service, so it gets what the object knows at
once, and a newer price follows if there is one.

An alarm, unlike an open socket, lets the object hibernate between checks. It wakes at most
288 times a day, and only while someone has the page open, for a fraction of a second each.
Without a refresh, a visitor who stays could see a rate hours old.

The object keeps the rate it last sent in its storage, so an unchanged tally isn't sent again,
even after the object has slept, and lookups that finish together send it once.

## Consequences

- The object asks the price service at most once every five minutes while pages are open,
  besides each invoice. It shares any lookup already on its way, and keeps 0013's minute
  after a failure.
- The alarm is the object's only one. Anything else that needs an alarm shares it, setting it
  for the earliest job due.
- D1 gains `tally` and `tally_hours`, filled from the donations already recorded when the
  migration runs.
- Whether the price is stale is kept in the object's storage, so a page doesn't see it flip
  back after the object sleeps.
- Hours are UTC hours, so in a time zone half an hour or 45 minutes off UTC, a page's "today"
  can start up to 45 minutes off.
- Hourly sums say no more than the donation events pages already get. Like the pile and the
  leaderboard, the board never sits along a production line.
- The tests fire the alarm themselves, the way the runtime would. The runtime's own alarms and
  hibernation can behave differently, which the tests can't show.

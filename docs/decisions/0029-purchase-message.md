# 0029. A purchase message, never a donation event

**Status:** accepted, 2026-10-23.

## Decision

Anything paid for reaches every page as a socket message of its own,
`{ type: "purchase", id, category, item, quantity, at, login }`, and a signed-in buyer's
purchase in a category with a leaderboard also sends `{ type: "purchaseBoard", category,
entries }`, and any purchase in a category that keeps counts sends `{ type: "purchaseCounts",
category, days, since, items }`, how many of each item sold over the last seven days. A purchase never sends a donation event, and the event's shape,
`{ id, sats, handle, message, at }`, is unchanged.

`login` is the buyer's only where the category announces its buyers, as fireworks do;
otherwise the message names nobody. A category may add fields of its own. Fireworks add
`launchAt`, a moment on the server's clock, `FIREWORK_LEAD_MS`, 3 seconds by default, after the
purchase is recorded, or later while an earlier firework still holds its slot; and `slot`, one
of six regions of sky, three neighbouring ones for a show: the one its buyer chose, or else the
next round the sky. The holds and the round are kept in the object's memory. Purchase messages are neither kept nor replayed.

## Alternatives

- **The donation event, with the item in its handle or message.** Every scene's `onDonation`
  would play it as a gift, with bananas, and the text fields would carry something they were
  never meant to.
- **A `kind` key on the donation event,** or a purchase field on the `donation` envelope. Both
  repositories forbid changing the event's shape, and older pages would still play the
  envelope as a donation.
- **A message per category,** as first drafted with `firework` and `fireworkBoard`. Each new
  thing sold would have needed new message types on both sides.
- **Messages to the buyer's page alone.** Pages' sockets carry no identity, so the object can't
  tell which is the buyer's; every page hears, and the buyer's knows its own invoice id.
- **Each page launching a firework on receipt, after a fixed delay.** Pages hear at different
  times, so they wouldn't launch together.
- **Replaying purchases on reconnect,** like donations. A show seen late is worse than none,
  and what a donor owns is a question for `/purchases/mine`, not the socket.

## Why

OBL's donation client drops message types it doesn't know, so new types are safe for older
pages, and the donation path on both sides stays exactly as it is. One type for every category
means OBL's client checks and routes it once, and each experience takes the purchases in its
own category. Announcing a buyer is each category's choice, since a firework is a show and a
costume isn't. For fireworks, one moment stamped by the server is what lines the pages up; a
delay alone can't, and the lead isn't wasted: pages count down through it, and write each
burst in slices before it bursts.

## Consequences

- OBL's `donations.js` gains branches for `purchase`, `purchaseBoard` and `status.catalogue`,
  and its scenes an optional way to take purchases in their own category. The contract test
  here still pins the donation event's five keys.
- `at`, the server's clock as each message goes out, refines a page's estimate of that clock,
  so pages land a firework within tens of milliseconds of each other.
- Firework slots and their holds reset when the object sleeps. By then nothing is in the sky,
  so at worst two fireworks share a slot.
- A page that reconnects has missed the purchases in between.

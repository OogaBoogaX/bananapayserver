# 0028. Purchases are not donations

**Status:** accepted, 2026-10-23.

## Decision

Anything OBL sells is a purchase, kept apart from donations. Fireworks, bought at the hub's
stand, are the first; any OBL experience can sell things the same way.

- **One catalogue,** [`shared/catalogue.mjs`](../../shared/catalogue.mjs), here in
  bananapayserver, lists every category for sale with its items and their prices in sats, who
  may buy, whether every page hears who bought, and whether its buyers are ranked. Each
  category belongs to the experience that sells it and lives in a module of its own;
  fireworks are `shared/firework.mjs`, 10 sats for an Ooga Pop, 69 for a Lightning Bolt, 100
  for a ₿ Mega Blast and 300 for a show.
- **One call for everything sold,** `POST /purchases/buy` with a category and an item,
  and one for what a donor has bought, `POST /purchases/mine`, under a prefix of their own on
  OBL's site, beside `/donations/*` and passed on the same way. The server sets the price
  from the catalogue. Each purchase is one Lightning invoice through the unchanged relay, and
  Lightning only.
- **One record.** On settlement a purchase becomes a row in D1's `purchases`, and what it
  bought a row in `purchase_items`, by category, item, quantity and the sats it cost; never a
  row in `donations`, so no bananas, no pile, no leaderboard and no tally. The tables don't
  list what is for sale, so a new category needs no migration, and they never hold anything
  needed to deliver goods.
- **One message,** `purchase`, to every page; see [0029](0029-purchase-message.md).

`MIN_SATS` and `MESSAGE_MIN_SATS` stay donation limits. Signed-in purchases are kept per GitHub
account, by numeric id and login; anonymous ones keep no identifier, only the coarse `nth` and
`before` the page sends. Who may buy is each category's, and a deployment can change it with
`<CATEGORY>_BUYERS`: for the first month on production only signed-in donors may buy fireworks,
then everyone, by setting `FIREWORK_BUYERS`. Purchase invoices have rate limits of their own,
`PURCHASE_RATE_PER_IP` and `PURCHASE_RATE_GLOBAL`, shared by every category, required for
purchases and set per deployment.

## Alternatives

- **A donation with a marker.** A firework could credit bananas and rank on the leaderboard,
  told apart by a tag. A sale isn't a gift, and the pile, the rankings and the tally would stop
  meaning what was given.
- **Prices from the page, or per deployment.** The page can't be trusted with a price, and
  every page and every stand have to agree on one menu.
- **The catalogue in OBL's Worker,** which would read the page's body and pass the item and
  its price over the binding. An experience could then add things for sale in OBL alone, but
  this server would make invoices at prices it can't check, and the maintainers of the payment
  path would no longer see what is sold through it.
- **A call per experience,** as first drafted for fireworks with `/donations/firework`. Each
  new thing sold would have added a call to both Workers, and tables of its own.
- **A table for fireworks alone,** as first drafted, with the kinds listed in its check. Each
  new thing sold would have needed a table of its own, or a rebuild of this one, since SQLite
  can't change a check or a key in place, and its totals and funnel would have been built
  again each time.
- **A cart table now, with a page call for it.** The tables already allow several items per
  payment; a call that sells several waits until something needs one.
- **Tagging invoices at the relay,** so BTCPay tells purchases apart. That changes the relay
  and its protocol, which needs two maintainers; joining BTCPay's invoice ids to `purchases`
  does the same for the books.
- **A separate repository and Worker for an OBL store.** Every sale needs an invoice, and the
  only way to one is the relay's line into this Worker's one Durable Object
  ([0002](0002-nodes-dial-out.md), [0003](0003-one-durable-object.md)). A store of its own
  would need its own relay and BTCPay key on the node, a second credential and a second line
  from the node's machine, or would call this Worker for every invoice, which would still make
  and settle them. Invoicing, settlement, repeats, rate limits and privacy are the same code
  for a sale as for a donation, and a split would add a contract between two repositories,
  each with its own two-maintainer rules, for one thing sold. Kept here until something sold
  has to be delivered: shipping needs addresses, tax and returns, personal data this server
  doesn't keep. That is where a store or fulfilment repository of its own fits, taking "this
  purchase is paid" from here and holding the addresses, never a payment credential, and
  when whether sales get their own BTCPay store is settled too. OBL's merch showrooms today
  only link to each brand's own store; selling those goods would make OBL a reseller, a
  change of business, not of code.
- **On-chain purchases.** A few hundred sats on-chain costs more in fees than it pays, and
  confirmations would leave no moment for every page to launch a firework together.
- **A prepaid tip jar.** One payment for several launches, but it makes this server a ledger
  of balances. Held back until the funnel shows a need.

## Why

A firework, or a costume, is the sale of a virtual good. Keeping sales out of the donation path
keeps the pile, the rankings and the tally honest, keeps the books able to tell sales from
gifts, and leaves the donation code, and OBL's donation contract, untouched. The relay sees a
request id and an amount, as it always has, so the boundary around the node doesn't move.
Prices the server owns are one menu for everyone, and a page can't buy a Mega for a Pop's
price. One call, one record and one message for everything sold mean the payment path is
written, reviewed and tested once, and an experience that sells something new adds what it
sells, not another way to pay.

## Consequences

- Selling something new takes a module listing its items, a line in the catalogue, both
  reviewed here, and the experience's own handling of `purchase` messages in OBL. No new call,
  table, migration or relay change. What a purchase does on the server once paid, such as a
  firework's launch moment, is per category in the object; most categories need nothing.
- D1 gains `purchases`, `purchase_items`, `purchase_totals` and `purchase_funnel` in migration
  0009, which must be applied before the Worker that sells anything. The object's pending
  requests gain `category`, `item`, `nth` and `before`, and reuse `github_login` for the buyer.
- Changing a price, or the menu, is a code change here, deployed through staging as any other.
- Selling something that has to be delivered is out of this record's reach on purpose: a
  postal address is personal data this server doesn't keep, and needs a decision of its own.
- The relay's own `MIN_SATS` must be at or below the cheapest item, 10 sats for the Pop, and
  its `RATE_PER_MINUTE` must cover `RATE_GLOBAL` and `PURCHASE_RATE_GLOBAL` together. Both are
  relay settings, changed by the two maintainers a deployment change needs.
- Every invoice still goes to one BTCPay store with one `orderId`. Whether sales need a store
  of their own, or a different treatment in the books, is a question for whoever keeps them.
- Purchases are records, like donations: they stay when a buyer deletes their OBL account. The
  privacy docs in both repositories say what is kept for signed-in and anonymous buyers.
- Missing purchase rates close purchases and leave donations open; an unknown buyers setting
  closes only its category.

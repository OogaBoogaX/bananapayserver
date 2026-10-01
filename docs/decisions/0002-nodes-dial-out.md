# 0002. Nodes dial out; nothing opens on a node

**Status:** accepted, 2026-09-30

## Decision

Nothing opens on a node's machine for this server. The relay dials out a WebSocket to the
Worker and keeps it open: invoice requests come down it, and invoices and payment notices go
up it. The Worker can never call the relay. The relay's only listener is for BTCPay's webhook,
on the machine's internal network, with the port never published. This is Lightning Foundry's
delivery rule, "the node listens on nothing", applied to the path that takes money.

## Alternatives

- **A Cloudflare Tunnel to BTCPay.** It opens no port, but it still lets requests in.
- **Donors' browsers going straight to BTCPay's pay button**, OBL's current design. Simple and
  standard, but it makes BTCPay public.
- **A stock of ready-made invoices**, which the node makes ahead of time and the server hands
  out, so nothing ever has to reach the node.

## Why

A tunnel opens no port, but whoever reaches the tunnel's hostname reaches BTCPay, so the node
still has a way in. The pay button puts BTCPay in front of every visitor, with its address in
every page. The stock comes closest, since it keeps the node closed, but it breaks the
donation: amounts are fixed in advance, invoices expire and need replacing, and bots can drain
it. A line the relay dials keeps the node closed and still makes each invoice on demand, for
the amount the donor picked.

## Consequences

- If the relay isn't connected, or doesn't answer in time, donations are closed, and the page
  says so.
- The relay redials whenever the line drops, and keeps each payment notice until the object
  acknowledges it.
- The page only ever gets the BOLT11 invoice and, if the donor switches, an on-chain address.
  It never gets a BTCPay link, and nothing here logs or returns a node's address.
- OBL's `createRequest`, which builds a link straight to BTCPay, gives way to the Worker's
  invoice request.

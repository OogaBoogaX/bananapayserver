# 0022. Edit donation details on the same invoice

**Status:** accepted, 2026-10-17; supersedes the invoice-replacement requirement in 0021.

## Decision

The request capability may update the donation's display handle and message until settlement
starts. It keeps the same invoice, payment code/address, sats, expiry, rate and account identity.

## Alternatives

Replace the invoice after editing, which changes the code a donor may already be paying.

## Why

Donors should be able to correct attribution after creating an invoice without invalidating
the payment instructions they have already copied or scanned.

## Consequences

The existing note endpoint accepts an optional handle as well as a message. Settlement freezes
the pending details synchronously before awaiting D1, so a concurrent edit cannot report a
save that the recorded donation will ignore. The freeze is durable across restarts and failed
D1 writes; the relay retries settlement as before. Already recorded donations are never edited.

# 0023. Live estimates and receipt-time pricing

**Status:** accepted, 2026-10-17; supersedes invoice-time locking in 0011, 0013 and 0022.

## Decision

Kiosks follow `wss://2140data.io/` for live estimates. Their sats amount and QR remain fixed.
The backend takes its own short socket sample when Lightning settles or an on-chain invoice
is first fully funded, including any required fee. It closes that socket immediately. REST
is the receipt lookup's fallback; the existing jump guard, stale last-price fallback and
unpriced-donation behavior remain. Invoice estimates still use REST first in parallel with
invoice creation, so the QR path is unchanged.

Full on-chain detection freezes the price, but only settlement credits the pile and rankings.
Partial payments keep floating. If no detection notice arrives, settlement takes the sample.
These times mean first detection by this backend, not a historical exchange tick at a block or
node timestamp the current relay protocol does not carry.

## Alternatives

Keep invoice locking, or keep an outbound price socket permanently open in the Durable Object.

## Why

The donor sees an estimate that follows the market; each paid donation keeps the value it had
when received. Confirmation delay does not change it. A short independent server lookup
keeps client prices untrusted and preserves the object's ability to hibernate.

## Consequences

The object stores the snapshot before D1, shares concurrent receipt lookups, and reuses it on
retry or restart. A failed feed freezes an explicitly stale last price, or a null price if
none exists; it never silently reprices later. Receipt time and price observation time are
recorded separately. A crash before any price is stored requires another lookup on recovery;
the persisted first detection time remains, and the later price observation time records the
gap honestly. Existing recorded donations are unchanged.

Apply D1 migration 0006 before deploying the backend. The `pricing: "receipt"` invoice marker
lets the updated site retain legacy invoice amounts until that backend is deployed. Deploy
the compatible site first, then the migrated backend; do not use old clients for receipt-priced
invoices because they cannot display floating estimates. No relay update is required.

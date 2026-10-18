# 0021. Editable donation handles and rankings by entered name

**Status:** accepted, 2026-10-17; supersedes the display-name and leaderboard policy in 0010.

The requirement to replace an invoice for handle changes is superseded by
[0022](0022-edit-details-in-place.md).

## Decision

Every donor may choose a display handle, signed in or not. OBL defaults it to the GitHub login
when signed in, otherwise `anon`. Matching entered handles combine case-insensitively on
both leaderboards. Each donation retains its own recorded sats and bananas; invoice-time
pricing is superseded by [0023](0023-receipt-time-pricing.md).
Messages run to 280 sanitized characters; handles remain limited to 39.

## Alternatives

Keep account-based rankings and restrict names to authenticated logins, or change display
names while keeping rankings tied to accounts. The maintainer chose totals by entered name.

## Why

The donation name is the donor's chosen attribution. It need not be their account login,
and signed-out donors should be able to accumulate totals under the same name.

## Consequences

Display names are unverified and may be shared. Changing names starts a separate total;
account ownership and sign-in still rely exclusively on the authenticated binding argument.
The relay sees neither handle nor message. Handle changes keep the same invoice under
[0022](0022-edit-details-in-place.md). Migration 0005 backfills the public name totals from
existing donation records, preserving all amounts; legacy unnamed donations stay outside the
rankings. The old account totals remain stored. Migration 0007 stops their old update trigger:
typed display names must never replace authenticated account logins in that historical table.

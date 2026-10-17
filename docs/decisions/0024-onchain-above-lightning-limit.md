# 0024. On-chain donations above the Lightning threshold

**Status:** superseded for amount policy and rollout by [0025](0025-no-onchain-donation-cap.md), 2026-10-17.

## Decision

Keep `MAX_SATS` as the overall donation cap and add an optional `LIGHTNING_MAX_SATS` on the
Worker and relay, defaulting to the overall cap for compatibility. Amounts above the Lightning
threshold remain valid on-chain up to the overall cap. Neither deployed limit changes here.

The Worker's page status advertises the configured minimum, overall maximum and Lightning
maximum. Both kiosks warn before Continue and disable Lightning on confirmation. The relay
accepts an optional `onchainOnly: true` on invoice requests and returns `bolt11: null` for
these invoices. It independently enforces its own caps, creates only the on-chain method and
does not activate Lightning. Addresses remain lazy until requested. The browser cannot send
payment-policy overrides through the page API.

## Alternatives

Reject every amount above the Lightning threshold, or remove the overall donation cap.

## Why

A Lightning policy threshold should not close the on-chain payment path. Separate configured
limits preserve the existing overall safety bound and keep deployment values out of code.

## Consequences

The relay protocol changes, requiring the relay upgrade and two-maintainer review. Upgrade
the compatible site and Worker with legacy limits first, then the relay, then configure the
intended thresholds on both sides. Keep Worker limits no higher than the relay's matching
limits for an accurate warning before Continue. Unknown or malformed limits fail closed;
omitting only the new threshold preserves the existing configured overall cap for both.
No credentials, node listeners, settlement accounting, or database migrations change here.

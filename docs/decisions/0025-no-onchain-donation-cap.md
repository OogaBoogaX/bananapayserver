# 0025. No application cap on on-chain donations

**Status:** accepted, 2026-10-17. Supersedes the amount policy and rollout in 0024.

## Decision

On-chain donations have no application maximum. The Worker and relay still validate positive
whole sats within Bitcoin's supply bound and the configured minimum. `LIGHTNING_MAX_SATS`
applies only to Lightning. Existing `MAX_SATS` is a fallback alias for that threshold, not an
on-chain cap. The socket's `maxSats` describes the fixed Bitcoin amount bound.

## Why

The maintainer requested on-chain donations without a donation cap. Lightning liquidity
policy should not prevent a valid on-chain payment. This replaces the earlier configurable
overall cap; it does not remove request rate limits, fee checks or amount validation.

## Consequences

Upgrade the compatible site first, stop the relay, apply the D1 migrations and deploy the
Worker, then upgrade and restart the matching relay with its state preserved. Follow the
ordered rollout in [configuration.md](../configuration.md); neither mixed-version pairing is
safe, including a new relay's Lightning-failure fallback against an old Worker. Old relays
still apply their old cap and reject `onchainOnly` requests. After both are upgraded, existing
`MAX_SATS` settings retain the Lightning threshold but no longer cap on-chain donations.
Prefer explicit `LIGHTNING_MAX_SATS` for new configuration. This changes payment policy and
requires two-maintainer review including the code owner. No deployment, credential, listener
or database migration changes accompany this decision.

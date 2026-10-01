# 0005. The relay connects over Tor, on trial

**Status:** accepted, 2026-09-30, as a one-week trial

## Decision

The relay dials the Worker over Tor, through the machine's Tor SOCKS proxy. For a week,
measure how often the line drops and how long invoices take. If either hurts, the relay alone
falls back to a no-log VPN.

## Alternatives

- **The plain internet.**
- **A no-log VPN.**
- **A rented server as a hop**, which the relay connects through.

## Why

Each alternative moves the knowledge of the machine's address to someone else: Cloudflare and
every network on the way, the VPN provider, or the hop's hosting provider. Over Tor,
Cloudflare sees only a Tor exit, and no one on the way sees both ends. The price is latency
and dropped connections, which a donor feels as a slow QR or as donations closed. The trial
measures both.

## Consequences

- The relay's line arrives at Cloudflare over Tor, which IP Access Rules show as country `T1`.
  The zone keeps Bot Fight Mode off, turns off Browser Integrity Check and Under Attack mode
  for the relay's path, and has no account-wide Tor rule.
- The relay redials whenever the line drops; while it's down, donations are closed.
- If the trial fails, a new record moves the relay alone to a no-log VPN and supersedes this
  one.

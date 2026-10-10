# 0019. Production's relay dials the Worker's workers.dev address

**Status:** accepted, 2026-10-09.

## Decision

Both Workers live in the Cloudflare account that serves OBL's Workers, since a service binding
works only within one account ([0014](0014-pages-through-obl.md)). The production relay dials
`bananapayserver-production`'s own `workers.dev` address, as staging's relay dials staging's,
so `wrangler.production.jsonc` sets `workers_dev` to `true`. That address takes only the
relay's line: pages never call it, and OBL's Worker reaches this one over the binding. The
account's `workers.dev` subdomain stays out of the repository; the relay's `.env` holds the
full address.

## Alternatives

- **A name on `oogabooga.land`,** such as `api.oogabooga.land`.

## Why

A name on `oogabooga.land` would need that domain's DNS moved to Cloudflare, then Bot Fight
Mode off for the whole zone, since it can't exempt one path and would challenge the relay's Tor
connections. It would also need a rule turning off Browser Integrity Check for that name, and
no rule blocking Tor. Those settings would weaken protections for OBL's whole site to serve one
connection. The `workers.dev` address needs none of it, and staging has shown the relay reaches
it over Tor and reconnects by itself after each deploy.

## Consequences

- The production relay's `WORKER_URL` is
  `wss://bananapayserver-production.<account subdomain>.workers.dev/relay`.
- The address names the account's subdomain. It isn't a secret, but like the account id it
  stays out of the repository.
- If the account's subdomain ever changes, the relay's address changes with it.
- Moving to a name on `oogabooga.land` later is a new decision, with the zone settings above.

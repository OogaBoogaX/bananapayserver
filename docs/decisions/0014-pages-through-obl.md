# 0014. Pages reach donations through OBL's Worker

**Status:** proposed, 2026-10-03. Once accepted, it supersedes where
[0010](0010-handles-from-github.md) runs sign-in; handles still come from GitHub.

## Decision

Pages never call this Worker directly. OBL's own Worker serves the page and signs visitors in
with GitHub. It passes the page's donation calls on over a service binding to a named
entrypoint, `PageApi`, which only a binding can reach. Beside each call it passes the donor's
GitHub id and username, or nobody, and the address the call came from. This Worker's public
address takes only the relay's line, until Foundry's exporters post there too. Its own GitHub
sign-in, the secrets that ran it and the list of allowed origins go. OBL's staging Worker binds
to `bananapayserver-staging` and its production Worker to `bananapayserver-production`.

## Alternatives

- **This Worker's own address and sign-in,** as 0010 had it, with the API on a name such as
  `api.oogabooga.land`.
- **Calls over the binding as plain fetches,** with the donor in a header OBL's Worker sets.
- **RPC calls that take the donor and the address as arguments,** with a fetch only for the
  socket's upgrade.

## Why

OBL now has its own Workers, each with its own GitHub sign-in, and staging is served from
`workers.dev`. That's a public suffix, so a cookie from a separate API address counts as
third-party there, and browsers block it: this Worker's own sign-in could never work on
staging. Two GitHub sign-ins on one site would also confuse donors.

Through OBL's Worker, the page calls only its own origin. There's no cross-origin handling and
no address to build into each environment's page. This Worker holds no GitHub secret or
session key, and the internet reaches only the relay's line. A binding adds no wait for the
donor, since Cloudflare runs the two Workers on the same thread.

RPC arguments beat a header. Who is giving can't come from a header the browser sent and OBL's
Worker forwarded by mistake, because the donor is never read from a header at all.

## Consequences

- **This Worker trusts OBL's Worker to say who is giving.** It checks the shape, a numeric id
  and a GitHub username, but can't check the sign-in itself. Whoever controls OBL's Worker, or
  any other Worker in the same Cloudflare account, can bind the entrypoint or the object and
  put any GitHub user's name on a donation, which reaches the leaderboard.
- **Both Workers live in one Cloudflare account,** as a binding requires. That account's
  admins and OBL's CI, which deploys with an account-wide token, can deploy over this Worker
  too, and a Worker that isn't this one can send donors' payments anywhere. That never reaches
  a node or its funds, and the page that shows the QR is already OBL's to serve, but the
  account's ownership and OBL's deploy workflows matter here as much as there.
- **The object checks the relay's token itself,** as well as the front door. Another Worker in
  the account could bind the object directly, and without that check it could open the relay's
  line and answer invoice requests with its own.
- **OBL's Worker takes on the checks this Worker made for browsers.** It checks the origin,
  runs its Worker first for `/donations/*`, builds each call from the page's body alone, sets
  the visitor's address, and answers "closed" when a call fails. See
  [`protocol.md`](../protocol.md).
- **Donations stay when an OBL account is deleted.** They are the record, and a donor who comes
  back keeps their history. Whether the leaderboard shows an account that is gone is the
  page's choice.
- **Local testing binds by name.** A local Worker runs from `wrangler.staging.jsonc`, so a
  local OBL Worker or this repository's stand-in, in `tools/stand-in/`, finds it.

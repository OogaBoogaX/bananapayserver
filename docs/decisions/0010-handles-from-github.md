# 0010. Handles come from GitHub sign-in

**Status:** accepted, 2026-10-01

## Decision

A donation's handle is the donor's GitHub username, proven by signing in with GitHub through
the Worker, or nothing for an anonymous donation. Free-text handles are gone. The Worker reads
only the username and numeric id, discards GitHub's token, and keeps a signed session cookie
for a week, in a form only the API's own host can set. A signed-in donor can still give
anonymously. The leaderboard counts signed-in donors by GitHub's numeric id. Anonymous
donations are stored and count toward the pile, but never appear on the board.

## Alternatives

- **Free-text handles,** as OBL has today.
- **First-come claims,** a handle held by whichever browser used it first.
- **Signing with a Lightning or Nostr key.**

## Why

The leaderboard needs identities nobody else can take. OBL's characters are already keyed by
GitHub username, so a signed-in contributor shows as their own character. Free text lets
anyone donate as a contributor and put a message under their name. First-come claims let
anyone take a contributor's handle before they arrive. Few donors have a Lightning or Nostr key
set up to sign with. GitHub sign-in proves the username without any password or key passing
through here, and its token is used once and dropped. Counting by numeric id keeps a donor's
total through a renamed username, which GitHub allows, and which would otherwise split the
total or hand it to whoever takes the old name.

## Consequences

- The Worker holds two new secrets: the GitHub app's client secret, and the key that signs
  sessions. Neither can reach a node, but both are credentials, so changing how they're used
  needs two maintainers.
- The API has to be served from the same site as OBL's page, such as a subdomain of
  `oogabooga.land`, or browsers won't send the sign-in cookie.
- Sign-in depends on GitHub. When GitHub is down, donors can still give anonymously.
- Signing out forgets the session in that browser; there's no list of sessions to revoke. A
  renamed GitHub username shows on the board after the donor's next sign-in, at most a week
  later.
- OBL's `HANDLE_MAX` is 24, and GitHub usernames run to 39 characters. OBL's contract has to
  grow to 39, or long usernames get cut.
- The donation dialog's free-text handle field goes, through OBL's own process.

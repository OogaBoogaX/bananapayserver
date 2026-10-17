# 0026. rock is the default branch

**Status:** accepted, 2026-10-17.

## Decision

At the maintainer's request, rename this repository's default branch from `main` to `rock`,
as part of the OogaBoogaX-wide branch naming change.

References to `main` in earlier records identify the branch now named `rock`. The review,
staging, production deployment and release requirements in
[0008](0008-limited-contributions.md), [0018](0018-staging-github-action.md) and
[0020](0020-staging-then-production.md) remain unchanged. Superseded records remain historical.

## Alternatives

- Keep the default branch named `main`.

## Why

Use the organization's chosen default branch name consistently.

## Consequences

- The CI push filter, current operating instructions and OogaBoogaX repository links use `rock`.
- Existing checkouts update their local branch name and upstream tracking reference.
- Accepted records retain their original wording; this record explains the new branch name.

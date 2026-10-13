# 0015. Staging deploys on push, through Cloudflare's Git connection

**Status:** superseded by [0018](0018-staging-github-action.md), 2026-10-09 (proposed
2026-10-04). Staging no longer deploys on push, and Workers Builds is disconnected.

## Decision

`bananapayserver-staging` deploys on every push to one branch, through Workers Builds,
Cloudflare's own connection to this repository. Each build runs the tests, applies D1
migrations and deploys with `wrangler.staging.jsonc`, with Wrangler pinned in the commands. The
branch is the top of the stack until it merges, then `main`. Preview builds are off. The first
deploy, the database and every secret are still set by a person, as
[`cloudflare.md`](../cloudflare.md) describes. `bananapayserver-production` is not connected:
it deploys by hand, from `main`.

## Alternatives

- **By hand only,** as `cloudflare.md` had it, with no deploy token at all.
- **A GitHub Actions workflow,** as OBL's Workers use, with an API token stored as a
  repository secret.
- **Builds for production too.**

## Why

Staging is where the code meets Cloudflare's runtime, and it is tested on signet, where the
coins are worthless. A deploy that waits for a person falls behind the branch under review,
and reviewers end up testing code that isn't the code on the pull request. Deploying on push
keeps staging and the branch the same.

Builds keeps the deploy token at Cloudflare. It never reaches GitHub, a workflow or a fork's
pull request, and there is no workflow file for a pull request to change. Actions would put an
account-wide token in this repository's secrets.

Production handles mainnet money, and Builds has no step where a person approves a deploy. A
merge to `main` would deploy production and apply its migrations with nobody watching.

## Consequences

- **One deploy token, owned by a person.** Builds makes a user token that can edit every
  Worker in the account, and it is given D1 edit to run migrations. It is listed under its
  owner's API tokens, and it stops working if they leave the account; then a build fails with
  a stale token, and another admin reconnects the repository.
- **Whoever can push to staging's branch deploys staging,** and the tests in the build run
  where that token is. The `donations/*` branches aren't protected.
- **One deployer.** No hand deploy and no `secret put` while a build is running, no edits in
  the dashboard, and the deploy command always names the config file. The default
  `npx wrangler deploy`, with no config at the root, deploys something else, and that is how a
  Git-connected build replaced OBL's staging Worker on 2026-10-03.
- **Settings live in the dashboard.** The build's commands, branch and variables are in the
  Worker's settings, not in this repository; `cloudflare.md` records them, and they are changed
  in both places together, Wrangler's pin included.
- **The branch moves by hand.** The repository deletes a branch when it merges, and Builds
  then stops without saying so. At each merge down the stack, an admin moves the Worker's
  branch to the next one, and finally to `main`.
- **Optional settings go in as secrets.** A deploy removes plain variables set in the
  dashboard, so a setting that isn't in the config file is set with `wrangler secret put`.

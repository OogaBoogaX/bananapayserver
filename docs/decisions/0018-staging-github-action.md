# 0018. Staging deploys through a manual GitHub Action

**Status:** accepted, 2026-10-09. Supersedes [0015](0015-staging-deploys-on-push.md) and
settles how [0009](0009-toolchain.md) pins Wrangler for staging. Production still deploys by
hand.

## Decision

A maintainer runs [Deploy Cloudflare staging](../../.github/workflows/cloudflare-staging.yml)
with `workflow_dispatch`, selecting the branch to test and deploy. Every job checks out the
run's exact commit. Node 22 and 24 run the tests without deployment credentials. Only after
both pass does a job in the GitHub `staging` environment apply pending D1 migrations, deploy
`wrangler.staging.jsonc`, and check the Worker's public responses. Pushes and pull requests
never trigger this deployment.

Wrangler 4.146.0 and its dependency integrity hashes are locked under `.github/deploy/`.
`npm ci --prefix .github/deploy --ignore-scripts` installs that toolchain without running
package scripts. Three of its packages, esbuild, workerd and fsevents, have install scripts;
`--ignore-scripts` skips them, and the deploy doesn't need them. Wrangler and its dependencies
run with the Cloudflare token in the deploy job, so pinning versions and verifying integrity
hashes also limits what code can use it.
The Worker, relay and tests still have no package dependencies.

## Alternatives

- Cloudflare Workers Builds deploying on every push, as 0015 proposed.
- Running every staging deployment from a maintainer's terminal.

## Why

The requested Action makes the selected branch, test results, migrations and deployment
visible in one GitHub run. A locked toolchain gives the same dependency versions to each
deployment and verifies their package integrity, while keeping those dependencies out of the
runtime and test jobs. Wrangler is needed to package and upload the Worker and apply D1
migrations; it adds no code to the relay.

## Consequences

- The `staging` environment holds `CLOUDFLARE_API_TOKEN`, with Workers Scripts Edit and D1 Edit
  for the target account. Those permissions can change other Workers in that account too;
  environment protections control who can deploy. The account id and smoke-check URL are
  environment variables, not values committed to the repository.
- The existing Worker's secrets stay in Cloudflare and survive deployment. No relay token,
  hash or limit is copied into GitHub.
- Disconnect Workers Builds before switching deployers, and let any active build finish.
  The Action serializes staging runs without cancelling an active deployment. A manual
  deployment or secret update must also wait until no deployment is running.
- The workflow must reach the default branch through review before GitHub accepts manual
  dispatches. The branch selected for a run must contain the workflow and deployment lockfile.
  Until then, a maintainer can deploy the reviewed branch with the same locked Wrangler.
- D1 migrations always precede the Worker that uses them, including `0003_tally.sql`. The
  Action changes neither production nor its deployment process.
- The public checks prove that `/relay` expects an authenticated WebSocket and pages cannot
  call the invoice route directly. They do not prove payment settlement or tally delivery through OBL's
  binding; those still need the signet checks in the testing guide.

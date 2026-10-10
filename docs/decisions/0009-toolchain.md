# 0009. Plain JavaScript, no dependencies

**Status:** proposed, 2026-10-01

## Decision

All code is plain JavaScript in ES modules (`.mjs`), with no dependencies at run time or in
the tests, and no `package.json`. The Worker and its Durable Object run on Cloudflare
Workers. The relay and the tests run on Node 22 or newer, using only its standard library,
with `node --test`. The relay brings its own SOCKS5 and WebSocket client instead of
packages. Code both ends share, the line's messages and OBL's contract, lives in `shared/`
and uses only what both platforms provide. The relay ships as a container image built on a
Node base image pinned by digest. CI uses GitHub's own checkout and setup-node actions,
pinned to a commit.

## Alternatives

- **TypeScript with a build step**, for types across the line's two ends.
- **npm packages for the relay**: `ws` for the WebSocket and `socks-proxy-agent` for Tor.
- **Cloudflare's Vitest pool**, which runs the Worker's tests inside the real runtime.
- **Go or Rust for the relay**, a single static binary.

## Why

The relay is the one program in this repository that runs on a machine next to LND and
BTCPay, so its supply chain matters most. `ws` and `socks-proxy-agent` would add several
packages, and their maintainers, to that machine; the client written here is about 350
lines, covers only what the line uses, and is tested against a server and a SOCKS stub. A
build step would put a compiler between the code and what runs, for types the line's checks
already enforce at run time. The Vitest pool would test the real runtime, but it brings
Wrangler, Miniflare and a long dependency tree into every test run. A second language for
the relay would split the line's protocol across two codebases, when 0001 put both ends in
one repository so they change together.

## Consequences

- The tests run the Worker and the object against fakes of the Cloudflare APIs, with
  `node:sqlite` standing in for D1 and the object's storage. They can't catch the runtime
  behaving differently, so before going live the service has to run end to end under
  Wrangler against BTCPay on regtest or signet.
- The WebSocket and SOCKS5 code is this repository's to maintain. It is part of the relay,
  so every change to it needs two maintainers.
- Deploying needs Wrangler. How it is pinned and run belongs with the deployment decision:
  [0015](0015-staging-deploys-on-push.md) proposes it for staging, and production's is still
  open.
- A dependency can still be added, with a written reason, a pinned version and a hash, and
  a record that supersedes this one.

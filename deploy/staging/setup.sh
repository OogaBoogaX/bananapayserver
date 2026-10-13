#!/usr/bin/env bash
# Sets up the staging stack once it has synced: bakes LND an invoice-only macaroon, then runs
# setup.mjs to set up BTCPay. Adds the relay's settings to .env and prints the relay token's
# SHA-256, for bananapayserver-staging. Run from anywhere, with the stack up and .env filled in.
# See docs/staging.md.

set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -p obl-staging "$@"; }
fail() { echo "setup: $*" >&2; exit 1; }

[ -f .env ] || fail "no .env here; copy .env.example to .env and fill it in"
if grep -q '^RELAY_TOKEN=.' .env; then fail "already set up: .env has a RELAY_TOKEN"; fi

network="$(compose exec -T lnd printenv LND_ENVIRONMENT | tr -d '\r')"
lncli() { compose exec -T lnd lncli -n "$network" "$@"; }

echo "Waiting for LND to catch up with the chain..."
until lncli getinfo 2>/dev/null | grep -q '"synced_to_chain": *true'; do sleep 15; done

# BTCPay may create and read invoices, and read the node's basic info. Nothing else.
# It goes to setup.mjs through the environment, since a command line is readable by every user
# on the machine.
MACAROON="$(lncli bakemacaroon invoices:read invoices:write info:read | tr -d '\r\n')"
export MACAROON

umask 077
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
compose exec -T lnd cat /data/tls.cert |
  compose run --rm --no-deps -T -e MACAROON -v "$PWD/setup.mjs:/setup.mjs:ro" relay node /setup.mjs >"$out"

set_env() {
  if grep -q "^$1=" .env; then
    sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else
    echo "$1=$2" >>.env
  fi
}
for key in RELAY_TOKEN BTCPAY_STORE_ID BTCPAY_API_KEY BTCPAY_WEBHOOK_SECRET BTCPAY_ADMIN_PASSWORD; do
  value="$(grep "^$key=" "$out" | cut -d= -f2-)"
  [ -n "$value" ] || fail "setup.mjs didn't return $key"
  set_env "$key" "$value"
done
chmod 600 .env

echo
echo "Set up. Give this to whoever deploys bananapayserver-staging, as RELAY_TOKEN_SHA256:"
grep '^RELAY_TOKEN_SHA256=' "$out" | cut -d= -f2-
echo
echo "Once it's set, start the relay: ./start.sh relay"

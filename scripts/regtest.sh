#!/usr/bin/env bash
# The local regtest stack for stage 1 of docs/testing.md, on one machine. Regtest only: its
# coins are worthless, and nothing here touches a real node.
#
#   BTCPAY_DIR=<a BTCPay Server checkout> scripts/regtest.sh <command>
#
#   up            Start BTCPay's regtest network, and give the customer node, which plays the
#                 donor, a channel to the merchant node, which plays the donating node.
#   setup         With BTCPay running, create the store, the relay's key and the webhook, and
#                 write .dev.vars and relay/.env with fresh secrets. Refuses if relay/.env
#                 exists.
#   pay <bolt11>  Pay an invoice from the customer node, once it checks out as one of this
#                 store's regtest invoices.
#   mine [n]      Mine n blocks, 1 by default. After a restart the Lightning nodes wait for a
#                 block newer than the last one they saw.
#   down          Stop the network, keeping its data.
#   reset         Stop it, delete its data and the Worker's local state, and remove
#                 .dev.vars and relay/.env, for a clean start.
#
# Needs Docker, curl, jq and openssl.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="http://localhost:14142/api/v1"
STORE_NAME="OBL donations (regtest)"
JSON="Content-Type: application/json"

fail() { echo "regtest: $*" >&2; exit 1; }

tests_dir() {
  [ -n "${BTCPAY_DIR:-}" ] || fail "set BTCPAY_DIR to a BTCPay Server checkout"
  [ -f "$BTCPAY_DIR/BTCPayServer.Tests/docker-compose.yml" ] || fail "no BTCPayServer.Tests/docker-compose.yml under BTCPAY_DIR"
  echo "$BTCPAY_DIR/BTCPayServer.Tests"
}

# Compose on BTCPay's development project and no other, whatever directory this runs from.
compose() {
  local dir
  dir="$(tests_dir)"
  docker compose -p btcpayservertests -f "$dir/docker-compose.yml" "$@"
}

container() {
  docker ps -q --filter label=com.docker.compose.project=btcpayservertests --filter "label=com.docker.compose.service=$1"
}
bitcoin() { docker exec "$(container bitcoind)" bitcoin-cli -datadir=/data "$@"; }
customer() { docker exec "$(container customer_lnd)" lncli --no-macaroons --rpcserver localhost:10008 "$@"; }
merchant() { docker exec "$(container merchant_lnd)" lncli --no-macaroons --rpcserver localhost:10008 "$@"; }

mine() { bitcoin generatetoaddress "${1:-1}" "$(bitcoin getnewaddress)" >/dev/null; }

wait_for() {
  local what="$1"; shift
  for _ in $(seq 1 60); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done
  fail "gave up waiting for $what"
}

synced() { [ "$("$1" getinfo | jq -r .synced_to_chain)" = true ]; }

channel_active() {
  customer listchannels | jq -e --arg id "$1" '.channels | any(.remote_pubkey == $id and .active)'
}

cmd_up() {
  docker info >/dev/null 2>&1 || fail "Docker isn't answering. On a Mac, start Docker Desktop; if it runs but this still fails, set DOCKER_HOST=unix://\$HOME/.docker/run/docker.sock"
  compose up -d dev
  wait_for "bitcoind" bitcoin getblockcount
  # Spendable coins, then a fresh block, so the Lightning nodes count the chain as current.
  if [ "$(bitcoin getblockcount)" -lt 101 ]; then mine 101; fi
  mine 1
  wait_for "the merchant node" synced merchant
  wait_for "the customer node" synced customer
  local merchant_id
  merchant_id="$(merchant getinfo | jq -r .identity_pubkey)"
  # Any channel to the merchant counts: after a restart it stays inactive until the peers
  # reconnect, and a new one is pending until mined.
  if customer listchannels | jq -e --arg id "$merchant_id" '.channels | any(.remote_pubkey == $id)' >/dev/null ||
    customer pendingchannels | jq -e --arg id "$merchant_id" '.pending_open_channels | any(.channel.remote_node_pub == $id)' >/dev/null; then
    echo "The customer node already has a channel to the merchant node."
  else
    echo "Opening a channel from the customer node to the merchant node."
    bitcoin sendtoaddress "$(customer newaddress p2wkh | jq -r .address)" 1 >/dev/null
    mine 6
    wait_for "the customer node's funds" synced customer
    customer connect "$(merchant getinfo | jq -r '.uris[0]')" >/dev/null 2>&1 || true
    customer openchannel "$merchant_id" 5000000 >/dev/null
    mine 6
  fi
  wait_for "the channel to be active" channel_active "$merchant_id"
  echo "Up. Next, run BTCPay from source (docs/testing.md), then: scripts/regtest.sh setup"
}

cmd_setup() {
  [ ! -e "$ROOT/relay/.env" ] || fail "relay/.env exists. Remove it and .dev.vars to set up again, or run reset."
  curl -sf "$API/health" >/dev/null || fail "BTCPay isn't answering at $API; start it first (docs/testing.md)"
  local tests user password admin auth store tpub relay_key token webhook_secret
  tests="$(tests_dir)"
  # BTCPay's own development login, from its setup script.
  user="admin@$(sed -n 's/^USERHOST="\(.*\)"$/\1/p' "$tests/setup-dev-basics.sh")"
  password="$(sed -n 's/^PASSWORD="\(.*\)"$/\1/p' "$tests/setup-dev-basics.sh")"
  # The first user becomes the admin; on a second run it already exists, which is fine.
  curl -s -o /dev/null -X POST -H "$JSON" \
    -d "$(jq -n --arg e "$user" --arg p "$password" '{email: $e, password: $p, isAdministrator: true}')" "$API/users"
  admin="$(curl -sf -X POST -H "$JSON" -u "$user:$password" \
    -d '{"label": "store setup (regtest)", "permissions": ["unrestricted"]}' "$API/api-keys" | jq -r .apiKey)"
  auth="Authorization: token $admin"
  # The unrestricted key is for this setup only, so it goes however setup ends.
  # Expanded now: the trap runs after this function's locals are gone.
  trap "curl -s -o /dev/null -X DELETE -H '$auth' '$API/api-keys/current'" EXIT
  store="$(curl -sf -X POST -H "$JSON" -H "$auth" \
    -d "$(jq -n --arg n "$STORE_NAME" '{name: $n, defaultCurrency: "BTC"}')" "$API/stores" | jq -r .id)"
  # On-chain: the watch-only regtest wallet from BTCPay's own development setup.
  tpub="$(grep -o 'tpubDD79[A-Za-z0-9]*' "$tests/setup-dev-basics.sh" | head -1)"
  curl -sf -o /dev/null -X PUT -H "$JSON" -H "$auth" \
    -d "$(jq -n --arg t "$tpub" '{enabled: true, config: $t}')" "$API/stores/$store/payment-methods/BTC-CHAIN"
  # Lightning: the merchant node, connected the way BTCPay's development setup does it.
  curl -sf -o /dev/null -X PUT -H "$JSON" -H "$auth" \
    -d '{"enabled": true, "config": {"connectionString": "type=lnd-rest;server=http://lnd:lnd@127.0.0.1:35531/;allowinsecure=true"}}' \
    "$API/stores/$store/payment-methods/BTC-LN"
  # The relay's key: create and view invoices on this one store, and nothing else.
  relay_key="$(curl -sf -X POST -H "$JSON" -H "$auth" \
    -d "$(jq -n --arg s "$store" '{label: "bananapayserver relay (regtest)", permissions: ["btcpay.store.cancreateinvoice:" + $s, "btcpay.store.canviewinvoices:" + $s]}')" \
    "$API/api-keys" | jq -r .apiKey)"
  token="$(openssl rand -hex 32)"
  webhook_secret="$(openssl rand -hex 32)"
  curl -sf -o /dev/null -X POST -H "$JSON" -H "$auth" \
    -d "$(jq -n --arg s "$webhook_secret" '{url: "http://localhost:8080/btcpay", secret: $s, enabled: true, automaticRedelivery: true, authorizedEvents: {everything: false, specificEvents: ["InvoiceSettled"]}}')" \
    "$API/stores/$store/webhooks"

  # Local test values; a deployment sets its own limits and never commits them.
  umask 077
  cat >"$ROOT/relay/.env" <<EOF
# Written by scripts/regtest.sh for the local regtest stack. Never commit this file.
WORKER_URL=ws://localhost:8787/relay
RELAY_TOKEN=$token
DIRECT=yes
BTCPAY_URL=http://localhost:14142
BTCPAY_STORE_ID=$store
BTCPAY_API_KEY=$relay_key
BTCPAY_WEBHOOK_SECRET=$webhook_secret
MAX_SATS=100000
RATE_PER_MINUTE=120
WEBHOOK_LISTEN=127.0.0.1:8080
EOF
  cat >"$ROOT/.dev.vars" <<EOF
# Written by scripts/regtest.sh for the local regtest stack. Never commit this file.
MAX_SATS=100000
RATE_PER_IP=20
RATE_GLOBAL=120
RELAY_TOKEN_SHA256=$(printf %s "$token" | shasum -a 256 | cut -d' ' -f1)
NETWORK=regtest
EOF
  echo "Store $store is ready, with the relay's key and the webhook. Wrote relay/.env and .dev.vars."
}

cmd_pay() {
  local bolt11="${1:-}" decoded merchant_id
  [[ "$bolt11" == lnbcrt* ]] || fail "give a regtest invoice, lnbcrt…"
  decoded="$(customer decodepayreq "$bolt11")"
  merchant_id="$(merchant getinfo | jq -r .identity_pubkey)"
  echo "$decoded" | jq -e --arg id "$merchant_id" '.destination == $id' >/dev/null ||
    fail "that invoice doesn't pay the local merchant node"
  echo "Paying $(echo "$decoded" | jq -r .num_satoshis) sats from the customer node."
  customer payinvoice --force --json "$bolt11" | jq -r '"Payment: " + .status'
}

cmd_down() { compose down; }

cmd_reset() {
  compose down -v
  rm -rf "$ROOT/.wrangler/state" "$ROOT/tools/stand-in/.wrangler/state"
  rm -f "$ROOT/relay/.env" "$ROOT/.dev.vars"
  echo "Reset. Start again with: scripts/regtest.sh up"
}

case "${1:-}" in
  up) cmd_up ;;
  setup) cmd_setup ;;
  pay) cmd_pay "${2:-}" ;;
  mine) mine "${2:-1}"; echo "Mined ${2:-1}." ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  *) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

#!/usr/bin/env bash
# Starts the staging stack, or the services named, only behind its fence: the firewall's rules
# go up first, then the stack's networks are checked against the subnets the rules were made
# from, and only then does anything start. Run it as the user who runs Docker; it asks sudo for
# the firewall. See docs/staging.md.
#
#   ./start.sh                  everything
#   ./start.sh relay            one service

set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -p obl-staging "$@"; }
fail() { echo "start: $*" >&2; exit 1; }

sudo ./firewall.sh
compose up --no-start "$@"

# The firewall guards the subnets in .env. A network Docker made earlier, before .env changed,
# keeps its old subnet, and the firewall wouldn't guard it.
for net in backend:BACKEND_SUBNET front:FRONT_SUBNET outside:OUTSIDE_SUBNET; do
  name="obl-staging_${net%%:*}"
  want="$(sed -n "s|^${net#*:}=||p" .env)"
  have="$(docker network inspect "$name" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
  [ "$have" = "$want" ] || fail "$name is on $have, but .env says $want, which is what the firewall guards. Stop the stack, remove that network, and run this again."
done

compose up -d "$@"

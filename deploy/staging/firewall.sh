#!/usr/bin/env bash
# The staging stack's fence, for the Linux machine it runs on. Run as root after the stack has
# started once, so its networks exist, and again after every reboot unless the machine's own
# firewall saves the rules. See docs/staging.md.
#
# - The outside network, where Tor alone reaches the internet, can't reach this machine or any
#   private network: not the LAN, not another Docker network.
# - The two internal networks have no route out, but every container can still reach this
#   machine's own addresses through its network's bridge, so those are dropped too.

set -euo pipefail
cd "$(dirname "$0")"

subnet() { sed -n "s|^$1=||p" .env; }
BACKEND="$(subnet BACKEND_SUBNET)"
FRONT="$(subnet FRONT_SUBNET)"
OUTSIDE="$(subnet OUTSIDE_SUBNET)"
[ -n "$BACKEND" ] && [ -n "$FRONT" ] && [ -n "$OUTSIDE" ] || { echo "firewall: the subnets aren't in .env" >&2; exit 1; }

# Adds a rule at the top of its chain unless it's already there.
add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }

for private in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  add DOCKER-USER -s "$OUTSIDE" -d "$private" -j DROP
done
for net in "$OUTSIDE" "$BACKEND" "$FRONT"; do
  add INPUT -s "$net" -j DROP
done
echo "The staging networks can't reach this machine or a private network."

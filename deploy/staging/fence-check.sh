#!/usr/bin/env bash
# Checks the staging stack's fence from inside it. From each of the stack's networks, it tries to
# reach this machine, its router, every port this machine's other containers publish, and one
# container on each of its other Docker networks. Then it checks that no container in the stack
# has an IPv6 address. Run it on the machine, with the stack up, as the user who runs Docker.
# See docs/staging.md.
#
#   ./fence-check.sh                    finds the machine's LAN address and router itself
#   ./fence-check.sh --lan <address> --router <address> --ssh-port <port>
#
# It prints two parts: one for you, with addresses and ports, and one to post where the team can
# see it, with neither. It exits 0 when the fence holds, 1 when something is reachable, and 2
# when it couldn't check.

set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -p obl-staging "$@"; }
fail() { echo "fence-check: $*" >&2; exit 2; }

lan="" router="" ssh_port=22
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) lan="${2:-}"; shift 2 ;;
    --router) router="${2:-}"; shift 2 ;;
    --ssh-port) ssh_port="${2:-}"; shift 2 ;;
    *) fail "unknown option $1" ;;
  esac
done
[ -n "$lan" ] || lan="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[ -n "$router" ] || router="$(ip -4 route show default 2>/dev/null | awk '{ print $3; exit }')"
[ -n "$lan" ] && [ -n "$router" ] || fail "couldn't find this machine's LAN address or its router; give them with --lan and --router"

for net in outside front backend; do
  docker network inspect "obl-staging_$net" >/dev/null 2>&1 || fail "obl-staging_$net doesn't exist; start the stack with ./start.sh first"
done
running="$(compose ps --services --status running)"
[ -n "$running" ] || fail "nothing in the stack is running; start it with ./start.sh first"

# One connection attempt. Only no answer, or no route, counts as blocked: a refusal means
# something answered, and any other error means the try told nothing.
PROBE="const s = require('net').connect(+process.argv[2], process.argv[1]); s.setTimeout(4000);
const say = (what, code) => { console.log(what); process.exit(code); };
s.on('connect', () => say('REACHABLE: it connected', 1));
s.on('timeout', () => say('blocked: no answer', 0));
s.on('error', (e) => e.code === 'ECONNREFUSED' ? say('REACHABLE: it refused, so something answered', 1)
  : ['ENETUNREACH', 'EHOSTUNREACH'].includes(e.code) ? say('blocked: ' + e.code, 0)
  : say('couldn\\'t run the probe: ' + e.code, 2));"

reachable=0 broken=0
public=()

# probe <stack network> <address> <port> <what it is, without the address>
probe() {
  local result
  if [ -z "$2" ]; then
    # An empty address would reach the probe's own container, and say nothing about the fence.
    broken=$((broken + 1))
    printf '  from %-8s %-25s %-28s %s\n' "$1" "(no address found)" "($4)" "couldn't run the probe"
    public+=("from $1, $4: couldn't run the probe")
    return
  fi
  result="$(docker run --rm --network "obl-staging_$1" --cap-drop ALL --security-opt no-new-privileges \
    obl-staging-relay node -e "$PROBE" "$2" "$3" 2>/dev/null | tail -n 1)" || true
  case "$result" in
    blocked*) ;;
    REACHABLE*) reachable=$((reachable + 1)) ;;
    couldn*) broken=$((broken + 1)) ;;
    *) result="couldn't run the probe"; broken=$((broken + 1)) ;;
  esac
  printf '  from %-8s to %-22s %-28s %s\n' "$1" "$2:$3" "($4)" "$result"
  public+=("from $1, $4: $result")
}

# The machine's own address on one of the stack's networks, the network's gateway: read from its
# bridge, since Docker doesn't always record it, or else from what Docker recorded.
gateway() {
  local id address
  id="$(docker network inspect "obl-staging_$1" --format '{{.Id}}')"
  address="$(ip -4 -o addr show dev "br-${id:0:12}" 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }' || true)"
  [ -n "$address" ] || address="$(docker network inspect "obl-staging_$1" --format '{{(index .IPAM.Config 0).Gateway}}')"
  echo "$address"
}

echo "For you: what was tried, and what came back."
echo

# Tor's network, the one that reaches the internet.
probe outside "$lan" "$ssh_port" "the machine, SSH"
probe outside "$(gateway outside)" "$ssh_port" "its gateway, SSH"
probe outside "$router" 80 "the router"

# Every TCP port another container publishes on this machine, such as the node's LND and bitcoind.
ports="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -v '^obl-staging-' |
  grep -oE ':[0-9]+->[0-9]+/tcp' | sed 's/^:\([0-9]*\)->.*/\1/' | sort -un || true)"
count=0
for port in $ports; do
  count=$((count + 1))
  probe outside "$lan" "$port" "the machine, published port $count"
done
[ "$count" -gt 0 ] || public+=("from outside, published ports: none on this machine")

# One container with a port on each of this machine's other Docker networks, such as the node's
# own apps', up to eight of them.
others=0
for net in $(docker network ls --filter driver=bridge --format '{{.Name}}' | grep -v '^obl-staging' || true); do
  [ "$others" -lt 8 ] || break
  while read -r name address; do
    [ -n "$address" ] || continue
    port="$(docker inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}' "$name" |
      tr ' ' '\n' | sed -n 's|/tcp$||p' | head -n 1)"
    [ -n "$port" ] || continue
    others=$((others + 1))
    probe outside "${address%/*}" "$port" "another Docker network, $others"
    break
  done < <(docker network inspect "$net" --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}')
done
[ "$others" -gt 0 ] || public+=("from outside, other Docker networks: none with a container to try")

# The two internal networks: this machine, and each network's own gateway, its side of the network.
for net in front backend; do
  probe "$net" "$lan" "$ssh_port" "the machine, SSH"
  probe "$net" "$(gateway "$net")" "$ssh_port" "its gateway, SSH"
done

# No container in the stack has IPv6, since the firewall fences IPv4 only.
ipv6="none"
for service in $running; do
  if ! out="$(compose exec -T "$service" cat /proc/net/if_inet6 2>/dev/null)"; then
    ipv6="couldn't check $service"; broken=$((broken + 1))
  elif [ -n "$out" ]; then
    ipv6="FOUND in $service"; reachable=$((reachable + 1))
  fi
done
echo "  IPv6 in the stack's containers: $ipv6"

echo
echo "To post: no address or port in it."
echo
echo "Fence check on the staging machine, $(date -u +%Y-%m-%d), with deploy/staging/fence-check.sh:"
for line in "${public[@]}"; do echo "- $line"; done
echo "- IPv6 in the stack's containers: $ipv6"
echo

if [ "$reachable" -gt 0 ]; then
  echo "Something got through. Stop the stack now, with docker compose -p obl-staging stop, and tell"
  echo "the team. Don't post the addresses above."
  exit 1
fi
if [ "$broken" -gt 0 ]; then
  echo "Some checks couldn't run, so this doesn't show the fence holds. See the lines above."
  exit 2
fi
echo "The fence holds."

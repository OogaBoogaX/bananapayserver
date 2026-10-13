#!/usr/bin/env bash
# Checks the staging stack's fence from inside it. From each of the stack's networks, it tries to
# reach this machine, its router, every port this machine's other containers publish, and one
# container on each of its other Docker networks. Then it checks that no container in the stack
# has an IPv6 address. Run it on the machine, with the stack up, as the user who runs Docker.
# See docs/staging.md.
#
#   ./fence-check.sh                    finds the machine's LAN address and router itself
#   ./fence-check.sh --lan <address> --router <address> --router-port <port> --ssh-port <port>
#
# It prints two parts: one for you, with addresses and ports, and one to post where the team can
# see it, with neither. It exits 0 when the fence holds, 1 when something got through, and 2
# when anything couldn't be checked, so a pass always means every check ran.

set -Eeuo pipefail
cd "$(dirname "$0")"
trap 'echo "fence-check: stopped by an unexpected error at line $LINENO, so the fence is unchecked" >&2; exit 2' ERR

compose() { docker compose -p obl-staging "$@"; }
fail() { echo "fence-check: $*" >&2; exit 2; }

lan="" router="" router_port=80 ssh_port=22
while [ $# -gt 0 ]; do
  case "$1" in
    --lan | --router | --router-port | --ssh-port) [ $# -ge 2 ] || fail "$1 needs a value" ;;
    *) fail "unknown option $1" ;;
  esac
  case "$1" in
    --lan) lan="$2" ;;
    --router) router="$2" ;;
    --router-port) router_port="$2" ;;
    --ssh-port) ssh_port="$2" ;;
  esac
  shift 2
done
[[ "$router_port" =~ ^[0-9]+$ && "$ssh_port" =~ ^[0-9]+$ ]] || fail "ports are numbers"
[ -n "$lan" ] || lan="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)"
[ -n "$router" ] || router="$(ip -4 route show default 2>/dev/null | awk '{ print $3; exit }' || true)"
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

# Something the check couldn't do. It says so, and then the fence counts as unchecked.
# unchecked <what, without an address> <why>
unchecked() {
  broken=$((broken + 1))
  echo "  $1: couldn't check: $2"
  public+=("$1: couldn't check: $2")
}

# probe <stack network> <address> <port> <what it is, without the address>
probe() {
  local result
  if [ -z "$2" ]; then
    # An empty address would reach the probe's own container, and say nothing about the fence.
    unchecked "from $1, $4" "no address found"
    return
  fi
  result="$(docker run --rm --network "obl-staging_$1" --cap-drop ALL --security-opt no-new-privileges \
    --pull never obl-staging-relay node -e "$PROBE" "$2" "$3" 2>/dev/null | tail -n 1 || true)"
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
probe outside "$router" "$router_port" "the router"

# Every TCP port another container publishes on this machine, such as the node's LND and bitcoind.
# Docker writes a run of ports as a range, and each port in it is tried.
ports=""
if ! listing="$(docker ps --format '{{.Names}} {{.Ports}}')"; then
  unchecked "from outside, the machine's published ports" "Docker couldn't list the containers"
  listing=""
fi
while read -r name mappings; do
  case "$name" in "" | obl-staging-*) continue ;; esac
  IFS=',' read -r -a entries <<<"$mappings"
  for entry in ${entries[@]+"${entries[@]}"}; do
    entry="${entry# }"
    case "$entry" in *"->"*/tcp) ;; *) continue ;; esac
    host="${entry%%->*}"
    host="${host##*:}"
    if [[ "$host" =~ ^[0-9]+$ ]]; then
      ports="$ports $host"
    elif [[ "$host" =~ ^([0-9]+)-([0-9]+)$ ]] && [ $((BASH_REMATCH[2] - BASH_REMATCH[1])) -lt 64 ]; then
      for ((port = BASH_REMATCH[1]; port <= BASH_REMATCH[2]; port++)); do ports="$ports $port"; done
    else
      unchecked "from outside, the machine's published ports" "a mapping too large or too odd to try"
    fi
  done
done <<<"$listing"
count=0
for port in $(printf '%s\n' $ports | sort -un); do
  count=$((count + 1))
  probe outside "$lan" "$port" "the machine, published port $count"
done
[ "$count" -gt 0 ] || public+=("from outside, published ports: none on this machine")

# One container on each of this machine's other Docker networks, such as the node's own apps'. On
# a port it says it uses, or else any port: a refusal shows the way is open just as well.
others=0
if ! networks="$(docker network ls --filter driver=bridge --format '{{.Name}}')"; then
  unchecked "from outside, other Docker networks" "Docker couldn't list the networks"
  networks=""
fi
for net in $networks; do
  case "$net" in obl-staging*) continue ;; esac
  if ! members="$(docker network inspect "$net" --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}')"; then
    unchecked "from outside, another Docker network" "Docker couldn't read one"
    continue
  fi
  read -r name address <<<"$(printf '%s\n' "$members" | grep -m 1 ' [0-9]' || true)"
  # With no container on it, there's nothing there to reach.
  [ -n "${address:-}" ] || continue
  port="$(docker inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}' "$name" 2>/dev/null |
    tr ' ' '\n' | sed -n 's|/tcp$||p' | head -n 1 || true)"
  others=$((others + 1))
  probe outside "${address%/*}" "${port:-1}" "another Docker network, $others"
done
[ "$others" -gt 0 ] || public+=("from outside, other Docker networks: none with a container")

# The two internal networks: this machine, and each network's own gateway, its side of the network.
for net in front backend; do
  probe "$net" "$lan" "$ssh_port" "the machine, SSH"
  probe "$net" "$(gateway "$net")" "$ssh_port" "its gateway, SSH"
done

# No container in the stack has IPv6, since the firewall fences IPv4 only.
found="" unread=""
for service in $running; do
  if ! out="$(compose exec -T "$service" cat /proc/net/if_inet6 2>/dev/null)"; then
    unread="$unread $service"
  elif [ -n "$out" ]; then
    found="$found $service"
  fi
done
ipv6=""
if [ -n "$found" ]; then
  ipv6="FOUND in$(printf ' %s,' $found)"
  ipv6="${ipv6%,}"
  reachable=$((reachable + 1))
fi
if [ -n "$unread" ]; then
  ipv6="${ipv6:+$ipv6; }couldn't check$(printf ' %s,' $unread)"
  ipv6="${ipv6%,}"
  broken=$((broken + 1))
fi
ipv6="${ipv6:-none}"
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

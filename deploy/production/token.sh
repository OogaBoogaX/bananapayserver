#!/usr/bin/env bash
# Makes the production relay's token, once: writes it to .env as RELAY_TOKEN and prints only its
# SHA-256, for bananapayserver-production's RELAY_TOKEN_SHA256. The token never leaves this
# machine and is never shown. Run again, it prints the same hash. See docs/production.md.

set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "token: no .env here; copy .env.example to .env first" >&2; exit 1; }
umask 077
chmod 600 .env

token="$(sed -n 's/^RELAY_TOKEN=//p' .env)"
if [ -z "$token" ]; then
  token="$(openssl rand -hex 32)"
  # Only bash's own printf touches the token: another program's arguments can be read by anyone
  # on the machine.
  sed -i.bak '/^RELAY_TOKEN=/d' .env && rm -f .env.bak
  if [ -n "$(tail -c 1 .env)" ]; then echo >>.env; fi
  printf 'RELAY_TOKEN=%s\n' "$token" >>.env
fi

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
printf %s "$token" | sha256 | cut -d' ' -f1

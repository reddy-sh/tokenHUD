#!/usr/bin/env bash
# Start the TokenHUD server in the foreground. Loopback by default; ctrl-c to stop.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="$PWD/server/target/release/tokenhud-server"
if [ -z "${TOKENHUD_KEY:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ ! -x "$BIN" ]; then echo "no server binary — ./scripts/build.sh"; exit 1; fi
exec "$BIN" "$@"

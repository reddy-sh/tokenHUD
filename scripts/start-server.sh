#!/usr/bin/env bash
# Start the TOKENHUD server. Loopback by default; ctrl-c to stop.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${TOKENHUD_KEY:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
exec python3 server/server.py

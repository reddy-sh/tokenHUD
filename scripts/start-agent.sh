#!/usr/bin/env bash
# Start the TOKENHUD agent on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${TOKENHUD_SERVER:=http://127.0.0.1:8787}"
export TOKENHUD_SERVER
exec python3 agent/agent.py "$@"

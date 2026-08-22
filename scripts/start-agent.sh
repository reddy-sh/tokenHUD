#!/usr/bin/env bash
# Start the AIMC agent on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${AIMC_SERVER:=http://127.0.0.1:8787}"
export AIMC_SERVER
exec python3 agent/agent.py "$@"

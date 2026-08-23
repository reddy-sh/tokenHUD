#!/usr/bin/env bash
# Start the TokenHUD agent on this machine, in the foreground.
#
# For a server on one box and agents on several: run this on each machine with
# TOKENHUD_SERVER pointed at the board. To keep it running across logins, use
# the launchd or systemd unit in agent/dist/ instead — see agent/INSTALL.md.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="$PWD/agent/target/release/tokenhud-agent"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${TOKENHUD_SERVER:=http://127.0.0.1:8787}"
export TOKENHUD_SERVER
if [ ! -x "$BIN" ]; then
  echo "no agent binary — ./scripts/build.sh"
  exit 1
fi
exec "$BIN" "$@"

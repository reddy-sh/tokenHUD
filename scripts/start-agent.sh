#!/usr/bin/env bash
# Start the agent (and check first - if it is already running, say so).
#
#   ./scripts/start-agent.sh
#
# The agent reads this machine's AI-assistant state and reports it to the API
# server every 30 seconds. Where its server and key come from, in order:
#   1. ~/.tokenhud/machine.json - this machine was enrolled from a board link
#      (`tokenhud-agent enroll "<link>"`); nothing else is needed.
#   2. .env in this repo - the local install's shared key, next to the server.
# Consent gates everything: the agent will not start until the read manifest
# has been agreed to, and this script never agrees on your behalf.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"

if alive "$RUN/agent.pid"; then
  echo "agent already running (pid $(cat "$RUN/agent.pid")) → logs/agent.log"
  exit 0
fi

build_rust agent
BIN="$ROOT/agent/target/release/tokenhud-agent"

# An enrolled machine is fully configured by machine.json; only fall back to
# the repo's .env when there is no enrollment (mixing the two pairs a key with
# a server it was not issued for).
if [ ! -f "$HOME/.tokenhud/machine.json" ]; then
  load_env
fi

# Consent is yours to give, not this script's. --accept records it after you
# have seen the list; the agent refuses to start without it, so check here
# and say what to do rather than letting it die quietly in a logfile.
if ! "$BIN" --consent-status >/dev/null 2>&1; then
  echo "this build's read manifest has not been agreed to yet. Look, then agree:"
  echo
  echo "    $BIN --what-i-read"
  echo "    $BIN --accept"
  echo
  echo "then run this again."
  exit 1
fi

start_bg agent "$BIN"
echo "agent up → reporting to ${TOKENHUD_SERVER:-http://127.0.0.1:$PORT} (or its enrolled server)"

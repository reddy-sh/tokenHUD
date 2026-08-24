#!/usr/bin/env bash
# Invoked as `sh scripts/site.sh`? Then the shebang above was bypassed — see
# run.sh for the full story. Re-exec under bash rather than dying obscurely.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Preview the marketing site exactly as Amplify will serve it.
#
#   ./scripts/site.sh           serve site/ on http://127.0.0.1:8788, open it
#   ./scripts/site.sh 9000      same, on another port
#
# Runs in the foreground; Ctrl-C stops it. There is nothing to build — the
# deploy publishes site/ as-is (amplify.yml), so what this serves is what
# ships. python3 because it ships on macOS; the site itself needs no runtime.
#
# Two things this preview cannot show: the custom headers in customHttp.yml
# (Amplify adds those, including the CSP) and https. Everything else — fonts,
# images, the ⌘K palette — is served from this directory, same as production.
set -euo pipefail
cd "$(dirname "$0")/../site"

PORT="${1:-${TOKENHUD_SITE_PORT:-8788}}"
URL="http://127.0.0.1:$PORT"

command -v python3 >/dev/null 2>&1 || {
  echo "python3 not found — it ships with macOS; on Linux: apt install python3" >&2
  exit 1
}

# A port already taken means a stale preview (or the board, on 8787). Say
# which, rather than letting http.server print a traceback.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — is a preview still running?" >&2
  echo "pick another: ./scripts/site.sh $((PORT + 1))" >&2
  exit 1
fi

echo "site → $URL   (Ctrl-C to stop)"

# Open the browser once the server is up, not before.
( sleep 0.4
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  fi ) &

exec python3 -m http.server "$PORT" --bind 127.0.0.1

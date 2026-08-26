#!/usr/bin/env bash
# Start the API server (and check first — running it twice is impossible).
#
#   ./scripts/start-server.sh
#
# The API server takes what agents send and keeps it in SQLite
# (data/tokenhud.db) on http://127.0.0.1:8787. The dashboard is the portal
# (./scripts/start-portal.sh) — this serves only the API. If no key exists yet,
# one is generated and written to .env (mode 600) — agents on this machine
# read it from there.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"

URL="http://127.0.0.1:$PORT"

# Already running? healthz is the truth; the pidfile is the bookkeeping.
if curl -sf -m 2 "$URL/healthz" >/dev/null 2>&1; then
  echo "server already running → $URL"
  exit 0
fi
if alive "$RUN/server.pid"; then
  echo "server process is up (pid $(cat "$RUN/server.pid")) but $URL is not answering —"
  echo "check logs/server.log, or ./scripts/stop-server.sh and start again."
  exit 1
fi

build_rust server
BIN="$ROOT/server/target/release/tokenhud-server"

load_env
# No key yet: generate one and record it where every local piece looks.
if [ -z "${TOKENHUD_KEY:-}" ]; then
  TOKENHUD_KEY="$("$BIN" --new-key)"
  export TOKENHUD_KEY
  touch "$ROOT/.env" && chmod 600 "$ROOT/.env"
  printf 'TOKENHUD_KEY=%s\n' "$TOKENHUD_KEY" >>"$ROOT/.env"
  echo "generated an ingest key → .env (mode 600)"
fi

start_bg server "$BIN"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf -m 1 "$URL/healthz" >/dev/null 2>&1 && break
  sleep 0.3
done
if curl -sf -m 2 "$URL/healthz" >/dev/null 2>&1; then
  echo "server up → $URL   (db: data/tokenhud.db)"
else
  echo "server did not come up — see logs/server.log" >&2
  exit 1
fi

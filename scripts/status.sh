#!/usr/bin/env bash
# One glance: what is up, where, and what the server is holding.
#
#   ./scripts/status.sh
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"

URL="http://127.0.0.1:$PORT"

row() { printf '  %-8s %s\n' "$1" "$2"; }

# ── server ──
if curl -sf -m 2 "$URL/healthz" >/dev/null 2>&1; then
  detail="up → $URL"
  counts="$(curl -sf -m 2 "$URL/api/v1/overview" 2>/dev/null |
    python3 -c 'import json,sys
d=json.load(sys.stdin); s=d.get("store",{}); h=d.get("hosts",[])
up=sum(1 for x in h if x.get("status")=="up")
print("%d machine(s), %d reporting - %s snapshots - %.1f MB db"
      % (len(h), up, s.get("snapshots", 0), s.get("bytes", 0)/1e6))' 2>/dev/null)"
  [ -n "$counts" ] && detail="$detail
           $counts"
  row server "$detail"
elif alive "$RUN/server.pid"; then
  row server "process up (pid $(cat "$RUN/server.pid")) but $URL not answering — logs/server.log"
else
  row server "down   → ./scripts/start-server.sh"
fi

# ── agent ──
if alive "$RUN/agent.pid"; then
  last="$(tail -1 "$LOGS/agent.log" 2>/dev/null)"
  row agent "up (pid $(cat "$RUN/agent.pid"))${last:+
           last: $last}"
else
  row agent "down   → ./scripts/start-agent.sh"
fi

# ── portal ──
if curl -sf -m 2 -o /dev/null "http://localhost:$PORTAL_PORT" 2>/dev/null; then
  # Serving, but from the module graph it booted with — a dependency added
  # since then resolves to nothing and the page renders blank.
  if [ -f "$ROOT/site/node_modules/.package-lock.json" ] \
    && [ "$ROOT/site/node_modules/.package-lock.json" -nt "$RUN/portal.pid" ] 2>/dev/null; then
    row portal "up → http://localhost:$PORTAL_PORT
           STALE: dependencies changed since it started — ./scripts/start-portal.sh restarts it"
  else
    row portal "up → http://localhost:$PORTAL_PORT"
  fi
else
  row portal "down   → ./scripts/start-portal.sh"
fi

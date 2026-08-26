#!/usr/bin/env bash
# Start the portal — the landing page with the dashboard behind it — as a
# local dev server (and check first).
#
#   ./scripts/start-portal.sh          http://localhost:5174, hot reload
#
# This is the LOCAL portal: Vite serving site/ with live reload, the same
# thing the Playwright tests point at. Production is different on purpose —
# Amplify builds site/ and serves the static result; nothing here deploys.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"

URL="http://localhost:$PORTAL_PORT"
MODULES="$ROOT/site/node_modules"
# npm rewrites this on every install and at no other time — the directory's
# own mtime moves when a build writes a cache, which is not a dependency
# change and must not read as one.
INSTALLED="$MODULES/.package-lock.json"

# A dev server started before a dependency was added keeps serving the module
# graph it booted with: the page goes blank and the only clue is a "failed to
# resolve import" buried in the log. The pidfile is written at start, so it
# doubles as the timestamp to compare against.
if [ -f "$INSTALLED" ] && [ "$INSTALLED" -nt "$RUN/portal.pid" ] 2>/dev/null; then
  if alive "$RUN/portal.pid"; then
    echo "dependencies changed since the portal started — it is serving a stale"
    echo "module graph (blank page, 'failed to resolve import' in logs/portal.log)."
    echo "Restarting it."
    stop_one portal "$PORTAL_PORT"
    rm -rf "$MODULES/.vite"   # the dep-optimizer cache is stale for the same reason
  fi
fi

if curl -sf -m 2 -o /dev/null "$URL" 2>/dev/null; then
  echo "portal already running → $URL"
  exit 0
fi
if alive "$RUN/portal.pid"; then
  echo "portal process is up (pid $(cat "$RUN/portal.pid")) but $URL is not answering —"
  echo "check logs/portal.log, or ./scripts/stop-portal.sh and start again."
  exit 1
fi

command -v npm >/dev/null 2>&1 || {
  echo "npm not found — the portal needs Node: https://nodejs.org" >&2
  exit 1
}
if [ ! -d "$MODULES" ]; then
  echo "installing portal dependencies (npm ci, first run only)…"
  (cd "$ROOT/site" && npm ci --silent) || exit 1
elif [ "$ROOT/site/package.json" -nt "$MODULES" ]; then
  # package.json moved after the last install: something was added and never
  # installed, which is the other half of the blank-page story.
  echo "package.json is newer than node_modules — installing what changed…"
  (cd "$ROOT/site" && npm install --silent) || exit 1
fi

# The vite binary itself, not an npx wrapper — the pidfile should name the
# process that actually serves, so stopping it stops the thing.
(cd "$ROOT/site" && start_bg portal "$ROOT/site/node_modules/.bin/vite" --port "$PORTAL_PORT" --strictPort)

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  curl -sf -m 1 -o /dev/null "$URL" 2>/dev/null && break
  sleep 0.4
done
if curl -sf -m 2 -o /dev/null "$URL" 2>/dev/null; then
  echo "portal up → $URL"
else
  echo "portal did not come up — see logs/portal.log" >&2
  exit 1
fi

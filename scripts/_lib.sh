# Shared plumbing for the start/stop/status scripts. Not a command — nothing
# here runs on its own. Sourced after each script's bash re-exec guard.
#
# Conventions every script honors:
#   .run/<name>.pid    who is running (same dir the old launcher used, so
#                      these scripts manage processes it started too)
#   logs/<name>.log    where its output goes
#   .env               TOKENHUD_* for a local install, key included, mode 600

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[1]}")/.."
ROOT="$PWD"
RUN="$ROOT/.run"
LOGS="$ROOT/logs"
mkdir -p "$RUN" "$LOGS"

PORT="${TOKENHUD_PORT:-8787}"
PORTAL_PORT="${TOKENHUD_PORTAL_PORT:-5174}"

alive() { # alive <pidfile> — is the process it names still up?
  local f="$1" p
  [ -f "$f" ] || return 1
  p="$(cat "$f" 2>/dev/null)"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

port_pid() { # port_pid <port> — pid listening on the port, if any
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

start_bg() { # start_bg <name> <cmd...> — detach, pidfile, log
  local name="$1"
  shift
  local log="$LOGS/$name.log"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >>"$log" 2>&1 &
  else
    nohup "$@" >>"$log" 2>&1 &
  fi
  echo $! >"$RUN/$name.pid"
  echo "$name started (pid $(cat "$RUN/$name.pid")) → logs/$name.log"
}

stop_one() { # stop_one <name> [port] — pidfile first, port as the fallback
  local name="$1" port="${2:-}" p=""
  if alive "$RUN/$name.pid"; then
    p="$(cat "$RUN/$name.pid")"
  elif [ -n "$port" ]; then
    p="$(port_pid "$port" || true)"
    [ -n "$p" ] && echo "$name has no pidfile — stopping pid $p on port $port instead"
  fi
  if [ -z "$p" ]; then
    echo "$name is not running"
    rm -f "$RUN/$name.pid"
    return 0
  fi
  kill "$p" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.3
  done
  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null
  rm -f "$RUN/$name.pid"
  echo "$name stopped"
}

load_env() { # the local install's TOKENHUD_* settings, if recorded
  if [ -f "$ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env"
    set +a
  fi
}

build_rust() { # build_rust <dir> — quiet when current, honest when not
  echo "building $1 (cargo, release — quick when nothing changed)…"
  (cd "$ROOT/$1" && cargo build --release --quiet) || {
    echo "build failed — run: cd $1 && cargo build --release" >&2
    exit 1
  }
}

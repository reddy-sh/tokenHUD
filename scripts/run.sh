#!/usr/bin/env bash
# Invoked as `sh scripts/run.sh`? Then the shebang above was bypassed and this
# is running under whatever /bin/sh happens to be — bash on a Mac, dash on most
# Linux. This script needs bash for `set -o pipefail`, and under dash it dies
# with a complaint about an illegal option rather than anything a reader could
# act on. Re-exec instead.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# One command to run the whole stack in the background.
#
#   ./scripts/run.sh            start server + agent, detached, and return
#   ./scripts/run.sh stop       stop both
#   ./scripts/run.sh restart    after any change to server/ or agent/
#   ./scripts/run.sh status     what is up, what it holds, whether it is current
#   ./scripts/run.sh logs       follow both logs
#   ./scripts/run.sh selftest   run every test in the repo
#
# It detaches on its own, so a trailing `&` is unnecessary — but harmless if
# you type it out of habit.
#
# Why a launcher rather than two terminals: starting the pieces by hand leaves
# duplicates behind. This machine collected three stray processes that way,
# one of them an agent invoked with the server script as its argument. A
# pidfile and a liveness check make double-starting impossible, so the answer
# to "is it running?" is one command instead of a `ps` and a squint.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
RUN="$ROOT/.run"
LOGS="$ROOT/logs"
mkdir -p "$RUN" "$LOGS"

PORT="${TOKENHUD_PORT:-8787}"
URL="http://127.0.0.1:$PORT"

# ── env ─────────────────────────────────────────────────────────────────
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

alive() {  # alive <pidfile>
  local f="$1" p
  [ -f "$f" ] || return 1
  p="$(cat "$f" 2>/dev/null)" || return 1
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

pid_of() { cat "$1" 2>/dev/null; }

# A running process keeps the code it was started with. Editing a file does
# not change what is serving, and the gap between the two is silent — you get
# the old behaviour and no reason why. The pidfile is written at start, so
# anything newer than it is code the running process has never seen.
code_is_stale() {  # code_is_stale <pidfile> <dir>
  local pf="$1" dir="$2"
  [ -f "$pf" ] || return 1
  [ -n "$(find "$dir" -name '*.py' -newer "$pf" -print -quit 2>/dev/null)" ]
}

start_one() {  # start_one <name> <logfile> <cmd...>
  local name="$1" log="$2"; shift 2
  local pf="$RUN/$name.pid"
  if alive "$pf"; then
    echo "  $name already running (pid $(pid_of "$pf"))"
    return 0
  fi
  # setsid where available so the children survive this shell closing; nohup
  # is the portable fallback on macOS, which has no setsid.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >> "$log" 2>&1 &
  else
    nohup "$@" >> "$log" 2>&1 &
  fi
  echo $! > "$pf"
  echo "  $name started (pid $(pid_of "$pf")) → ${log#$ROOT/}"
}

stop_one() {
  local name="$1"
  local pf="$RUN/$name.pid"
  if alive "$pf"; then
    local p; p="$(pid_of "$pf")"
    kill "$p" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null
    echo "  $name stopped (was pid $p)"
  else
    echo "  $name not running"
  fi
  rm -f "$pf"
}

# Anything started by hand before this script existed has no pidfile, so it
# would survive `stop` and then fight the new copy for the port.
reap_strays() {
  local mine="" p
  for f in "$RUN"/*.pid; do [ -f "$f" ] && mine="$mine $(cat "$f" 2>/dev/null)"; done
  for p in $(/bin/ps -Ao pid,command | grep -E "tokenhud-agent|tokenhud-server" | grep -v grep | awk '{print $1}'); do
    case " $mine " in *" $p "*) continue ;; esac
    kill "$p" 2>/dev/null && echo "  reaped stray pid $p"
  done
}

# The agent is a binary now, and it has to be built before it can be run. Say
# so plainly and stop, rather than starting a server with nothing reporting to
# it — a board with no agent looks like an idle machine, which is worse than an
# error because it looks like data.
# Both are binaries now, and both have to be built before they can be run. Say
# so plainly and stop, rather than starting half a stack: a board with no agent
# looks like an idle machine, which is worse than an error because it looks like
# data.
server_bin() {
  SERVER="$ROOT/server/target/release/tokenhud-server"
  if [ ! -x "$SERVER" ]; then
    echo "  no server binary at server/target/release/"
    echo "  build it once:  ./scripts/build.sh"
    exit 1
  fi
}

agent_bin() {
  AGENT="$ROOT/agent/target/release/tokenhud-agent"
  if [ ! -x "$AGENT" ]; then
    echo "  no agent binary at agent/target/release/"
    echo "  build it once:  ./scripts/build.sh"
    exit 1
  fi
}

cmd_start() {
  echo "TokenHUD"
  if [ -z "${TOKENHUD_KEY:-}" ]; then
    echo "  TOKENHUD_KEY is not set. Create one:"
    echo "    ./server/target/release/tokenhud-server --new-key   # then put it in .env"
    exit 2
  fi
  reap_strays
  server_bin
  start_one server "$LOGS/server.log" "$SERVER"

  # Wait for the port before starting the agent, so its first post lands
  # instead of spooling and making the board look empty for one interval.
  for _ in $(seq 1 40); do
    curl -fsS "$URL/healthz" >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! curl -fsS "$URL/healthz" >/dev/null 2>&1; then
    echo "  server did not come up — see ${LOGS#$ROOT/}/server.log"
    exit 1
  fi

  agent_bin
  start_one agent "$LOGS/agent.log" "$AGENT"
  echo
  echo "  → $URL"
  echo "  stop: ./scripts/run.sh stop   ·   logs: ./scripts/run.sh logs"
}

cmd_status() {
  local s a
  alive "$RUN/server.pid" && s="up (pid $(pid_of "$RUN/server.pid"))" || s="down"
  alive "$RUN/agent.pid"  && a="up (pid $(pid_of "$RUN/agent.pid"))"  || a="down"
  echo "  server  $s"
  echo "  agent   $a"
  printf '  http    '; curl -fsS -o /dev/null -w "%{http_code}\n" "$URL/healthz" 2>/dev/null || echo "unreachable"
  if curl -fsS "$URL/api/v1/overview" >/dev/null 2>&1; then
    curl -fsS "$URL/api/v1/overview" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for h in d.get('hosts',[]):
    age=h.get('ageSeconds')
    print(f\"  host    {h['host']}  {h['status']}  last seen {age:.0f}s ago\" if age is not None else f\"  host    {h['host']}  {h['status']}\")
st=d.get('store',{})
n, k, b = st.get('snapshots',0), st.get('keyframes',0), st.get('bytes',0)
# Readings are stored as a keyframe every so often and a difference in
# between, so the count alone no longer says what the file is doing.
print('  stored  %d readings · %d keyframes, %d differences · %.1f MB'
      % (n, k, n - k, b / 1048576))
" 2>/dev/null
  fi
  local stale=""
  alive "$RUN/server.pid" && code_is_stale "$RUN/server.pid" "$ROOT/server" && stale="server"
  alive "$RUN/agent.pid"  && code_is_stale "$RUN/agent.pid"  "$ROOT/agent"  && stale="${stale:+$stale and }agent"
  if [ -n "$stale" ]; then
    echo
    echo "  ! $stale is running code older than the files on disk."
    echo "  ! ./scripts/run.sh restart"
  fi
}

cmd_selftest() {
  exec "$ROOT/scripts/build.sh" --check
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    stop_one agent; stop_one server; reap_strays ;;
  restart) stop_one agent; stop_one server; reap_strays; sleep 1; cmd_start ;;
  status)  cmd_status ;;
  logs)    tail -n 40 -f "$LOGS/server.log" "$LOGS/agent.log" ;;
  selftest) cmd_selftest ;;
  *)       echo "usage: $0 [start|stop|restart|status|logs|selftest]"; exit 1 ;;
esac

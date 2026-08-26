#!/usr/bin/env bash
# Stop the agent. Nothing else is touched; the server keeps serving whatever
# it last heard.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"
stop_one agent

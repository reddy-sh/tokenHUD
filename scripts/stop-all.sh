#!/usr/bin/env bash
# Stop everything, reverse order of start.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
HERE="$(dirname "$0")"
"$HERE/stop-portal.sh"
"$HERE/stop-agent.sh"
"$HERE/stop-server.sh"

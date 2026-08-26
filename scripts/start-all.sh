#!/usr/bin/env bash
# Start everything, in the order that matters: the server first (so the agent
# has somewhere to report), then the agent, then the portal.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
HERE="$(dirname "$0")"
"$HERE/start-server.sh" && "$HERE/start-agent.sh" && "$HERE/start-portal.sh"

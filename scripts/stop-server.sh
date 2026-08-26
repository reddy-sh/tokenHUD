#!/usr/bin/env bash
# Stop the API server. Agents keep collecting and spool their readings; the
# board fills the gap in when the server is back.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"
stop_one server "$PORT"

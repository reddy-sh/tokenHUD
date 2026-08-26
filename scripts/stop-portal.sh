#!/usr/bin/env bash
# Stop the local portal dev server.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
. "$(dirname "$0")/_lib.sh"
stop_one portal "$PORTAL_PORT"

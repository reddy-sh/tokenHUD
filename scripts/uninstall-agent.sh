#!/bin/sh
# Remove the TokenHUD agent from this account's machine.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/uninstall-agent.sh | sh
#
# It intentionally leaves tokenhud-server alone. This script removes only the
# agent service, the common installed copies of its binary, and ~/.tokenhud —
# the sole directory the agent creates for its enrollment, index and spool.

set -eu

say() { printf '%s\n' "$*"; }

case "$(uname -s)" in
  Darwin)
    # A bootout can fail harmlessly when the unit was never installed or this
    # shell has no logged-in graphical session.
    launchctl bootout "gui/$(id -u)/com.tokenhud.agent" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/com.tokenhud.agent.plist"
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now tokenhud-agent.service 2>/dev/null || true
      rm -f "$HOME/.config/systemd/user/tokenhud-agent.service"
      systemctl --user daemon-reload 2>/dev/null || true
    fi
    ;;
esac

# Covers a foreground run and the common launchd/systemd unit. Restrict the
# process match to the current user and the exact executable name.
if command -v pkill >/dev/null 2>&1; then
  pkill -u "$(id -u)" -x tokenhud-agent 2>/dev/null || true
fi

# Route A installs to ~/.local/bin; Route C uses ~/.cargo/bin. A copied binary
# conventionally lives in ~/.local/bin too. Do not guess at arbitrary paths.
rm -f "$HOME/.local/bin/tokenhud-agent" "$HOME/.cargo/bin/tokenhud-agent"
rm -rf "$HOME/.tokenhud"

say "TokenHUD agent removed. tokenhud-server, if installed, was left running."

#!/bin/sh
# Install tokenhud-agent and optionally enroll.
#
# One command, shown by the "Add a machine" modal:
#   curl -fsSL https://platform.tokenhud.com/install.sh | ENROLL="<link>" sh
#
# The board names the machine <first>-<hostname>-<id> from the hostname the
# agent reports at enrolment, so it arrives already identifiable. Override the
# hostname half when this box's real hostname is not the name you think of it
# by — a numbered cloud instance, or two laptops restored from the same backup:
#   curl -fsSL … | ENROLL="<link>" TOKENHUD_HOST="build-box" sh
#
# Every download is checksum-verified against the .sha256 sidecar the
# release publishes beside it, so a corrupted or tampered binary fails
# loudly instead of installing quietly.
set -e

CDN="https://d3gu0e7g3rcz5n.cloudfront.net"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

echo ""
echo "  TokenHUD — installing agent"
echo ""

# ── detect platform ──────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="apple-darwin" ;;
  Linux)  os="unknown-linux-gnu" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

TARGET="${arch}-${os}"

if command -v shasum >/dev/null 2>&1; then
  SHA() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  SHA() { sha256sum "$1" | cut -d' ' -f1; }
else
  echo "Neither shasum nor sha256sum found — refusing to install unverified binaries."
  exit 1
fi

# ── download ─────────────────────────────────────────────────────────

LATEST="$(curl -fsSL "${CDN}/latest/version.txt")"

if [ -z "$LATEST" ]; then
  echo "Could not determine latest release."
  exit 1
fi

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BINARY="tokenhud-agent"
ASSET="${BINARY}-${TARGET}"
URL="${CDN}/latest/${ASSET}"

echo "  1. Installing ${BINARY} ${LATEST} (${TARGET})…"
echo "     to: ${INSTALL_DIR}/${BINARY}"

curl -fsSL "$URL" -o "${TMP}/${BINARY}"
curl -fsSL "${URL}.sha256" -o "${TMP}/${BINARY}.sha256"

WANT="$(cut -d' ' -f1 <"${TMP}/${BINARY}.sha256")"
GOT="$(SHA "${TMP}/${BINARY}")"
if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then
  echo "     CHECKSUM MISMATCH — refusing to install."
  echo "       expected: ${WANT:-<empty>}"
  echo "       got:      ${GOT}"
  exit 1
fi
echo "     sha256 verified"

chmod +x "${TMP}/${BINARY}"
mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"

if "${INSTALL_DIR}/${BINARY}" --version >/dev/null 2>&1; then
  echo "     $("${INSTALL_DIR}/${BINARY}" --version)"
fi

# Ensure the binary is on PATH for the enroll step below.
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) export PATH="${INSTALL_DIR}:${PATH}" ;;
esac

echo ""

# ── enroll ───────────────────────────────────────────────────────────

if [ -n "$ENROLL" ]; then
  echo "  2. Enrolling this machine…"
  # Exported rather than merely set, because the agent reads it from its own
  # environment and it is the agent, not this script, that reports the name.
  if [ -n "${TOKENHUD_HOST:-}" ]; then
    export TOKENHUD_HOST
    echo "     reporting as: ${TOKENHUD_HOST}"
  else
    echo "     reporting as: $(hostname 2>/dev/null || echo 'this machine')"
  fi
  echo ""
  # stdin is the pipe from curl, which is at EOF by now. The agent's
  # consent prompt needs the real terminal, so redirect from /dev/tty.
  exec "${INSTALL_DIR}/${BINARY}" enroll "$ENROLL" </dev/tty
else
  echo "  Installed to ${INSTALL_DIR}/${BINARY}"
  echo ""
  echo "  To enroll this machine, run:"
  echo "    tokenhud-agent enroll \"<link from the board>\""
  echo ""
  echo "  The board names it after this machine's hostname. To report a"
  echo "  different name, set TOKENHUD_HOST before enrolling."
fi

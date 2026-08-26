#!/bin/sh
# Install tokenhud-agent and tokenhud-server from the latest GitHub Release.
# Usage: curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
#
# Every download is checksum-verified against the .sha256 the release
# publishes beside it, so a corrupted or tampered binary fails loudly
# instead of installing quietly.
set -e

REPO="reddy-sh/tokenhud"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# Detect OS and architecture
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

# One of these ships everywhere this script supports.
if command -v shasum >/dev/null 2>&1; then
  SHA() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  SHA() { sha256sum "$1" | cut -d' ' -f1; }
else
  echo "Neither shasum nor sha256sum found — refusing to install unverified binaries."
  exit 1
fi

# Get latest tag
LATEST="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"

if [ -z "$LATEST" ]; then
  echo "Could not determine latest release."
  exit 1
fi

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for BINARY in tokenhud-agent tokenhud-server; do
  ASSET="${BINARY}-${TARGET}"
  URL="https://github.com/${REPO}/releases/download/${LATEST}/${ASSET}"

  echo "Installing ${BINARY} ${LATEST} (${TARGET})..."
  echo "  from: ${URL}"
  echo "  to:   ${INSTALL_DIR}/${BINARY}"

  curl -fsSL "$URL" -o "${TMP}/${BINARY}"
  curl -fsSL "${URL}.sha256" -o "${TMP}/${BINARY}.sha256"

  # The published file is `shasum -a 256` output: "<hex>  <path>".
  WANT="$(cut -d' ' -f1 <"${TMP}/${BINARY}.sha256")"
  GOT="$(SHA "${TMP}/${BINARY}")"
  if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then
    echo "  CHECKSUM MISMATCH for ${ASSET} — refusing to install."
    echo "    expected: ${WANT:-<empty>}"
    echo "    got:      ${GOT}"
    exit 1
  fi
  echo "  sha256 verified"

  chmod +x "${TMP}/${BINARY}"
  mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"

  if "${INSTALL_DIR}/${BINARY}" --version >/dev/null 2>&1; then
    echo "  ok:   $("${INSTALL_DIR}/${BINARY}" --version)"
  else
    echo "  ok"
  fi
  echo ""
done

echo "Both installed to ${INSTALL_DIR}/"
echo ""
echo "Two ways on from here — pick one."
echo ""
echo "Cloud (the board is at tokenhud.com):"
echo "  Sign in, then Machines → Add machine, and run the enroll command it"
echo "  shows you:"
echo "    tokenhud-agent enroll \"<ingest-url>#<token>\""
echo "  It lists what it will read and asks first, waits for the machine to be"
echo "  approved, then starts reporting in that same command — the board fills"
echo "  in from the first reading. Nothing else to configure:"
echo "  ~/.tokenhud/machine.json holds the server and this machine's own key."
echo "  To keep it running across logins, install the launchd or systemd unit"
echo "  — see agent/INSTALL.md."
echo ""
echo "Self-host (your own server, no account):"
echo "  tokenhud-server --new-key        # prints an ingest key"
echo "  export TOKENHUD_KEY=<key>"
echo "  tokenhud-server &                # the API, on http://127.0.0.1:8787"
echo "  tokenhud-agent                   # starts sending readings"
echo "  The server is API-only — no dashboard ships in it, and the portal reads"
echo "  the cloud rather than your server. Read it directly:"
echo "    curl http://127.0.0.1:8787/api/v1/overview"

# Check PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "NOTE: ${INSTALL_DIR} is not on your PATH."
    echo "Add it with:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

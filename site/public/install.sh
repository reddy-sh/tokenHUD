#!/bin/sh
# Install tokenhud-agent from the latest GitHub Release and optionally enroll.
#
# One command, shown by the "Add a machine" modal:
#   curl -fsSL https://platform.tokenhud.com/install.sh | ENROLL="<link>" sh
#
# Every download is checksum-verified against the .sha256 the release
# publishes beside it, so a corrupted or tampered binary fails loudly
# instead of installing quietly.
set -e

REPO="reddy-sh/tokenhud"
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

LATEST="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"

if [ -z "$LATEST" ]; then
  echo "Could not determine latest release."
  exit 1
fi

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BINARY="tokenhud-agent"
ASSET="${BINARY}-${TARGET}"
URL="https://github.com/${REPO}/releases/download/${LATEST}/${ASSET}"

echo "  1. Installing ${BINARY} ${LATEST} (${TARGET})…"
echo "     from: ${URL}"
echo "     to:   ${INSTALL_DIR}/${BINARY}"

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
  echo ""
  exec "${INSTALL_DIR}/${BINARY}" enroll "$ENROLL"
else
  echo "  Installed to ${INSTALL_DIR}/${BINARY}"
  echo ""
  echo "  To enroll this machine, run:"
  echo "    tokenhud-agent enroll \"<link from the board>\""
fi

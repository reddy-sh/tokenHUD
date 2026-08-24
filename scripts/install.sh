#!/bin/sh
# Install tokenhud-agent from the latest GitHub Release.
# Usage: curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
set -e

REPO="reddy-sh/tokenhud"
BINARY="tokenhud-agent"
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

TARGET="${BINARY}-${arch}-${os}"

# Get latest tag
LATEST="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"

if [ -z "$LATEST" ]; then
  echo "Could not determine latest release."
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${LATEST}/${TARGET}"

echo "Installing ${BINARY} ${LATEST} (${arch}-${os})..."
echo "  from: ${URL}"
echo "  to:   ${INSTALL_DIR}/${BINARY}"

mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/${BINARY}"
chmod +x "${INSTALL_DIR}/${BINARY}"

# Verify
if "${INSTALL_DIR}/${BINARY}" --version >/dev/null 2>&1; then
  echo ""
  echo "Installed: $("${INSTALL_DIR}/${BINARY}" --version)"
else
  echo ""
  echo "Installed ${BINARY} to ${INSTALL_DIR}/${BINARY}"
fi

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

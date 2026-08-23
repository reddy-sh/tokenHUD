#!/usr/bin/env sh
# TokenHUD installer.
#
#   curl -fsSL https://tokenhud.com/install.sh -o install.sh
#   less install.sh          # please actually do this
#   sh install.sh
#
# Deliberately not `curl | sh`. This tool's entire claim is that it shows you
# what it reads before it reads it; asking you to pipe an unread script from the
# internet into your shell would be the same trust you are being sold an
# alternative to. It is kept short so that reading it is realistic.
#
# It installs two binaries and writes one directory. It asks before the agent
# reads anything, and it prints the full list of files first.
#
# Undo everything:  sh install.sh --uninstall
set -eu

REPO="reddy-sh/tokenhud"
PREFIX="${TOKENHUD_PREFIX:-$HOME/.local/bin}"
STATE="${TOKENHUD_STATE:-$HOME/.tokenhud}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── uninstall ───────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  say "Removing TokenHUD."
  for b in tokenhud-agent tokenhud-server; do
    [ -f "$PREFIX/$b" ] && rm -f "$PREFIX/$b" && say "  removed $PREFIX/$b"
  done
  if [ -d "$STATE" ]; then
    say "  $STATE holds your index, spool and consent record."
    printf '  delete it too? [y/N] '
    read -r a </dev/tty || a=n
    case "$a" in y|Y|yes) rm -rf "$STATE"; say "  removed $STATE" ;; *) say "  kept $STATE" ;; esac
  fi
  say "Done. Nothing else was ever written."
  exit 0
fi

# ── platform ────────────────────────────────────────────────────────────
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)  TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  Linux-aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  Linux-x86_64)  TARGET=x86_64-unknown-linux-gnu ;;
  *) die "no build for $OS-$ARCH yet. Build from source: https://github.com/$REPO" ;;
esac

say ""
say "TokenHUD — a heads-up display for the AI agents on your machine."
say "  platform  $OS $ARCH"
say "  binaries  $PREFIX"
say "  state     $STATE   (the only directory it writes)"
say ""

# ── get the binaries ────────────────────────────────────────────────────
mkdir -p "$PREFIX"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

VERSION="${TOKENHUD_VERSION:-latest}"
BASE="https://github.com/$REPO/releases/${VERSION:+download/}$VERSION"
[ "$VERSION" = latest ] && BASE="https://github.com/$REPO/releases/latest/download"

if curl -fsSL --head "$BASE/tokenhud-$TARGET.tar.gz" >/dev/null 2>&1; then
  say "Downloading $VERSION for $TARGET…"
  curl -fsSL "$BASE/tokenhud-$TARGET.tar.gz"        -o "$TMP/t.tar.gz"
  curl -fsSL "$BASE/tokenhud-$TARGET.tar.gz.sha256" -o "$TMP/t.sha256"

  # Verify before unpacking, not after.
  ( cd "$TMP" && if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c t.sha256
    else
      shasum -a 256 -c t.sha256
    fi ) >/dev/null 2>&1 || die "checksum mismatch — do not run this binary. Report it at https://github.com/$REPO/issues"
  say "  checksum verified: $(cut -d' ' -f1 < "$TMP/t.sha256" | cut -c1-16)…"

  tar -xzf "$TMP/t.tar.gz" -C "$TMP"
  mv "$TMP/tokenhud-agent" "$TMP/tokenhud-server" "$PREFIX/"
  chmod +x "$PREFIX/tokenhud-agent" "$PREFIX/tokenhud-server"

  # macOS quarantines anything downloaded. Until the binaries are notarised,
  # say so plainly rather than silently stripping the flag.
  if [ "$OS" = Darwin ] && xattr -p com.apple.quarantine "$PREFIX/tokenhud-agent" >/dev/null 2>&1; then
    say ""
    say "  macOS has quarantined these because they are not yet notarised."
    say "  Inspect them, then clear it yourself:"
    say "    xattr -d com.apple.quarantine $PREFIX/tokenhud-agent $PREFIX/tokenhud-server"
  fi
else
  command -v cargo >/dev/null 2>&1 || die "no release for $TARGET yet, and cargo is not installed.
  Install Rust from https://rustup.rs and run this again, or clone and run ./scripts/build.sh"
  say "No published binary for $TARGET yet — building from source (about 30s)…"
  SRC="$TMP/src"
  git clone --depth 1 "https://github.com/$REPO" "$SRC" >/dev/null 2>&1 || die "clone failed"
  ( cd "$SRC" && cargo build --release --manifest-path agent/Cargo.toml  >/dev/null 2>&1 \
                 && cargo build --release --manifest-path server/Cargo.toml >/dev/null 2>&1 ) \
    || die "build failed — run it by hand in $SRC to see why"
  cp "$SRC/agent/target/release/tokenhud-agent"   "$PREFIX/"
  cp "$SRC/server/target/release/tokenhud-server" "$PREFIX/"
fi

say "  installed tokenhud-agent and tokenhud-server"

# ── the part that matters ───────────────────────────────────────────────
# The agent prints its own manifest and asks for itself. The installer does not
# paraphrase it: a list written here would drift from what the binary does, and
# a disclosure that drifts is worse than none.
say ""
"$PREFIX/tokenhud-agent" --what-i-read

printf 'Install and start it? [y/N] '
read -r ANSWER </dev/tty || ANSWER=n
case "$ANSWER" in
  y|Y|yes|YES) ;;
  *) say ""; say "Stopped. Nothing was read. The binaries are in $PREFIX if you want to look."; exit 0 ;;
esac

"$PREFIX/tokenhud-agent" --accept >/dev/null

# ── configure ───────────────────────────────────────────────────────────
mkdir -p "$STATE"
ENVF="$STATE/env"
if [ ! -f "$ENVF" ]; then
  KEY="$("$PREFIX/tokenhud-server" --new-key)"
  printf 'TOKENHUD_SERVER=http://127.0.0.1:8787\nTOKENHUD_KEY=%s\n' "$KEY" > "$ENVF"
  chmod 600 "$ENVF"
  say "  wrote $ENVF with a fresh ingest key"
else
  say "  kept the existing $ENVF"
fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) say ""; say "  $PREFIX is not on your PATH. Add it:"
     say "    echo 'export PATH=\"$PREFIX:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
esac

say ""
say "Done. Start both:"
say ""
say "  set -a; . $ENVF; set +a"
say "  tokenhud-server &"
say "  tokenhud-agent &"
say ""
say "Then open http://127.0.0.1:8787"
say ""
say "  tokenhud-agent --what-i-read    what it reads, any time"
say "  tokenhud-agent --dry-run        exactly what it would send"
say "  sh install.sh --uninstall       remove all of it"
say ""
say "To keep it running across logins, see agent/dist/ for launchd and systemd units."

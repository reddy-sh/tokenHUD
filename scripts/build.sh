#!/usr/bin/env bash
# Run as `sh scripts/build.sh`? The shebang was bypassed; this needs bash for
# `set -o pipefail`, so re-exec rather than die on an illegal option.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Build the agent and the server.
#
#   ./scripts/build.sh              release builds of both
#   ./scripts/build.sh --check      build, then run every test
#
# Two binaries, no runtime, nothing to install beside them.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is not installed."
  echo "  https://rustup.rs   —   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

for crate in agent server; do
  echo "building tokenhud-${crate} (release)…"
  cargo build --release --manifest-path "$ROOT/$crate/Cargo.toml"
done

if [ "${1:-}" = "--check" ]; then
  for crate in agent server; do
    echo
    echo "testing ${crate}…"
    cargo test --manifest-path "$ROOT/$crate/Cargo.toml" 2>&1 | grep -E "^test |test result" || true
  done
fi

echo
for crate in agent server; do
  bin="$ROOT/$crate/target/release/tokenhud-$crate"
  printf "  %-24s %s MB\n" "tokenhud-$crate" "$(/bin/ls -l "$bin" | awk '{printf "%.2f", $5/1048576}')"
done
echo
echo "Start both:  ./scripts/run.sh"

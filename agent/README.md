# tokenhud-agent (Rust)

The agent, rewritten. Same readings, same payload, one binary and no runtime.

It replaced a Python implementation that lived here until it had been diffed
against this one field by field - 860 leaves of a real payload, zero
differences. That diff is gone with the thing it compared against; what
survived it is `tests/machine.rs`, which runs against your real machine.

**Installing it properly - a PATH binary, launch at login, a Linux box, the
uninstall - is [INSTALL.md](INSTALL.md).** This page is the short version.

## Install (no Rust required)

```bash
curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
```

Prebuilt binaries for macOS and Linux are published to
[GitHub Releases](https://github.com/reddy-sh/tokenhud/releases/latest) on
every tagged version.

## Build from source and run

```bash
./scripts/build.sh                  # needs cargo; ~20s
./scripts/run.sh restart
./scripts/run.sh status                   # says "agent up (pid …) · rust"
```

To look before you switch - this sends nothing and writes nothing but the index:

```bash
./agent/target/release/tokenhud-agent --dry-run | head -40
```

The index in `~/.tokenhud/transcripts.json` is unchanged in format, so an
existing install carries straight over with no re-scan.

## Measured on this machine

| | the Python agent it replaced | this one |
|---|---:|---:|
| resident, running | 24.4 MB | **6.5 MB** |
| warm cycle | 130-200 ms · 33 MB peak | **50 ms · 13 MB peak** |
| cold scan, 1.1 GB corpus | 590 MB peak | **95 MB peak** |
| ships as | assumes a `python3` | **1.94 MB binary** |

The cold-scan row is the one that matters for a laptop: peak memory is now a
property of a 4 MB constant rather than of how large your largest transcript is.

## Tests

```bash
cargo test --manifest-path agent/Cargo.toml
```

24 of them: 13 unit tests, and 11 in `tests/machine.rs` that run the real
collectors against your real machine and mock nothing. A check whose source is
absent - no transcripts, no usage cache - skips and says why rather than
failing. `cargo test -- --nocapture` prints those.

The one that matters most is `reading_the_limits_never_writes_claude_json`,
which asserts mechanically what `SECURITY.md` promises in prose.

## Layout

| file | what it is |
|---|---|
| `src/main.rs` | the loop, the POST, the disk spool |
| `src/collect.rs` | every collector - one function each, as in the Python |
| `src/transcripts.rs` | the incremental index: byte offsets, budget, buckets |
| `src/pricing.rs` | the rate card, and Python's banker's rounding reproduced |
| `src/limits.rs` | the plan's usage windows out of `~/.claude.json` |

Four dependencies do real work (`serde_json`, `flate2`, `chrono`, `ureq`) and
two are small (`indexmap`, `sha2`). No async runtime: a 60 ms cycle every 30
seconds does not need one, and not having one is most of why the binary is
under 2 MB.

## Two things worth knowing if you change this

**Rounding.** Python's `round()` is banker's rounding and Rust's is not. Every
dollar figure goes through `pricing::round`, which reproduces it. Use it rather
than `f64::round` or the diff grows a tail of fourth-decimal differences.

**Timestamps.** Python's `isoformat()` prints six decimal places when there are
microseconds and none when there are not. chrono has no mode that does both.
`collect::iso_of` does.

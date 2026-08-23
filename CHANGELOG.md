# Changelog

Notable changes to TokenHUD. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

### Added
- **The agent is now a Rust binary** (`agent/`) — the same readings from the
  same files in the same payload, as one 1.94 MB binary with no interpreter to
  install. On this machine: **6.5 MB resident against the Python agent's
  24.4 MB**, a warm cycle of 50 ms against 130–200 ms, and a cold scan of a
  1.1 GB corpus that peaks at 95 MB rather than 590 MB.
- **The Python agent has been removed.** It served as the oracle first: a
  conformance harness ran both against a frozen copy of real transcripts and
  compared every leaf of both payloads, ending at **860 leaves and zero
  substantive differences** over 150 transcripts. Its eight machine checks
  moved to `agent/tests/machine.rs` before it went, along with three more for
  seams the Python suite never had to cover; the harness itself went with the
  thing it compared against. `~/.tokenhud/transcripts.json` is unchanged, so an
  existing install carries over with no re-scan.
- **The server is now a Rust binary** (`server/`) — same endpoints, same
  database, same wire format, 2.05 MB with SQLite compiled in. Against the
  Python server it replaced: **ingest 2,488 → 5,402 req/s** at 16 concurrent,
  idle RSS **29.5 → 7.7 MB**, and at 1,000 concurrent event-stream watchers the
  Python server refused 390 where this one serves all of them.
- **The Python server has been removed, and the repository has no Python left
  in it.** It was the oracle first: a conformance harness drove both servers
  through the same sequence of state changes and diffed every answer — 24
  checks, zero differing leaves — then its ten checks moved into
  `server/tests/` and it went, along with the harness that needed it.
- **Fixed: floats did not survive being stored and read back.** `serde_json`'s
  default parser is not correctly rounded — it writes `1.1400000000000001` and
  reads back the `f64` that prints as `1.14` — where Python's `json` uses
  `strtod` and does not. `float_roundtrip` is now on in both binaries. Found by
  porting a check, and unfindable by the conformance harness, which compared two
  implementations against each other rather than either against its own input.
- **`scripts/build.sh`** — builds both binaries, `--check` runs every test.
- **`agent/INSTALL.md`** — installation, three routes, with launchd and systemd
  units in `agent/dist/`. Every command in it was run on the machine it was
  written on, and the parts that were not — Linux, cross-compilation — say so
  instead of implying otherwise.
- **`scripts/build-agent.sh`** — builds it, and says what to type next.
- **Usage windows** — your plan's real five-hour and seven-day limits, read from
  Claude Code's own cache. Real percentages and reset instants, with the cache's
  age on the card's face; past an hour the percentages grey out and the
  countdowns stay live, because a reset instant is absolute and does not rot.
- **Recently finished** — agents that were running at one reading and gone by the
  next, derived server-side by diffing consecutive snapshots. Carries both
  timestamps so an ending is reported as a range when the gap was large.
- **Estimated value** — per session, model and day, priced at API list rates and
  labelled as an estimate everywhere it appears. Unpriced models report as
  *unpriced*, never as `$0`.
- **Server-sent events** — the board is pushed to rather than polled; polling
  remains the fallback.
- **A navigation rail** — docked above 1240px, an overlay below, with the nav rows
  doubling as an at-a-glance digest.
- **Print stylesheet and Save as PDF**, with no PDF library.
- **`docs/ARCHITECTURE.md`** — what runs today with the measurements behind it,
  the difference format, the account/device/agent identity model that
  multi-machine needs, and the Python-vs-Node question settled on those numbers
  rather than around them.
- **`scripts/selftest.py`** — ten checks over the server, the store and the
  dashboard, no framework, nothing mocked, and `./scripts/run.sh selftest` to
  run them without remembering the path. The agent's own twenty-four are
  `cargo test`. One of the ten runs the real binary and posts its reading to a
  real server, because that seam is now the only place two languages meet.
- **`run.sh status` says when the running processes are older than the files on
  disk**, and reports what the store holds now that a reading may be a keyframe
  or a difference.
- Inline SVG favicon; the board now makes no external request of any kind.

### Changed
- **History is stored as differences.** A reading is 61 KB and 59 of its 2,388
  leaves change between one reading and the next, so `snapshots` now keeps a
  keyframe every 60 rows and a compressed structural difference in between:
  **0.66 KB a reading instead of 61 KB**, and 4.38 GB per host per month becomes
  0.05 GB. Reading history replays the chain; round-tripping is asserted
  byte-for-byte in the self-test. Rows written before this are read as they are
  and age out with retention — nothing is rewritten.
- **The overview is built once per reading, not once per reader.** It was
  re-read from SQLite, re-parsed and re-serialised for every poll and for every
  open event stream, so fan-out cost grew with the audience.
  **`GET /api/v1/overview` went from 107 to 3,762 req/s** (p50 9.4 ms → 0.21 ms;
  at 64 concurrent readers, p99 214 ms → 11 ms), and pushing a reading to 128
  watchers went from 72 ms to 53 ms.
- **Renamed from AI Mission Control to TokenHUD.** Environment variables moved
  from `AIMC_*` to `TOKENHUD_*`, the state directory from `~/.aimc` to
  `~/.tokenhud`, and the ingest header from `X-AIMC-Key` to `X-TokenHUD-Key`.
- Per-panel dirty checking: an unchanged reading now costs **0.2 ms** to render
  instead of 13.6 ms rebuilding 1993 DOM nodes.
- HTTP/1.1 with keep-alive, and gzip on responses — 69.3 KB to 14.0 KB on the wire.

### Fixed
- **The server listened with a backlog of five.** `socketserver`'s default; one
  browser opens six connections to an origin by itself. Every connection past
  the backlog was refused by the kernel, so nothing appeared in any log.
  Measured with a thousand simultaneous watchers: 512 refused before, 317 after
  — the rest of that ceiling is thread-per-reader, and is in
  `docs/ARCHITECTURE.md` §5 rather than pretended away here.
- **Retention could orphan a difference chain.** Pruning at the cutoff exactly
  would delete a keyframe that surviving rows still needed; the cut is now taken
  at the last keyframe at or before the cutoff, which over-keeps by under an
  hour and can never lose a reading inside the window.
- The event-stream heartbeat re-sent the entire payload every 20 seconds.
- A held-open stream was never closed on page unload, leaking one of the
  browser's six connections per origin until the page could not load at all.

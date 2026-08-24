# Changelog

Notable changes to TokenHUD. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

### Added
- **Fixed: the assistant picker did not pick anything.** Choosing Codex CLI
  redrew Claude Code's panels, unchanged, under a Codex label — same sessions,
  same models, same usage windows, all of them read from `~/.claude`. The board
  collected Codex data and then never read it: `web/index.html` contained no
  reference to `codex` at all. Panels now declare which assistant they belong
  to (`data-tool`), the picker hides the ones that do not, and Codex has its own
  board — tiles, plan windows, sessions, tokens by model, and the approval and
  sandbox policy each session actually ran under, taken from `turn_context` in
  the rollouts rather than from the config file's default. Where those two
  disagree, the panel says so.

  Hiding a panel by setting `hidden` on it was not enough, and the reason is
  worth writing down: `[hidden] { display: none }` comes from the browser's own
  stylesheet and is the weakest rule in the cascade, so `.grid { display: grid }`
  and `.rail-nav a { display: flex }` both outrank it and the panels stayed on
  screen with the attribute set. There was already one local patch for this
  (`.rail select[hidden]`) from an earlier encounter; it is now one author rule
  for the whole sheet.
- **Codex is monitored, not just detected.** The process scanner matched
  `/claude` and nothing else, so a running Codex was invisible and the `tool`
  column the server already keeps on every ending was never filled. Both are
  matched now, on the binary rather than the word — `~/.codex` appears in half
  the command lines on a machine that runs Codex and none of them is a running
  Codex. "Running now" and "Recently finished" follow the picker; Codex also
  gets tokens per day and a projects list built from each rollout's own `cwd`,
  since it has no projects directory to read one from.
- **Governance panels: what an assistant may reach, beside what it did reach.**
  Every other panel answers "what did it spend". These answer "what can it
  touch" — MCP servers with their transport, credentials and call counts;
  permission rules by scope; what runs on a hook; plugins, skills and subagents
  with how often each was actually invoked. Configured and used are separate
  columns and never merged: a server mounted six months ago and never called is
  a row only the pair can state, and a call count cannot tell you a server is
  mounted at all. Servers called but absent from any settings file — the ones a
  plugin or a project `.mcp.json` brought in — are listed as such rather than
  quietly dropped.
- **Tool calls are counted by name.** The transcript index learns a call's tool
  name (`transcripts.json` version 5, so the corpus is re-read once), which is
  what makes "this MCP server has been called 1,386 times" a measurement rather
  than an inference. `subagent_type` and `skill` are taken too, because they
  name a configured capability. Nothing else from a tool's input is read: not
  the command, not the path, not the prompt — asserted by a test that dumps the
  index and greps it.
- **An MCP server's credentials are named and never read.** `env` and `headers`
  are read for their KEYS, so the board can say a server is handed
  `GITHUB_TOKEN` without the value going anywhere; a URL server is reported by
  host, so a token in a query string does not travel either. A machine check
  collects every credential value configured on the machine it runs on and
  asserts none of them reaches the payload.
- **The manifest grew, so the consent digest changed and the agent will ask
  again.** That is the mechanism working: eight new sources are declared in
  `agent/src/manifest.rs`, `--what-i-read` prints them resolved against your
  machine, and an earlier yes does not cover a release that reads something new.
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

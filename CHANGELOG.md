# Changelog

Notable changes to TokenHUD. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

### Added
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
- **`scripts/selftest.py`** — 13 checks, no framework, nothing mocked.
- Inline SVG favicon; the board now makes no external request of any kind.

### Changed
- **Renamed from AI Mission Control to TokenHUD.** Environment variables moved
  from `AIMC_*` to `TOKENHUD_*`, the state directory from `~/.aimc` to
  `~/.tokenhud`, and the ingest header from `X-AIMC-Key` to `X-TokenHUD-Key`.
- Per-panel dirty checking: an unchanged reading now costs **0.2 ms** to render
  instead of 13.6 ms rebuilding 1993 DOM nodes.
- HTTP/1.1 with keep-alive, and gzip on responses — 69.3 KB to 14.0 KB on the wire.

### Fixed
- The event-stream heartbeat re-sent the entire payload every 20 seconds.
- A held-open stream was never closed on page unload, leaking one of the
  browser's six connections per origin until the page could not load at all.

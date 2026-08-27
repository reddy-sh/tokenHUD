# Diagrams

Eight interactive, self-contained HTML diagrams of this repository - open any
of them in a browser; no server, no build step, no external reference. Each has
light/dark themes, pan/zoom, search, guided views, and PNG/SVG export built in.

| Diagram | Type | What it shows |
|---|---|---|
| [tokenhud-architecture.html](tokenhud-architecture.html) | architecture | The core runtime: `~/.claude` sources → collectors → agent → keyed ingest → SQLite → board → SSE dashboard, all inside `127.0.0.1` |
| [tokenhud-integrations.html](tokenhud-integrations.html) | architecture | The nine assistants in three honest tiers: Claude Code and Codex CLI fully read, Devin activity-only, six detect-only |
| [tokenhud-roundtrip-sequence.html](tokenhud-roundtrip-sequence.html) | sequence | One reading's round trip: `POST /api/v1/ingest` → append → diff → SSE push, plus the disk buffer and the poll fallback |
| [tokenhud-spend-dataflow.html](tokenhud-spend-dataflow.html) | dataflow | Spend lineage: transcripts and stats-cache priced separately and never reconciled; usage windows forwarded, not estimated |
| [tokenhud-liveness-lifecycle.html](tokenhud-liveness-lifecycle.html) | lifecycle | Host liveness (up ≤ 2 min, stale to 15, down after, recoverable) and how endings fall out of reading diffs |
| [tokenhud-portal-pipeline.html](tokenhud-portal-pipeline.html) | architecture | The `site/` local loop through GitHub into AWS Amplify and the CSP-locked tokenhud.com |
| [tokenhud-release-pipeline.html](tokenhud-release-pipeline.html) | architecture | A `v*` tag through the 4-target Actions matrix to checksummed release assets and `install.sh` |
| [tokenhud-consent-sequence.html](tokenhud-consent-sequence.html) | sequence | Consent before reading: the manifest shown first, the yes recorded as a digest, and the re-ask when a release reads more |

The JSON specifications behind each diagram live in [specs/](specs/). The HTML
is generated from them; regenerate rather than editing the HTML by hand.

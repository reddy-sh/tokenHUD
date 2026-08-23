<h1>TokenHUD</h1>

**A heads-up display for the AI agents running on your machine.**

[tokenhud.com](https://tokenhud.com) · MIT · zero dependencies · local-first

---

A single developer now runs several coding agents and a shelf of MCP servers at
once, and flies all of it blind. Token spend is metered by the provider and
surfaced after the fact. MCP servers start, hang and die silently. A looping
agent burns budget with no alarm anywhere in the system.

TokenHUD is the instrument panel for that machine. It watches the host and
reports what it finds: what is running, what it is costing, and when to step in.

## Metrics leave. Content never does.

This is the product's foundation, not a setting.

| Read and reported | Never collected at all |
|---|---|
| token counts — in, out, cached | prompt text |
| model identifiers | completion text |
| computed cost | source code, file contents |
| session start, stop, duration | tool call arguments and results |
| agent runtime and version | environment variables, secrets |
| MCP server names and health | |

The right-hand column is not filtered out before sending. **It is never read
into the payload in the first place.** There is no code path that collects it —
which means there is no configuration mistake, no server-side bug and no policy
change that can ever expose it. Structurally unable, rather than contractually
unwilling.

*We can tell your finance team exactly what you spent. We cannot tell them what
you wrote.*

That is also the competitive position, and it is a claim about *mechanism*
rather than about intentions. Every other tool in this space asks you to trust a
policy; this one publishes the list and fails its own build if the list is
wrong:

```
tokenhud-agent --what-i-read
```

It prints every path the agent will open, resolved against your machine — file
counts and sizes, what is taken from each, what is only checked for existence,
the exhaustive list of what is written, and what is refused with the reason. It
reads nothing while doing it. Nothing is read at all until you agree, consent is
recorded against a SHA-256 digest of that list, and a release that reads one
more file produces a different digest and asks again.

Three tests keep it honest: one greps the collectors for every path literal and
fails on anything undeclared, one fails if the manifest claims a path nothing
reads, and one asserts the keys the exclusion list names appear nowhere in the
code that opens `~/.claude.json`. That last check is a grep, not a sandbox — a
path assembled at runtime would slip past it. What it catches is the realistic
failure: a well-meaning change that reads one more file and forgets to say so.

> **On this repository specifically.** Two fields currently reported —
> **absolute project paths** and **git branch names** — sit on the wrong side of
> that line for a hosted product, and are being moved behind the boundary. They
> are documented in [Privacy and safety](#privacy-and-safety) rather than
> quietly shipped. Everything runs on `127.0.0.1` today, so nothing leaves your
> machine regardless.

## What works today

This repository is the **local daemon and web dashboard**. It is real, it runs,
and it is what the screenshots show.

- **Discovers** Claude Code sessions and processes on the host, with no config
- **Meters** tokens and estimated spend per session, agent, model and project
- **Surfaces** your plan's real five-hour and seven-day windows, and when they reset
- **Reports** what finished while you were away, by diffing consecutive readings
- **Stays out of the way** — a board you leave open, pushed to over SSE

**Not built yet:** the macOS menu bar app (the intended primary surface), MCP
server health, threshold alerts, and cross-machine team rollups. The roadmap
below is a plan, not a description.

## Architecture

```
┌──────────────┐   POST /api/v1/ingest   ┌──────────────┐        ┌───────────┐
│  agent       │ ──────────────────────► │  server      │ ◄───── │ dashboard │
│  (per host)  │   X-TokenHUD-Key        │  SQLite      │  SSE   │ (browser) │
└──────────────┘                         └──────────────┘        └───────────┘
   reads ~/.claude, ps                      keeps history          reads only
```

Two static binaries, about 4 MB together — no interpreter, no package manager,
nothing to install beside them. The agent does the heavy
work locally: it scans a transcript corpus that reaches a gigabyte and ships a
summary, which is both the privacy story and the reason it stays cheap.

Today it understands **Claude Code**. The collector interface is one function
returning JSON, so other runtimes drop in beside it — and the assistant dropdown
lists every one it finds installed, marking the ones no collector reads yet
rather than showing an empty board that looks broken.

## Quick start

```bash
git clone https://github.com/reddy-sh/tokenhud.git
cd tokenhud

cp .env.example .env
./scripts/build.sh                                        # builds both binaries first
./server/target/release/tokenhud-server --new-key        # paste the value into .env as TOKENHUD_KEY

./scripts/run.sh                          # starts both, detached
```

Open **http://127.0.0.1:8787**.

```bash
./scripts/run.sh status     # is it up? which hosts? what does it hold?
./scripts/run.sh logs       # follow both
./scripts/run.sh stop
./scripts/run.sh restart    # after any change under server/ or agent/
./scripts/run.sh selftest   # the checks below, without remembering the path
```

The agent is a Rust binary and has to be built once:

```bash
./scripts/build.sh              # needs cargo; ~30s, then run.sh finds both
```

The server is one too. `./scripts/build.sh` builds both.

Full installation for **[macOS, Linux and Windows](INSTALL.md)** — launch at
login, running one board across several machines, and how to remove all of it.

`status` also says when the running processes are older than the files on
disk. A process keeps the code it started with, and finding that out by
wondering why an edit did nothing is a bad afternoon.

`run.sh` detaches on its own, so a trailing `&` is unnecessary (harmless if you
type it). It refuses to double-start and reaps processes left behind by an
earlier hand-start, so there is never more than one agent reporting per host.

To run the pieces separately — a server on one box, agents on several — use
`scripts/start-server.sh` and `scripts/start-agent.sh` instead.

The first reading lands within one interval (30s by default); the board says
so until it does.

Check what the agent would send, without a server and without sending anything:

```bash
./agent/target/release/tokenhud-agent --dry-run | less
```

Check that this checkout actually works on your machine:

```bash
./scripts/run.sh selftest       # every test in the repo
```

Forty-four checks, no framework, nothing installed, nothing mocked — the real
collectors against your real machine, a real SQLite file in a temp directory, a
real server on a throwaway port. It verifies the rate-card arithmetic, that an
unpriced model reports as unpriced rather than as $0, that a five-hour block is
five hours, that the limits collector never writes to Claude Code's config and
carries nothing identifying, that prompt text stays put without the opt-in, that
a broken source does not drop the host, that a replayed snapshot invents no
endings, that ingest refuses a wrong key, and that the dashboard has no external
references and no duplicate element ids.

## Layout

| Path | What it is |
|---|---|
| `agent/src/collect.rs` | every source, one function each — add one here and nowhere else |
| `agent/src/transcripts.rs` | per-session index over ~/.claude/projects, read incrementally |
| `agent/src/limits.rs` | the plan's real usage windows, from Claude Code's own cache |
| `agent/src/pricing.rs` | the rate card, and the argument for having one at all |
| `agent/src/main.rs` | collect → POST loop, with an on-disk buffer for when the server is away |
| `agent/tests/machine.rs` | eleven checks against your real machine, nothing mocked |
| `server/src/store.rs` | SQLite: `hosts` (now) + `snapshots` (then, as differences) + `endings` (what stopped) |
| `server/src/board.rs` | the overview, built once for everyone reading it |
| `server/src/http.rs` | ingest, query, the event stream, the static dashboard |
| `web/index.html` | the board — one self-contained file, no CDN, no build step |
| `server/tests/` | thirteen checks over the store, the HTTP surface and the board |
| `docs/ARCHITECTURE.md` | what runs, what it measured, and what multi-machine would take |

## The API

| | |
|---|---|
| `POST /api/v1/ingest` | one snapshot. Requires `X-TokenHUD-Key`. |
| `GET /api/v1/overview` | latest reading per host, agent liveness, recent endings |
| `GET /api/v1/history?host=…&limit=…` | recent snapshots for one host |
| `GET /api/v1/endings?host=…&hours=…&limit=…` | agents that stopped recently |
| `GET /healthz` | liveness |

Responses are gzipped when the client asks, and the server speaks HTTP/1.1 so a
board left open reuses one connection instead of building a new one every
interval.

A host is reported **up** while its agent has checked in within 2 minutes,
**stale** to 15, **down** after. That is a statement about the agent, not
about whether the machine is switched on — a distinction worth keeping.

Every snapshot carries `intervalSeconds`, the cadence the agent that sent it
reports on. The board schedules from that rather than from a poll rate someone
picked: the **Live** switch in the header refetches one second after the next
reading is due, so the page makes one request per reading and is never more
than a second behind the data. Switch it off and the board freezes on what it
already has and fetches nothing.

## Speed, and what actually made it faster

The board is pushed to, not polled. `GET /api/v1/stream` holds a connection
open and sends the whole overview the instant an agent's reading lands. Polling
is still there and still correct: if `EventSource` is missing, the stream
errors, or the server is at its connection cap, the timer takes over and the
board behaves exactly as before. Push is an improvement to the transport, not a
dependency.

Every event carries the **whole state**, not a delta. That costs bytes, and
gzip with a sync flush per event gets them back — the stream measures the same
on the wire as the gzipped polls it replaces. What it buys is that a reader who
missed an event is not behind, and a reconnect is a resync rather than a gap to
reconcile. A delta protocol would have saved a few kilobytes on loopback and
introduced the one class of bug this board cannot afford: silent divergence,
where the screen is wrong and the clock is still ticking.

What was measured before and after, on this machine:

| | before | after |
|---|---|---|
| full board render | 13.6 ms, 1993 nodes rebuilt | 0.2 ms unchanged · 1.3 ms typical |
| overview on the wire | 69.3 KB | 14.0 KB (gzip) |
| HTTP | 1.0, new connection per poll | 1.1, connection reused |
| server time per request | 1.8 ms | 1.8 ms |
| learning a reading landed | on the next timer | pushed |

The render was the whole story. Each panel now keeps a signature of the data it
was drawn from and is skipped when that has not moved — the daily-activity chart
is the same until midnight, the rate card never changes. Two things deliberately
bypass it, and both are about drawing rather than data: chart colours are read
from CSS, so a theme flip redraws everything, and charts measure their own
width, so a resize or the sidebar sliding does too.

**On Node.js.** It was considered seriously and measured rather than argued
about. The server answers in 1.8 ms; the browser parses 69 KB of JSON in 0.4 ms;
HTTP keep-alive on loopback bought 6%. There is no throughput problem here for a
faster runtime to solve — the cost was the browser rebuilding 1993 DOM nodes
thirty times a minute, which is a rendering decision, not a runtime one. Moving
to Node would have cost the property that makes this repo work on a machine
someone has not prepared: `python3` ships on macOS, `node` does not.

The honest caveat on latency: the poll was already phase-locked to the agent's
write, so it was arriving about a second late, not thirty. The stream removes
that second and, more usefully, stops the board guessing at a cadence — but the
real limit on freshness is `TOKENHUD_INTERVAL`, which is how often the agent looks.

**Two things not done, on purpose.** A server-computed delta protocol, for the
reason above. And splitting the agent into fast and slow sampling tiers: it
looks obviously right, and it silently breaks endings, because endings are
derived by diffing the process list between two *stored* snapshots — move
processes to a tier that is not stored and the panel empties with no error
anywhere.

## What finished while you were away

A snapshot says which agents were running at an instant. Nobody watches a
dashboard at every instant, and the question people actually have when they sit
back down is *what finished* — including the notification that fired while the
tab was in the background.

So the server diffs consecutive readings: anything running in one and gone from
the next has ended, and it goes in an `endings` table with **both** timestamps.
A reading every 30 seconds places an ending inside a 30-second window; a laptop
that slept places it inside a four-hour one. The board shows "ended 2m ago" for
the first and "ended between 09:14 and 13:20" for the second, because a precise
time on a guess is worse than an honest range.

Endings can only exist from the moment the server starts watching, and the
panel says so rather than looking empty for an unexplained reason.

## Usage windows

Claude Code asks Anthropic how much of your plan is spent and when each window
resets, and caches the answer in `~/.claude.json` under
`cachedUsageUtilization`. The board forwards that: the percentages are the
server's own numbers, not a local estimate.

The design problem is that it is a **cache**, and nothing here can refresh it —
it is written as a side effect of a Claude Code session hitting the usage
endpoint, and the CLI discards it after an hour. So the age is on the card's
face, measured from `fetchedAtMs` rather than the file's mtime (which moves when
unrelated settings are written and would make stale data look fresh). Past an
hour the card is badged **stale** and the percentages grey out — but the
countdowns stay live, because `resets_at` is an absolute instant and does not
rot. A rolled-over window says so instead of rendering `0%`.

The agent reads exactly one key from that file, hashes the account id with a
per-install salt rather than forwarding it, and never writes. The same file
holds a real name, an email address, an organisation, MCP configuration and a
per-project cost history; none of it is read.

Beside that sits a five-hour block reconstructed from your own request
timestamps — the block is wall-clock, so the window itself is measured rather
than estimated. It matched the CLI's own panel to within three minutes on the
machine this was built on, and it is the fallback when the cache is missing.

## Saving a PDF

The rail has a **Save as PDF** button, and `Cmd-P` does the same thing. There is
no PDF library: the browser already writes PDFs, `.cols-2` is
`minmax(420px, 1fr)` so an A4 content box linearises the board on its own, and a
print stylesheet does the rest — chrome removed, the light palette forced, the
scrolling tables expanded so nothing is clipped, and a dateline added carrying
the machine name and the reading's timestamp, since the rail that normally
carries them is not printed. It prints what the board is showing, including an
unsupported assistant's warning card.

## Privacy and safety

The defaults are chosen so that doing nothing is safe.

- **The server binds `127.0.0.1`.** Nothing off your machine can reach it until
  you change `TOKENHUD_BIND` on purpose.
- **Prompt text is not sent.** `TOKENHUD_SEND_PROMPTS=1` opts in. Off, the board
  shows counts and never content. Session *titles* are written from the first
  prompt, so they are prompt text by another name and follow the same switch —
  off, the sessions table identifies a session by its id.
- **Command lines are truncated** before they cross the wire — an argv can
  carry a path, a prompt, or a token.
- **No data is in this repo, and none can be.** `.env`, `data/` and `*.db` are
  gitignored; the repo ships code and an example config.
- **Writes need the key**, compared with `hmac.compare_digest` so a wrong key
  cannot be discovered one byte at a time. Reads are open so the dashboard
  needs no secret in the browser — set `TOKENHUD_PROTECT_READS=1` to change that.

**If you expose the server**, the ingest key is a bearer secret in a plain
header: put TLS in front of it (a reverse proxy is the easy answer) and treat
`TOKENHUD_KEY` as a real credential.

## Honesty

Every number is either measured or labelled as an estimate. There is exactly
one estimate, and this is the argument for it.

- **Dollar figures are a yardstick, not a bill.** Claude Code reports
  `costUSD: 0` for every model on a subscription plan, because a flat fee has
  no per-request price. That is true and useless: it cannot tell you which
  session, model or day your usage went to. So the board prices the tokens it
  counted at Anthropic's published API list rates and says so on every panel
  that shows a dollar — the tile reads *at API list prices · not billed*, and
  `agent/src/pricing.rs` carries the reasoning and the caveats. The rate card
  itself is on the board under *How this number is made*, because a figure
  whose arithmetic you cannot inspect is a figure to distrust.
- **A model with no rate is "unpriced", never $0.** A model released after the
  rate card was written is counted in tokens and left out of every dollar
  total, and the board says how many tokens that covers.
- **The usage drivers overlap and do not sum to 100%.** One session can be
  subagent-heavy *and* long *and* deep in context. Each bar is measured on its
  own against the window total, and its threshold sits under it.
- **Two sources are not forced to agree, and the board says which is which.**
  The all-time model table counts tokens from `stats-cache.json` — Claude
  Code's own rollup, recomputed every so often, still counting sessions whose
  transcripts have since been pruned. The per-day and per-session panels count
  the transcripts on disk: current to the last request, missing whatever was
  pruned. On this machine they differ by about a fifth, in both directions
  depending on the model. Each table is priced from its own numbers, so every
  row is internally consistent, and neither total is quietly reconciled into
  the other.
- **Partial data says it is partial.** The first pass over a large transcript
  corpus takes several cycles, and the spend panel shows how far it has got
  instead of quietly showing a fraction as a total.
- **Cache reads are excluded from the token chart** — they run ~100× the other
  numbers and would flatten everything else — but they are in the model table,
  and they are priced (a cache read is a tenth of fresh input, not free).
- **A missing source says so.** A collector that fails reports the rest of the
  machine rather than dropping the host, because "the disk collector is down"
  and "the host is down" are different facts.

## Design

The chart palette is validated, not chosen by eye: it clears the lightness
band, chroma floor, colour-blind separation, normal-vision floor and contrast
checks in both light and dark. The three light-mode hues that sit under 3:1 on
the light surface are why the legend carries values and the token chart has a
table view — identity is never carried by colour alone.

## Reading a gigabyte every 30 seconds (not doing that)

Claude Code appends one JSONL per session; a working machine reaches a
gigabyte and a single transcript can pass 200 MB. `agent/src/transcripts.rs` keeps
a byte offset per file and reads only what was appended since the last cycle —
steady state is a few kilobytes. The first pass is bounded by
`TOKENHUD_SCAN_BUDGET_MB` (512 by default, ~1s per cycle here) so the agent never
blocks on it, and the index stores token counts rather than dollars, so
changing the rate card never means re-reading the corpus.

## Scope — now, later, and never

The third column is the one that matters. *Later* is a scheduling decision and
can move. **Never is a promise, and moving it would break the product.**

| Now | Later | Never |
|---|---|---|
| One developer, one machine | Cross-machine team rollups | Prompt or completion text leaving the host |
| Read-only observation | Shared budgets and policies | Source code or file contents collected |
| Claude Code first | Retained history, chargeback | Sitting in the request path as a proxy |
| MCP discovery and health | Other agent runtimes | Production application tracing |
| Token and cost accounting | Control — pausing a runaway agent | Output quality scoring or evals |
| Local thresholds and alerts | SSO, SCIM, admin roles | |

Read-only is deliberate: **observe before control.** The right to touch a
running agent is earned by watching one accurately first. And an instrument
must not be able to break the aircraft — TokenHUD never sits in the request
path, so it cannot be the reason a call fails.

## Operating principles

1. **Metrics leave, content never does.** Not negotiable for a customer, a deal, or a quarter.
2. **Zero-config or it does not ship.** If you have to describe your own setup, discovery failed.
3. **Glanceable over queryable.** Every question you have to type is a number that should already be on screen.
4. **Negligible overhead.** An instrument that slows the aircraft is a bad instrument.
5. **Observe before control.**
6. **Honest numbers.** An estimate is labelled an estimate. Never present a calculation as a measurement, and never round a cost in our own favour.

Principle 6 is why this repository says "estimated at API list prices" on every
dollar figure, reports an unpriced model as *unpriced* rather than as `$0`, and
greys out a stale percentage while leaving its countdown live.

## Pricing

**Free forever** for one user on one machine: unlimited metering, no sampling,
full history, local alerts, and it runs with the network off. A free user costs
nothing to serve, because nothing is served — it all happens on your machine.

**Paid per seat** for teams: cross-machine rollups, shared budgets, retained
history, chargeback reports, alerts to Slack and email, admin roles.

The free tier will not be degraded to drive upgrades. The upgrade trigger is
other people — the moment a second developer needs to see the same numbers —
not an artificial ceiling on the first one.

## Licence

MIT — see [LICENSE](LICENSE).

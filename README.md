<h1>TokenHUD</h1>

**A heads-up display for the AI agents running on your machine.**

[tokenhud.com](https://tokenhud.com) · MIT · two static binaries · nothing to install beside them

**Docs:** [documentation index](docs/) · [install](INSTALL.md) ·
[the dashboard](docs/dashboard.md) · [the leaderboard](docs/leaderboard.md) ·
[sharing](docs/sharing.md) · [HTTP API](docs/api.md) ·
[configuration](docs/configuration.md)

---

A single developer now runs several coding agents at once and flies all of it
blind. Token spend is metered by the provider and surfaced after the fact. A
looping agent burns budget with no alarm anywhere in the system. Claude Code
deletes its own session history after thirty days.

TokenHUD is the instrument panel for that machine. It reads what your agents
have already written to disk, prices it, and shows you what is running, what it
is costing, and when to step in. Nothing leaves the machine until you enroll it
— and when you do, metrics leave, content never does.

![The TokenHUD admin shell: sessions, messages, tool calls, output tokens, value,
usage windows, daily activity and tokens by model — dark theme](docs/board.png)

## Get started

### 1 — Install the agent (no Rust required)

Prebuilt binaries for macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
```

Or download directly from [GitHub Releases](https://github.com/reddy-sh/tokenhud/releases/latest).

Installing reads nothing and sends nothing. The agent shows you every file it
intends to open and asks before opening one.

### 2 — Sign in and add the machine

Sign in at [tokenhud.com](https://tokenhud.com) (email and password), open
**Machines → Add machine**, and run the command it shows on the machine you
just installed on:

```bash
tokenhud-agent enroll "<ingest-url>#<token>"
```

The link is one-shot and expires in 15 minutes. `enroll` shows the read
manifest and asks before anything else; then it claims the link, is approved —
you minted it seconds ago while signed in, so there is nothing left for a
person to decide — and then **does not exit**. It falls straight into the
reporting loop, so the board fills in from that first reading and every
`TOKENHUD_INTERVAL` seconds after it, 30 by default. Ctrl-C stops it; to keep
it reporting across logins, install the launchd or systemd unit in
`agent/dist/` — [agent/INSTALL.md](agent/INSTALL.md) covers both.

That is two commands and no environment variables: `~/.tokenhud/machine.json`
carries the server URL and this machine's own key, and the agent reads it from
there on every start. Worth knowing where the heartbeats go — the cloud
**ingest Function URL**, not `tokenhud.com`. If you write egress rules, that
is the host to allow.

Enrolling is the moment metrics start leaving the machine, and metrics are all
that ever leaves; until you run that command, nothing does.

### Self-hosting instead

The same agent speaks the same protocol to the server in this repo — your own
machine or LAN, no account anywhere.

**Read this first: there is no self-host board today.** The server is the
self-host **API** and nothing else. It keeps history in SQLite and answers
`/api/v1/*`; `GET /` is a JSON 404 and no HTML ships in the binary. The board
in the screenshot above lives in the portal, and the portal reads the cloud
and only the cloud — it signs in with Cognito and subscribes over AppSync.
There is no field in it for a server URL or a key, so `./scripts/start-portal.sh`
shows your *cloud* account's machines; it cannot read `127.0.0.1:8787`.
Self-hosting today means reading the API yourself:

```bash
curl -s localhost:8787/api/v1/overview | python3 -m json.tool
```

Every panel the board draws is built from that one response, so it is the
whole picture, unrendered.

#### macOS · Linux

```bash
git clone https://github.com/reddy-sh/tokenhud.git
cd tokenhud
./scripts/start-server.sh   # API on 127.0.0.1:8787; needs cargo — https://rustup.rs
./scripts/start-agent.sh    # refuses to start until you have read the manifest and agreed
```

One script per component, named for what it does; each checks whether its
piece is already running before starting it, and builds what it needs.
`./scripts/start-all.sh` runs both of those plus the portal, which is useful
when you are working on the portal itself — not a way to point it at your
server.

You are not asked to create a key or edit a config file. On a loopback install
the ingest key is ceremony rather than security — both processes are yours, on
your machine — so it is generated for you and written to `.env` at mode 600. It
starts mattering the moment you bind beyond loopback, which is
[its own section](INSTALL.md#linux--sharing-one-board-across-machines).

### The ingest key

The key authenticates the **agent → server** direction (writes). On the cloud
portal there is no shared key to manage: each machine receives its own at
enrollment, saved to `~/.tokenhud/machine.json` (mode 600), and revoking that
machine in the portal shuts that one door — nothing else rotates.

Self-hosting, the key works as it always has. API reads are open by default —
no key needed to `curl` the overview. The key is what gates writes, and what
gates the machines list inside that overview.

| How you started | Where the key is |
|---|---|
| enrolled — cloud portal, or a self-host server via its API | its own per-machine key, in `~/.tokenhud/machine.json` (mode 600) |
| `./scripts/start-server.sh` | generated automatically, written to `.env` in the repo root |
| `scripts/install.sh` (curl) | none written — it installs the binaries and nothing else |
| `./install.sh` in the repo root | generated, written to `~/.tokenhud/env` (mode 600) |
| manual / standalone | generate one with `tokenhud-server --new-key`, then `export TOKENHUD_KEY=<value>` |

```bash
# Generate a key manually
tokenhud-server --new-key

# Start the server with it
export TOKENHUD_KEY=<the key above>
tokenhud-server &

# Start the agent (needs the same key)
tokenhud-agent
```

### Adding another machine

Don't copy a key around. In the portal, **Machines → Add machine** mints a
one-shot enrollment link; run the one command it shows on the new machine:

```bash
tokenhud-agent enroll "<ingest-url>#<token>"
```

The machine is approved automatically — the signed-in owner minted that link
seconds earlier, so there is no doubt left to resolve — and the pairing code
is still shown on both ends for eye-matching. The machine receives its own
key (`~/.tokenhud/machine.json`, mode 600) and starts reporting in the same
command, so it appears on the board within one interval. Revoking it in the
portal shuts that one door, and nothing else rotates.

A self-host server speaks the same enrollment protocol, minus the signed-in
owner — and minus any UI to run it in. You mint and approve against the API:

```bash
# 1. mint a link. This is the one write that creates a credential, so it
#    always needs the key, whatever TOKENHUD_PROTECT_READS says.
curl -sX POST localhost:8787/api/v1/enroll/new -H "X-TokenHUD-Key: $TOKENHUD_KEY"
# → {"token":"…","code":"…","expiresAt":…,"ttlSeconds":900}

# 2. on the new machine
tokenhud-agent enroll "http://your-server:8787#<token>"
#    it prints its pairing code and waits, polling for up to 15 minutes

# 3. back on the server: the machine is now pending, carrying that pairing
#    code, its detected assistants and its consent-manifest digest.
curl -s localhost:8787/api/v1/overview -H "X-TokenHUD-Key: $TOKENHUD_KEY" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["machines"])'

# 4. check the code matches what the machine printed, then decide.
#    action is approve, deny or revoke.
curl -sX POST localhost:8787/api/v1/machines/decide \
  -H "X-TokenHUD-Key: $TOKENHUD_KEY" -H 'content-type: application/json' \
  -d '{"installId":"<from step 3>","action":"approve"}'
```

The waiting agent's next poll collects its key and falls into the reporting
loop, exactly as the cloud path does. The `machines` list travels only to a
caller holding the key — reads being open by default does not open that.

To also require the key for **reading** the self-host API, set
`TOKENHUD_PROTECT_READS=1`.

### Windows

**Not yet — and it will not compile rather than merely misbehave.** The agent
calls `uname`, `getloadavg`, `kill`, `gethostname` and `getentropy` unguarded and
shells out to `ps`. [INSTALL.md](INSTALL.md#windows) lists the four changes that
would fix it.

**Use WSL2 today.** Claude Code inside WSL writes to the WSL home directory, so
the Linux instructions apply unchanged and the agent reads the right files.

### Day to day

```bash
./scripts/status.sh                              # up? which machines? what does it hold?
tail -f logs/*.log                               # follow everything
./scripts/stop-server.sh && ./scripts/start-server.sh   # restart after a change
./scripts/stop-all.sh
```

That is the whole of `scripts/`, plus `_lib.sh`, `install.sh` and the
`start-`/`stop-` pairs for agent, portal and server. Tests live where the code
does: `cargo test` in `agent/` and in `server/`, `npx playwright test` in
`site/`.

Keeping it running across logins, running one server for several machines, and
removing all of it: **[INSTALL.md](INSTALL.md)**.

## It tells you every file it will open, before it opens one

This is the part worth two minutes. Run it before you trust anything else here:

```console
$ tokenhud-agent --what-i-read

  ~/.claude/projects/**/*.jsonl    1130 files, 1.1 GB
                                   per-session token counts, models, timings and tool calls
                                   └ only lines whose type is `assistant` or `ai-title`

  ~/.claude.json                   74.6 KB
                                   your plan's real 5-hour and 7-day usage windows
                                   └ exactly one key: `cachedUsageUtilization`.
                                     Never `oauthAccount`, never `projects`, never `utilization.spend`

  …

  NEVER READ
  prompt text and session titles   opt-in, off by default
  ~/.claude.json → oauthAccount    your identity
  your source code                 no collector opens a file outside the paths above
```

Resolved against *your* machine — real file counts and sizes, not a description.
It reads nothing while printing it, and **nothing is read at all until you
agree.** Consent is recorded against a SHA-256 digest of that list, so a release
that reads one more file asks again instead of inheriting an older yes.

The list cannot quietly drift from the code, because three tests hold it to the
code: one greps every collector for path literals and fails on anything
undeclared, one fails if the manifest claims a path nothing reads, and one
asserts the keys the exclusion list names appear nowhere in the code that opens
`~/.claude.json`.

It is a grep, not an adversarial sandbox — a path assembled at runtime would slip
past it. What it catches is the realistic failure: a well-meaning change that
reads one more file and forgets to say so.

```bash
tokenhud-agent --dry-run     # the exact reading it would send, sent nowhere
```

## Metrics leave. Content never does.


This is the product's foundation, not a setting.

| Read and reported | Never collected at all |
|---|---|
| token counts — in, out, cached | prompt text |
| model identifiers | completion text |
| computed cost | source code, file contents |
| session start, stop, duration | tool call arguments and results |
| agent runtime and version | environment variables, secrets |
| MCP server names, from the configs that declare them | |

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
> quietly shipped. Nothing leaves your machine until you enroll it — but
> enrolling is now one command, so the line has to sit in the right place
> before the command is easy, not after.

## What works today


This repository is the **agent, the self-host API server, and the portal**. It
is real, it runs, and it is what the screenshots show.

- **Reads** Claude Code, Codex CLI, GitHub Copilot CLI and Devin CLI — the four that
  write real usage to disk
- **Catalogues** twenty-six tools in all, and tells you what to do about the quiet
  ones: which setting to switch on, which key to create, or that no token metric
  exists to fetch
- **Meters** tokens and estimated spend per session, agent, model and project (Codex
  tokens unpriced; Copilot in premium requests and AI units; Devin in credits — none
  of them converted to dollars at a rate this build does not have)
- **Surfaces** your plan's real five-hour and seven-day windows, and when they reset
- **Reports** what finished while you were away, by diffing consecutive readings
- **Ranks** every machine reporting to one board against the others, by tokens,
  estimated value, sessions, tool calls or active days — and turns that into a
  public link if you want one
- **Stays out of the way** — a board you leave open, pushed to the moment a
  reading lands

The portal is exactly six things and no more: sign in, create an account,
confirm the emailed code, reset a password, register a machine with a one-shot
15-minute link, and revoke one. Plus the board. There are no teams, no shared
budgets, no alerts and no SSO in it — those are in the *Later* column below,
which is a plan and not a description.

**Not built yet:** the macOS menu bar app (the intended primary surface), MCP
server health, threshold alerts, and cross-machine team rollups. There is also
no self-host board — the server is an API, and the portal reads the cloud.

## Architecture


```
┌──────────────┐  POST /api/v1/ingest  ┌───────────────────┐   AppSync    ┌────────────────┐
│  agent       │ ────────────────────► │  cloud ingest     │ ───────────► │  portal        │
│  (per host)  │  X-TokenHUD-Key       │  Lambda Fn URL    │ subscription │  tokenhud.com  │
└──────────────┘                       └───────────────────┘              └────────────────┘
   reads ~/.claude, ps                   writes the machine row              live board

┌──────────────┐  POST /api/v1/ingest  ┌───────────────────┐
│  agent       │ ────────────────────► │  tokenhud-server  │ ──► GET /api/v1/overview
│  (per host)  │  X-TokenHUD-Key       │  SQLite, 127.0.0.1│     GET /api/v1/stream
└──────────────┘                       └───────────────────┘     (JSON; you render it)
```

The middle box swaps — same route, same header, same JSON, SQLite instead of
DynamoDB — and an agent cannot tell which one it is posting to, which is the
point. The right-hand box does **not** swap. The portal signs into Cognito and
reads AppSync; there is nowhere in it to type a server URL, so the self-host
path ends at the API and you render what you like from it.

Note where each arrow actually lands on the cloud path: the agent posts to the
ingest **Function URL**, the browser subscribes to **AppSync**, and
`tokenhud.com` serves the static site and nothing else. Three hosts, not one —
which matters if you are writing egress rules or reading a firewall log.

Two static binaries, about 4.5 MB together — no interpreter, no package manager,
nothing to install beside them. The agent does the heavy
work locally: it scans a transcript corpus that reaches a gigabyte and ships a
summary, which is both the privacy story and the reason it stays cheap.

Today it reads four tools whose usage lives on your disk: **Claude Code** (tokens,
spend, real plan windows), **Codex CLI** (tokens and rate limits, unpriced),
**GitHub Copilot CLI** (tokens per model, premium requests and AI units), and
**Devin CLI** (per-session credits and ACU, model and mode — conversations counted,
never opened). The collector interface is one function returning JSON, so other
runtimes drop in beside it.

Copilot is the instructive case: its two halves disagree. The **CLI** writes a full
token breakdown to `~/.copilot/session-state/*/events.jsonl`; the **IDE extension**
writes a session store holding the conversation and no usage whatsoever. One is read
locally, the other needs GitHub's billing API. The board says which is which.

The other twenty-two tools are catalogued rather than guessed at, in
`agent/src/integrations.rs`, and each carries what would make it readable. Some are
one setting away — **Gemini CLI** logs six token fields per call once telemetry is
enabled. Some keep usage only in their **cloud** and need a key: **Cursor**'s token
counts need a team admin key, **Windsurf** exposes credits and never tokens.
**Amazon Q Developer** publishes no token metric anywhere, in any report, so the
board says that outright rather than showing an empty chart. And web products —
Replit, v0, Bolt, Lovable — leave no local trace at all, which is stated instead of
worked around.

## Layout


| Path | What it is |
|---|---|
| `agent/src/collect.rs` | every source, one function each — add one here and nowhere else |
| `agent/src/transcripts.rs` | per-session index over ~/.claude/projects, read incrementally |
| `agent/src/limits.rs` | the plan's real usage windows, from Claude Code's own cache |
| `agent/src/pricing.rs` | the rate card, and the argument for having one at all |
| `agent/src/main.rs` | collect → POST loop, with an on-disk buffer for when the server is away |
| `agent/src/integrations.rs` | the catalogue: twenty-six tools, and what each would take to read |
| `agent/tests/machine.rs` | twelve checks against your real machine, nothing mocked |
| `server/src/store.rs` | SQLite: `hosts` (now) + `snapshots` (then, as differences) + `endings` (what stopped) + `shares` |
| `server/src/board.rs` | the overview, built once for everyone reading it |
| `server/src/http.rs` | ingest, query, the event stream — JSON only, no HTML |
| `server/src/share.rs` | the public leaderboard, and the one whitelist that decides what may leave |
| `site/src/lib/leaderboard.js` | the ranking — windows, streaks, tiers — used by the private board and the shared one |
| `site/src/lib/demand.js` | the fleet rollups: model share, reach, momentum, concentration, the export |
| `site/` | the portal — sign-in, machine registration, the live board, the shared page |
| `amplify/` | auth (Cognito), the machine table, and the ingest Lambda agents post to |
| `server/tests/` | checks over the store, the HTTP surface, enrollment and sharing |
| `docs/` | the [documentation](docs/): dashboard, leaderboard, sharing, API, configuration, architecture |

Tests are `cargo test` in `agent/` and in `server/`, and `npx playwright test`
in `site/`.

## The API


Summarised below; the full reference — request shapes, the public payload
schema, response conventions and the cloud differences — is in
[docs/api.md](docs/api.md).

| | | both |
|---|---|:-:|
| `POST /api/v1/ingest` | one snapshot. Requires `X-TokenHUD-Key`. | ✓ |
| `POST /api/v1/enroll` | a machine claims a link. Open — the token in the body is the credential | ✓ |
| `GET /api/v1/enroll/await?token=…&secret=…` | the claiming machine's poll; delivers its key exactly once | ✓ |
| `GET /healthz` | liveness | ✓ |
| `POST /api/v1/enroll/new` | mint a link. Always requires `X-TokenHUD-Key` | |
| `POST /api/v1/machines/decide` | `{installId, action}`, action ∈ approve\|deny\|revoke. Requires the key | |
| `GET /api/v1/overview` | latest reading per host, agent liveness, recent endings. `machines` only with the key | |
| `GET /api/v1/history?host=…&limit=…` | recent snapshots for one host | |
| `GET /api/v1/endings?host=…&hours=…&limit=…` | agents that stopped recently | |
| `GET /api/v1/stream` | SSE; the whole overview per reading | |
| `POST /api/v1/stream-token` | trades the key for a one-time 60-second token, since `EventSource` cannot set a header | |
| `GET /api/v1/share` | every share this fleet has minted, and the address to build links against. Requires the key | |
| `POST /api/v1/share` | `{title, identities}` mints one; adding `slug` edits it. Requires the key | |
| `POST /api/v1/share/revoke` | `{slug}`. Requires the key | |
| `GET /api/v1/public/board?s=…` | a shared leaderboard. **No key** — the slug is the credential | |

The four marked **both** are the wire protocol rather than one server's
routes: the self-host server in this repo and the cloud ingest Lambda answer
them identically — same header, same status codes, same JSON keys — so an
agent cannot tell which one it is talking to. Everything else is the self-host
server alone. The cloud has no `/api/v1/overview`: reading there is Cognito
sign-in and an AppSync subscription, and the Lambda 404s anything not in the
first four.

The unrouted case is a JSON 404 on both, `GET /` included. Every caller of
this API is a program, and a program should not have to parse a document to
learn it got the path wrong.

Responses are gzipped when the client asks, and the server speaks HTTP/1.1, so
anything that reads it on a loop — the agent posting, a script polling the
overview, a held-open stream — reuses one connection instead of building a new
one every interval.

A host is reported **up** while its agent has checked in within 2 minutes,
**stale** to 15, **down** after. That is a statement about the agent, not
about whether the machine is switched on — a distinction worth keeping. The
portal computes it from the same two thresholds rather than trusting a status
field, so the two paths cannot drift into disagreeing about what "up" means.

Every snapshot carries `intervalSeconds`, the cadence the agent that sent it
reports on. Nothing schedules from it any more — the portal is pushed to
rather than polled, so there is no poll rate to align to a write — but the
rail shows it (*reports every 30s*), which is what tells you whether a quiet
board means a quiet machine or a slow one. The **Live** switch in the header
is the manual override: on, the subscription is open; off, it is torn down and
the board freezes on what it already has and fetches nothing.

## Freshness, and the property worth defending


The board is pushed to, not polled. In the portal that is an AppSync
subscription: `observeQuery` seeds from a list and then applies the feed, so a
heartbeat shows up the moment the ingest function writes the row. A plain
`list()` every 60 seconds backstops it, because a socket can die without
saying so — a backgrounded tab is the ordinary case, and the portal also
rebuilds the subscription when the tab is looked at again. Push is the
transport; the poll is the guarantee. The self-host server takes the same
posture on its own wire: `GET /api/v1/stream` holds a connection open and
sends the whole overview the instant a reading lands, for whatever you point
at it.

Every event carries the **whole state**, not a delta, on both paths. That costs
bytes, and the SSE stream keeps one deflate context across the connection and
flushes it after each event, so the second reading — being nearly identical to
the first — costs a fraction of even the first's gzipped size. What the whole
state buys is that a reader who missed an event is not behind, and a reconnect
is a resync rather than a gap to reconcile. A delta protocol would have saved
a few kilobytes and introduced the one class of bug this board cannot afford:
silent divergence, where the screen is wrong and the clock is still ticking.
That reasoning is why the cloud path is shaped the same way — a `Machine` row
holds the current snapshot, not a change log.

**The honest limit on freshness is `TOKENHUD_INTERVAL`** — how often the agent
looks. Everything above removes seconds from a thirty-second number.

**Two things not done, on purpose.** A server-computed delta protocol, for the
reason above. And splitting the agent into fast and slow sampling tiers: it
looks obviously right, and it silently breaks endings, because endings are
derived by diffing the process list between two *stored* snapshots — move
processes to a tier that is not stored and the panel empties with no error
anywhere.

<details>
<summary><b>The previous local dashboard, and what was measured on it</b></summary>

Before the portal, the board was a hand-written `web/index.html` that the
server itself served, polling `/api/v1/overview` on a timer and consuming
`/api/v1/stream` with an `EventSource` when it could. It is deleted — no HTML
ships in the server binary and `TOKENHUD_WEB` is gone. These numbers are kept
because the conclusion outlived the code.

| | before | after |
|---|---|---|
| full board render | 13.6 ms, 1993 nodes rebuilt | 0.2 ms unchanged · 1.3 ms typical |
| overview on the wire | 69.3 KB | 14.0 KB (gzip) |
| HTTP | 1.0, new connection per poll | 1.1, connection reused |
| server time per request | 1.8 ms | 1.8 ms |
| learning a reading landed | on the next timer | pushed |

The render was the whole story, and that is the part that carried over. Each
panel kept a signature of the data it was drawn from and was skipped when that
had not moved; the portal gets the same effect from memoised panel inputs and
React's reconciliation, which is the same idea with the bookkeeping handed to a
library. The transport was never the problem: the server answered in 1.8 ms and
the browser parsed 69 KB of JSON in 0.4 ms, so there was no throughput for a
faster runtime to win back — the cost was the browser rebuilding 1993 DOM nodes
thirty times a minute, which is a rendering decision, not a runtime one.

One property that argument used to lean on is genuinely gone: the old board
needed no Node, and the portal is a Vite build that does. What survives is
narrower and still true — the two binaries need no runtime at all, which is
why the server does not serve the portal.

</details>

## What finished while you were away


A snapshot says which agents were running at an instant. Nobody watches a
dashboard at every instant, and the question people actually have when they sit
back down is *what finished* — including the notification that fired while the
tab was in the background.

So whatever receives the reading diffs it against the one before — the
self-host server into an `endings` table, the cloud ingest function into the
machine's row — and anything running in one and gone from the next has ended,
recorded with **both** timestamps. A reading every 30 seconds places an ending
inside a 30-second window; a laptop that slept places it inside a four-hour
one. The board shows "ended 2m ago" for the first and "ended between 09:14 and
13:20" for the second, because a precise time on a guess is worse than an
honest range.

Endings can only exist from the moment something started watching, and the
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

## The board, and the leaderboard on it


The dashboard has two levels of navigation. The root rail — behind the
hamburger — answers **which product**; a second rail, where a section has one,
answers **where inside it**.

```text
MONITORING
  Token Monitoring   machines, sessions, models, spend, governance
  Leaderboard        Leaderboard · Live · Models · Demand
WORKSPACE
  Settings           connection, appearance, public links, this server
```

Every other panel answers *how much did this machine do*. None of them answered
*compared to what* — and that is the question that changes anything. Nobody
opens a ranking to admire the numbers; they open it to find out where they
stand.

So the Leaderboard is four pages: the **standings**, what is **live** right
now, which **models** did the work and what they actually cost, and the shape
of the **demand**. A machine with nothing in the chosen window is unranked
rather than last, tiers are cut on decades of tokens because that is how this
number moves, and momentum is measured in share points because "+100%" on a
small base is true and useless.

Any of it can become a **public link**. What may leave is decided in one file,
[`server/src/share.rs`](server/src/share.rs), by naming the fields that go out
rather than deleting the private ones from a reading — a reading is ~61 KB
across some 2,400 leaves and the agent grows new ones every release, so a
blacklist would publish each new field by default and be wrong exactly once, in
public. Token counts, model names and daily activity go; projects, paths,
prompts, branches, tool names and plan limits never do; hostnames only if you
ask for them. The hour-of-day curve is withheld below three machines, because
over one machine it is not a demand curve, it is somebody's sleep.

Nothing is uploaded anywhere. Aggregates leave when a person exports them or
publishes a link — both deliberate acts, both visible on the board.

→ [The dashboard](docs/dashboard.md) · [The Leaderboard](docs/leaderboard.md) ·
[Sharing a board](docs/sharing.md)


## Saving a PDF


The rail has a **Save as PDF** button, and `Cmd-P` does the same thing. There is
no PDF library: the browser already writes PDFs. An A4 content box is narrower
than the 900px breakpoint at which two-column panels drop to one, so the board
linearises on its own, and a print stylesheet does the rest — chrome removed
(topbar, rail, scrim, tooltips), cards kept off page breaks, the scrolling
tables expanded so nothing is clipped, and a dateline added carrying the
machine name and the reading's timestamp, since the rail that normally carries
them is not printed. It prints what the board is showing, including an
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
- **Writes need the key**, compared byte by byte with no early exit, so a wrong
  key cannot be discovered one character at a time. Reads are open so a script
  on your own machine needs no secret to `curl` the overview — set
  `TOKENHUD_PROTECT_READS=1` to change that. Two things stay behind the key
  either way: minting an enrollment link, and the `machines` list.

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
| One developer, several machines | Cross-machine team rollups | Prompt or completion text leaving the host |
| Read-only observation | Shared budgets and policies | Source code or file contents collected |
| Claude Code first | Retained history, chargeback | Sitting in the request path as a proxy |
| MCP server discovery | MCP server health | Production application tracing |
| Token and cost accounting | Other agent runtimes | Output quality scoring or evals |
| Per-machine keys, revocable alone | Thresholds and alerts | |
| | Control — pausing a runaway agent | |
| | SSO, SCIM, admin roles | |

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


**Free forever** for one user: unlimited metering, no sampling, full history.

Self-hosted, that costs nothing to serve because nothing is served — the agent
and the server are both yours, and it runs with the network off entirely. On
the cloud portal it is not free to serve, and saying otherwise would be the
first dishonest number in this file: a heartbeat every thirty seconds is a
Lambda invocation and a row written, plus a subscription held open for as long
as a tab is. It is small. It is not nothing.

**Paid per seat** for teams — none of which exists yet, and all of which is in
the *Later* column above: cross-machine rollups, shared budgets, retained
history, chargeback reports, alerts, admin roles.

The free tier will not be degraded to drive upgrades. The upgrade trigger is
other people — the moment a second developer needs to see the same numbers —
not an artificial ceiling on the first one.

## Licence


MIT — see [LICENSE](LICENSE).

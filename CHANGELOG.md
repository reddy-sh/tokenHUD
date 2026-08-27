# Changelog

Notable changes to TokenHUD. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

### Added
- **The dashboard has a root navigation, and the Leaderboard is a section of
  it.** One rail was doing two jobs: switching machines and switching what you
  were looking at, which is why the leaderboard - a view about the fleet, not
  about a machine - ended up filed behind a machine picker that does not apply
  to it. There are now two rails. The root one, behind the topbar hamburger,
  carries **Token Monitoring**, **Leaderboard** and **Settings**; the second
  exists only inside Token Monitoring and carries the machines, the assistant
  and the board's own sections. They collapse independently on purpose: on a
  narrow screen the machine list is the first thing you give up and the product
  switch is the last, and both states persist, as does the section you were in.
  Opening Leaderboard opens the leaderboard and nothing else - no machine rail,
  no board underneath it.
  **Settings** is new and is not a stub: connection (server, whether the admin
  key is held in this browser, disconnect), appearance (theme, and a switch per
  rail), live updates (follow/pause, last reading, open streams against the
  cap), public links (every live share with its view count, its URL and a
  one-click revoke), what the store is holding on disk, and which agent
  versions are reporting against the latest release.
- **The Leaderboard is four pages, and three of them are a demand signal.**
  A ranking answers "who is ahead" and stops. The same readings answer three
  more questions that nothing else in this repo was asking, so the section now
  has a rail of its own: **Leaderboard** (a headline, then the standings),
  **Live** (what is running at this instant, as counts), **Models** (share,
  reach, momentum, realised cost) and **Demand** (how much, when, how evenly
  spread).
  The measures were chosen so one calculation serves three readers. Whoever
  runs the board wants to know where the spend went; whoever runs the platform
  wants concentration and reach; whoever builds the models wants adoption and
  migration. Hence **reach** beside tokens - depth and breadth are different
  findings and one column hides which you are looking at - **momentum in share
  points** rather than percentage change, because 2% to 4% of a fleet is two
  points and "+100%" would be true and useless - **cache rate**, because a
  workload that reads 99.7% of its context from cache is a different economic
  animal from one that rebuilds it every turn - and **$/M output**, the whole
  bill over the output tokens it produced, which is the realised price of a
  million useful tokens and a number no rate card can give you.
  Codex reports a day's tokens without saying which model spent them, so that
  share is stacked as **unattributed** rather than folded into a model that did
  not earn it.
  **Export aggregates** on the Models page writes a `tokenhud.fleet-demand/1`
  JSON report - totals, per-model share and reach and cache rates and realised
  cost, seven-day momentum, ninety days of daily model split, the hour curve. No
  machine identities and no per-machine rows: a model-demand report is about
  models. A test reads the downloaded bytes and asserts none of the fixture's
  machine names, project names or paths appear in them.
  Two boundaries, stated because they are decisions: nothing is uploaded
  anywhere - aggregates leave only when a person exports them or publishes a
  link - and the **hour-of-day curve is withheld below three machines**, because
  summed over a team it is a demand curve and over one machine it is somebody's
  sleep schedule. `HOURS_MIN_MACHINES` in `share.rs` is that rule, and
  `the_hours_curve_is_withheld_until_it_is_a_sum_of_people` is the test that
  holds it in place.
  The whitelist grew by exactly two fields to carry this: which models each
  day's tokens went to, and what is running now as `{tool, kind, headless,
  uptime}` - never a command line, never a pid.
- **A leaderboard on the dashboard, and a link that makes it public.** Every
  panel on the board answered "how much did *this machine* do". None answered
  "compared to what", which is the question that actually changes behaviour -
  the reason anyone looks at a LeetCode ranking is to find out where they stand.
  `site/src/lib/leaderboard.js` ranks every reporting machine by tokens,
  estimated value, sessions, tool calls or active days, over today / 7 days /
  30 days / all time, with a podium, medals, a 30-day sparkline per row, a
  current-and-longest streak, movement against the previous window, and six
  tiers cut on **decades** of tokens (Rookie → Legend) because a week of heavy
  agent work is not 20% more than a light one, it is ten times, and linear bands
  would put everybody in the same one. A machine with nothing in the window is
  unranked rather than tied for last: three machines that did nothing today are
  not joint third.
- **Shared boards: `POST /api/v1/share` mints a slug, `GET /api/v1/public/board`
  serves it to anyone.** The slug is the whole credential - 96 bits of the same
  randomness the ingest key uses - and the public route answers with no key even
  when `TOKENHUD_PROTECT_READS=1`, because closing the private API to anonymous
  readers is a different decision from publishing a link on purpose. A revoked
  slug and an invented one answer identically, so the endpoint cannot be used to
  test slugs for existence, and revoking is total: the board is computed from
  live data per request, so nothing rendered survives to keep serving.
  What may leave is decided in exactly one place, `server/src/share.rs`, by
  **naming the fields that go out** rather than deleting the private ones from a
  reading. A reading is ~61 KB across some 2,400 leaves and the agent grows new
  ones every release; a blacklist would publish each new field by default and be
  wrong exactly once, in public. Out: token counts, model names and their
  estimated value, counters, one row per date, OS and core count. Never out:
  project names and paths, git branches, prompt text, session titles, process
  command lines, tool and MCP server names, skills, plugins, permissions, plan
  limits, the account hash. Hostnames leave only under `"identities":"host"`;
  otherwise each machine wears a pseudonym hashed from the slug **and** the
  host, so two shared boards of one fleet cannot be lined up against each other
  to work out who is who. `tests/share.rs` asserts this against the bytes an
  anonymous stranger actually receives, not against the whitelist function - a
  unit test on the filter can pass while the route around it leaks.
  The Share dialog shows the same guarantee twice: as two columns of prose, and
  as a live preview fetched from the real public link with no key attached. A
  privacy control nobody can check is a promise; this one is checkable before
  the link is copied.
  `TOKENHUD_PUBLIC_URL` names the address a stranger's browser can reach, and
  the dialog says plainly when a loopback-bound server has minted a link that
  works for its owner and for nobody else.

- **GitHub Copilot CLI is read, not just detected.** Copilot's two halves store
  differently, and only one is readable: the **CLI** writes an append-only event
  log per session to `~/.copilot/session-state/<id>/events.jsonl` whose
  `session.shutdown` records carry the full breakdown - input, output, cache
  read, cache write and reasoning tokens per model, plus premium requests and
  AI units (on this machine: 494,703 tokens and 0.99 premium requests across six
  requests). The **VS Code extension** keeps only `sessions` and `turns` tables
  of conversation and no usage at all, so it is not claimed to be read.
  The trap worth naming: these metrics are **per segment and must be summed**,
  the exact opposite of Codex's cumulative `total_token_usage`. A resumed
  session writes one shutdown record per stop, and taking the last - the habit
  the Codex collector correctly enforces - would silently divide a session's
  usage by the number of times it was resumed. Prompt text and tool arguments
  are never parsed: conversation records are skipped by type, and a tool call
  contributes its name alone.
- **Every integration is on the board, and the quiet ones say what to do.**
  A tile with no numbers used to be a dead end - it answered "what can I see?"
  and left "why can't I see Gemini, and what do I do about it?" hanging.
  `agent/src/integrations.rs` now catalogues twenty-six tools, resolves each
  against the machine into one of six states, and carries the steps that move it
  to the next one: **Gemini CLI** is one `telemetry` block in `settings.json`
  away from logging six token fields per call; **Cursor**'s token counts need a
  team admin key and `POST /teams/filtered-usage-events` (a personal Pro plan
  has no usage API at all); **Windsurf** exposes credits and never tokens, and
  only to a team service key; **Amazon Q Developer** publishes no token metric
  in any of its 43 reported metrics, which the tile states outright rather than
  implying a number exists. Web products - Replit, v0, Bolt, Lovable - are listed
  with no steps, because inventing an enablement path for them would waste an
  afternoon. Each entry is marked `verified` (opened on a real machine) or
  `documented` (from the tool's own docs), because a wrong setup step costs a
  user more than a missing tile does.
  The catalogue probes for existence only; every path it touches is declared in
  the manifest under PROBED, which is why the consent digest changes and the
  agent asks again rather than inheriting an older yes.
- **Sign in, add a machine, watch the board - the portal is live.**
  [tokenhud.com](https://tokenhud.com) now signs you in (AWS Amplify, Cognito
  email and password) and registers machines: **Machines → Add machine** mints
  a one-shot enrollment link (15-minute expiry, single use) and shows two
  commands - the curl install and `tokenhud-agent enroll "<ingest-url>#<token>"`.
  The agent speaks one protocol either way: it enrolls against the cloud ingest
  endpoint - a Lambda Function URL running a function that reproduces the
  server's exact wire protocol, status codes, JSON keys and pairing-code
  derivation - precisely as it would against a local server. Enrolling no longer
  exits: an approved machine falls straight through into the reporting loop, so
  one command both registers the machine and starts it heartbeating
  `POST /api/v1/ingest` every `TOKENHUD_INTERVAL` seconds (default 30) with its
  own per-machine key. Those heartbeats go to that ingest Function URL, not to
  tokenhud.com - which is the address to allow if egress is filtered. Nothing
  else needs configuring, because `~/.tokenhud/machine.json` carries both the
  server URL and that machine's key; keeping it running across logins is the
  launchd or systemd unit in `agent/dist/`.
  Machines are auto-approved - the signed-in owner minted the link seconds
  earlier - with the pairing code still shown on both ends for eye-matching;
  the board updates the moment a heartbeat is written (AppSync subscriptions),
  and revoking a machine in the portal shuts that one door. The privacy line
  has not moved: nothing leaves a machine until you enroll it, metrics leave
  and content never does, and the cloud stores the same snapshot the local
  server did.
- **Devin is read, not just detected.** Devin ships two products and they store
  differently: the **Devin CLI** persists real per-session usage -
  `total_credit_cost` and `total_acu_cost`, plus model and mode - in
  `~/.local/share/devin/cli/sessions.db`, and the board now surfaces it (on this
  machine: 25,600 credits, 24,800 of them on `claude-opus-4-6-thinking`). It is
  read through `sqlite3`, read-only, with a column-scoped query that never names
  the `prompt_history` / `message_nodes` / `tool_call_state` tables or the
  `title` / `cogs_json` columns - the conversation is never opened. Credits are
  shown as credits; no credit→dollar rate is invented. **Devin Desktop** adds
  session activity only (it records no usage locally). Devin's MCP servers
  (`~/.config/devin/mcp_config.json`) and custom subagents (`~/.config/devin/agents/`)
  are traced by name - `env`/`headers` secrets and agent bodies never read.
- **An honest line on cloud-only tools.** Cursor, Devin Desktop, Windsurf,
  Gemini CLI, Copilot, Antigravity and Aider are detected but keep usage in their
  cloud; the board says so plainly rather than inventing a local number. Real
  figures for those need their own APIs - an opt-in network path, not a file.
- **Fixed: the assistant picker did not pick anything.** Choosing Codex CLI
  redrew Claude Code's panels, unchanged, under a Codex label - same sessions,
  same models, same usage windows, all of them read from `~/.claude`. The board
  collected Codex data and then never read it: `web/index.html` contained no
  reference to `codex` at all. Panels now declare which assistant they belong
  to (`data-tool`), the picker hides the ones that do not, and Codex has its own
  board - tiles, plan windows, sessions, tokens by model, and the approval and
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
  matched now, on the binary rather than the word - `~/.codex` appears in half
  the command lines on a machine that runs Codex and none of them is a running
  Codex. "Running now" and "Recently finished" follow the picker; Codex also
  gets tokens per day and a projects list built from each rollout's own `cwd`,
  since it has no projects directory to read one from.
- **Governance panels: what an assistant may reach, beside what it did reach.**
  Every other panel answers "what did it spend". These answer "what can it
  touch" - MCP servers with their transport, credentials and call counts;
  permission rules by scope; what runs on a hook; plugins, skills and subagents
  with how often each was actually invoked. Configured and used are separate
  columns and never merged: a server mounted six months ago and never called is
  a row only the pair can state, and a call count cannot tell you a server is
  mounted at all. Servers called but absent from any settings file - the ones a
  plugin or a project `.mcp.json` brought in - are listed as such rather than
  quietly dropped.
- **Tool calls are counted by name.** The transcript index learns a call's tool
  name (`transcripts.json` version 5, so the corpus is re-read once), which is
  what makes "this MCP server has been called 1,386 times" a measurement rather
  than an inference. `subagent_type` and `skill` are taken too, because they
  name a configured capability. Nothing else from a tool's input is read: not
  the command, not the path, not the prompt - asserted by a test that dumps the
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
- **The agent is now a Rust binary** (`agent/`) - the same readings from the
  same files in the same payload, as one 1.94 MB binary with no interpreter to
  install. On this machine: **6.5 MB resident against the Python agent's
  24.4 MB**, a warm cycle of 50 ms against 130-200 ms, and a cold scan of a
  1.1 GB corpus that peaks at 95 MB rather than 590 MB.
- **The Python agent has been removed.** It served as the oracle first: a
  conformance harness ran both against a frozen copy of real transcripts and
  compared every leaf of both payloads, ending at **860 leaves and zero
  substantive differences** over 150 transcripts. Its eight machine checks
  moved to `agent/tests/machine.rs` before it went, along with three more for
  seams the Python suite never had to cover; the harness itself went with the
  thing it compared against. `~/.tokenhud/transcripts.json` is unchanged, so an
  existing install carries over with no re-scan.
- **The server is now a Rust binary** (`server/`) - same endpoints, same
  database, same wire format, 2.05 MB with SQLite compiled in. Against the
  Python server it replaced: **ingest 2,488 → 5,402 req/s** at 16 concurrent,
  idle RSS **29.5 → 7.7 MB**, and at 1,000 concurrent event-stream watchers the
  Python server refused 390 where this one serves all of them.
- **The Python server has been removed.** It was the oracle first: a
  conformance harness drove both servers through the same sequence of state
  changes and diffed every answer - 24
  checks, zero differing leaves - then its ten checks moved into
  `server/tests/` and it went, along with the harness that needed it.
- **Fixed: floats did not survive being stored and read back.** `serde_json`'s
  default parser is not correctly rounded - it writes `1.1400000000000001` and
  reads back the `f64` that prints as `1.14` - where Python's `json` uses
  `strtod` and does not. `float_roundtrip` is now on in both binaries. Found by
  porting a check, and unfindable by the conformance harness, which compared two
  implementations against each other rather than either against its own input.
- **`scripts/` is one verb per script.** `start-server.sh`, `start-agent.sh`,
  `start-portal.sh` and their `stop-` counterparts each do one thing and check
  before doing it. The server builds when it is stale, mints an ingest key into
  `.env` (mode 600) if there is none, and waits on `/healthz` before claiming to
  be up. The agent will not start until this build's read manifest has been
  agreed to, and the script prints the two commands that show it and record it
  rather than agreeing on your behalf. The portal restarts itself when a
  dependency was installed after it booted, because a dev server keeps serving
  the module graph it started with and the only symptom is a blank page with the
  reason buried in a logfile. `start-all.sh` and `stop-all.sh` run the set in the
  order that matters, and `status.sh` says what is up, where, and what the store
  is holding. Tests are `cargo test` in `agent/` and in `server/`, and
  `npx playwright test` in `site/`.
- **`agent/INSTALL.md`** - installation, four routes, with launchd and systemd
  units in `agent/dist/`. Every command in it was run on the machine it was
  written on, and the parts that were not - Linux, cross-compilation - say so
  instead of implying otherwise.
- **Usage windows** - your plan's real five-hour and seven-day limits, read from
  Claude Code's own cache. Real percentages and reset instants, with the cache's
  age on the card's face; past an hour the percentages grey out and the
  countdowns stay live, because a reset instant is absolute and does not rot.
- **Recently finished** - agents that were running at one reading and gone by the
  next, derived server-side by diffing consecutive snapshots. Carries both
  timestamps so an ending is reported as a range when the gap was large.
- **Estimated value** - per session, model and day, priced at API list rates and
  labelled as an estimate everywhere it appears. Unpriced models report as
  *unpriced*, never as `$0`.
- **Server-sent events** - the board is pushed to rather than polled; polling
  remains the fallback.
- **A navigation rail** - docked above 1240px, an overlay below, with the nav rows
  doubling as an at-a-glance digest.
- **Print stylesheet and Save as PDF**, with no PDF library.
- **`docs/ARCHITECTURE.md`** - what runs today with the measurements behind it,
  the difference format, the account/device/agent identity model that
  multi-machine needs, and the Python-vs-Node question settled on those numbers
  rather than around them.
- Inline SVG favicon and bundled fonts - the board fetches no third-party
  asset. The origins it does reach are Cognito and AppSync: signing in, and
  reading your own machines.

### Fixed
- **The admin board no longer re-renders itself to a standstill.** `BoardView`
  reports its computed navigation up to the shell, which turns it into state;
  the shell derived a fresh `data` object on every render and handed it back
  down. Each half re-rendered the other until React gave up with "maximum
  update depth exceeded". Two causes, both now closed: inline fallbacks
  (`m.governance || {}`) that made "absent" a *new* value on every render and so
  broke every memo downstream of them, and an unmemoised reshaping of the
  overview in `SelfHost`. A reading missing any one subtree - an older agent, a
  collector that found nothing - was enough to trigger it.


### Changed
- **The server is now the self-host API only.** It keeps history in SQLite and
  answers `/api/v1/*` as before; it no longer serves HTML, and `GET /` is a
  JSON 404. The board lives in the portal, and the portal reads the cloud
  account you sign in to - `./scripts/start-portal.sh` runs that same portal on
  localhost against that same cloud, so it does not read a server on
  `127.0.0.1:8787` either. Self-hosting therefore has no UI: enrolling a machine
  is `POST /api/v1/enroll/new` to mint a one-shot link and
  `POST /api/v1/machines/decide` with `{installId, action}` to approve it, both
  carrying the board key in `X-TokenHUD-Key`. `server/README.md` has the calls.
- **History is stored as differences.** A reading is 61 KB and 59 of its 2,388
  leaves change between one reading and the next, so `snapshots` now keeps a
  keyframe every 60 rows and a compressed structural difference in between:
  **0.66 KB a reading instead of 61 KB**, and 4.38 GB per host per month becomes
  0.05 GB. Reading history replays the chain; round-tripping is asserted
  byte-for-byte by `history_round_trips_through_the_chain` in
  `server/tests/store.rs`. Rows written before this are read as they are
  and age out with retention - nothing is rewritten.
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
- HTTP/1.1 with keep-alive, and gzip on responses - 69.3 KB to 14.0 KB on the wire.

### Removed
- **The embedded web dashboard** (`web/index.html`) and, with it, the server's
  static-file fallback and `TOKENHUD_WEB`. The board is the portal now.
- **The portal's "Open Dashboard" overlay** - the server-URL-plus-API-key way
  in. Signing in and enrolling a machine replaced it.

### Fixed
- **The server listened with a backlog of five.** `socketserver`'s default; one
  browser opens six connections to an origin by itself. Every connection past
  the backlog was refused by the kernel, so nothing appeared in any log.
  Measured with a thousand simultaneous watchers: 512 refused before, 317 after
  - the rest of that ceiling is thread-per-reader, and is in
  `docs/ARCHITECTURE.md` §5 rather than pretended away here.
- **Retention could orphan a difference chain.** Pruning at the cutoff exactly
  would delete a keyframe that surviving rows still needed; the cut is now taken
  at the last keyframe at or before the cutoff, which over-keeps by under an
  hour and can never lose a reading inside the window.
- The event-stream heartbeat re-sent the entire payload every 20 seconds.
- A held-open stream was never closed on page unload, leaking one of the
  browser's six connections per origin until the page could not load at all.

# AI Mission Control

A status board for the AI coding agents running on your machines — sessions,
messages, tool calls, tokens by model, which projects are live, and what is
running right now.

Datadog's shape, at laptop scale: **an agent on each machine collects, a server
stores, a dashboard reads the server.** No SaaS, no account, no telemetry to
anyone. Python standard library only — nothing to install.

```
┌──────────────┐   POST /api/v1/ingest   ┌──────────────┐        ┌───────────┐
│  agent       │ ──────────────────────► │  server      │ ◄───── │ dashboard │
│  (per host)  │   X-AIMC-Key            │  SQLite      │  GET   │ (browser) │
└──────────────┘                         └──────────────┘        └───────────┘
   reads ~/.claude, ps                      keeps history          reads only
```

Today it understands **Claude Code**. The collector interface is one function
returning JSON, so other agent runtimes drop in beside it.

## Quick start

```bash
git clone https://github.com/reddy-sh/AIMissionControl.git
cd AIMissionControl

cp .env.example .env
python3 server/server.py --new-key        # paste the value into .env as AIMC_KEY

./scripts/run.sh                          # starts both, detached
```

Open **http://127.0.0.1:8787**.

```bash
./scripts/run.sh status     # is it up? which hosts? how many snapshots?
./scripts/run.sh logs       # follow both
./scripts/run.sh stop
./scripts/run.sh restart
```

`run.sh` detaches on its own, so a trailing `&` is unnecessary (harmless if you
type it). It refuses to double-start and reaps processes left behind by an
earlier hand-start, so there is never more than one agent reporting per host.

To run the pieces separately — a server on one box, agents on several — use
`scripts/start-server.sh` and `scripts/start-agent.sh` instead.

The first reading lands within one interval (30s by default); the board says
so until it does.

Check what the agent would send, without a server and without sending anything:

```bash
python3 agent/agent.py --dry-run | less
```

## Layout

| Path | What it is |
|---|---|
| `agent/collectors.py` | every source, one function each — add one here and nowhere else |
| `agent/agent.py` | collect → POST loop, with an on-disk buffer for when the server is away |
| `server/store.py` | SQLite: `hosts` (what is true now) + `snapshots` (what was true then) |
| `server/server.py` | ingest, query, and the static dashboard |
| `web/index.html` | the board — one self-contained file, no CDN, no build step |

## The API

| | |
|---|---|
| `POST /api/v1/ingest` | one snapshot. Requires `X-AIMC-Key`. |
| `GET /api/v1/overview` | latest reading per host + agent liveness |
| `GET /api/v1/history?host=…&limit=…` | recent snapshots for one host |
| `GET /healthz` | liveness |

A host is reported **up** while its agent has checked in within 2 minutes,
**stale** to 15, **down** after. That is a statement about the agent, not
about whether the machine is switched on — a distinction worth keeping.

## Privacy and safety

The defaults are chosen so that doing nothing is safe.

- **The server binds `127.0.0.1`.** Nothing off your machine can reach it until
  you change `AIMC_BIND` on purpose.
- **Prompt text is not sent.** `AIMC_SEND_PROMPTS=1` opts in. Off, the board
  shows counts and never content.
- **Command lines are truncated** before they cross the wire — an argv can
  carry a path, a prompt, or a token.
- **No data is in this repo, and none can be.** `.env`, `data/` and `*.db` are
  gitignored; the repo ships code and an example config.
- **Writes need the key**, compared with `hmac.compare_digest` so a wrong key
  cannot be discovered one byte at a time. Reads are open so the dashboard
  needs no secret in the browser — set `AIMC_PROTECT_READS=1` to change that.

**If you expose the server**, the ingest key is a bearer secret in a plain
header: put TLS in front of it (a reverse proxy is the easy answer) and treat
`AIMC_KEY` as a real credential.

## Honesty

Nothing on the board is estimated.

- **No dollar figures.** Claude Code reports `costUSD: 0` for every model on a
  subscription plan. Pricing that from a public rate card would be a guess
  presented as a fact, so the board says cost is not reported instead.
- **Cache reads are excluded from the token chart** — they run ~100× the other
  numbers and would flatten everything else — but they are in the model table.
- **A missing source says so.** A collector that fails reports the rest of the
  machine rather than dropping the host, because "the disk collector is down"
  and "the host is down" are different facts.

## Design

The chart palette is validated, not chosen by eye: it clears the lightness
band, chroma floor, colour-blind separation, normal-vision floor and contrast
checks in both light and dark. The three light-mode hues that sit under 3:1 on
the light surface are why the legend carries values and the token chart has a
table view — identity is never carried by colour alone.

## Roadmap

- collectors for other agent runtimes
- alerting (an agent that stops reporting; a run that overruns its budget)
- per-project drill-down and time-range selection
- a packaged launchd / systemd unit so the agent starts with the machine

## Licence

MIT — see [LICENSE](LICENSE).

# Configuration

Everything is an environment variable. There is no config file to find, no
schema to learn, and the defaults are chosen so that doing nothing is safe:
loopback bind, key required for writes, no prompt text, no network calls the
agent was not asked to make.

Copy [`.env.example`](../.env.example) to `.env` for the scripts in
[`scripts/`](../scripts/) to pick up. It is gitignored and written mode 600.

A cloud-enrolled agent needs no `.env` at all: `tokenhud-agent enroll` writes
`~/.tokenhud/machine.json`, which carries the server URL and that machine's own
key.

## Shared

| Variable | Default | What it does |
|---|---|---|
| `TOKENHUD_KEY` | *(none)* | The ingest key. Generate one with `tokenhud-server --new-key`. Without it the server rejects every agent |
| `TOKENHUD_SERVER` | `http://127.0.0.1:8787` | Where the agent reports |

## Agent

| Variable | Default | What it does |
|---|---|---|
| `TOKENHUD_INTERVAL` | `30` | Seconds between readings |
| `TOKENHUD_HOST` | the machine's hostname | Override the name this machine reports under |
| `TOKENHUD_STATE` | `~/.tokenhud` | Where the transcript index and enrollment identity live |
| `TOKENHUD_SPOOL` | `<state>/spool.jsonl` | Readings buffered while the server is away, replayed on reconnect |
| `TOKENHUD_SCAN_BUDGET_MB` | `512` | Transcript bytes read per cycle. The first pass over a large corpus takes a few cycles and stops mid-file rather than stalling a reading |
| `TOKENHUD_ONCE` | *(off)* | `1` takes a single reading and exits. Same as `--once` |
| `TOKENHUD_CLAUDE_JSON` | Claude Code's own path | Override where the usage cache is read from |

### Opt-in, and off by default

| Variable | What it turns on |
|---|---|
| `TOKENHUD_SEND_PROMPTS=1` | Ships recent prompt subjects and the session titles written from them. **Off by default.** The manifest the agent shows before its first read names this explicitly |
| `TOKENHUD_DEVIN_TOKEN` + `TOKENHUD_DEVIN_ORG` | Devin org usage from the Devin API. This is the one place the agent makes an outbound call, and only when both are set. Create a service-user token at app.devin.ai → Settings → Devin API |

## Server

| Variable | Default | What it does |
|---|---|---|
| `TOKENHUD_BIND` | `127.0.0.1` | Interface to bind. Anything else exposes the server - read the note below |
| `TOKENHUD_PORT` | `8787` | Port to listen on |
| `TOKENHUD_DB` | `./data/tokenhud.db` | The SQLite file. Created with its parent directory |
| `TOKENHUD_RETENTION_DAYS` | `30` | How long snapshots are kept. Pruned hourly, and once at startup |
| `TOKENHUD_PROTECT_READS` | *(off)* | `1` requires the key on `GET` too. Does **not** gate a published share link |
| `TOKENHUD_MAX_STREAMS` | `64` | Event-stream readers allowed at once. Past the cap the board falls back to polling |
| `TOKENHUD_PUBLIC_URL` | *(none)* | The address this server is reachable at from outside, when that is not the address requests arrive on. Only [shared links](sharing.md) need it |

## Scripts

| Variable | Default | What it does |
|---|---|---|
| `TOKENHUD_PORTAL_PORT` | `5174` | Port for the local portal dev server |
| `TOKENHUD_PREFIX` | `~/.local/bin` | Where `install.sh` puts the binaries |
| `TOKENHUD_VERSION` | latest release | Pin the version `install.sh` fetches |

## On exposing the server

The ingest key is a bearer secret in a header. Over plain HTTP on a LAN that is
adequate against accident and useless against anyone listening.

If this server ever leaves your machine:

- put TLS in front of it - a reverse proxy is the easy answer
- treat `TOKENHUD_KEY` as a real credential
- set `TOKENHUD_PUBLIC_URL` so shared links name an address that resolves
- know that `GET /api/v1/portal-key` refuses to answer on a non-loopback bind,
  because a network-reachable server must not give its key away

The server prints a warning at startup when `TOKENHUD_BIND` is anything other
than `127.0.0.1`.

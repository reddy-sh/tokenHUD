# Installing the TokenHUD agent

The agent is one binary. It reads what Claude Code has already written on your
machine, prices it, and POSTs a reading to your server — cloud or self-host —
every thirty seconds. It
runs as you, it writes to one directory, and it needs nothing installed
alongside it.

Everything in this guide was run on the machine it was written on: macOS 27.0,
arm64, Rust 1.95.0. Where something has *not* been verified here — Linux,
Windows, cross-compilation — it says so rather than implying otherwise.

---

## Before you install

The agent reads your home directory. That is the whole job, so it is worth
thirty seconds of your attention before you run it:

| it reads | for |
|---|---|
| `~/.claude/projects/**.jsonl` | per-session token counts, models, timings |
| `~/.claude/stats-cache.json` | Claude Code's own daily activity roll-up |
| `~/.claude.json` → `cachedUsageUtilization` **only** | your plan's real 5-hour and 7-day windows |
| `ps -Ao pid,etime,command` | which agents are running right now |

It does **not** read your prompts (opt-in, off by default), your account
identity, or your billed spend. It never writes to any file Claude Code owns.
The per-path table and the reasoning are in [`SECURITY.md`](../SECURITY.md).

It writes to exactly one place: **`~/.tokenhud/`** — a transcript index, a
per-install salt, and a spool for readings that could not be sent.

---

## 1. Prerequisites

**A running TokenHUD server**, or the intention to start one. The agent posts to
it; without one it buffers to disk and waits, which is a supported state rather
than an error. A cloud enrollment counts: the ingest URL the portal hands you
is the server, as far as the agent is concerned.

**A Rust toolchain** — only if you want to build from source. Prebuilt binaries
are available for macOS and Linux (see Route A below), so most users need
nothing installed beforehand.

If you do want to build from source:

```bash
cargo --version     # any recent stable; verified on 1.95.0
```

If that says "command not found":

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Homebrew's `rust` works too, and is what this machine has. The difference
matters in exactly one place — [cross-compiling](#appendix-building-for-another-machine)
— and nowhere else.

---

## 2. Install

Four routes. Pick by where you want the binary to live.

### Route A — prebuilt binary (no Rust required)

One command. Downloads the latest release for your OS and architecture, puts it
in `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
```

Supports macOS (arm64, x86_64) and Linux (x86_64, arm64). The script
auto-detects your platform.

Or download manually from
[GitHub Releases](https://github.com/reddy-sh/tokenhud/releases/latest) and
place the binary anywhere on your PATH.

Skip to [Configure](#3-configure).

### Route B — you have the repo, and want the scripts to manage it

Simplest, and the one to use on the machine you develop on. There is no
separate build step: `start-agent.sh` builds a release binary when the source
has moved, refuses to start until the read manifest has been agreed to, then
runs it detached.

```bash
cd tokenhud
./scripts/start-agent.sh
```

```
building agent (cargo, release — quick when nothing changed)…
agent started (pid 41207) → logs/agent.log
agent up → reporting to http://127.0.0.1:8787 (or its enrolled server)
```

The binary stays in the repo at `agent/target/release/tokenhud-agent`, which is
where the scripts look for it. Skip to [Configure](#3-configure).

### Route C — a binary on your PATH (build from source)

For running the agent by hand, or from a launchd/systemd unit.

```bash
cd tokenhud
cargo install --path agent
```

That puts `tokenhud-agent` in `~/.cargo/bin/`. **Check that directory is on
your PATH** — on this machine it was not, which is the single most likely reason
the next command "isn't found":

```bash
case ":$PATH:" in *":$HOME/.cargo/bin:"*) echo "on PATH";; *) echo "NOT on PATH";; esac
```

If it isn't, add it to your shell profile:

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc && exec zsh
```

### Route D — build here, run there

The binary links only against libraries macOS already ships
(`libSystem`, `CoreFoundation`, `libiconv`), so it copies to another Mac of the
same architecture and runs:

```bash
scp agent/target/release/tokenhud-agent you@other-mac:~/.local/bin/
```

Different architecture or a Linux box: see the
[appendix](#appendix-building-for-another-machine).

---

## 3. Configure

### Cloud enroll — no configuration at all

If the machine was added in the portal ([tokenhud.com](https://tokenhud.com) →
**Machines → Add machine**), run the one command it shows:

```bash
tokenhud-agent enroll "<ingest-url>#<token>"
```

It shows the read manifest and waits for your yes before it claims the link —
enrolling is exactly the moment this machine starts reporting, so the question
is asked there. Then it writes `~/.tokenhud/machine.json` (mode 600), carrying
the ingest URL and this machine's own key, and falls through into the loop rather
than exiting: the first reading goes out at once and the board fills in from
it. Ctrl-C stops it — [§5](#5-keep-it-running) is how you keep it reporting
across logins. From then on the agent starts with no environment variables at
all. The variables below still apply on top — `TOKENHUD_INTERVAL` sets the
cadence, 30 seconds by default — they are just no longer required.

The URL in that link is where the readings go. For a cloud enrollment it is the
ingest Lambda's Function URL, not `tokenhud.com` — the address to allow if
egress from this machine is filtered.

The same command against a self-host server's enrollment link works
identically, with one difference: nobody has pre-approved it, so the machine
appears as **pending** with a pairing code and waits until someone approves it
over the API ([INSTALL.md](../INSTALL.md#linux--sharing-one-board-across-machines)
has both calls).

### Manual — two variables

Two variables matter. The rest have working defaults.

```bash
export TOKENHUD_SERVER=http://127.0.0.1:8787   # where your server is
export TOKENHUD_KEY=…                          # the server's ingest key
```

Get a key from the server, once:

```bash
./server/target/release/tokenhud-server --new-key
```

Put both in `.env` in the repo root: that is where `./scripts/start-agent.sh`
reads them from, and where `./scripts/start-server.sh` writes a generated key
(mode 600). An enrolled machine ignores `.env` on purpose — `machine.json`
already names a server, and pairing that with a key from somewhere else means
a 401 forever. For a standalone install, put them in the service file (§5) or
your shell profile — but note that a key in `~/.zshrc` is readable by anything
you run.

### Every variable

| variable | default | what it does |
|---|---|---|
| `TOKENHUD_SERVER` | `http://127.0.0.1:8787` | where to POST. An enrollment supplies it instead; setting this overrides one |
| `TOKENHUD_KEY` | *(none)* | ingest key — or the enrolled machine's own. With neither, the agent exits 2 rather than posting into a 401 loop |
| `TOKENHUD_INTERVAL` | `30` | seconds between readings |
| `TOKENHUD_HOST` | your hostname | how this machine is labelled. Set it when two machines share a hostname — they merge on the board otherwise |
| `TOKENHUD_STATE` | `~/.tokenhud` | the one directory it writes |
| `TOKENHUD_SPOOL` | `$TOKENHUD_STATE/spool.jsonl` | where unsent readings queue |
| `TOKENHUD_SCAN_BUDGET_MB` | `512` | most it will read per cycle while catching up |
| `TOKENHUD_SEND_PROMPTS` | *(off)* | `1` puts prompt text and session titles in the payload. Off unless you mean it |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | if your Claude Code config lives elsewhere |

---

## 4. First run

**Look before you send.** This writes the index and prints the payload; it
posts nothing and needs no key:

```bash
tokenhud-agent --dry-run | head -40
```

**Then one real reading:**

```bash
tokenhud-agent --once
```

```
19:12:27 tokenhud-agent 0.2.0 (rust) · host=your-mac.local
19:12:27 server=http://127.0.0.1:8787 interval=30s
19:12:27 sent · 13 proc · 21 projects
```

**Then continuously** — either through the scripts, from the repo root:

```bash
./scripts/start-agent.sh    # builds if the source moved, then runs it detached
./scripts/status.sh         # server, agent and portal, one line each
./scripts/stop-agent.sh     # stops the agent; the server keeps serving
```

There is no restart verb — `./scripts/stop-agent.sh && ./scripts/start-agent.sh`
is the restart, and `./scripts/start-all.sh` brings up server, agent and portal
in that order.

…or on its own, in a terminal you keep open:

```bash
tokenhud-agent
```

### The first cycle does more work than the rest

The first run indexes every transcript you have. On a 1.1 GB corpus that took
about a second here, and peaks at 95 MB of memory; on a cold disk it takes
longer. If it hits the per-cycle byte budget it stops and resumes on the next
cycle, and the board says **"Indexing transcripts — 40% of 1.1GB read. Figures
are partial and climbing."** until it catches up. That is a true statement about
the board, not a stall.

Afterwards each cycle reads only what was appended — a few kilobytes, about
50 ms, **6.5 MB resident**.

---

## 5. Keep it running

### macOS — launchd

```bash
cp agent/dist/com.tokenhud.agent.plist ~/Library/LaunchAgents/
sed -i '' "s|REPLACE-ME/path/to/tokenhud-agent|$(command -v tokenhud-agent)|" \
  ~/Library/LaunchAgents/com.tokenhud.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenhud.agent.plist
```

Check it, and stop it:

```bash
launchctl print gui/$(id -u)/com.tokenhud.agent | head -20
tail -f /tmp/tokenhud-agent.log

launchctl bootout gui/$(id -u)/com.tokenhud.agent
```

That `sed` fills in the file's one REPLACE-ME: the absolute path to the
binary. It has to be absolute — launchd expands neither `~` nor `$HOME`. If
`command -v` comes back empty the binary is not on your PATH, so pass the path
yourself; `~/.local/bin/tokenhud-agent` is where the install script puts it.

Nothing else needs editing. `TOKENHUD_SERVER` and `TOKENHUD_KEY` ship
commented out, because on an enrolled machine `~/.tokenhud/machine.json`
supplies both, and setting one of them in the environment overrides half an
enrollment, which pairs a key with a server it was not issued for. Uncomment
them only for a manual install against your own server.

A **LaunchAgent, not a LaunchDaemon**, deliberately: it runs as you, in your
login session, and can read your home directory. A daemon runs as root before
you log in — more privilege than this needs, and the wrong user to read
`~/.claude` as.

### Linux — systemd

```bash
mkdir -p ~/.config/systemd/user
cp agent/dist/tokenhud-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokenhud-agent
journalctl --user -u tokenhud-agent -f
```

A cloud-enrolled machine needs no configuration at all: `machine.json` carries
the ingest URL and its own key, and the unit marks its env file optional
(`EnvironmentFile=-%h/.config/tokenhud/env`), so a missing file starts the
service instead of failing it.

For a manual install against your own server, write that file first:

```bash
mkdir -p ~/.config/tokenhud
printf 'TOKENHUD_SERVER=http://your-board:8787\nTOKENHUD_KEY=…\n' > ~/.config/tokenhud/env
chmod 600 ~/.config/tokenhud/env
```

Do not write it on an enrolled machine. Naming a server there overrides half an
enrollment, and the failure is a quiet 401 rather than a loud one.

A **user service**, for the same reason. Run it as root and it reads root's home
directory, finds nothing, and reports an idle machine — worse than not running,
because it looks like data.

On a server where nobody stays logged in: `sudo loginctl enable-linger $USER`.

*(The unit file is written and reviewed but has not been run from this machine,
which is a Mac. Treat the first `systemctl --user status` as the real test.)*

---

## 6. Check it worked

Against a self-host server, ask the API — that is the whole of it, since the
server ships no HTML (`GET /` is a JSON 404) and the portal reads a cloud
account rather than your server, wherever you run it from:

```bash
curl -s localhost:8787/api/v1/overview | python3 -m json.tool | head -20
./scripts/status.sh    # from the repo: what is up, and what the server holds
```

For a cloud-enrolled machine the board is [tokenhud.com](https://tokenhud.com):
sign in, and the host card should say **up** with a "last seen" under a minute.

Three things worth glancing at once:

- **`scan.complete: true`** — the whole corpus is indexed
- **`limits.available: true`** — it found your real plan windows
- **the estimate is labelled an estimate** — every dollar figure on the board is
  list-price arithmetic, not a bill. On a subscription the CLI reports `$0`,
  which is true and useless; the board answers a different question and says so.

---

## 7. Uninstall

The portal's **Remove** action gives you this command. Run it on the machine
whose agent you want to remove; it stops the agent, removes its login service,
deletes the standard installed binary and clears `~/.tokenhud`:

```bash
curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/uninstall-agent.sh | sh
```

It leaves `tokenhud-server` alone. If you built the agent inside a checkout
(Route B), the checkout remains too.

Or remove the pieces yourself:

```bash
# stop it
launchctl bootout gui/$(id -u)/com.tokenhud.agent    # macOS
systemctl --user disable --now tokenhud-agent        # Linux
./scripts/stop-agent.sh                              # or, from the repo

# remove the binary
cargo uninstall tokenhud-agent        # if installed via Route C
rm -f ~/.local/bin/tokenhud-agent     # if installed via Route A, or copied via Route D

# remove what it wrote — this is everything it ever created
rm -rf ~/.tokenhud
```

Route B leaves nothing outside the checkout: `cargo clean` in `agent/`, or
delete the repo.

Nothing else on your machine was touched. It never wrote outside
`~/.tokenhud`, and nothing it read was modified.

---

## Troubleshooting

Each of these is a message the agent actually prints, with what it means.

**`No key — the server will refuse this agent.`** (exit 2)
It stops instead of starting, on purpose: an agent posting into a permanent 401
looks like it is working and is not. Either enroll the machine
(`tokenhud-agent enroll "<link>"`), which gives it a key of its own, or set
`TOKENHUD_KEY`.

**`server refused: 401`**
The key does not match the server's. The reading is buffered, not lost. Compare
`TOKENHUD_KEY` on both sides — the commonest cause is a `.env` the agent did not
load because it was started from a different directory or by a service file.

**`post failed: io: Connection refused`** then **`buffered (server unreachable)`**
The server is not up. This is a supported state: readings queue in
`~/.tokenhud/spool.jsonl` (bounded to 500) and go out with the next successful
post. Verified: a 55.6 KB reading buffered while the server was down, then
flushed and the spool file removed on the next cycle.

**`command not found: tokenhud-agent`**
`~/.cargo/bin` is not on your PATH. See
[Route C](#route-c--a-binary-on-your-path-build-from-source).

**The board says "Indexing transcripts" and stays there**
It is reading a large corpus within a per-cycle budget. Watch `scan.bytesDone`
climb, or raise `TOKENHUD_SCAN_BUDGET_MB`. If `bytesDone` is not moving, check
the log for a permissions error on `~/.claude/projects`.

**No usage data, but the agent says `sent`**
Look at `CLAUDE_CONFIG_DIR`. If your Claude Code config is not at `~/.claude`,
the agent found an empty corpus and honestly reported nothing in it.

**Two machines showing as one host**
They share a hostname. Set `TOKENHUD_HOST` on one of them.

**The numbers look wrong**
Check the agent against your own machine before checking anything else:

```bash
cargo test --manifest-path agent/Cargo.toml -- --nocapture
```

Eleven of those run the real collectors against your real files. A check whose
source is missing skips and says why, which is often the answer on its own.

---

## Appendix: building for another machine

This machine has Rust from Homebrew, which builds for **this** target only.
Cross-compiling needs rustup and a linker for the target:

```bash
rustup target add x86_64-unknown-linux-gnu
cargo build --release --target x86_64-unknown-linux-gnu
```

That still needs a cross-linker, which is the part that usually goes wrong on a
Mac. Two ways round it that do work:

```bash
# Build the Linux binary in a Linux container
docker run --rm -v "$PWD":/w -w /w/agent rust:1.95 cargo build --release

# Or use cross, which manages the containers for you
cargo install cross && cross build --release --target aarch64-unknown-linux-gnu
```

Neither has been run from this machine. Both are the standard answer, and the
container route is the one to try first.

---

## Upgrading

From the repo (Route B) — `start-agent.sh` rebuilds before it starts:

```bash
git pull && ./scripts/stop-agent.sh && ./scripts/start-agent.sh
```

From a release (Route A) — the installer overwrites in place, then restart
whatever runs it:

```bash
curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
launchctl kickstart -k gui/$(id -u)/com.tokenhud.agent   # macOS, if it runs from the unit
systemctl --user restart tokenhud-agent                  # Linux, the same
```

The transcript index format is versioned. If a release changes it, the first
cycle after the upgrade re-reads your corpus once and the board says
"Indexing transcripts" while it does — expected, and it only happens once.

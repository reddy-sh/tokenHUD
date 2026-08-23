# Installing the TokenHUD agent

The agent is one binary. It reads what Claude Code has already written on your
machine, prices it, and POSTs a reading to your board every thirty seconds. It
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

**A Rust toolchain.** There are no prebuilt binaries yet — no GitHub Release to
download — so you build it once. That takes about twenty seconds.

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

**A running TokenHUD server**, or the intention to start one. The agent posts to
it; without one it buffers to disk and waits, which is a supported state rather
than an error.

---

## 2. Install

Three routes. Pick by where you want the binary to live.

### Route A — you have the repo, and want the launcher to manage it

Simplest, and the one to use on the machine you develop on.

```bash
cd tokenhud
./scripts/build.sh
```

```
building tokenhud-agent (release)…
  built  …/agent/target/release/tokenhud-agent
  size   1.94 MB — no runtime, nothing to install alongside it
```

The binary stays in the repo and `run.sh` finds it. Skip to
[Configure](#3-configure).

### Route B — a binary on your PATH

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

### Route C — build here, run there

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

Two variables matter. The rest have working defaults.

```bash
export TOKENHUD_SERVER=http://127.0.0.1:8787   # where your board is
export TOKENHUD_KEY=…                          # the server's ingest key
```

Get a key from the server, once:

```bash
./server/target/release/tokenhud-server --new-key
```

Put both in `.env` next to the server and `run.sh` will load them. For a
standalone install, put them in the service file (§5) or your shell profile —
but note that a key in `~/.zshrc` is readable by anything you run.

### Every variable

| variable | default | what it does |
|---|---|---|
| `TOKENHUD_SERVER` | `http://127.0.0.1:8787` | where to POST |
| `TOKENHUD_KEY` | *(none)* | ingest key. Without it the agent exits 2 rather than posting into a 401 loop |
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

**Then continuously** — either through the launcher:

```bash
./scripts/run.sh restart
./scripts/run.sh status
```

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
$EDITOR ~/Library/LaunchAgents/com.tokenhud.agent.plist   # two REPLACE-ME values
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenhud.agent.plist
```

Check it, and stop it:

```bash
launchctl print gui/$(id -u)/com.tokenhud.agent | head -20
tail -f /tmp/tokenhud-agent.log

launchctl bootout gui/$(id -u)/com.tokenhud.agent
```

A **LaunchAgent, not a LaunchDaemon**, deliberately: it runs as you, in your
login session, and can read your home directory. A daemon runs as root before
you log in — more privilege than this needs, and the wrong user to read
`~/.claude` as.

### Linux — systemd

```bash
mkdir -p ~/.config/systemd/user ~/.config/tokenhud
cp agent/dist/tokenhud-agent.service ~/.config/systemd/user/
printf 'TOKENHUD_SERVER=http://your-board:8787\nTOKENHUD_KEY=…\n' > ~/.config/tokenhud/env
chmod 600 ~/.config/tokenhud/env
systemctl --user daemon-reload
systemctl --user enable --now tokenhud-agent
journalctl --user -u tokenhud-agent -f
```

A **user service**, for the same reason. Run it as root and it reads root's home
directory, finds nothing, and reports an idle machine — worse than not running,
because it looks like data.

On a server where nobody stays logged in: `sudo loginctl enable-linger $USER`.

*(The unit file is written and reviewed but has not been run from this machine,
which is a Mac. Treat the first `systemctl --user status` as the real test.)*

---

## 6. Check it worked

```bash
curl -s localhost:8787/api/v1/overview | python3 -m json.tool | head -20
```

Or on the board itself, `http://127.0.0.1:8787` — the host card should say **up**
with a "last seen" under a minute.

Three things worth glancing at once:

- **`scan.complete: true`** — the whole corpus is indexed
- **`limits.available: true`** — it found your real plan windows
- **the estimate is labelled an estimate** — every dollar figure on the board is
  list-price arithmetic, not a bill. On a subscription the CLI reports `$0`,
  which is true and useless; the board answers a different question and says so.

---

## 7. Uninstall

```bash
# stop it
launchctl bootout gui/$(id -u)/com.tokenhud.agent    # macOS
systemctl --user disable --now tokenhud-agent        # Linux
./scripts/run.sh stop                                # or the launcher

# remove the binary
cargo uninstall tokenhud-agent        # if installed via Route B
rm -f ~/.local/bin/tokenhud-agent     # if copied via Route C

# remove what it wrote — this is everything it ever created
rm -rf ~/.tokenhud
```

Nothing else on your machine was touched. It never wrote outside
`~/.tokenhud`, and nothing it read was modified.

---

## Troubleshooting

Each of these is a message the agent actually prints, with what it means.

**`TOKENHUD_KEY is not set — the server will refuse this agent.`** (exit 2)
It stops instead of starting, on purpose: an agent posting into a permanent 401
looks like it is working and is not. Set the key.

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
`~/.cargo/bin` is not on your PATH. See [Route B](#route-b--a-binary-on-your-path).

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

```bash
git pull && ./scripts/build.sh && ./scripts/run.sh restart
```

The transcript index format is versioned. If a release changes it, the first
cycle after the upgrade re-reads your corpus once and the board says
"Indexing transcripts" while it does — expected, and it only happens once.

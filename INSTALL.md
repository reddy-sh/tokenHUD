# Installing TokenHUD

Two binaries, no interpreter, nothing to install beside them. It reads what
Claude Code has already written on your machine and shows you what your agents
are running and costing.

**It shows you every file it will open before it opens one, and reads nothing
until you say yes.** That is the first command below on every platform.

| | supported | how |
|---|---|---|
| **macOS** (Apple Silicon and Intel) | yes, tested | below |
| **Linux** (x86_64 and arm64) | yes | below |
| **Windows** | **not yet** — see [why](#windows) | — |

---

## macOS

### Quickest — from source

Needs `cargo` ([rustup.rs](https://rustup.rs)); the build takes about thirty seconds.

```bash
git clone https://github.com/reddy-sh/tokenhud.git
cd tokenhud
./scripts/build.sh
./scripts/run.sh
```

`run.sh` does the rest in the right order. It shows you the read manifest, asks,
generates an ingest key, writes it to `.env` with mode 600, and starts both
processes. Then open **http://127.0.0.1:8787**.

You never create the key by hand. On a loopback install it is ceremony rather
than security — both processes are yours, on your machine, started by the same
script. It still exists because it stops mattering only while you stay on
loopback; see [sharing a board](#linux--sharing-one-board-across-machines).

### Look before you agree

```bash
./agent/target/release/tokenhud-agent --what-i-read
```

Prints every path, resolved against *your* machine — real file counts and sizes
— with what is taken from each, what is only checked for existence, the
exhaustive list of what is written, and what is refused with the reason. It
reads nothing while doing it.

```bash
./agent/target/release/tokenhud-agent --dry-run   # the exact reading it would send
```

### Keep it running across logins

```bash
cp agent/dist/com.tokenhud.agent.plist ~/Library/LaunchAgents/
$EDITOR ~/Library/LaunchAgents/com.tokenhud.agent.plist   # two REPLACE-ME values
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenhud.agent.plist
```

Stop it with `launchctl bootout gui/$(id -u)/com.tokenhud.agent`.

A **LaunchAgent, not a LaunchDaemon**, on purpose: it runs as you, in your login
session, and can read your home directory. A daemon runs as root before you log
in — more privilege than this needs, and the wrong user to read `~/.claude` as.

### If you downloaded a binary rather than building one

macOS quarantines anything downloaded and not notarised: *"cannot be opened
because the developer cannot be verified."* Inspect it, then clear the flag
yourself:

```bash
xattr -d com.apple.quarantine ./tokenhud-agent ./tokenhud-server
```

Building from source avoids this entirely, which is why it is the first
instruction. Notarised builds are not shipping yet.

---

## Linux

Same two commands.

```bash
git clone https://github.com/reddy-sh/tokenhud.git
cd tokenhud
./scripts/build.sh
./scripts/run.sh
```

Then **http://127.0.0.1:8787**.

### Keep it running — systemd

```bash
mkdir -p ~/.config/systemd/user ~/.config/tokenhud
cp agent/dist/tokenhud-agent.service ~/.config/systemd/user/
printf 'TOKENHUD_SERVER=http://127.0.0.1:8787\nTOKENHUD_KEY=%s\n' "$(grep '^TOKENHUD_KEY=' .env | cut -d= -f2)" \
  > ~/.config/tokenhud/env
chmod 600 ~/.config/tokenhud/env
systemctl --user daemon-reload
systemctl --user enable --now tokenhud-agent
journalctl --user -u tokenhud-agent -f
```

A **user service**, for the same reason as the LaunchAgent. Run it as root and
it reads root's home directory, finds nothing, and reports an idle machine —
worse than not running, because it looks like data.

On a box where nobody stays logged in:

```bash
sudo loginctl enable-linger $USER
```

The unit sets `RestartPreventExitStatus=2`, so an agent that has not been given
consent stops rather than looping. Give it consent once:

```bash
~/.local/bin/tokenhud-agent --what-i-read
~/.local/bin/tokenhud-agent --accept
```

### Linux — sharing one board across machines

This is the case the ingest key exists for: **one server, several machines
reporting to it.** A laptop, a desktop and two build boxes on one board.

**On the machine running the board:**

```bash
# bind beyond loopback — deliberately
TOKENHUD_BIND=0.0.0.0 ./scripts/run.sh restart
grep '^TOKENHUD_KEY=' .env          # this is the value the others need
```

**On every other machine — agent only, no server:**

```bash
./scripts/build.sh
export TOKENHUD_SERVER=http://board.local:8787   # or the IP
export TOKENHUD_KEY=<the key from the board>
./agent/target/release/tokenhud-agent --what-i-read    # look first
./agent/target/release/tokenhud-agent --accept
./scripts/start-agent.sh
```

The board will show each machine as its own host. If two of them share a
hostname, set `TOKENHUD_HOST` on one — otherwise they merge into a single row.

> **Read this before binding to anything but loopback.** The key is a bearer
> secret in a plain HTTP header. On a LAN that is adequate against accident and
> **useless against anyone listening.** Anyone who can reach the port and has
> the key can write readings to your board; anyone who can reach the port can
> *read* it, because reads are unauthenticated by default so the dashboard needs
> no secret in the browser.
>
> Two things to do if this leaves your own machine:
> - put TLS in front of it — a reverse proxy is the easy answer
> - set `TOKENHUD_PROTECT_READS=1` so `GET` needs the key too
>
> Treat `TOKENHUD_KEY` as a real credential: it is mode 600 in `.env` for a
> reason, and pasting it into a shell puts it in your history.

Per-device keys, revocation and TLS by default are the cloud tier's job, not
this one's. Today there is one key per board.

---

## Windows

**Not supported yet, and the honest reason is that it will not compile.** The
agent calls `uname`, `getloadavg`, `kill`, `gethostname` and `getentropy`
unguarded, and shells out to `ps` to find running agents. None of those exist on
Windows.

What would make it work, in order:

1. A process lister behind a trait — `ps` on Unix, `CreateToolhelp32Snapshot` or
   WMI on Windows
2. Replace the five `libc` calls with `std` equivalents or `#[cfg]` branches
   (hostname, load average, process liveness, randomness)
3. Path handling for `%USERPROFILE%\.claude` alongside `~/.claude`
4. A Windows CI leg so it stays working

None of that is large. It is not done, so this page does not pretend otherwise.

**Today, on Windows, use WSL2.** Claude Code inside WSL writes to the WSL
home directory, so the Linux instructions apply unchanged and the agent reads
the right files. A native Windows Claude Code install is the case that does not
work.

---

## Uninstalling

```bash
./scripts/run.sh stop

launchctl bootout gui/$(id -u)/com.tokenhud.agent     # macOS, if installed
systemctl --user disable --now tokenhud-agent          # Linux, if installed

rm -rf ~/.tokenhud     # the index, the spool, the salt, your consent record
```

`~/.tokenhud` is the only directory it ever writes. Nothing it read was
modified, and nothing else on your machine was touched.

---

## Troubleshooting

**`TOKENHUD_KEY is not set`** — you are on an older build. `git pull` and run
`./scripts/run.sh` again; it generates the key itself now.

**The agent starts and immediately stops** — it has not been given consent, and
whatever started it had no terminal to ask on. Run
`tokenhud-agent --what-i-read`, then `tokenhud-agent --accept`.

**The board says "Indexing transcripts — 40% of 1.1GB read"** — the first run
indexes everything you already have, within a per-cycle byte budget. It catches
up on its own and only happens once.

**No usage data, but the agent says `sent`** — your Claude Code config is not at
`~/.claude`. Set `CLAUDE_CONFIG_DIR`.

**Two machines showing as one host** — they share a hostname. Set
`TOKENHUD_HOST` on one.

**Numbers look wrong** — check the agent against your own machine before
anything else:

```bash
cargo test --manifest-path agent/Cargo.toml -- --nocapture
```

Eleven of those run the real collectors against your real files, and a check
whose source is missing skips and says why — which is often the answer.

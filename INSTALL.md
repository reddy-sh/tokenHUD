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

## Cloud portal — the two-command path

No server to run. Install the agent:

```bash
curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh
```

Sign in at [tokenhud.com](https://tokenhud.com) with an email and a password,
open **Machines → Add machine**, and run the command it shows on the machine
you just installed on:

```bash
tokenhud-agent enroll "<ingest-url>#<token>"
```

The link is one-shot and expires in 15 minutes. Enrolling shows the read
manifest and waits for your yes, writes the machine's own key to
`~/.tokenhud/machine.json` (mode 600) — no environment variables, no `.env` —
and then keeps going: it falls through into the reporting loop rather than
exiting, so the first reading goes out at once and the board fills in from it.
Ctrl-C stops it.

That run lasts as long as the terminal does. To keep it reporting across
logins, install the unit — [launchd](#keep-it-running-across-logins) on macOS,
[systemd](#keep-it-running--systemd) on Linux. A cloud-enrolled agent needs no
environment at all: delete the `TOKENHUD_SERVER` and `TOKENHUD_KEY` entries
from the plist, leaving the path to the binary as its only REPLACE-ME, or
leave those two lines out of `~/.config/tokenhud/env` — `machine.json` already
carries the ingest URL and this machine's key. The systemd unit reads that env
file unconditionally, so the file still has to exist; empty is fine.

Readings go to the ingest URL printed in the link — an AWS Lambda Function
URL, not `tokenhud.com` — which is the host to allow if egress from that
machine is filtered. Revoking the machine in the portal shuts that one door;
nothing else rotates.

Nothing leaves the machine until you run that enroll command, and when you do,
metrics leave — content never does. The rest of this page is the self-host
path: the same agent, the same protocol, your own server, no account anywhere.

---

## macOS

### Quickest — from source

Needs `cargo` ([rustup.rs](https://rustup.rs)); the build takes about thirty seconds.

```bash
git clone https://github.com/reddy-sh/tokenhud.git
cd tokenhud
./scripts/start-all.sh
```

`start-all.sh` does the rest in the right order: server, then agent, then the
portal dev server. It builds what it needs, generates an ingest key, writes it
to `.env` with mode 600, and the agent shows you the read manifest and asks
before anything is sent.

A self-host server is **API-only** — `GET /` is a JSON 404, no dashboard ships
in the binary — so you read the board through `/api/v1/*` on `127.0.0.1:8787`:

```bash
./scripts/status.sh                                   # what is up, and what the server holds
curl -s 127.0.0.1:8787/api/v1/overview | python3 -m json.tool | head -40
curl -N 127.0.0.1:8787/api/v1/stream                  # pushed the instant a reading lands
```

The portal that `start-all.sh` also starts, on **http://localhost:5174**, is
the cloud portal running locally: it signs in to a TokenHUD account and
subscribes to that account's machines. It has no server-URL or key field, so it
never reads `127.0.0.1:8787` and cannot be pointed at it.

You never create the key by hand when using the start scripts. On a loopback install it
is ceremony rather than security — both processes are yours, on your machine,
started by the same script. It still exists because it stops mattering only
while you stay on loopback; see [sharing a board](#linux--sharing-one-board-across-machines).

### The ingest key

The key authenticates the agent → server direction (writes). **API reads are
open by default** — no key is needed to read the board's data. The machines
list is the exception: pairing codes and the fleet inventory travel only to a
caller that presents the key, whatever the read setting is.

| How you started | Where the key lives |
|---|---|
| `./scripts/start-server.sh` | Auto-generated, written to `.env` in the repo root (mode 600) |
| `scripts/install.sh` (curl install) | Not written — installs binaries only; generate with `tokenhud-server --new-key`, or use `./install.sh` which writes `~/.tokenhud/env` |
| Manual / standalone binaries | Generate with `tokenhud-server --new-key` |

**Manual setup** (when not using the start scripts):

```bash
tokenhud-server --new-key        # prints a key to stdout
export TOKENHUD_KEY=<that key>
tokenhud-server &                # starts on http://127.0.0.1:8787
tokenhud-agent                   # starts sending readings
```

To require the key for **reading** the API too:

```bash
export TOKENHUD_PROTECT_READS=1
```

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

The two REPLACE-ME values are the path to the binary and `TOKENHUD_KEY`. A
cloud-enrolled machine has one: set the path, and delete the `TOKENHUD_SERVER`
and `TOKENHUD_KEY` entries — `~/.tokenhud/machine.json` supplies both, and an
env value would override half an enrollment.

A **LaunchAgent, not a LaunchDaemon**, on purpose: it runs as you, in your login
session, and can read your home directory. A daemon runs as root before you log
in — more privilege than this needs, and the wrong user to read `~/.claude` as.

The **server** has its own LaunchAgent — without it, the API dies at logout
while the agents keep spooling at it:

```bash
cp server/dist/com.tokenhud.server.plist ~/Library/LaunchAgents/
$EDITOR ~/Library/LaunchAgents/com.tokenhud.server.plist  # the REPLACE-ME values
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenhud.server.plist
```

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
./scripts/start-all.sh
```

Then read it the same way — `./scripts/status.sh`, or `/api/v1/*` on
`127.0.0.1:8787`. The server ships no HTML, and the portal on
`localhost:5174` reads a cloud account rather than this server.

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

That `printf` writes the shared-key configuration. A cloud-enrolled machine
needs neither variable — `~/.tokenhud/machine.json` carries the ingest URL and
its own key — but the unit's `EnvironmentFile=` is not optional, so create
`~/.config/tokenhud/env` anyway: empty, or holding only `TOKENHUD_INTERVAL=30`.

On the machine that runs the board, install the **server unit** too, and let
it outlive your logins:

```bash
cp server/dist/tokenhud-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokenhud-server
sudo loginctl enable-linger $USER
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

The [cloud portal](#cloud-portal--the-two-command-path) is the hosted version
of exactly this flow — Add machine, one-shot link, per-machine key — with the
approval step absorbed by sign-in: the owner minted the link seconds earlier,
so nothing is left to decide. A self-host server speaks the same enrollment
protocol with no UI in front of it. Minting and approving are two API calls,
made with the board key.

**On the machine running the board:**

```bash
# bind beyond loopback — deliberately
TOKENHUD_BIND=0.0.0.0 ./scripts/stop-server.sh
TOKENHUD_BIND=0.0.0.0 ./scripts/start-server.sh
KEY="$(grep '^TOKENHUD_KEY=' .env | cut -d= -f2)"   # the board key
```

**For every other machine — enroll it (recommended).** Mint a link. This is
the one write that creates a credential, so it always needs the key, whatever
`TOKENHUD_PROTECT_READS` says:

```bash
curl -s -X POST http://board.local:8787/api/v1/enroll/new -H "X-TokenHUD-Key: $KEY"
# {"token":"…","code":"…","expiresAt":"…","ttlSeconds":900}
```

Give the new machine the server URL and that token, joined by a `#`:

```bash
tokenhud-agent enroll "http://board.local:8787#<token>"
```

It shows the read manifest, asks, claims the link, prints its pairing code and
waits. The claim is now **pending** on the board — read it *with* the key: the
machines list carries pairing codes and the fleet inventory, so it is not part
of the open-reads default.

```bash
curl -s http://board.local:8787/api/v1/overview -H "X-TokenHUD-Key: $KEY" |
  python3 -c 'import json,sys
for m in json.load(sys.stdin).get("machines", []):
    print(m["status"], m.get("code"), m["installId"], m["hostname"])'
```

Each pending row carries the pairing code, the AI assistants that machine runs
and its consent-manifest digest. Check the code against the one the terminal
printed, then decide that `installId` — `approve`, `deny` or `revoke`:

```bash
curl -s -X POST http://board.local:8787/api/v1/machines/decide \
  -H "X-TokenHUD-Key: $KEY" -H 'content-type: application/json' \
  -d '{"installId":"<from above>","action":"approve"}'
```

The waiting agent's next poll collects **its own key**, writes it to
`~/.tokenhud/machine.json` (mode 600) and starts reporting in that same
process — no environment variables, then or later. Revoking shuts *that* door
without touching any other machine. Links are one-shot and expire in 15
minutes; a revoked machine needs a fresh one to rejoin.

Two machines with the same hostname stay two rows — enrollment tells them
apart by a random per-install id, not by name.

**Or the shared-key way (still works):**

```bash
export TOKENHUD_SERVER=http://board.local:8787   # or the IP
export TOKENHUD_KEY=<the key from the board>
./agent/target/release/tokenhud-agent --what-i-read    # look first
./agent/target/release/tokenhud-agent --accept
./scripts/start-agent.sh                         # builds the agent if needed
```

With the shared key, the board shows each machine as its own host — but if two
of them share a hostname, set `TOKENHUD_HOST` on one, or enroll them instead.

> **Read this before binding to anything but loopback.** The key is a bearer
> secret in a plain HTTP header. On a LAN that is adequate against accident and
> **useless against anyone listening.** Anyone who can reach the port and has
> the key can write readings to your board; anyone who can reach the port can
> *read* it, because reads are unauthenticated by default — so that a `curl`, a
> script or `./scripts/status.sh` needs no credential to ask how things are.
>
> Two things to do if this leaves your own machine:
> - put TLS in front of it — a reverse proxy is the easy answer
> - set `TOKENHUD_PROTECT_READS=1` so `GET` needs the key too
>
> Treat `TOKENHUD_KEY` as a real credential: it is mode 600 in `.env` for a
> reason, and pasting it into a shell puts it in your history.

Per-device keys and revocation are what `tokenhud-agent enroll` gives you.
TLS by default is still yours to add — a reverse proxy is the easy answer.

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
./scripts/stop-all.sh

launchctl bootout gui/$(id -u)/com.tokenhud.agent     # macOS, if installed
systemctl --user disable --now tokenhud-agent          # Linux, if installed

rm -rf ~/.tokenhud     # the index, the spool, the salt, your consent record
```

`~/.tokenhud` is the only directory it ever writes. Nothing it read was
modified, and nothing else on your machine was touched.

---

## Troubleshooting

**`No key — the server will refuse this agent`** — the agent found neither an
enrollment nor a key. Enroll the machine, or run `./scripts/start-server.sh`,
which generates a key into `.env` for the agent on the same machine to read.

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

---

## Next

| | |
|---|---|
| [The dashboard](docs/dashboard.md) | Navigating the board once it is up |
| [The Leaderboard](docs/leaderboard.md) | Ranking a fleet, and what every metric means |
| [Sharing a board](docs/sharing.md) | Publishing a public link, and exactly what it carries |
| [Configuration](docs/configuration.md) | Every environment variable, with its default |
| [All documentation](docs/) | The index |


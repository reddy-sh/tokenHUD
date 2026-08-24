# Security

TokenHUD reads a developer's machine. That deserves a plain account of what it
touches, what it cannot touch, and how to tell us when we get it wrong.

## What TokenHUD reads

Everything below is read **read-only**. The agent opens no file for writing
outside its own state directory.

`agent/src/manifest.rs` is the authoritative list; this table is its prose
form, and `tokenhud-agent --what-i-read` prints it resolved against your own
machine. A test greps the collectors for every path literal and fails the build
if one is not declared there, so the two cannot drift.

| Path | What is read | Why |
|---|---|---|
| `~/.claude/stats-cache.json` | aggregate token counts by model and day | the all-time totals |
| `~/.claude/projects/**/*.jsonl` | assistant records only — model, token counts, timestamps, and each tool call's **name** | per-session metering, and which tools and MCP servers were actually used |
| `~/.claude.json` | **one key**, `cachedUsageUtilization` | your plan's real five-hour and weekly windows |
| `~/.claude/settings.json`, `settings.local.json` | permission rules, hooks, MCP servers, plugins, and the settings that decide what runs without asking | the governance panels |
| `~/.claude/mcp-needs-auth-cache.json` | server names | which MCP servers are mounted but not signed in |
| `~/.claude/plugins/config.json`, `installed_plugins.json` | plugin names | installed beside enabled |
| `~/.claude/agents`, `~/.claude/skills` | a directory listing — **names only** | the extensions inventory |
| `~/.claude/daemon.status.json` | supervisor pid and liveness | the "supervisor up" pill |
| `~/.claude/history.jsonl` | prompt text — **only** when `TOKENHUD_SEND_PROMPTS=1` | off by default |
| `~/.codex/sessions/**/*.jsonl` | token counts, plan windows, the approval and sandbox policy each session ran under, and each call's **name** | the Codex board |
| `~/.codex/config.toml` | MCP servers, approval policy, sandbox mode, plugins, features | Codex governance |
| `~/.codex/session_index.jsonl`, `~/.codex/skills` | a count, and a directory listing | detection, and the extensions inventory |
| `ps -Ao pid,etime,command` | processes matching a Claude binary path | the running-agents list |

## What it never reads

- **Prompt and completion text.** Transcript parsing skips every record that is
  not an assistant turn carrying a `usage` block, and reads only the numeric
  fields from it. Message content is never deserialised into the payload.
- **Source code or file contents.** No collector opens a file in your project.
- **`oauthAccount`** in `~/.claude.json` — your name, email, organisation,
  billing tier. The parser reads one sibling key and stops.
- **`utilization.spend`** — real billed dollars on accounts with extra usage
  enabled. Deliberately excluded; see `agent/src/limits.rs`.
- **`projects`** in `~/.claude.json` — a per-project cost and token history.
  Deliberately excluded.
- **A tool call's input.** The governance panel counts calls by tool name. The
  command a Bash call ran, the file a Read call opened, the prompt a Task
  carried — none of it is read into the index those counts come from. The two
  exceptions are `subagent_type` and `skill`, which name a configured
  capability rather than describe a piece of work.
- **MCP credentials.** An MCP server's `env` and `headers` blocks are read for
  their variable **names** — "this server is handed `GITHUB_TOKEN`" is the
  governance fact worth showing — and never for a value. A URL-based server is
  reported by host, so a token in a query string does not travel either.

The test suite enforces five of these mechanically. One asserts the limits
payload carries no `emailAddress`, `@`, `organizationName`, `oauthAccount` or
`used_dollars`. Another asserts prompt text and session titles stay empty
unless the opt-in is set. A third collects every credential value configured on
*your* machine and asserts none of them appears in the governance payload, and
that what the payload lists for a server is that block's keys rather than its
values. A fourth asserts a tool call's input never reaches the transcript
index. The last asserts that no `innerHTML` assignment in
the dashboard is built from a value — what it renders (model names, project
paths) arrives from a transcript and crosses ingest untouched, and one such
interpolation was a live cross-site-scripting hole until it was found.

## What it never writes

`~/.claude.json` is Claude Code's live configuration. TokenHUD opens it
read-only and never writes to it — a clobbering write would take your MCP server
configuration with it and there is no backup we own. `agent/src/limits.rs` documents
this; a self-test asserts the file's mtime is unchanged after a read.

The agent writes only to `~/.tokenhud/` (a transcript index, a spool, and a
salt) and to the server's SQLite file.

## Threat model

**In scope.** Anything that causes TokenHUD to read a file it has no business
reading, to write where it should not, to include withheld content in a
payload, or to expose the local server beyond the machine it runs on.

**Design posture.** The server binds `127.0.0.1` by default and nothing off your
machine can reach it until you change `TOKENHUD_BIND` deliberately. Ingest
requires a key, compared with `hmac.compare_digest` so a wrong key cannot be
discovered one byte at a time. Reads are open by default so the dashboard needs
no secret in the browser — set `TOKENHUD_PROTECT_READS=1` to change that.

**If you expose the server**, the ingest key is a bearer secret in a plain
header. Put TLS in front of it and treat `TOKENHUD_KEY` as a real credential.
This is stated in the README too, because it is the single easiest way to
misconfigure this.

**Out of scope.** An attacker who already has your user account. TokenHUD reads
what that user can read; it does not defend against that user being compromised.

## Reporting a vulnerability

Open a **private security advisory** through GitHub:
`Security → Report a vulnerability` on this repository. That channel is private
until we publish.

Please do not open a public issue for a security problem.

Include what you did, what happened, and what you expected. A proof of concept
helps enormously. We will acknowledge within **3 working days** and aim to have
a fix or a clear plan within **30 days**.

There is no bug bounty. We will credit you in the advisory and the changelog
unless you would rather we did not.

## Supported versions

Pre-1.0. Only the latest commit on `main` is supported. Once there are tagged
releases this section will name them.

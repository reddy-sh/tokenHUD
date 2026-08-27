# HTTP API

The self-host server answers everything below. Four of the routes are the
**wire protocol** rather than one server's implementation: the server in this
repository and the cloud ingest Lambda answer them identically - same header,
same status codes, same JSON keys - so an agent cannot tell which one it is
talking to.

Base URL in every example is `http://127.0.0.1:8787`, the default bind.

## Authentication

One credential, one header:

```text
X-TokenHUD-Key: <TOKENHUD_KEY>
```

Compared with a constant-time check, so a wrong key cannot be found one byte at
a time.

Two routes take a credential that is not the key: the enrollment poll carries a
one-shot token and the secret the claiming machine invented, and the public
board carries a share slug in its query string. Two more trade the key for a
short-lived single-use token, because neither `EventSource` nor `curl | sh` can
set a header.

## Ingest and enrollment

These are what the agent speaks. The four marked **wire** are the protocol
itself: the cloud ingest Lambda answers them identically, so an agent cannot
tell which server it reached.

| Route | Auth | | What it does |
|---|---|:-:|---|
| `POST /api/v1/ingest` | key | wire | One snapshot. Accepts gzip. Answers `202` |
| `POST /api/v1/enroll` | open | wire | A machine claims a one-shot link; the token in the body is the credential |
| `GET /api/v1/enroll/await?token=…&secret=…` | open | wire | The claiming machine's poll. Delivers its own key exactly once |
| `GET /healthz` | open | wire | Liveness. `text/plain` |
| `GET /api/v1/version` | open | | The server's own version, as `{"version": "…"}`. Self-host only |

A wrong token learns nothing but "unknown link".

## Fleet administration

Every route here requires the key.

| Route | What it does |
|---|---|
| `POST /api/v1/enroll/new` | Mint a one-shot enrollment link. Returns `{token, code, expiresAt, ttlSeconds}` |
| `POST /api/v1/machines/decide` | `{installId, action}` where action is `approve`, `deny` or `revoke` |
| `POST /api/v1/machines/rename` | `{machineId, label}` - the name the board files a machine under |
| `POST /api/v1/machines/remove` | `{host}` - forget a machine and its readings |
| `POST /api/v1/stream-token` | Trade the key for a single-use 60-second stream token |
| `POST /api/v1/install-token` | Trade the key for a single-use 5-minute install token |
| `GET /api/v1/install-script?server=…&t=…` | A shell script that installs and enrolls an agent |
| `GET /api/v1/upgrade-script?server=…&t=…` | A shell script that upgrades an installed agent in place |
| `GET /api/v1/portal-key` | The admin key. **Loopback binds only** - refuses if `TOKENHUD_BIND` is anything else |

The two script routes accept either the key in a header or a single-use install
token as `?t=`, because a command somebody copies out of the board must not
carry the fleet's admin credential in it.

## Reads

Open by default so tooling needs no secret in a browser. Set
`TOKENHUD_PROTECT_READS=1` to require the key on `GET` too.

| Route | What it answers |
|---|---|
| `GET /api/v1/overview` | Latest reading per host, agent liveness, recent endings, store counts. The `machines` list travels only to a caller holding the key |
| `GET /api/v1/history?host=…&limit=…` | One host's recent snapshots, reconstructed from the difference chain. `limit` clamped 1-1000 |
| `GET /api/v1/endings?host=…&hours=…&limit=…` | Agents that stopped recently. `limit` clamped 1-500 (default 100), `hours` 1-720 (default 24) |
| `GET /api/v1/stream` | Server-sent events: one `reading` event per ingest, carrying the whole overview |

`/api/v1/stream` takes `?st=<token>` from `/api/v1/stream-token`, because
`EventSource` cannot set a header and the board key in a URL would sit in every
access log. A redeemed token also marks that reader as one that may see the
`machines` list.

## Sharing

Three routes need the key. The fourth needs nothing, which is the point of it.

| Route | What it does |
|---|---|
| `GET /api/v1/share` | Every share this fleet has minted, plus `apiUrl` and `reachable`. Key required |
| `POST /api/v1/share` | `{title, identities}` mints one; adding `slug` edits that one. Key required |
| `POST /api/v1/share/revoke` | `{slug}`. Key required |
| `GET /api/v1/public/board?s=<slug>` | The shared leaderboard. **No key** - the slug is the credential |

`identities` is `alias` or `host`. A title is trimmed and capped at 80
characters, because it is printed on a public page.

The public route answers regardless of `TOKENHUD_PROTECT_READS`, and a revoked
slug is indistinguishable from an invented one. See
[Sharing a board](sharing.md).

### The public payload

```jsonc
{
  "share":   { "slug": "…", "title": "…", "identities": "alias", "views": 12 },
  "generatedAt": "…",
  "windowDays": 90,
  "pricingAsOf": "2026-06-24",
  "hours": { "0": 4, "…": 0 },        // null below hoursMinMachines
  "hoursMinMachines": 3,
  "totals":  { "machines": 4, "tokens": 0, "estUSD": 0 },
  "entries": [{
    "id": "…", "name": "amber-otter", "os": "Darwin", "cores": 14,
    "status": "up", "lastActive": "…", "firstSeen": "2026-06-02",
    "tools":   [{ "id": "claude-code", "name": "Claude Code" }],
    "totals":  { "tokens": 0, "input": 0, "output": 0, "cacheRead": 0,
                 "cacheWrite": 0, "estUSD": 0, "sessions": 0, "requests": 0,
                 "toolCalls": 0, "messages": 0, "activeDays": 0 },
    "byTool":  [{ "id": "…", "tokens": 0, "output": 0, "estUSD": 0 }],
    "models":  [{ "model": "…", "tool": "…", "tokens": 0, "input": 0,
                  "output": 0, "cacheRead": 0, "cacheWrite": 0,
                  "estUSD": 0, "priced": true }],
    "byDay":   [{ "date": "2026-08-25", "tokens": 0, "estUSD": 0,
                  "sessions": 0, "toolCalls": 0, "messages": 0,
                  "byModel": { "claude-opus-5": 0 } }],
    "running": [{ "tool": "claude-code", "kind": "IDE session",
                  "headless": false, "model": null, "elapsedSeconds": 0 }],
    "block":   { "requests": 0, "outputTokens": 0, "open": true,
                 "minutesLeft": 0, "minutesUsed": 0 }
  }]
}
```

That is the whole schema. Anything not listed here is not served, whatever the
agent collects.

## Response conventions

**Everything unrouted is a JSON 404, `GET /` included.** Every caller of this
API is a program, and a program should not have to parse a document to learn it
got the path wrong.

**Errors are `{"error": "…"}`** with a real status code.

**Responses are gzipped when the client asks** and the body is worth
compressing. The server speaks HTTP/1.1, so anything reading on a loop reuses
one connection.

**Headers on every response:** `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control:
no-store`.

**CORS** is allowed - a board is a different origin from the API it reads - but
only on the routes a browser legitimately calls: the reads, the stream and its
token, the key-gated fleet actions, and the public board. Ingest and the
enrollment routes are agent-facing and carry no CORS headers at all.

**Bodies are capped at 8 MB.** A snapshot is about 61 KB.

## Liveness thresholds

A host is **up** while its agent has checked in within 2 minutes, **stale** to
15 minutes, **down** after. The board computes the same verdict from the same
two thresholds rather than trusting a status field, so the two cannot drift
into disagreeing about what "up" means.

## Cloud differences

The cloud ingest Lambda answers the four **wire** routes and 404s everything
else. There is no `/api/v1/overview` there: reading is a Cognito sign-in and an
AppSync subscription. Sharing is self-host only.

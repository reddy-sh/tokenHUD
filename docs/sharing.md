# Sharing a board

A share turns the [Leaderboard](leaderboard.md) into a URL anyone can open. No
sign-in, no account, no key — the link is the whole credential.

## Publishing one

From the board: **Leaderboard → Share**, or **Settings → Public links → Manage
sharing**. Give it a title, choose how machines are named, and create the link.

From the API:

```bash
curl -sX POST http://127.0.0.1:8787/api/v1/share \
  -H "X-TokenHUD-Key: $TOKENHUD_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Engineering","identities":"alias"}'
# {"slug":"…","apiUrl":"http://127.0.0.1:8787","reachable":false}
```

The link the board builds looks like this — it carries both halves, because the
site is static and the server is wherever you run it:

```text
https://tokenhud.com/#/b/<slug>?api=https%3A%2F%2Fboard.example.com
```

The slug is 96 bits of the same OS randomness the ingest key uses. It is
unguessable rather than short, because there is no second check behind it.

## What the link carries

Decided in exactly one file, [`server/src/share.rs`](../server/src/share.rs),
and decided by **naming the fields that go out** rather than by taking a
reading and deleting the private parts.

That distinction is the whole design. A reading is about 61 KB across some
2,400 leaves, and the agent grows new ones every release. A blacklist would
publish each new field by default and be wrong exactly once, in public. A
whitelist is wrong in the safe direction: a field nobody listed does not
appear.

| Goes out | Never goes out |
|---|---|
| Token counts — input, output, cache reads and writes | Project names, paths, git branches, worktrees |
| Model names, and the tokens and estimated value against each | Prompt text and session titles |
| Sessions, requests, tool calls, messages, active days | Running processes' command lines, pids, working directories |
| One row per date: tokens, value, counts, and which models spent them | Which project, file or prompt those tokens went to |
| What is running now: product, kind, headless, uptime | Tool names, MCP servers, skills, plugins, permissions |
| Operating system and core count | Plan limits, usage percentages, the account hash |
| A pseudonym per machine | Hostnames — unless `identities` is `host` |

## Machine names

**Pseudonyms** (default) — each machine gets a name like `amber-otter`, hashed
from the slug **and** the host. The same laptop is `amber-otter` on one shared
board and `quiet-heron` on another, so two boards of one fleet cannot be lined
up against each other to work out who is who.

**Real names** — machines appear as you named them. Right for a team board
where everyone already knows whose laptop is whose.

Everything else stays shut at either setting.

## The hour curve is withheld below three machines

Aggregated over a team, "when does this fleet work" is a demand curve. Over one
machine it is a person's sleep schedule.

The server does not publish the hour-of-day curve on a board with fewer than
three machines, and it is a board-level sum in every case — never a per-machine
field, so a reader cannot pull one person's day back out of it. The threshold
is `HOURS_MIN_MACHINES`, and
`the_hours_curve_is_withheld_until_it_is_a_sum_of_people` in
[`server/tests/share.rs`](../server/tests/share.rs) holds it there.

## Checking before you send it

The Share dialog states the guarantee twice: once as two columns of prose, and
once as a **live preview fetched from the real public link with no key
attached**. A privacy control nobody can check is a promise. This one is
checkable, before the link is copied.

The board's own tests check it too, against the bytes an anonymous stranger
actually receives rather than against the whitelist function — a unit test on
the filter can pass while the route around it leaks.

## Revoking

**Make private**, from the dialog or from Settings. It is immediate and total:
the board behind a link is computed from live data on every request, so no
rendered copy exists anywhere to keep serving.

A revoked slug and an invented one answer identically. That is deliberate —
otherwise the endpoint would be a way to test slugs for existence.

Editing a share cannot resurrect a revoked one. A revoked share is finished;
make a new link.

## Making the link reachable

A server bound to `127.0.0.1` can mint a link that works for the person who
minted it and for nobody else. The dialog says so rather than letting you find
out from whoever you sent it to, and the API returns `"reachable": false`.

Set `TOKENHUD_PUBLIC_URL` to the address a stranger's browser can actually
reach — a proxy, a tunnel, a hostname — and put TLS in front of it. See
[Configuration](configuration.md).

```bash
TOKENHUD_PUBLIC_URL=https://board.example.com tokenhud-server
```

## The public route is open on purpose

`GET /api/v1/public/board?s=<slug>` answers with no key **even when
`TOKENHUD_PROTECT_READS=1`**. Closing the private API to anonymous readers is a
different decision from publishing a link deliberately, and a share that
silently stopped working would be a surprising way to find that out.

## What this is for, besides you

The aggregates behind a shared board — model share, adoption over time, cache
economics, the demand curve — are the part somebody who builds models would
find valuable. **Export aggregates** on the Models page writes exactly that, as
`tokenhud.fleet-demand/1` JSON, with no machine identities and no per-machine
rows.

Two boundaries, stated because they are design decisions and not oversights:

**Nothing is uploaded anywhere.** There is no telemetry path in this repository.
Aggregates leave when a person exports them or publishes a link — both
deliberate acts, both visible on the board.

**Consent belongs at collection.** If this ever becomes a data product, the
place to ask is when the agent is installed, not in a settings page nobody
opened. The manifest the agent shows before its first read is where that
conversation already happens.

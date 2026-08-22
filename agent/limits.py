"""
Rate-limit windows — the real ones, read from Claude Code's own cache.

Claude Code asks Anthropic what fraction of your plan you have used and when
each window rolls over, and writes the answer to `~/.claude.json` under
`cachedUsageUtilization`. It is the same body its own Account & Usage panel
renders. So the percentages here are not derived, not estimated, and not
inferred from local activity — they are the server's numbers, forwarded.

Note the path: `~/.claude.json`, a file, not something inside `~/.claude/`.

Three things shape this module, and all three are honesty problems rather
than engineering ones:

  · **It is a cache, so it has an age.** Nothing here can refresh it. It is
    written as a side effect of a Claude Code session hitting the usage
    endpoint, and the CLI discards it after an hour. So the age is reported
    with the reading, always, and it is measured from `fetchedAtMs` — never
    from the file's mtime, which moves when unrelated settings are written
    and would make a stale number look fresh.

  · **A reset instant does not go stale.** `resets_at` is an absolute time.
    When the percentage is too old to trust, the countdown beside it is still
    exactly right. The two degrade separately and the payload keeps them
    separable.

  · **The file holds far more than this.** Real name, email address,
    organisation name and role, billing tier, MCP configuration, and a
    `projects` map with per-project cost and token history. This reads
    exactly one key out of it. The omissions are deliberate, not oversights:

      - `utilization.spend` and `utilization.extra_usage` are actual billed
        dollars on accounts with extra usage enabled. The board's one estimate
        is labelled as an estimate everywhere it appears, and a real bill
        rendered next to it in the same style would destroy that distinction.
        If it is ever shown it needs its own panel and its own words.
      - `projects` carries a second, richer usage history — lastCost,
        lastModelUsage, per-project token totals. The board reads usage from
        the transcripts instead, which is current rather than last-session.
      - `oauthAccount` is never touched. The file is mode 0600 and that is
        the OS agreeing it is private.

    It never writes: that file is Claude Code's live configuration, we do not
    own it, and a clobbering write would take the user's MCP servers with it.

Keys are read BY NAME, never enumerated. `utilization` carries a dozen
unshipped internal buckets under rotating codenames; a panel built by
iterating that dict would one day grow a meter labelled "amber ladder".
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

# The CLI's own reader discards this cache once it is an hour old. Matching
# that number means the board calls stale exactly what Claude Code calls
# stale, rather than inventing a second opinion.
STALE_AFTER = 3600

LABELS = {
    "session": "Session (5h)",
    "weekly_all": "Weekly (7 day)",
}


def _salt() -> str:
    """A per-install salt for the account hash.

    Without it, a truncated hash of the account uuid is the same string on
    every machine that account touches — a stable cross-host identifier
    travelling in a payload that crosses a network. The point of the hash is
    to answer "is this still the same account as last reading" on ONE board,
    and a salt kept beside the agent's other state does that without
    producing a value that correlates anything anywhere else.
    """
    path = Path(os.environ.get("TOKENHUD_STATE", Path.home() / ".tokenhud")).expanduser() / "salt"
    try:
        return path.read_text().strip()
    except Exception:
        pass
    value = secrets.token_hex(16)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        os.chmod(path, 0o600)
    except Exception:
        pass
    return value


def _candidates() -> list[Path]:
    out = []
    env = os.environ.get("TOKENHUD_CLAUDE_JSON")
    if env:
        out.append(Path(env).expanduser())
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        out.append(Path(cfg).expanduser() / ".claude.json")
    out.append(Path.home() / ".claude.json")
    return out


def _load() -> dict | None:
    """Read the config, tolerating the moment it is being rewritten.

    Claude Code rewrites this file while running. A read landing mid-write
    gets a JSONDecodeError, which is a transient fact about timing and not a
    fact about the machine — so it is retried once before being reported.
    """
    for path in _candidates():
        if not path.is_file():
            continue
        for attempt in (0, 1):
            try:
                with path.open("rb") as fh:
                    return {"path": str(path), "data": json.loads(fh.read())}
            except json.JSONDecodeError:
                if attempt == 0:
                    time.sleep(0.1)
                    continue
                return {"path": str(path), "error": "unreadable"}
            except Exception:
                return {"path": str(path), "error": "unreadable"}
    return None


def _label(row: dict) -> str:
    kind = row.get("kind")
    if kind in LABELS:
        return LABELS[kind]
    if kind == "weekly_scoped":
        # Only the display name the server itself supplied. The neighbouring
        # keys in this file are internal bucket codenames that rotate, and
        # nothing on disk maps them to a model — inventing that mapping would
        # put a made-up model name on the board.
        name = ((row.get("scope") or {}).get("model") or {}).get("display_name")
        return f"Weekly · {name}" if name else "Weekly · scoped"
    return str(kind or "window").replace("_", " ").title()


def _rows(util: dict) -> list:
    rows = []
    for row in (util.get("limits") or []):
        if not isinstance(row, dict):
            continue
        pct = row.get("percent")
        rows.append({
            "kind": row.get("kind"),
            "group": row.get("group"),
            "label": _label(row),
            "percent": int(pct) if isinstance(pct, (int, float)) else None,
            "severity": row.get("severity") or "normal",
            "resetsAt": row.get("resets_at"),
            "active": bool(row.get("is_active")),
        })
    if rows:
        return rows

    # Older CLIs wrote only these two. Same numbers, less structure.
    for key, kind in (("five_hour", "session"), ("seven_day", "weekly_all")):
        w = util.get(key)
        if not isinstance(w, dict):
            continue
        pct = w.get("utilization")
        rows.append({
            "kind": kind, "group": kind.split("_")[0],
            "label": LABELS.get(kind, kind),
            "percent": int(pct) if isinstance(pct, (int, float)) else None,
            "severity": "normal",
            "resetsAt": w.get("resets_at"),
            "active": kind == "session",
        })
    return rows


def collect_limits() -> dict:
    """The plan's usage windows as Anthropic last reported them."""
    found = _load()
    if not found:
        return {"available": False, "reason": "absent", "staleAfterSeconds": STALE_AFTER}
    if found.get("error"):
        return {"available": False, "reason": found["error"], "staleAfterSeconds": STALE_AFTER}

    cache = (found["data"] or {}).get("cachedUsageUtilization")
    if not isinstance(cache, dict):
        return {"available": False, "reason": "absent", "staleAfterSeconds": STALE_AFTER}

    util = cache.get("utilization")
    if not isinstance(util, dict):
        return {"available": False, "reason": "absent", "staleAfterSeconds": STALE_AFTER}

    fetched_ms = cache.get("fetchedAtMs")
    fetched_at, age = None, None
    if isinstance(fetched_ms, (int, float)):
        fetched_at = datetime.fromtimestamp(fetched_ms / 1000, tz=timezone.utc).isoformat()
        age = int(time.time() - fetched_ms / 1000)

    acct = cache.get("accountUuid")
    return {
        "available": True,
        # Named so the board can say where a number came from without the
        # reader having to take it on trust.
        "source": "~/.claude.json:cachedUsageUtilization",
        "fetchedAt": fetched_at,
        "ageSeconds": age,
        "staleAfterSeconds": STALE_AFTER,
        # Answers "is this the same account as last reading" on this board,
        # and nothing else anywhere else. Salted per install so it is not a
        # cross-host identifier for the account it stands in for.
        "accountHash": (hashlib.sha256((_salt() + str(acct)).encode()).hexdigest()[:12]
                        if acct else None),
        "windows": _rows(util),
        # Deliberately not computed here: a snapshot can sit in the store for
        # minutes before a browser reads it, and a countdown baked in at
        # collection time would be wrong by exactly that long. The browser
        # holds the clock; this ships the instant.
    }


if __name__ == "__main__":
    print(json.dumps(collect_limits(), indent=2))

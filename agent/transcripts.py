"""
Transcript index — per-session usage, read once and never re-read.

Claude Code appends one JSONL per session under ~/.claude/projects. On a
working machine that corpus reaches a gigabyte, and a single transcript can
pass 200 MB. Re-reading it every thirty seconds is not an option, so this
keeps a byte offset per file and only ever reads what was appended since the
last pass. Steady state is a few kilobytes per cycle.

Three decisions worth keeping:

  · **A byte budget per cycle.** The first pass has a gigabyte to get through.
    Rather than block the agent for a minute, each cycle reads at most
    TOKENHUD_SCAN_BUDGET_MB and stops mid-file; the next cycle resumes at the
    offset. The board says "indexing 40%" until it catches up, which is a
    true statement about the board rather than a lie about the machine.

  · **Tokens are stored, dollars are not.** The index holds token counts by
    model; cost is computed at report time from pricing.py. A rate card that
    changes must not require re-reading a gigabyte, and a stored dollar figure
    would quietly mix two rate cards in one total.

  · **Buckets are decided while reading.** Whether a request ran over a 150k
    context, and whether it came from a subagent, is known per request and
    lost afterwards. Those go into their own token buckets as the line is
    read, so attribution never has to estimate what it could have counted.

Nothing here sends anything. It reads local files and writes one local index.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

VERSION = 4
BIG_CONTEXT = 150_000        # the line the CLI's own usage panel draws
LONG_SESSION_HOURS = 8
KEEP_DAYS = 120
KEEP_SESSIONS = 3000
# Subscription usage is metered in rolling five-hour blocks. Reconstructing
# where you are inside the current one needs request times at minute
# resolution — an hour bucket cannot answer "how long until it rolls over".
# Nine days of minutes is ~13k integers: small enough to keep, long enough
# to cover the seven-day window with room either side.
KEEP_MINUTE_DAYS = 9
BLOCK_HOURS = 5


def _state_dir() -> Path:
    return Path(os.environ.get("TOKENHUD_STATE", Path.home() / ".tokenhud"))


def _index_path() -> Path:
    return _state_dir() / "transcripts.json"


def _budget() -> int:
    try:
        return max(1, int(os.environ.get("TOKENHUD_SCAN_BUDGET_MB", "512"))) * 1024 * 1024
    except ValueError:
        return 512 * 1024 * 1024


def _projects_root() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects"


# ── index io ────────────────────────────────────────────────────────────

def _empty() -> dict:
    return {"version": VERSION, "files": {}, "sessions": {}, "days": {},
            "minutes": {}, "outMinutes": {}}


def load() -> dict:
    try:
        idx = json.loads(_index_path().read_text())
        # A schema change re-reads the corpus once. Cheaper than migrating,
        # and the alternative is a total that silently mixes two shapes.
        if isinstance(idx, dict) and idx.get("version") == VERSION:
            idx.setdefault("files", {})
            idx.setdefault("sessions", {})
            idx.setdefault("days", {})
            idx.setdefault("minutes", {})
            idx.setdefault("outMinutes", {})
            return idx
    except Exception:
        pass
    return _empty()


def save(idx: dict) -> None:
    try:
        p = _index_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(idx, separators=(",", ":")))
        tmp.replace(p)          # atomic: a killed agent leaves the old index
    except Exception:
        pass


# ── accumulation ────────────────────────────────────────────────────────

def _bump(bucket: dict, model: str, tok: tuple) -> None:
    m = bucket.get(model)
    if m is None:
        m = bucket[model] = {"in": 0, "out": 0, "cr": 0, "cw5": 0, "cw1": 0}
    m["in"] += tok[0]
    m["out"] += tok[1]
    m["cr"] += tok[2]
    m["cw5"] += tok[3]
    m["cw1"] += tok[4]


def _new_session(sid: str) -> dict:
    return {
        "id": sid, "project": None, "branch": None, "title": None, "entry": None,
        "first": None, "last": None, "req": 0, "tools": 0, "maxCtx": 0,
        "models": {},   # everything
        "sub": {},      # subagent (isSidechain) requests only
        "ctx": {},      # requests whose context exceeded BIG_CONTEXT
    }


_MIN_CACHE: dict[str, int] = {}


def _epoch_minute(ts: str) -> int | None:
    """Whole minutes since the epoch, UTC. Minutes rather than seconds
    because a block boundary is never worth more precision than that, and a
    minute key costs a fifth of the index a second key would."""
    if not ts or len(ts) < 16:
        return None
    key = ts[:16]
    hit = _MIN_CACHE.get(key)
    if hit is not None:
        return hit
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        m = int(dt.timestamp() // 60)
    except Exception:
        return None
    if len(_MIN_CACHE) > 20000:
        _MIN_CACHE.clear()
    _MIN_CACHE[key] = m
    return m


_DAY_CACHE: dict[str, str] = {}


def _local_day(ts: str) -> str | None:
    """Local calendar day for an ISO timestamp.

    Local, not UTC: the rest of the board bins by local day, and a chart where
    one panel rolls over at midnight and another at 5pm is a bug report.
    Cached on the minute prefix — consecutive lines almost always share one.
    """
    if not ts or len(ts) < 16:
        return None
    key = ts[:16]
    hit = _DAY_CACHE.get(key)
    if hit is not None:
        return hit
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        day = dt.astimezone().date().isoformat()
    except Exception:
        return None
    if len(_DAY_CACHE) > 20000:
        _DAY_CACHE.clear()
    _DAY_CACHE[key] = day
    return day


def _absorb(idx: dict, rec: dict) -> None:
    """One transcript record into the index. Assistant turns carry the usage."""
    kind = rec.get("type")
    sid = rec.get("sessionId")
    if not sid:
        return

    if kind == "ai-title":
        s = idx["sessions"].get(sid)
        if s is not None and rec.get("aiTitle"):
            s["title"] = str(rec["aiTitle"])[:120]
        return

    if kind != "assistant":
        return

    msg = rec.get("message") or {}
    u = msg.get("usage") or {}
    if not u:
        return

    sessions = idx["sessions"]
    s = sessions.get(sid)
    if s is None:
        s = sessions[sid] = _new_session(sid)

    if rec.get("cwd") and not s["project"]:
        s["project"] = rec["cwd"]
    if rec.get("gitBranch") and not s["branch"]:
        s["branch"] = rec["gitBranch"]
    if rec.get("slug") and not s["title"]:
        s["title"] = str(rec["slug"])[:120]
    if rec.get("entrypoint") and not s["entry"]:
        s["entry"] = rec["entrypoint"]

    ts = rec.get("timestamp")
    if ts:
        if not s["first"] or ts < s["first"]:
            s["first"] = ts
        if not s["last"] or ts > s["last"]:
            s["last"] = ts

    model = str(msg.get("model") or "unknown")
    # `<synthetic>` is the CLI's marker for a message it wrote itself — a
    # cancellation notice, a replayed error. No request was made and no
    # tokens were billed, so counting it would put a model on the board
    # that nobody ran.
    if model.startswith("<"):
        return
    cc = u.get("cache_creation") or {}
    cw1 = int(cc.get("ephemeral_1h_input_tokens") or 0)
    cw5 = int(cc.get("ephemeral_5m_input_tokens") or 0)
    if not cw1 and not cw5:
        # Older transcripts report one total. Assume the cheaper TTL rather
        # than the dearer one — an estimate should not flatter itself.
        cw5 = int(u.get("cache_creation_input_tokens") or 0)

    tin = int(u.get("input_tokens") or 0)
    tout = int(u.get("output_tokens") or 0)
    tcr = int(u.get("cache_read_input_tokens") or 0)
    tok = (tin, tout, tcr, cw5, cw1)

    s["req"] += 1
    _bump(s["models"], model, tok)

    if rec.get("isSidechain"):
        _bump(s["sub"], model, tok)

    context = tin + tcr + cw5 + cw1
    if context > s["maxCtx"]:
        s["maxCtx"] = context
    if context > BIG_CONTEXT:
        _bump(s["ctx"], model, tok)

    content = msg.get("content")
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                s["tools"] += 1

    day = _local_day(ts)
    if day:
        _bump(idx["days"].setdefault(day, {}), model, tok)

    minute = _epoch_minute(ts)
    if minute is not None:
        k = str(minute)
        idx["minutes"][k] = idx["minutes"].get(k, 0) + 1
        if tout:
            idx["outMinutes"][k] = idx["outMinutes"].get(k, 0) + tout


# ── the scan ────────────────────────────────────────────────────────────

def _files(root: Path) -> list:
    out = []
    if not root.is_dir():
        return out
    for p in root.rglob("*.jsonl"):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((str(p), st.st_size, st.st_mtime))
    # Newest first: a fresh session should reach the board on the first cycle,
    # not after the backlog of a year of transcripts has been chewed through.
    out.sort(key=lambda r: r[2], reverse=True)
    return out


def scan(budget: int | None = None) -> dict:
    """Read what is new (up to `budget` bytes), update the index, return it."""
    idx = load()
    budget = _budget() if budget is None else budget
    started = time.time()

    files = _files(_projects_root())
    known = idx["files"]
    total = read = 0
    done_bytes = 0
    touched = False

    for path, size, _mtime in files:
        prev = known.get(path)
        off = 0
        if prev:
            # A file that shrank was rotated or rewritten; the offsets no
            # longer mean anything, so read it again from the top.
            off = prev.get("off", 0) if prev.get("off", 0) <= size else 0
        total += size

        if off >= size or budget - read <= 0:
            done_bytes += min(off, size)
            continue

        take = min(size - off, budget - read)
        try:
            with open(path, "rb") as fh:
                fh.seek(off)
                chunk = fh.read(take)
        except OSError:
            done_bytes += off
            continue

        end = chunk.rfind(b"\n")
        if end < 0:
            # No complete line in the window — a single record longer than the
            # budget. Leave the offset; the next cycle has the whole budget.
            done_bytes += off
            continue

        for raw in chunk[:end].split(b"\n"):
            if not raw:
                continue
            # Substring first: json.loads on every user turn would parse
            # megabytes of tool output to learn nothing.
            if b'"assistant"' not in raw and b'"ai-title"' not in raw:
                continue
            try:
                rec = json.loads(raw)
            except Exception:
                continue
            if isinstance(rec, dict):
                _absorb(idx, rec)

        off += end + 1
        read += take
        known[path] = {"off": off, "size": size}
        done_bytes += off
        touched = True

    for path in [p for p in known if not os.path.exists(p)]:
        # Forget the file, keep its totals: a deleted transcript is still
        # usage that happened.
        known.pop(path, None)
        touched = True

    _trim(idx)
    if touched:
        save(idx)

    idx["scan"] = {
        "bytesTotal": total,
        "bytesDone": min(done_bytes, total),
        "complete": done_bytes >= total,
        "files": len(files),
        "readThisCycle": read,
        "seconds": round(time.time() - started, 2),
    }
    return idx


def _trim(idx: dict) -> None:
    cutoff = int(time.time() // 60) - KEEP_MINUTE_DAYS * 24 * 60
    for key in ("minutes", "outMinutes"):
        bucket = idx.get(key) or {}
        if bucket:
            for m in [m for m in bucket if int(m) < cutoff]:
                bucket.pop(m, None)

    days = idx["days"]
    if len(days) > KEEP_DAYS:
        for d in sorted(days)[:-KEEP_DAYS]:
            days.pop(d, None)
    sessions = idx["sessions"]
    if len(sessions) > KEEP_SESSIONS:
        order = sorted(sessions.values(), key=lambda s: s.get("last") or "")
        for s in order[: len(sessions) - KEEP_SESSIONS]:
            sessions.pop(s["id"], None)


if __name__ == "__main__":
    i = scan()
    print(json.dumps({"scan": i["scan"], "sessions": len(i["sessions"]),
                      "days": len(i["days"]), "minutes": len(i["minutes"])}, indent=2))

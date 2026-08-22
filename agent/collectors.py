"""
Collectors — everything the agent knows how to look at on one machine.

Each collector returns plain JSON-able data and never raises: a host with a
broken or missing source should report the rest of itself, not disappear from
the board. That is the difference between "the disk collector is down" and
"the host is down", and a monitoring tool that cannot tell them apart is worse
than none.

Adding a source means adding a function here and one line in `collect()`.
Nothing else in the agent or the server needs to know about it.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import limits        # noqa: E402  the plan's real usage windows
import pricing       # noqa: E402  the rate card, and why there is one
import transcripts   # noqa: E402  the incremental per-session index

AGENT_VERSION = "0.1.0"


# ── helpers ─────────────────────────────────────────────────────────────

def _json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def _jsonl(path: Path, limit: int | None = None) -> list:
    rows = []
    try:
        with path.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        return []
    return rows[-limit:] if limit else rows


def _iso_ms(ms) -> str | None:
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()
    except Exception:
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def host_id() -> str:
    """Stable name for this machine. Overridable so two laptops with the same
    hostname (a fresh Mac restored from backup) do not merge on the board."""
    return os.environ.get("TOKENHUD_HOST") or socket.gethostname()


# ── host facts ──────────────────────────────────────────────────────────

def collect_host() -> dict:
    load = None
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except Exception:
        pass
    return {
        "hostname": socket.gethostname(),
        "platform": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpus": os.cpu_count(),
        "loadavg": load,
    }


# ── live processes ──────────────────────────────────────────────────────
#
# The "what is my machine doing right now" panel. Matched on the binary path
# rather than the word "claude", which appears in half the paths on a machine
# that has ever cloned an Anthropic repo.

_PS = re.compile(r"^\s*(\d+)\s+(\S+)\s+(.*)$")


def collect_processes() -> list:
    out = []
    try:
        lines = subprocess.run(
            ["ps", "-Ao", "pid,etime,command"],
            capture_output=True, text=True, timeout=5,
        ).stdout.splitlines()[1:]
    except Exception:
        return out

    for line in lines:
        m = _PS.match(line)
        if not m:
            continue
        pid, etime, cmd = m.group(1), m.group(2), m.group(3)
        if "claude-code/bin/claude" not in cmd and not re.search(r"/claude(\s|$)", cmd):
            continue
        if "tokenhud" in cmd or "tokenhud" in cmd:
            continue

        headless = " -p " in cmd or cmd.endswith(" -p") or "--print" in cmd
        agent = (re.search(r"--agent\s+(\S+)", cmd) or [None, None])[1] \
            if re.search(r"--agent\s+(\S+)", cmd) else None
        model = (re.search(r"--model\s+(\S+)", cmd) or [None, None])[1] \
            if re.search(r"--model\s+(\S+)", cmd) else None

        if agent:
            kind = f"agent · {agent}"
        elif headless:
            kind = "headless"
        elif "--input-format" in cmd and "stream-json" in cmd:
            kind = "IDE session"
        elif "--remote-control" in cmd or "--rc" in cmd:
            kind = "remote control"
        else:
            kind = "interactive"

        out.append({
            "pid": int(pid), "elapsed": etime, "kind": kind,
            "headless": headless, "agent": agent, "model": model,
            # Truncated deliberately: a full argv can carry a path, a prompt,
            # or a token, and this payload crosses a network.
            "cmd": cmd[:200],
        })
    return sorted(out, key=lambda p: p["pid"])


# ── Claude Code ─────────────────────────────────────────────────────────

def _claude_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))


def collect_claude_stats() -> dict:
    root = _claude_dir()
    s = _json(root / "stats-cache.json", {}) or {}

    tokens_by_date = {
        r.get("date"): (r.get("tokensByModel") or {})
        for r in (s.get("dailyModelTokens") or []) if isinstance(r, dict)
    }
    daily = []
    for r in (s.get("dailyActivity") or []):
        if not isinstance(r, dict) or not r.get("date"):
            continue
        tok = tokens_by_date.get(r["date"]) or {}
        daily.append({
            "date": r["date"],
            "messages": r.get("messageCount") or 0,
            "toolCalls": r.get("toolCallCount") or 0,
            "sessions": r.get("sessionCount") or 0,
            "tokensByModel": tok,
            "tokens": sum(v for v in tok.values() if isinstance(v, (int, float))),
        })
    daily.sort(key=lambda r: r["date"])

    models = []
    for name, m in (s.get("modelUsage") or {}).items():
        if not isinstance(m, dict):
            continue
        models.append({
            "model": name,
            "input": m.get("inputTokens") or 0,
            "output": m.get("outputTokens") or 0,
            "cacheRead": m.get("cacheReadInputTokens") or 0,
            "cacheCreate": m.get("cacheCreationInputTokens") or 0,
            "webSearches": m.get("webSearchRequests") or 0,
            # Zero on a subscription plan. Forwarded exactly as reported; the
            # UI says "not reported" rather than pricing it from a rate card.
            "costUSD": m.get("costUSD") or 0,
        })
    models.sort(key=lambda r: r["output"], reverse=True)

    hours = {str(h): 0 for h in range(24)}
    for h, c in (s.get("hourCounts") or {}).items():
        if str(h) in hours:
            hours[str(h)] = c

    return {
        "present": (root / "stats-cache.json").exists(),
        "totalSessions": s.get("totalSessions") or 0,
        "totalMessages": s.get("totalMessages") or 0,
        "firstSessionDate": s.get("firstSessionDate"),
        "lastComputedDate": s.get("lastComputedDate"),
        "daily": daily,
        "models": models,
        "hours": hours,
        "costReported": any(m["costUSD"] for m in models),
    }


def _transcript_cwd(path: Path) -> tuple[str | None, str | None]:
    """Real cwd and branch, read from inside a transcript.

    The project directory NAME is the absolute path with every "/" replaced by
    "-", which is not reversible — real directory names contain hyphens, so
    un-mangling turns `pattadar-platform` into `.../pattadar/platform`. The
    transcript records its own cwd, so read that instead of guessing.
    """
    try:
        with path.open() as fh:
            for i, line in enumerate(fh):
                if i > 40:
                    break
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if isinstance(r, dict) and r.get("cwd"):
                    return r["cwd"], r.get("gitBranch")
    except Exception:
        pass
    return None, None


def collect_claude_projects() -> list:
    root = _claude_dir() / "projects"
    out = []
    if not root.is_dir():
        return out
    for d in root.iterdir():
        if not d.is_dir():
            continue
        sessions = sorted(d.glob("*.jsonl"), key=lambda f: f.stat().st_mtime)
        last = max((f.stat().st_mtime for f in sessions), default=d.stat().st_mtime)
        path, branch = _transcript_cwd(sessions[-1]) if sessions else (None, None)
        if not path:
            path = "/" + d.name.strip("-").replace("-", "/")
        out.append({
            "path": path,
            "label": Path(path).name or d.name,
            "branch": branch,
            # A background sweep gets its own project directory because it runs
            # in its own worktree. Machine-made and short-lived — mark it so a
            # sha does not pose as a project someone works on.
            "worktree": bool(re.search(r"/[0-9a-f]{7,40}$", path)) or "-parity/" in path,
            "sessions": len(sessions),
            "bytes": sum(f.stat().st_size for f in sessions),
            "lastActive": datetime.fromtimestamp(last, tz=timezone.utc).isoformat(),
        })
    out.sort(key=lambda p: p["lastActive"], reverse=True)
    return out


def collect_daemon() -> dict:
    st = _json(_claude_dir() / "daemon.status.json", {}) or {}
    pid = st.get("supervisorPid")
    alive = False
    if pid:
        try:
            os.kill(int(pid), 0)
            alive = True
        except Exception:
            alive = False
    return {
        "pid": pid, "alive": alive,
        "startedAt": st.get("supervisorProcStart"),
        "workers": st.get("workers") or {},
        "writtenAt": _iso_ms(st.get("writtenAt")),
    }


def collect_prompts(limit: int = 30) -> list:
    """Recent prompt subjects.

    OFF by default (`TOKENHUD_SEND_PROMPTS=1` to enable): prompt text is the most
    sensitive thing on this machine, and a metrics payload that crosses a
    network should not carry it unless someone deliberately said so.
    """
    if os.environ.get("TOKENHUD_SEND_PROMPTS") != "1":
        return []
    rows = _jsonl(_claude_dir() / "history.jsonl", limit=limit)
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        out.append({
            "text": (r.get("display") or "").strip().replace("\n", " ")[:160],
            "project": r.get("project") or "",
            "at": _iso_ms(r.get("timestamp")),
        })
    out.reverse()
    return out


# ── spend, sessions, and what is driving them ───────────────────────────
#
# The question "where is my usage going" has no answer on a subscription
# plan — the CLI reports $0 because that is what a flat fee costs per
# request. So the board answers it in list-price dollars instead, computed
# from the transcripts, and says so everywhere the number appears. See
# pricing.py for why that trade is worth making.


def _ts(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _tok_totals(models: dict) -> dict:
    t = {"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0}
    for m in (models or {}).values():
        t["in"] += m.get("in", 0)
        t["out"] += m.get("out", 0)
        t["cacheRead"] += m.get("cr", 0)
        t["cacheWrite"] += m.get("cw5", 0) + m.get("cw1", 0)
    return t


def _session_view(s: dict) -> dict:
    est, unpriced = pricing.cost_of(s.get("models"))
    sub, _ = pricing.cost_of(s.get("sub"))
    ctx, _ = pricing.cost_of(s.get("ctx"))
    first, last = _ts(s.get("first")), _ts(s.get("last"))
    hours = round((last - first).total_seconds() / 3600, 2) if first and last else 0.0
    models = sorted(
        (s.get("models") or {}).items(),
        key=lambda kv: kv[1].get("out", 0), reverse=True,
    )
    return {
        "id": (s.get("id") or "")[:8],
        # Session titles are written from the first prompt, so they are prompt
        # text by another name and follow the same rule: opt in or not at all.
        "title": (s.get("title") if os.environ.get("TOKENHUD_SEND_PROMPTS") == "1" else None),
        "project": Path(s.get("project") or "").name or "—",
        "path": s.get("project"),
        "branch": s.get("branch"),
        "entry": s.get("entry"),
        "first": s.get("first"),
        "last": s.get("last"),
        "hours": hours,
        "requests": s.get("req", 0),
        "toolCalls": s.get("tools", 0),
        "maxContext": s.get("maxCtx", 0),
        "models": [m for m, _ in models[:4]],
        "tokens": _tok_totals(s.get("models")),
        "estUSD": round(est, 2),
        "subUSD": round(sub, 2),
        "ctxUSD": round(ctx, 2),
        "unpricedTokens": unpriced,
    }


def _attribution(rows: list) -> dict:
    """Independent characteristics of a set of sessions, not a breakdown.

    These overlap on purpose — one expensive session can be subagent-heavy AND
    long AND deep in context, so the percentages do not sum to 100. Each is
    "this share of the estimate has this property", which is the only reading
    that survives the overlap. Every threshold is stated in `note` so the
    number cannot be quoted without its definition.
    """
    total = round(sum(r["estUSD"] for r in rows), 4)
    out = {
        "estUSD": total,
        "sessions": len(rows),
        "requests": sum(r["requests"] for r in rows),
        "drivers": [],
    }
    if total <= 0:
        return out

    def pct(v):
        return round(v / total * 100)

    sub_direct = sum(r["subUSD"] for r in rows)
    sub_sessions = sum(r["estUSD"] for r in rows if r["subUSD"] > 0)
    ctx_direct = sum(r["ctxUSD"] for r in rows)
    long_sessions = sum(r["estUSD"] for r in rows if r["hours"] >= transcripts.LONG_SESSION_HOURS)
    n_sub = sum(1 for r in rows if r["subUSD"] > 0)
    n_long = sum(1 for r in rows if r["hours"] >= transcripts.LONG_SESSION_HOURS)

    out["drivers"] = [
        {"key": "subagent-work", "pct": pct(sub_direct), "label": "ran as subagents",
         "note": "Requests marked as a sidechain — work a subagent did, not the main thread."},
        {"key": "subagent-sessions", "pct": pct(sub_sessions), "label": "from sessions that spawned subagents",
         "note": f"{n_sub} of {len(rows)} sessions used at least one subagent. Each subagent "
                 f"runs its own requests, so one delegation can cost more than the turn that made it."},
        {"key": "big-context", "pct": pct(ctx_direct),
         "label": f"at over {transcripts.BIG_CONTEXT // 1000}k context",
         "note": "Measured per request: input + cache read + cache write at the moment of the call. "
                 "A long session is dearer per turn even when the cache is hot."},
        {"key": "long-sessions", "pct": pct(long_sessions),
         "label": f"from sessions running {transcripts.LONG_SESSION_HOURS}h+",
         "note": f"{n_long} of {len(rows)} sessions spanned {transcripts.LONG_SESSION_HOURS} hours or more "
                 f"between first and last request — usually a background or loop session."},
    ]
    return out


def _blocks(idx: dict) -> dict:
    """Where you are inside the rolling five-hour usage block.

    Subscription usage is metered in five-hour blocks: the first request
    opens one, and it runs five hours whatever happens next. That is a rule
    about wall-clock time, not about an account, so it can be reconstructed
    from local request timestamps alone — and on this machine the
    reconstruction lands within minutes of what the CLI's own usage panel
    reports.

    What is NOT reconstructable is the limit itself. How much of the block
    you have consumed is a fact about your plan, and no local file knows it.
    So this reports what it measured — when the block opened, when it rolls
    over, how much work went into it — and compares it against your own
    recent blocks, which is a real answer to "is this a heavy one". It never
    shows a percentage of a limit it cannot see.
    """
    minutes = idx.get("minutes") or {}
    out_minutes = idx.get("outMinutes") or {}
    if not minutes:
        return {"available": False, "hours": transcripts.BLOCK_HOURS}

    span = transcripts.BLOCK_HOURS * 60
    stamps = sorted(int(m) for m in minutes)
    blocks = []
    for m in stamps:
        if not blocks or m >= blocks[-1]["startMin"] + span:
            blocks.append({"startMin": m, "requests": 0, "output": 0, "lastMin": m})
        b = blocks[-1]
        b["requests"] += minutes.get(str(m), 0)
        b["output"] += out_minutes.get(str(m), 0)
        b["lastMin"] = m

    now_min = int(time.time() // 60)

    def view(b):
        end = b["startMin"] + span
        return {
            "start": datetime.fromtimestamp(b["startMin"] * 60, timezone.utc).isoformat(),
            "end": datetime.fromtimestamp(end * 60, timezone.utc).isoformat(),
            "lastRequest": datetime.fromtimestamp(b["lastMin"] * 60, timezone.utc).isoformat(),
            "requests": b["requests"],
            "outputTokens": b["output"],
            "open": now_min < end,
            "minutesLeft": max(0, end - now_min),
            "minutesUsed": min(span, max(0, now_min - b["startMin"])),
        }

    recent = [view(b) for b in blocks[-14:]]
    current = recent[-1] if recent and recent[-1]["open"] else None
    closed = [b for b in recent if not b["open"]]
    busiest = max(recent, key=lambda b: b["outputTokens"], default=None)

    # The seven-day window is a different animal: it resets on a schedule
    # tied to the account, and nothing on disk records when. Reporting a
    # rolling seven days is the honest substitute — it is a real number
    # about a real window, just not the one that resets.
    week_cut = now_min - 7 * 24 * 60
    week_req = sum(c for m, c in minutes.items() if int(m) >= week_cut)
    week_out = sum(c for m, c in out_minutes.items() if int(m) >= week_cut)

    return {
        "available": True,
        "hours": transcripts.BLOCK_HOURS,
        "current": current,
        "recent": recent,
        "busiest": busiest,
        "closedMedianOutput": sorted(b["outputTokens"] for b in closed)[len(closed) // 2] if closed else 0,
        "rolling7d": {
            "requests": week_req,
            "outputTokens": week_out,
            "since": datetime.fromtimestamp(week_cut * 60, timezone.utc).isoformat(),
        },
        "note": (
            "Your own activity, reconstructed from request timestamps on this "
            "machine. The five-hour block is wall-clock — the first request opens "
            "it and it rolls over five hours later whatever you do — so the window "
            "is measured, not estimated. What share of your plan it consumed is a "
            "different question, and Anthropic answers it in the usage windows "
            "above; this panel never guesses at it."
        ),
        "weekNote": (
            "A rolling seven days of your own work, not your plan's weekly window. "
            "The real weekly window and the instant it resets are above, reported "
            "by Anthropic. This is here to answer a different question: how hard "
            "have you been going lately."
        ),
    }


def collect_usage() -> dict:
    """Per-session usage and an estimated dollar value, from the transcripts."""
    try:
        idx = transcripts.scan()
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}

    rows = [_session_view(s) for s in idx.get("sessions", {}).values()]
    rows.sort(key=lambda r: r["last"] or "", reverse=True)

    by_model: dict[str, dict] = {}
    for s in idx.get("sessions", {}).values():
        for name, m in (s.get("models") or {}).items():
            b = by_model.setdefault(name, {"in": 0, "out": 0, "cr": 0, "cw5": 0, "cw1": 0})
            for k in b:
                b[k] += m.get(k, 0)
    models = []
    for name, m in by_model.items():
        est = pricing.cost(name, m)
        models.append({
            "model": name,
            "estUSD": round(est, 2) if est is not None else None,
            "priced": est is not None,
            "input": m["in"], "output": m["out"],
            "cacheRead": m["cr"], "cacheWrite": m["cw5"] + m["cw1"],
        })
    models.sort(key=lambda r: (r["estUSD"] or 0), reverse=True)

    days = []
    for day, per_model in sorted((idx.get("days") or {}).items()):
        est, _ = pricing.cost_of(per_model)
        days.append({
            "date": day,
            "estUSD": round(est, 2),
            "byModel": {n: round(pricing.cost(n, m) or 0, 2) for n, m in per_model.items()},
        })

    now = datetime.now(timezone.utc)
    def since(hours):
        cut = now - timedelta(hours=hours)
        return [r for r in rows if (_ts(r["last"]) or now) >= cut]

    all_tokens = {"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0}
    for r in rows:
        for k in all_tokens:
            all_tokens[k] += r["tokens"][k]

    return {
        "available": True,
        "scan": idx.get("scan", {}),
        "pricing": pricing.card(),
        "blocks": _blocks(idx),
        "allTime": {
            "estUSD": round(sum(r["estUSD"] for r in rows), 2),
            "sessions": len(rows),
            "requests": sum(r["requests"] for r in rows),
            "toolCalls": sum(r["toolCalls"] for r in rows),
            "tokens": all_tokens,
            "unpricedTokens": sum(r["unpricedTokens"] for r in rows),
        },
        "byModel": models,
        "byDay": days[-60:],
        "windows": {
            "day": _attribution(since(24)),
            "week": _attribution(since(24 * 7)),
            "all": _attribution(rows),
        },
        # Trimmed: the whole point is the ones worth looking at, and the
        # payload crosses a network every interval.
        "sessions": rows[:60],
    }


# ── which assistants this machine has ───────────────────────────────────
#
# The board reads Claude Code. Everything else here is detection only, and
# says so: an entry in this list is "this tool is installed", never "we have
# numbers for it". A dropdown that silently showed one tool's data under
# another tool's name would be worse than having no dropdown.

_ASSISTANTS = [
    {"id": "claude-code", "name": "Claude Code", "dirs": [".claude"], "bin": "claude"},
    {"id": "codex", "name": "Codex CLI", "dirs": [".codex"], "bin": "codex"},
    {"id": "cursor", "name": "Cursor", "dirs": [".cursor"], "bin": "cursor"},
    {"id": "gemini-cli", "name": "Gemini CLI", "dirs": [".gemini"], "bin": "gemini"},
    {"id": "copilot", "name": "GitHub Copilot", "dirs": [".config/github-copilot"], "bin": None},
    {"id": "windsurf", "name": "Windsurf", "dirs": [".windsurf", ".codeium"], "bin": "windsurf"},
    {"id": "antigravity", "name": "Antigravity", "dirs": [".antigravity-ide"], "bin": None},
    {"id": "aider", "name": "Aider", "dirs": [".aider.conf.yml"], "bin": "aider"},
]


def _which(name: str | None) -> str | None:
    if not name:
        return None
    return shutil.which(name)


def _codex_sessions() -> int | None:
    """Codex keeps one line per session in an index file. Cheap to count, and
    it makes "detected" mean something more than "a directory exists"."""
    p = Path.home() / ".codex" / "session_index.jsonl"
    try:
        with p.open("rb") as fh:
            return sum(1 for line in fh if line.strip())
    except Exception:
        return None


def collect_assistants() -> list:
    home = Path.home()
    out = []
    for a in _ASSISTANTS:
        dirs = [str(home / d) for d in a["dirs"] if (home / d).exists()]
        binary = _which(a["bin"])
        detected = bool(dirs or binary)
        supported = a["id"] == "claude-code"
        row = {
            "id": a["id"], "name": a["name"],
            "detected": detected,
            "supported": supported,
            "paths": dirs,
            "bin": binary,
            "note": ("Read by this board." if supported else
                     "Detected on this machine. No collector reads it yet — "
                     "add one to collectors.py and it appears here with data."),
        }
        if a["id"] == "codex" and detected:
            n = _codex_sessions()
            if n is not None:
                row["sessions"] = n
        out.append(row)
    out.sort(key=lambda r: (not r["supported"], not r["detected"], r["name"]))
    return out


# ── the snapshot ────────────────────────────────────────────────────────

def collect() -> dict:
    """One full reading of this machine, ready to POST."""
    return {
        "host": host_id(),
        "agentVersion": AGENT_VERSION,
        "collectedAt": now_iso(),
        "metrics": {
            "host": collect_host(),
            "processes": collect_processes(),
            "claude": collect_claude_stats(),
            "usage": collect_usage(),
            "limits": limits.collect_limits(),
            "assistants": collect_assistants(),
            "projects": collect_claude_projects(),
            "daemon": collect_daemon(),
            "prompts": collect_prompts(),
        },
    }


if __name__ == "__main__":
    print(json.dumps(collect(), indent=2))

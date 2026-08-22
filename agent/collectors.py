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
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path

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
    return os.environ.get("AIMC_HOST") or socket.gethostname()


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
        if "aimc" in cmd or "AIMissionControl" in cmd:
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

    OFF by default (`AIMC_SEND_PROMPTS=1` to enable): prompt text is the most
    sensitive thing on this machine, and a metrics payload that crosses a
    network should not carry it unless someone deliberately said so.
    """
    if os.environ.get("AIMC_SEND_PROMPTS") != "1":
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
            "projects": collect_claude_projects(),
            "daemon": collect_daemon(),
            "prompts": collect_prompts(),
        },
    }


if __name__ == "__main__":
    print(json.dumps(collect(), indent=2))

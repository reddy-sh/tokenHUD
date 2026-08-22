"""
Storage — SQLite, because the alternative is worse.

A metrics store wants three things: append fast, read the latest per host
fast, and expire old rows without a maintenance job. SQLite in WAL mode does
all three on one file with no daemon, no container and no ops. When one box
stops being enough, the schema below ports to Postgres unchanged.

Three tables:

  hosts      one row per machine, overwritten — "what is true now"
  snapshots  append-only history — "what was true then"
  endings    derived — "what stopped, and when nobody was looking"

`endings` is the one that is not just storage. A snapshot says which agents
were running at an instant; nobody watches a dashboard at every instant. The
question people actually ask is "what finished while I was away", and that is
a difference between two readings, not a reading. The server is the only
place that holds both, so the server is where the difference gets taken.

The latest reading is deliberately duplicated into `hosts` rather than derived
with a MAX(at) subquery on every dashboard poll: the board asks for it every
few seconds, and the history table is the one that grows without bound.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS hosts (
  host          TEXT PRIMARY KEY,
  last_seen     TEXT NOT NULL,
  agent_version TEXT,
  payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  host    TEXT NOT NULL,
  at      TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_host_at ON snapshots (host, at DESC);

CREATE TABLE IF NOT EXISTS endings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  kind        TEXT,
  tool        TEXT,
  cmd         TEXT,
  ran_seconds INTEGER,
  last_seen   TEXT NOT NULL,   -- last reading it appeared in
  noticed_at  TEXT NOT NULL,   -- first reading it was missing from
  UNIQUE (host, pid, last_seen)
);

CREATE INDEX IF NOT EXISTS idx_endings_noticed ON endings (noticed_at DESC);
"""

# ps etime: [[DD-]HH:]MM:SS. Parsed so the board can say "ran 4h 12m" instead
# of showing a string only ps could love.
_ETIME = re.compile(r"^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$")


def etime_seconds(s: str | None) -> int | None:
    m = _ETIME.match((s or "").strip())
    if not m:
        return None
    d, h, mm, ss = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mm * 60 + ss


class Store:
    def __init__(self, path: Path, retention_days: int = 30):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.retention_days = retention_days
        # One connection guarded by a lock. The server is threaded, and
        # sqlite3 objects are not safe to share across threads by default;
        # a lock is simpler to reason about than a connection pool at this size.
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.executescript(SCHEMA)
            self._db.commit()

    # ── writes ──────────────────────────────────────────────────────────

    def ingest(self, snapshot: dict) -> None:
        host = snapshot.get("host") or "unknown"
        at = snapshot.get("collectedAt") or datetime.now(timezone.utc).isoformat()
        blob = json.dumps(snapshot, separators=(",", ":"))
        with self._lock:
            prev = self._db.execute(
                "SELECT last_seen, payload FROM hosts WHERE host=?", (host,)
            ).fetchone()
            # Only a reading NEWER than the one on file can tell us something
            # stopped. The agent spools when the server is away and replays on
            # reconnect, so an older snapshot arriving is normal — and diffing
            # it would report every currently-running agent as ended.
            if prev and prev["last_seen"] < at:
                self._record_endings(host, prev, at, snapshot)
            self._db.execute(
                "INSERT INTO hosts (host, last_seen, agent_version, payload) VALUES (?,?,?,?) "
                "ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen, "
                "agent_version=excluded.agent_version, payload=excluded.payload",
                (host, at, snapshot.get("agentVersion"), blob),
            )
            self._db.execute(
                "INSERT INTO snapshots (host, at, payload) VALUES (?,?,?)",
                (host, at, blob),
            )
            self._db.commit()

    def _record_endings(self, host: str, prev, at: str, snapshot: dict) -> None:
        """Whatever was running last time and is not running now, ended."""
        try:
            before = json.loads(prev["payload"]).get("metrics", {}).get("processes") or []
            after = (snapshot.get("metrics") or {}).get("processes") or []
        except Exception:
            return
        if not before:
            return
        live = {p.get("pid") for p in after if isinstance(p, dict)}
        for p in before:
            if not isinstance(p, dict) or p.get("pid") in live:
                continue
            self._db.execute(
                "INSERT OR IGNORE INTO endings "
                "(host, pid, kind, tool, cmd, ran_seconds, last_seen, noticed_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (host, p.get("pid"), p.get("kind"), p.get("tool") or "claude-code",
                 (p.get("cmd") or "")[:200], etime_seconds(p.get("elapsed")),
                 prev["last_seen"], at),
            )

    def endings(self, limit: int = 40, within_hours: int = 24, host: str | None = None) -> list:
        """Recently finished agents, newest first.

        Each row carries both timestamps, not one. A reading every 30 seconds
        places an ending inside a 30-second window; a laptop that slept places
        it inside a four-hour one. The board can only be honest about when
        something ended if it is told how wide the window was.
        """
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=within_hours)).isoformat()
        sql = ("SELECT host, pid, kind, tool, cmd, ran_seconds, last_seen, noticed_at "
               "FROM endings WHERE noticed_at >= ?")
        args: list = [cutoff]
        if host:
            sql += " AND host=?"
            args.append(host)
        sql += " ORDER BY noticed_at DESC, id DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def prune(self) -> int:
        """Drop history past the retention window. Called on ingest, so the
        file cannot grow forever on a machine nobody is administering."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=self.retention_days)).isoformat()
        with self._lock:
            cur = self._db.execute("DELETE FROM snapshots WHERE at < ?", (cutoff,))
            self._db.execute("DELETE FROM endings WHERE noticed_at < ?", (cutoff,))
            self._db.commit()
            return cur.rowcount

    # ── reads ───────────────────────────────────────────────────────────

    def hosts(self) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT host, last_seen, agent_version FROM hosts ORDER BY last_seen DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def latest(self, host: str | None = None) -> dict | None:
        with self._lock:
            if host:
                row = self._db.execute("SELECT payload FROM hosts WHERE host=?", (host,)).fetchone()
            else:
                row = self._db.execute(
                    "SELECT payload FROM hosts ORDER BY last_seen DESC LIMIT 1"
                ).fetchone()
        return json.loads(row["payload"]) if row else None

    def all_latest(self) -> list:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM hosts ORDER BY last_seen DESC").fetchall()
        return [json.loads(r["payload"]) for r in rows]

    def history(self, host: str, limit: int = 200) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT at, payload FROM snapshots WHERE host=? ORDER BY at DESC LIMIT ?",
                (host, limit),
            ).fetchall()
        return [{"at": r["at"], **json.loads(r["payload"])} for r in rows][::-1]

    def counts(self) -> dict:
        with self._lock:
            s = self._db.execute("SELECT COUNT(*) c FROM snapshots").fetchone()["c"]
            h = self._db.execute("SELECT COUNT(*) c FROM hosts").fetchone()["c"]
            e = self._db.execute("SELECT COUNT(*) c FROM endings").fetchone()["c"]
        return {"snapshots": s, "hosts": h, "endings": e, "db": str(self.path),
                "bytes": self.path.stat().st_size if self.path.exists() else 0}

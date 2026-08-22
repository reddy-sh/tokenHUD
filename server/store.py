"""
Storage — SQLite, because the alternative is worse.

A metrics store wants three things: append fast, read the latest per host
fast, and expire old rows without a maintenance job. SQLite in WAL mode does
all three on one file with no daemon, no container and no ops. When one box
stops being enough, the schema below ports to Postgres unchanged.

Two tables:

  hosts      one row per machine, overwritten — "what is true now"
  snapshots  append-only history — "what was true then"

The latest reading is deliberately duplicated into `hosts` rather than derived
with a MAX(at) subquery on every dashboard poll: the board asks for it every
few seconds, and the history table is the one that grows without bound.
"""
from __future__ import annotations

import json
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
"""


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

    def prune(self) -> int:
        """Drop history past the retention window. Called on ingest, so the
        file cannot grow forever on a machine nobody is administering."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=self.retention_days)).isoformat()
        with self._lock:
            cur = self._db.execute("DELETE FROM snapshots WHERE at < ?", (cutoff,))
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
        return {"snapshots": s, "hosts": h, "db": str(self.path),
                "bytes": self.path.stat().st_size if self.path.exists() else 0}

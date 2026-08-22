#!/usr/bin/env python3
"""
AIMC server — takes what agents send, keeps it, serves the board.

    python3 server/server.py --new-key      # print a key, then set AIMC_KEY
    AIMC_KEY=... python3 server/server.py   # http://127.0.0.1:8787

Three jobs, and nothing else:

    POST /api/v1/ingest      an agent's snapshot            (key required)
    GET  /api/v1/overview    latest reading for every host  (key optional)
    GET  /api/v1/history     one host's recent snapshots
    GET  /                   the dashboard

Standard library only. SQLite for storage. Binds loopback by default — set
AIMC_BIND=0.0.0.0 deliberately, and read the note below before you do.

## On exposing this

The ingest key is a bearer secret in a header. Over plain HTTP on a LAN that
is adequate against accident and useless against anyone listening. If this
server ever leaves your machine, put it behind TLS — a reverse proxy is the
easy answer — and treat AIMC_KEY as a real credential.

Defaults are chosen so that doing nothing is safe: loopback bind, key
required for writes, no CORS, and the agent sends no prompt text.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from store import Store  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

BIND = os.environ.get("AIMC_BIND", "127.0.0.1")
PORT = int(os.environ.get("AIMC_PORT", "8787"))
KEY = os.environ.get("AIMC_KEY", "")
DB = Path(os.environ.get("AIMC_DB", ROOT / "data" / "aimc.db"))
RETENTION = int(os.environ.get("AIMC_RETENTION_DAYS", "30"))
# Reads are open by default so the dashboard needs no secret in the browser.
# Set AIMC_PROTECT_READS=1 to require the key on GET too.
PROTECT_READS = os.environ.get("AIMC_PROTECT_READS") == "1"

MAX_BODY = 8 * 1024 * 1024      # a snapshot is ~50 KB; this is a wide ceiling

store = Store(DB, retention_days=RETENTION)


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not KEY:
        return False
    sent = handler.headers.get("X-AIMC-Key", "")
    # compare_digest, not ==, so a wrong key cannot be found one byte at a time.
    return hmac.compare_digest(sent, KEY)


class Handler(BaseHTTPRequestHandler):
    server_version = "aimc/0.1"

    # ── plumbing ────────────────────────────────────────────────────────

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def log_message(self, fmt, *args):
        pass        # a 5-second poll would otherwise scroll the terminal away

    # ── writes ──────────────────────────────────────────────────────────

    def do_POST(self):
        if urlparse(self.path).path != "/api/v1/ingest":
            self._json(404, {"error": "not found"})
            return
        if not authorized(self):
            self._json(401, {"error": "bad or missing X-AIMC-Key"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._json(413, {"error": "body missing or too large"})
            return
        try:
            snap = json.loads(self.rfile.read(n))
        except Exception as e:
            self._json(400, {"error": f"bad json: {e}"})
            return
        if not isinstance(snap, dict) or not snap.get("host"):
            self._json(400, {"error": "snapshot needs a host"})
            return
        try:
            store.ingest(snap)
            store.prune()
        except Exception as e:
            self._json(500, {"error": str(e)})
            return
        self._json(202, {"ok": True, "host": snap["host"]})

    # ── reads ───────────────────────────────────────────────────────────

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/healthz":
            self._send(200, b"ok", "text/plain")
            return

        if u.path.startswith("/api/"):
            if PROTECT_READS and not authorized(self):
                self._json(401, {"error": "bad or missing X-AIMC-Key"})
                return

            if u.path == "/api/v1/overview":
                hosts = store.hosts()
                now = datetime.now(timezone.utc)
                for h in hosts:
                    try:
                        seen = datetime.fromisoformat(h["last_seen"])
                        age = (now - seen).total_seconds()
                    except Exception:
                        age = None
                    h["ageSeconds"] = age
                    # "up" is about the AGENT reporting, not the machine being
                    # switched on. Three missed intervals is the usual line.
                    h["status"] = "unknown" if age is None else (
                        "up" if age < 120 else "stale" if age < 900 else "down")
                self._json(200, {
                    "generatedAt": now.isoformat(),
                    "hosts": hosts,
                    "latest": store.all_latest(),
                    "store": store.counts(),
                })
                return

            if u.path == "/api/v1/history":
                host = (q.get("host") or [""])[0]
                if not host:
                    self._json(400, {"error": "host is required"})
                    return
                limit = min(1000, int((q.get("limit") or ["200"])[0]))
                self._json(200, {"host": host, "snapshots": store.history(host, limit)})
                return

            self._json(404, {"error": "not found"})
            return

        # ── static ──────────────────────────────────────────────────────
        rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
        target = (WEB / rel).resolve()
        if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        types = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
                 ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json"}
        self._send(200, target.read_bytes(), types.get(target.suffix, "application/octet-stream"))


def main():
    ap = argparse.ArgumentParser(description="AIMC server")
    ap.add_argument("--new-key", action="store_true", help="print a fresh ingest key and exit")
    args = ap.parse_args()

    if args.new_key:
        print(secrets.token_urlsafe(32))
        return

    if not KEY:
        print("AIMC_KEY is not set — ingest will reject every agent.")
        print("Generate one:  python3 server/server.py --new-key")
        print("Then:          export AIMC_KEY=<that value>\n")

    if BIND != "127.0.0.1":
        print(f"! binding {BIND} — this server is reachable from the network.")
        print("! put TLS in front of it before sending a real key over the wire.\n")

    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"AIMC server on http://{BIND}:{PORT}")
    print(f"  db        {DB}")
    print(f"  retention {RETENTION} days")
    print("  ctrl-c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()

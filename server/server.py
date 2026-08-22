#!/usr/bin/env python3
"""
TOKENHUD server — takes what agents send, keeps it, serves the board.

    python3 server/server.py --new-key      # print a key, then set TOKENHUD_KEY
    TOKENHUD_KEY=... python3 server/server.py   # http://127.0.0.1:8787

Three jobs, and nothing else:

    POST /api/v1/ingest      an agent's snapshot            (key required)
    GET  /api/v1/stream      server-sent events: pushed the instant a
                             reading lands, so the board stops guessing
    GET  /api/v1/overview    latest reading for every host  (key optional)
    GET  /api/v1/history     one host's recent snapshots
    GET  /api/v1/endings     agents that stopped recently
    GET  /                   the dashboard

Standard library only. SQLite for storage. Binds loopback by default — set
TOKENHUD_BIND=0.0.0.0 deliberately, and read the note below before you do.

## On exposing this

The ingest key is a bearer secret in a header. Over plain HTTP on a LAN that
is adequate against accident and useless against anyone listening. If this
server ever leaves your machine, put it behind TLS — a reverse proxy is the
easy answer — and treat TOKENHUD_KEY as a real credential.

Defaults are chosen so that doing nothing is safe: loopback bind, key
required for writes, no CORS, and the agent sends no prompt text.
"""
from __future__ import annotations

import argparse
import gzip
import hmac
import json
import os
import threading
import zlib
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

BIND = os.environ.get("TOKENHUD_BIND", "127.0.0.1")
PORT = int(os.environ.get("TOKENHUD_PORT", "8787"))
KEY = os.environ.get("TOKENHUD_KEY", "")
DB = Path(os.environ.get("TOKENHUD_DB", ROOT / "data" / "tokenhud.db"))
RETENTION = int(os.environ.get("TOKENHUD_RETENTION_DAYS", "30"))
# Reads are open by default so the dashboard needs no secret in the browser.
# Set TOKENHUD_PROTECT_READS=1 to require the key on GET too.
PROTECT_READS = os.environ.get("TOKENHUD_PROTECT_READS") == "1"

MAX_BODY = 8 * 1024 * 1024      # a snapshot is ~50 KB; this is a wide ceiling
# Every reader of the event stream holds a thread for as long as it watches.
# That is the honest cost of push on a stdlib server, so it is bounded rather
# than hoped about: past the cap the endpoint says no and the board falls back
# to polling, which still works and is what it did before.
MAX_STREAMS = int(os.environ.get("TOKENHUD_MAX_STREAMS", "8"))
# Long enough not to be chatter, short enough that a connection the client
# has already abandoned is reclaimed quickly: a write to a dead socket is
# the only way this server learns the reader has gone, and until it does,
# that reader still counts against MAX_STREAMS.
HEARTBEAT = 15

store = Store(DB, retention_days=RETENTION)


class Broadcast:
    """One counter and a condition, which is all a fan-out needs here.

    Readers wait for the counter to move; an ingest moves it. No queues, so
    a slow reader cannot make the server buffer without bound — it simply
    wakes late and sends the current state, which for a status board is the
    correct thing to send anyway. Missing an intermediate reading costs
    nothing when every event carries the whole truth.
    """

    def __init__(self):
        self._cv = threading.Condition()
        self._seq = 0
        self.readers = 0

    def publish(self) -> None:
        with self._cv:
            self._seq += 1
            self._cv.notify_all()

    def current(self) -> int:
        with self._cv:
            return self._seq

    def wait(self, seen: int, timeout: float):
        with self._cv:
            if self._seq == seen:
                self._cv.wait(timeout)
            return self._seq


bus = Broadcast()


def overview() -> dict:
    """Everything the board reads, in one object.

    Built in one place because two callers need it identical: the poll and
    the event stream. A stream that sent a different shape from the poll it
    replaces would be a bug that only appeared on reconnect.
    """
    hosts = store.hosts()
    now = datetime.now(timezone.utc)
    for h in hosts:
        try:
            age = (now - datetime.fromisoformat(h["last_seen"])).total_seconds()
        except Exception:
            age = None
        h["ageSeconds"] = age
        # "up" is about the AGENT reporting, not the machine being switched
        # on. Three missed intervals is the usual line.
        h["status"] = "unknown" if age is None else (
            "up" if age < 120 else "stale" if age < 900 else "down")
    return {
        "generatedAt": now.isoformat(),
        "hosts": hosts,
        "latest": store.all_latest(),
        # Carried here rather than left to its own endpoint: "what finished
        # while I was away" is the first thing someone returning to the
        # board wants, and a second round trip to learn it would be worse.
        "endings": store.endings(limit=40, within_hours=24),
        "store": store.counts(),
        "streams": {"open": bus.readers, "max": MAX_STREAMS},
    }


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not KEY:
        return False
    sent = handler.headers.get("X-TokenHUD-Key", "")
    # compare_digest, not ==, so a wrong key cannot be found one byte at a time.
    return hmac.compare_digest(sent, KEY)


class Handler(BaseHTTPRequestHandler):
    server_version = "tokenhud/0.1"
    # HTTP/1.1 keeps the connection open between polls. The board asks for
    # the same URL every interval for as long as the tab is open, and on
    # 1.0 every one of those was a fresh TCP connection set up and torn
    # down. Every response below sends an accurate Content-Length, which is
    # what makes this safe.
    protocol_version = "HTTP/1.1"

    # ── plumbing ────────────────────────────────────────────────────────

    def _send(self, code: int, body: bytes, ctype: str):
        # The overview payload is ~69 KB of JSON and compresses about 5x.
        # Over loopback that is not bandwidth, it is memcpy and parse time,
        # and both are worth cutting on a board that refreshes forever.
        if (len(body) > 1400
                and "gzip" in (self.headers.get("Accept-Encoding") or "")
                and ctype.startswith(("application/json", "text/"))):
            body = gzip.compress(body, 6)
            self.send_response(code)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        else:
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

    # ── push ────────────────────────────────────────────────────────────

    def _stream(self):
        """Server-sent events: one `reading` event per ingest.

        Chunked rather than Content-Length, because the length of a stream
        that never ends is not knowable — and chunked keeps the connection
        HTTP/1.1 so the browser reuses it rather than reconnecting.

        The client gets the current state immediately on connect, so a
        reconnect after a dropped link is a resync and not a gap. That is
        also why no delta protocol is needed for correctness: every event
        carries the whole truth, and a reader that missed one is not behind.
        """
        if bus.readers >= MAX_STREAMS:
            # Not an error the board should retry: it says so, and the
            # client falls back to polling, which needs no held connection.
            self._json(503, {"error": f"too many streams open (max {MAX_STREAMS}) — poll instead"})
            return

        # A stream that is not compressed is WORSE than the poll it replaces:
        # each reading is 69 KB where a gzipped poll is 14 KB. zlib with a
        # sync flush after every event keeps one compression context across
        # the whole stream — so the second reading, being nearly identical to
        # the first, costs a fraction of even that.
        gz = None
        if "gzip" in (self.headers.get("Accept-Encoding") or ""):
            gz = zlib.compressobj(6, zlib.DEFLATED, 16 + zlib.MAX_WBITS)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")   # in case anyone proxies this
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        bus.readers += 1
        # Start from where the bus IS, not from zero: starting at zero makes
        # the first wait return immediately and the board receives the same
        # reading twice on every connect.
        seen = bus.current()
        send = True          # the state on connect, so joining is a resync
        try:
            while True:
                if send:
                    payload = json.dumps(overview()).encode()
                    self._chunk(b"event: reading\ndata: " + payload + b"\n\n", gz)
                    send = False
                nxt = bus.wait(seen, HEARTBEAT)
                if nxt == seen:
                    # Nothing new, so nothing is sent. A comment line is a
                    # valid SSE no-op and is how a dead connection gets
                    # discovered: this write is what raises once the tab has
                    # gone. It must NOT fall through to the payload above,
                    # or an idle board would pull 69 KB every 20 seconds
                    # for no reason at all.
                    self._chunk(b": beat\n\n", gz)
                    continue
                seen = nxt
                send = True
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                  # the reader left; not an error
        finally:
            bus.readers -= 1
            self.close_connection = True

    def _chunk(self, data: bytes, gz=None) -> None:
        if gz is not None:
            # Z_SYNC_FLUSH ends a deflate block without ending the stream,
            # so the browser can decode this event now and the next one
            # still benefits from everything already in the window.
            data = gz.compress(data) + gz.flush(zlib.Z_SYNC_FLUSH)
            if not data:
                return
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    # ── writes ──────────────────────────────────────────────────────────

    def do_POST(self):
        if urlparse(self.path).path != "/api/v1/ingest":
            self._json(404, {"error": "not found"})
            return
        if not authorized(self):
            self._json(401, {"error": "bad or missing X-TokenHUD-Key"})
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
        # Everyone watching hears about it now, not on their next timer.
        bus.publish()
        self._json(202, {"ok": True, "host": snap["host"]})

    # ── reads ───────────────────────────────────────────────────────────

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/healthz":
            self._send(200, b"ok", "text/plain")
            return

        if u.path == "/api/v1/stream":
            if PROTECT_READS and not authorized(self):
                self._json(401, {"error": "bad or missing X-TokenHUD-Key"})
                return
            self._stream()
            return

        if u.path.startswith("/api/"):
            if PROTECT_READS and not authorized(self):
                self._json(401, {"error": "bad or missing X-TokenHUD-Key"})
                return

            if u.path == "/api/v1/overview":
                self._json(200, overview())
                return

            if u.path == "/api/v1/endings":
                try:
                    limit = min(500, max(1, int((q.get("limit") or ["100"])[0])))
                    hours = min(720, max(1, int((q.get("hours") or ["24"])[0])))
                except ValueError:
                    self._json(400, {"error": "limit and hours must be integers"})
                    return
                host = (q.get("host") or [""])[0] or None
                self._json(200, {"endings": store.endings(limit=limit, within_hours=hours, host=host)})
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
    ap = argparse.ArgumentParser(description="TOKENHUD server")
    ap.add_argument("--new-key", action="store_true", help="print a fresh ingest key and exit")
    args = ap.parse_args()

    if args.new_key:
        print(secrets.token_urlsafe(32))
        return

    if not KEY:
        print("TOKENHUD_KEY is not set — ingest will reject every agent.")
        print("Generate one:  python3 server/server.py --new-key")
        print("Then:          export TOKENHUD_KEY=<that value>\n")

    if BIND != "127.0.0.1":
        print(f"! binding {BIND} — this server is reachable from the network.")
        print("! put TLS in front of it before sending a real key over the wire.\n")

    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"TOKENHUD server on http://{BIND}:{PORT}")
    print(f"  db        {DB}")
    print(f"  retention {RETENTION} days")
    print("  ctrl-c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()

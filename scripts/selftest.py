#!/usr/bin/env python3
"""
Self-test — does this checkout actually work on this machine?

    python3 scripts/selftest.py

There is no test framework here for the same reason there are no dependencies
anywhere else: a stranger who has just cloned this should be able to check it
without installing anything first.

What it does NOT do is mock. Every check runs against the real thing — the
real collectors on the real machine, a real SQLite file in a temp directory, a
real HTTP server on an ephemeral port. A test that passes against a fake would
tell you nothing about whether the board works here, which is the only
question worth asking at this point.

Nothing it touches is yours: the store goes in a temp directory, the server
binds a throwaway port, and no collector writes anything.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent"))
sys.path.insert(0, str(ROOT / "server"))

PASS, FAIL, SKIP = "  ok  ", " FAIL ", " skip "
results: list[tuple[str, str, str]] = []


def check(name: str, fn):
    try:
        note = fn()
        results.append((PASS, name, note or ""))
    except AssertionError as e:
        results.append((FAIL, name, str(e)))
    except _Skip as e:
        results.append((SKIP, name, str(e)))
    except Exception as e:
        results.append((FAIL, name, f"{type(e).__name__}: {e}"))


class _Skip(Exception):
    pass


def skip(msg):
    raise _Skip(msg)


# ── the rate card ───────────────────────────────────────────────────────

def t_pricing_arithmetic():
    import pricing
    # A million output tokens on Opus 5 is $25 by the published rate, and if
    # that ever stops being true the board's headline is wrong.
    c = pricing.cost("claude-opus-5", {"out": 1_000_000})
    assert abs(c - 25.0) < 1e-6, f"expected $25.00, got {c}"
    # Cache is priced off input, not separately.
    r = pricing.cost("claude-opus-5", {"cr": 1_000_000})
    assert abs(r - 0.5) < 1e-6, f"cache read should be 0.1x the $5 input rate, got {r}"
    w = pricing.cost("claude-opus-5", {"cw1": 1_000_000})
    assert abs(w - 10.0) < 1e-6, f"1h cache write should be 2x input, got {w}"
    return "opus-5 $25/MTok out, cache read 0.1x, 1h write 2x"


def t_pricing_unknown_model_is_not_free():
    import pricing
    assert pricing.cost("claude-from-the-future-9", {"out": 1_000_000}) is None, \
        "an unpriced model must return None, never 0 — a 0 would silently join a total"
    total, unpriced = pricing.cost_of({"claude-from-the-future-9": {"out": 1234}})
    assert total == 0 and unpriced == 1234, f"unpriced tokens must be counted separately, got {total}/{unpriced}"
    return "unknown models report as unpriced, not as $0"


# ── the transcript index ────────────────────────────────────────────────

def t_transcript_scan():
    import transcripts
    root = transcripts._projects_root()
    if not root.is_dir():
        skip(f"no transcripts at {root}")
    # A small budget so this stays a test and not a full corpus scan.
    idx = transcripts.scan(budget=4 * 1024 * 1024)
    assert "sessions" in idx and "minutes" in idx, "index is missing its buckets"
    s = idx["scan"]
    assert s["bytesTotal"] >= 0 and s["bytesDone"] <= s["bytesTotal"], \
        f"progress is impossible: {s['bytesDone']} of {s['bytesTotal']}"
    return f"{len(idx['sessions'])} sessions indexed, {s['bytesDone'] / 1e6:.0f}/{s['bytesTotal'] / 1e6:.0f} MB read"


def t_blocks_are_five_hours():
    import collectors, transcripts
    b = collectors.collect_usage().get("blocks") or {}
    if not b.get("available"):
        skip("no request timestamps indexed yet")
    span = transcripts.BLOCK_HOURS * 60
    for row in b.get("recent", []):
        start = datetime.fromisoformat(row["start"])
        end = datetime.fromisoformat(row["end"])
        got = (end - start).total_seconds() / 60
        assert abs(got - span) < 1, f"a block ran {got} minutes, expected {span}"
    cur = b.get("current")
    if cur:
        assert 0 <= cur["minutesLeft"] <= span, f"minutesLeft out of range: {cur['minutesLeft']}"
    return f"{len(b.get('recent', []))} blocks, all exactly {transcripts.BLOCK_HOURS}h"


# ── the plan's real limits ──────────────────────────────────────────────

def t_limits_shape():
    import limits
    lim = limits.collect_limits()
    if not lim.get("available"):
        skip(f"no usage cache ({lim.get('reason')}) — run /usage in Claude Code")
    assert lim["accountHash"] and len(lim["accountHash"]) == 12, "account hash missing or wrong length"
    blob = json.dumps(lim)
    for leak in ("emailAddress", "@", "organizationName", "oauthAccount", "used_dollars"):
        assert leak not in blob, f"the limits payload must not carry {leak!r}"
    for w in lim["windows"]:
        assert w["percent"] is None or 0 <= w["percent"] <= 100, f"percent out of range: {w}"
    return f"{len(lim['windows'])} windows, {lim['ageSeconds']}s old, nothing identifying"


def t_limits_never_writes():
    import limits
    path = Path.home() / ".claude.json"
    if not path.is_file():
        skip("no ~/.claude.json on this machine")
    before = path.stat().st_mtime_ns
    limits.collect_limits()
    assert path.stat().st_mtime_ns == before, \
        "collect_limits() modified ~/.claude.json — it must never write to Claude Code's config"
    return "~/.claude.json untouched"


# ── collectors, as a whole ──────────────────────────────────────────────

def t_collect_is_json_and_quiet():
    import collectors
    t = time.time()
    snap = collectors.collect()
    el = time.time() - t
    blob = json.dumps(snap)          # raises if anything is unserialisable
    m = snap["metrics"]
    for key in ("host", "processes", "claude", "usage", "limits", "assistants", "projects", "daemon"):
        assert key in m, f"metrics is missing {key}"
    if os.environ.get("TOKENHUD_SEND_PROMPTS") != "1":
        assert m["prompts"] == [], "prompt text left the collector without TOKENHUD_SEND_PROMPTS=1"
        for s in (m["usage"].get("sessions") or []):
            assert s["title"] is None, "a session title (written from a prompt) leaked without opt-in"
    return f"{len(blob) / 1024:.0f} KB in {el:.2f}s"


def t_collectors_never_raise():
    """A broken source must report the rest of the machine, not vanish."""
    import collectors
    saved = os.environ.get("CLAUDE_CONFIG_DIR")
    os.environ["CLAUDE_CONFIG_DIR"] = "/nonexistent/definitely/not/here"
    try:
        snap = collectors.collect()
        json.dumps(snap)
        assert snap["metrics"]["host"]["cpus"], "host facts should survive a missing Claude directory"
    finally:
        if saved is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = saved
    return "a missing ~/.claude does not drop the host"


# ── the store ───────────────────────────────────────────────────────────

def _snap(host, at, pids, pad=0):
    """A snapshot. `pad` inflates it past the server's compression floor —
    small responses are deliberately not gzipped, because compressing 200
    bytes costs CPU and can make them bigger."""
    return {"host": host, "agentVersion": "test", "collectedAt": at,
            "metrics": {"processes": [{"pid": p, "kind": "test", "elapsed": "01:00:00",
                                       "cmd": "x"} for p in pids],
                        "filler": ["compressible " * 8] * pad}}


def t_store_endings_and_replay():
    from store import Store
    with tempfile.TemporaryDirectory() as d:
        st = Store(Path(d) / "t.db", retention_days=30)
        t0 = datetime.now(timezone.utc) - timedelta(minutes=10)
        iso = lambda k: (t0 + timedelta(minutes=k)).isoformat()

        st.ingest(_snap("h", iso(0), [1, 2, 3]))
        st.ingest(_snap("h", iso(1), [1, 3]))          # 2 ended
        st.ingest(_snap("h", iso(2), [1]))             # 3 ended
        st.ingest(_snap("h", iso(0.5), [1, 2, 3]))     # a spooled replay

        ends = st.endings(limit=50, within_hours=24)
        pids = sorted(e["pid"] for e in ends)
        assert pids == [2, 3], f"expected pids 2 and 3 to have ended, got {pids}"
        for e in ends:
            assert e["last_seen"] < e["noticed_at"], "an ending must be bracketed by two readings"
            assert e["ran_seconds"] == 3600, f"01:00:00 should parse to 3600s, got {e['ran_seconds']}"
        return "2 endings from 3 readings; a replayed snapshot added none"


def t_store_etime_parsing():
    import store
    for text, secs in [("45", None), ("01:30", 90), ("02:03:04", 7384), ("1-02:03:04", 93784)]:
        got = store.etime_seconds(text)
        assert got == secs, f"etime {text!r} -> {got}, expected {secs}"
    return "ps etime parses in all four shapes"


# ── the server ──────────────────────────────────────────────────────────

def t_server_end_to_end():
    import server as srv
    from store import Store

    with tempfile.TemporaryDirectory() as d:
        srv.store = Store(Path(d) / "t.db", retention_days=30)
        srv.KEY = "test-key-not-a-real-one"
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()

        from http.server import ThreadingHTTPServer
        httpd = ThreadingHTTPServer(("127.0.0.1", port), srv.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{port}"
        try:
            def post(body, key):
                r = urllib.request.Request(base + "/api/v1/ingest", data=json.dumps(body).encode(),
                                           method="POST",
                                           headers={"Content-Type": "application/json", "X-TokenHUD-Key": key})
                with urllib.request.urlopen(r, timeout=5) as resp:
                    return resp.status

            try:
                post(_snap("h", datetime.now(timezone.utc).isoformat(), [1]), "wrong-key")
                raise AssertionError("ingest accepted a wrong key")
            except urllib.error.HTTPError as e:
                assert e.code == 401, f"a wrong key should be 401, got {e.code}"

            now = datetime.now(timezone.utc)
            assert post(_snap("h", now.isoformat(), [1, 2], pad=40), srv.KEY) == 202
            assert post(_snap("h", (now + timedelta(seconds=30)).isoformat(), [1], pad=40), srv.KEY) == 202

            import gzip as gz
            # Small responses must NOT be compressed; large ones must be.
            with urllib.request.urlopen(
                    urllib.request.Request(base + "/healthz", headers={"Accept-Encoding": "gzip"}),
                    timeout=5) as resp:
                assert resp.headers.get("Content-Encoding") is None, \
                    "a two-byte response was gzipped, which costs more than it saves"

            req = urllib.request.Request(base + "/api/v1/overview", headers={"Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                assert resp.headers.get("Content-Encoding") == "gzip", "a large overview was not compressed"
                assert resp.headers.get("Vary") == "Accept-Encoding", "compressed responses must Vary"
                d2 = json.loads(gz.decompress(resp.read()))

            # ... and a client that does not ask for gzip must not get it.
            with urllib.request.urlopen(base + "/api/v1/overview", timeout=5) as resp:
                assert resp.headers.get("Content-Encoding") is None, "gzip was sent unasked"
                json.loads(resp.read())
            assert d2["hosts"][0]["status"] == "up", "a fresh reading should read as up"
            assert len(d2["endings"]) == 1 and d2["endings"][0]["pid"] == 2, \
                f"the server should have noticed pid 2 ending, got {d2['endings']}"
            return (f"401 on a bad key, 202 on a good one, gzip negotiated both ways, "
                    f"{len(d2['endings'])} ending seen")
        finally:
            httpd.shutdown()


def t_ingest_accepts_both_encodings():
    """The agent gzips its upload; anything older or hand-rolled does not."""
    import server as srv
    from store import Store
    import gzip as gz
    import socket as sock

    with tempfile.TemporaryDirectory() as d:
        srv.store = Store(Path(d) / "t.db", retention_days=30)
        srv.KEY = "test-key-not-a-real-one"
        s0 = sock.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
        from http.server import ThreadingHTTPServer
        httpd = ThreadingHTTPServer(("127.0.0.1", port), srv.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            now = datetime.now(timezone.utc)
            body = json.dumps(_snap("gz", now.isoformat(), [1], pad=40)).encode()

            r = urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/ingest",
                                       data=gz.compress(body), method="POST",
                                       headers={"Content-Type": "application/json",
                                                "Content-Encoding": "gzip",
                                                "X-TokenHUD-Key": srv.KEY})
            assert urllib.request.urlopen(r, timeout=5).status == 202, "gzipped ingest refused"

            plain = json.dumps(_snap("plain", now.isoformat(), [1])).encode()
            r2 = urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/ingest",
                                        data=plain, method="POST",
                                        headers={"Content-Type": "application/json",
                                                 "X-TokenHUD-Key": srv.KEY})
            assert urllib.request.urlopen(r2, timeout=5).status == 202, "plain ingest refused"

            hosts = {h["host"] for h in srv.store.hosts()}
            assert hosts == {"gz", "plain"}, f"both should have landed, got {hosts}"
            ratio = len(body) / len(gz.compress(body))
            return f"gzip and plain both accepted; upload compresses {ratio:.1f}x"
        finally:
            httpd.shutdown()


def t_stream_pushes():
    """The event stream must carry state on connect, then push on ingest.

    Read from a raw socket rather than http.client: its chunked reader
    blocks trying to fill the buffer, which is fine for a response that
    ends and wrong for one that never does. A browser's EventSource has no
    such problem, but the test has to speak the wire itself.
    """
    import server as srv
    from store import Store
    import socket as sock

    with tempfile.TemporaryDirectory() as d:
        srv.store = Store(Path(d) / "t.db", retention_days=30)
        srv.KEY = "test-key-not-a-real-one"
        srv.bus = srv.Broadcast()
        s0 = sock.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()

        from http.server import ThreadingHTTPServer
        httpd = ThreadingHTTPServer(("127.0.0.1", port), srv.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            now = datetime.now(timezone.utc)
            r = urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/ingest",
                                       data=json.dumps(_snap("h", now.isoformat(), [1])).encode(),
                                       method="POST",
                                       headers={"Content-Type": "application/json",
                                                "X-TokenHUD-Key": srv.KEY})
            urllib.request.urlopen(r, timeout=5).read()

            c = sock.create_connection(("127.0.0.1", port), timeout=10)
            c.sendall(b"GET /api/v1/stream HTTP/1.1\r\nHost: x\r\n\r\n")
            time.sleep(0.4)
            head = c.recv(65536)
            assert b"text/event-stream" in head, "the stream did not identify as SSE"
            assert b"chunked" in head, "a stream with no end needs chunked framing"
            assert b"event: reading" in head, "the stream sent no state on connect"

            # now ingest again and prove it arrives without being asked
            r2 = urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/ingest",
                                        data=json.dumps(_snap("h", (now + timedelta(seconds=30)).isoformat(), [1, 2])).encode(),
                                        method="POST",
                                        headers={"Content-Type": "application/json",
                                                 "X-TokenHUD-Key": srv.KEY})
            urllib.request.urlopen(r2, timeout=5).read()
            c.settimeout(5)
            pushed = c.recv(65536)
            assert b"event: reading" in pushed, "an ingest did not reach an open stream"
            c.close()
            return "state on connect, then pushed on ingest, chunked and framed"
        finally:
            httpd.shutdown()


def t_dashboard_is_self_contained():
    html = (ROOT / "web" / "index.html").read_text()
    for bad in ("https://", "http://cdn", "<script src=", "<link rel=\"stylesheet\""):
        assert bad not in html, f"the dashboard reaches outside itself: {bad!r}"
    ids = {}
    import re
    for m in re.finditer(r'\bid="([a-zA-Z0-9_-]+)"', html):
        ids[m.group(1)] = ids.get(m.group(1), 0) + 1
    dupes = {k: v for k, v in ids.items() if v > 1}
    # This one has bitten this file before: two elements claiming #live put
    # the running-process list inside a header button.
    assert not dupes, f"duplicate element ids: {dupes}"
    return f"no external references, {len(ids)} unique ids"


CHECKS = [
    ("pricing: the arithmetic", t_pricing_arithmetic),
    ("pricing: unknown models are not free", t_pricing_unknown_model_is_not_free),
    ("transcripts: incremental scan", t_transcript_scan),
    ("blocks: five hours means five hours", t_blocks_are_five_hours),
    ("limits: shape and no identity", t_limits_shape),
    ("limits: never writes ~/.claude.json", t_limits_never_writes),
    ("collectors: serialisable and quiet", t_collect_is_json_and_quiet),
    ("collectors: a broken source is not a dead host", t_collectors_never_raise),
    ("store: endings, and a replay adds none", t_store_endings_and_replay),
    ("store: ps etime parsing", t_store_etime_parsing),
    ("server: key, gzip, ingest, endings", t_server_end_to_end),
    ("server: ingest accepts gzip and plain", t_ingest_accepts_both_encodings),
    ("server: the event stream pushes", t_stream_pushes),
    ("dashboard: self-contained, unique ids", t_dashboard_is_self_contained),
]


def main():
    print(f"TokenHUD · self-test · python {sys.version.split()[0]}\n")
    for name, fn in CHECKS:
        check(name, fn)
        tag, n, note = results[-1]
        print(f"[{tag}] {n}" + (f"\n         {note}" if note else ""))
    bad = sum(1 for r in results if r[0] == FAIL)
    skipped = sum(1 for r in results if r[0] == SKIP)
    print(f"\n{len(results) - bad - skipped} passed · {skipped} skipped · {bad} failed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

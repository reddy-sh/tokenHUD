#!/usr/bin/env python3
"""
TOKENHUD agent — runs on a machine, reads it, ships it.

    TOKENHUD_SERVER=http://127.0.0.1:8787 TOKENHUD_KEY=... python3 agent/agent.py

The agent is the only thing that touches your machine. It knows nothing about
storage or the dashboard: it collects a snapshot, POSTs it, and forgets it.
That separation is the point — the server can move to another box, or five
laptops can report to one board, without a line of this file changing.

Standard library only, so it can run anywhere Python does with nothing
installed and nothing to keep patched.

Design notes worth keeping:

  · **It buffers.** A laptop that closes its lid mid-post must not lose the
    reading. Failed snapshots queue on disk (bounded) and go out with the next
    successful post, so a flaky network shows as a gap that fills in, not a
    hole that stays.

  · **It never crashes the loop.** Any exception in a cycle is logged and the
    loop continues. A monitoring agent that dies on the one day something goes
    wrong is worse than no agent.

  · **It sends no secrets.** Prompt text is opt-in (TOKENHUD_SEND_PROMPTS=1) and
    command lines are truncated. See collectors.py.
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collectors  # noqa: E402

SERVER = os.environ.get("TOKENHUD_SERVER", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("TOKENHUD_KEY", "")
INTERVAL = int(os.environ.get("TOKENHUD_INTERVAL", "30"))
ONCE = "--once" in sys.argv or os.environ.get("TOKENHUD_ONCE") == "1"
DRY = "--dry-run" in sys.argv

# TOKENHUD_STATE is the one directory the agent writes to: the spool below and
# the transcript index in transcripts.py. TOKENHUD_SPOOL still overrides the file.
STATE = Path(os.environ.get("TOKENHUD_STATE", Path.home() / ".tokenhud")).expanduser()
SPOOL = Path(os.environ.get("TOKENHUD_SPOOL", STATE / "spool.jsonl"))
SPOOL_MAX = 500          # snapshots; ~a few MB, bounded on purpose


def log(msg: str) -> None:
    # stderr, so `agent.py --dry-run | jq` is a pipeline and not a puzzle.
    print(f"{time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


def post(snapshot: dict) -> bool:
    raw = json.dumps(snapshot).encode()
    # Compress the UPLOAD, not just the download. A snapshot is ~65 KB of
    # highly repetitive JSON and gzips about 5:1. On loopback that is a
    # rounding error; over a network — which is where this is heading — it is
    # the difference between a rounding error and a bill. The server accepts
    # both, so an old agent talking to a new server still works.
    body = gzip.compress(raw, 6)
    headers = {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "X-TokenHUD-Key": KEY,
        "User-Agent": f"tokenhud-agent/{collectors.AGENT_VERSION}",
    }
    if len(body) >= len(raw):        # tiny payloads can grow; do not bother
        body, raw = raw, raw
        headers.pop("Content-Encoding")
    req = urllib.request.Request(
        f"{SERVER}/api/v1/ingest",
        data=body,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        # A 401 is a configuration mistake, not a blip — say so plainly rather
        # than spooling forever against a server that will never accept us.
        log(f"server refused: {e.code} {e.reason}")
        return False
    except Exception as e:
        log(f"post failed: {e}")
        return False


def spool_add(snapshot: dict) -> None:
    try:
        SPOOL.parent.mkdir(parents=True, exist_ok=True)
        rows = spool_read()
        rows.append(snapshot)
        rows = rows[-SPOOL_MAX:]
        SPOOL.write_text("".join(json.dumps(r) + "\n" for r in rows))
    except Exception as e:
        log(f"spool write failed: {e}")


def spool_read() -> list:
    rows = []
    try:
        with SPOOL.open() as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        continue
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"spool read failed: {e}")
    return rows


def spool_flush() -> None:
    rows = spool_read()
    if not rows:
        return
    log(f"flushing {len(rows)} buffered snapshot(s)")
    left = []
    for i, row in enumerate(rows):
        if not post(row):
            left = rows[i:]
            break
    try:
        if left:
            SPOOL.write_text("".join(json.dumps(r) + "\n" for r in left))
        else:
            SPOOL.unlink(missing_ok=True)
    except Exception:
        pass


def cycle() -> None:
    snap = collectors.collect()
    # The board schedules its next fetch from this. Only the agent knows how
    # often it reports, so only the agent can say it; without it a dashboard
    # has to guess a poll rate and is wrong in one of two directions — too
    # fast and it refetches an unchanged reading, too slow and it shows an
    # old one. Stamped per snapshot rather than sent once, so changing
    # TOKENHUD_INTERVAL takes effect on the next cycle.
    snap["intervalSeconds"] = INTERVAL
    if DRY:
        print(json.dumps(snap, indent=2))
        return
    if post(snap):
        spool_flush()
        m = snap["metrics"]
        log(f"sent · {len(m['processes'])} proc · {len(m['projects'])} projects")
    else:
        spool_add(snap)
        log("buffered (server unreachable)")


def main() -> None:
    if not DRY and not KEY:
        log("TOKENHUD_KEY is not set — the server will refuse this agent.")
        log("Generate one with: python3 server/server.py --new-key")
        sys.exit(2)

    log(f"tokenhud-agent {collectors.AGENT_VERSION} · host={collectors.host_id()}")
    if not DRY:
        log(f"server={SERVER} interval={INTERVAL}s")

    while True:
        try:
            cycle()
        except Exception as e:                      # never die on one bad cycle
            log(f"cycle error: {e}")
        if ONCE or DRY:
            return
        time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("stopped")

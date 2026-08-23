# tokenhud-server

Takes what agents send, keeps it, serves the board. One 2.05 MB binary with
SQLite compiled into it and nothing to install beside it.

```bash
./scripts/build.sh                       # builds this and the agent
./server/target/release/tokenhud-server --new-key    # once, into .env
./scripts/run.sh                         # starts both
```

## What it does

```text
POST /api/v1/ingest      an agent's snapshot            (key required)
GET  /api/v1/stream      server-sent events, pushed the instant a reading lands
GET  /api/v1/overview    latest reading for every host  (key optional)
GET  /api/v1/history     one host's recent snapshots
GET  /api/v1/endings     agents that stopped recently
GET  /                   the dashboard
```

Loopback by default, key required for writes, no CORS. Doing nothing is safe.
**Reads are open by default** so the dashboard needs no secret in the browser —
set `TOKENHUD_PROTECT_READS=1` to require the key on `GET` too, and read the
note in `main.rs` before binding anything other than `127.0.0.1`.

## It replaced a Python server

That server was the oracle while this one was written: a harness drove both
through the same sequence of state changes — ingest plain and gzipped, a derived
ending, a spooled replay that must add none, a history read that replays a
difference chain, the auth and error paths, the header contract, the event
stream raw and gzipped — and diffed every answer. It ended at 24 checks and zero
differing leaves. Then its ten checks moved into `tests/`, and it was removed.

**Porting those checks was not a formality.** `history_round_trips_through_the_chain`
failed on the first run: `serde_json`'s default parser is not correctly rounded,
so a cost of `1.1400000000000001` was stored and read back as `1.14`. Python's
`json` uses `strtod` and does not do this, so this store was quietly lossier
than the one it replaced. The `float_roundtrip` feature fixes it.

The conformance harness could never have found that. It compared two
implementations against each other; it never asked either whether it gave back
what it was given. That is the difference between a diff and a test, and it is
why the checks moved before the oracle went.

## Measured against the server it replaced

| | Python | this |
|---|---:|---:|
| ingest, 16 concurrent | 2,488 req/s | **5,402 req/s** |
| ingest, 64 concurrent | 2,398 req/s | **5,313 req/s** |
| overview, 64 concurrent | 7,040 req/s · p99 12.0 ms | **7,679 req/s · p99 10.2 ms** |
| idle RSS | 29.5 MB | **7.7 MB** |
| 1,000 event-stream watchers | **390 refused**, 606 served | **all 1,000 served** |
| ships as | assumed a `python3` | 2.05 MB binary |

The overview row is close because both served the same memoised bytes — that
cache was a 35× win and it predates the rewrite. Ingest is where the runtime
shows; the watcher row is where the architecture does.

**A watcher is not free.** ~31.8 KB of hyper buffers, and ~280 KB once it has
its own gzip context. `docs/ARCHITECTURE.md` §5 predicted 0.5 KB from a
prototype that did not compress. Per-connection compression, not the runtime,
is what sets the fan-out floor — which makes sending the 0.66 KB *difference* on
the wire the most valuable thing left in that document.

## Layout

| file | what it is |
|---|---|
| `src/store.rs` | SQLite: `hosts` (now) + `snapshots` (then, as differences) + `endings` |
| `src/board.rs` | the overview, and the cache that builds it once for everyone |
| `src/http.rs` | ingest, query, the event stream, the static dashboard |
| `src/main.rs` | configuration, `--new-key`, and the routing table |
| `tests/` | thirteen checks: the store on a real file, the server on a real socket |

Eight direct dependencies. `rusqlite` is `bundled`, so SQLite is compiled in
rather than linked from the system — one file with nothing beside it is the
point, and a version skew between two machines is what that rules out.

## Worth knowing if you change this

**Timestamps.** `store::iso` prints six decimal places when there are
microseconds and none when there are not, which is what Python's `isoformat()`
did. The database still holds rows written by that server; changing this makes
old and new rows sort differently.

**The stream is chunked on the outside and one deflate stream on the inside.**
`GzEncoder::flush()` is the Z_SYNC_FLUSH that ends a block without ending the
stream. Test it with `curl --compressed`: reading the socket by hand and feeding
those bytes to zlib decodes the chunk-size headers as payload and fails in a way
that looks like a server bug and is not.

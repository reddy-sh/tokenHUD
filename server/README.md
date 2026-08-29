# tokenhud-server

Takes what agents send, keeps it, and answers the API that the portal and any
other tooling read. One 2.2 MB binary with SQLite compiled into it and nothing
to install beside it.

```bash
./scripts/start-server.sh   # builds if it is stale, mints a key into .env, waits on /healthz
./scripts/start-agent.sh    # this machine starts reporting to it
./scripts/status.sh         # what is up, where, and what the store is holding
```

`start-server.sh` generates an ingest key the first time and writes it to `.env`
(mode 600), which is where the agent and the other scripts look for it.
`start-all.sh` runs server, agent and portal in that order - but the portal it
starts reads the cloud account you sign in to, not this server, so a self-host
uses the API directly.

## What it does

```text
POST /api/v1/ingest      an agent's snapshot            (key required)
GET  /api/v1/stream      server-sent events, pushed the instant a reading lands
GET  /api/v1/overview    latest reading for every host  (key optional)
GET  /api/v1/history     one host's recent snapshots
GET  /api/v1/endings     agents that stopped recently
GET  /healthz            liveness, no key
```

Plus the enrollment routes - how a machine comes to hold a key of its own:

```text
POST /api/v1/enroll/new         mint a one-shot link           (key required)
POST /api/v1/enroll             a new machine claims one       (the token is the credential)
GET  /api/v1/enroll/await       that machine polls for a decision
POST /api/v1/machines/decide    approve, deny, or revoke one   (key required)
POST /api/v1/stream-token       trade the key for a 60s stream token
```

And the share routes - how a leaderboard becomes a URL anyone can open:

```text
GET  /api/v1/share              every share this fleet has minted (key required)
POST /api/v1/share              mint one, or edit a live one      (key required)
POST /api/v1/share/revoke       take it private again             (key required)
GET  /api/v1/public/board?s=…   the shared leaderboard            (no key: the slug is one)
```

No dashboard ships in the binary any more: the board lives in the tokenhud.com
portal, and this server is the self-host API. Everything unrouted - `/`
included - is a JSON 404.

Every route, with its request shape and the public payload schema, is in
[docs/api.md](../docs/api.md); every environment variable is in
[docs/configuration.md](../docs/configuration.md).

## Enrolling a machine, without a UI

The portal signs into the cloud and shows that account's machines; it cannot
read this server. So self-host enrollment is two API calls of your own, with the
new machine's `enroll` in between. Mint a link:

```bash
curl -sX POST http://127.0.0.1:8787/api/v1/enroll/new \
  -H "X-TokenHUD-Key: $TOKENHUD_KEY"
# {"token":"…","code":"…","expiresAt":"…","ttlSeconds":900}
```

Give the new machine `<server-url>#<token>` and let it claim the link - it will
print a pairing code and wait:

```bash
tokenhud-agent enroll "http://127.0.0.1:8787#<token>"
```

Check that code against the one the mint returned, then approve by `installId`,
which `GET /api/v1/overview` lists for a caller holding the key:

```bash
curl -sX POST http://127.0.0.1:8787/api/v1/machines/decide \
  -H "X-TokenHUD-Key: $TOKENHUD_KEY" -H 'Content-Type: application/json' \
  -d '{"installId":"…","action":"approve"}'
```

The machine's next poll collects a key that is its alone, writes it to
`~/.tokenhud/machine.json`, and starts reporting in the same command. `"revoke"`
takes it back and shuts that one door.

## Sharing a leaderboard

`POST /api/v1/share` mints a slug. The slug is the whole credential - 96 bits of
the same randomness the ingest key uses - and `GET /api/v1/public/board?s=<slug>`
serves that board to anyone who has it, with no key and regardless of
`TOKENHUD_PROTECT_READS`: closing the private API to anonymous readers is a
different decision from publishing a link on purpose.

```bash
curl -sX POST http://127.0.0.1:8787/api/v1/share \
  -H "X-TokenHUD-Key: $TOKENHUD_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Engineering","identities":"alias"}'
# {"slug":"…","apiUrl":"http://127.0.0.1:8787","reachable":false}
```

What that URL carries is decided in exactly one place, `src/share.rs`, and it
is decided by **naming the fields that go out** rather than by deleting the
private ones from a reading. `reachable` is the server telling the truth about
itself: bound to `127.0.0.1` with no `TOKENHUD_PUBLIC_URL` set, a "public" link
works for the person who minted it and for nobody else.

Revoking is immediate and total - the board behind a link is computed from live
data on every request, so there is no rendered copy anywhere to keep serving. A
revoked slug and an invented one answer identically, which is what stops the
endpoint being a way to test slugs for existence.

Full detail - the field-by-field whitelist, the identity modes, the
three-machine rule on the hour curve - is in
[docs/sharing.md](../docs/sharing.md).

Loopback by default, key required for writes. Doing nothing is safe. CORS
exists, because the portal is a different origin, but only on the routes a
browser legitimately calls - the reads, the stream and its token, and the two
key-gated fleet actions. Ingest and the enrollment routes are agent-facing and
carry no CORS headers at all. **Reads are open by default** so tooling needs no
secret - set `TOKENHUD_PROTECT_READS=1` to require the key on `GET` too, and
read the note in `main.rs` before binding anything other than `127.0.0.1`.

## It replaced a Python server

That server was the oracle while this one was written: a harness drove both
through the same sequence of state changes - ingest plain and gzipped, a derived
ending, a spooled replay that must add none, a history read that replays a
difference chain, the auth and error paths, the header contract, the event
stream raw and gzipped - and diffed every answer. It ended at 24 checks and zero
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

The overview row is close because both served the same memoised bytes - that
cache was a 35× win and it predates the rewrite. Ingest is where the runtime
shows; the watcher row is where the architecture does.

**A watcher is not free.** ~31.8 KB of hyper buffers, and ~280 KB once it has
its own gzip context. `docs/ARCHITECTURE.md` §5 predicted 0.5 KB from a
prototype that did not compress. Per-connection compression, not the runtime,
is what sets the fan-out floor - which makes sending the 0.66 KB *difference* on
the wire the most valuable thing left in that document.

## Layout

| file | what it is |
|---|---|
| `src/store.rs` | SQLite: `hosts` (now) + `snapshots` (then, as differences) + `endings` |
| `src/board.rs` | the overview, and the cache that builds it once for everyone |
| `src/http.rs` | ingest, enrollment, query, the event stream |
| `src/lib.rs` | the routing table, and which routes a browser is allowed to call |
| `src/main.rs` | configuration, `--new-key`, and the listener |
| `tests/` | thirteen checks: the store on a real file, the server on a real socket |

Twelve direct dependencies. `rusqlite` is `bundled`, so SQLite is compiled in
rather than linked from the system - one file with nothing beside it is the
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

# Architecture

What TokenHUD is today, what the numbers say, and what has to change before it
is a thing many people use rather than a thing one person runs.

Everything quantified here was measured on the machine this was written on - an
Apple Silicon laptop, Python 3.14, loopback - against the real code and a real
database, not a model of one. Reproduce with `./scripts/run.sh selftest` and the
figures in [Measurements](#measurements).

---

## 1. Today: one machine

```
  ~/.claude ──► agent ──POST /api/v1/ingest──► server ──► SQLite
                                                 │
   browser ◄──── SSE /api/v1/stream ─────────────┘
```

Three processes, no dependencies, nothing leaves the machine. The agent reads
Claude Code's own files, prices what it finds, and posts a reading every ~37
seconds. The server keeps it and pushes it to whoever is watching. The board is
one HTML file with no external reference of any kind.

The design commitments that follow from *local-first* are worth stating plainly,
because every scaling decision downstream is constrained by them:

- **The agent must run with zero install.** Today that means Python, because
  macOS ships `python3` and a Node install is not a thing to ask of someone who
  wants to see their own token spend. Note the shape of that argument, though:
  what it actually demands is *nothing to install*, and a 0.9 MB binary
  satisfies it better than an interpreter the machine happens to have. That is
  §5.
- **Loopback by default, key required for writes.** Doing nothing is safe.
- **No prompt text ever leaves the agent.** See `SECURITY.md` for the per-path
  table of what is read and what is deliberately not.

---

## 2. Measurements

Ingest and read throughput, stdlib `ThreadingHTTPServer`, isolated database:

| | before | after | |
|---|---:|---:|---|
| `GET /api/v1/overview`, 1 client | 107 req/s · p50 9.4 ms | **3,762 req/s · p50 0.21 ms** | 35× |
| `GET /api/v1/overview`, 64 clients | 128 req/s · p50 200 ms | **3,343 req/s · p50 4.2 ms** | 26× |
| `POST /api/v1/ingest`, 64 clients | 1,179 req/s · p50 42 ms | **1,650 req/s · p50 28 ms** | 1.4× |
| SSE fan-out to 128 readers | 72 ms | **53 ms** | 1.4× |
| database after the same run | 17.3 MB | **0.3 MB** | 58× |

Storage, measured against 200 consecutive real readings:

| encoding | per reading | per host per 30 days |
|---|---:|---:|
| whole JSON text *(what it did)* | 61 KB | 4.38 GB |
| zlib per row | 13.4 KB | 0.96 GB |
| zlib with the previous reading as a dictionary | 13.1 KB | 0.94 GB |
| **structural difference + zlib** *(what it does)* | **0.66 KB** | **0.05 GB** |

The last row is the whole argument. A reading has 2,388 leaves and 59 of them
move between one reading and the next; storing the other 2,329 again, 2,300
times a day, was the largest single defect in the system and nobody would ever
have seen it on a dashboard.

The dictionary row is included because it is the obvious idea and it does not
work: zlib's window is 32 KB and a reading is 61 KB, so the dictionary cannot
reach the parts that repeat.

---

## 3. Differences: storage now, wire next

**Storage (shipped).** `snapshots` holds a keyframe every 60 rows and a
structural difference in between, each zlib-compressed. `history()` replays a
chain forward from its keyframe. Chains are bounded, so a lost row costs at most
one chain, and `prune()` cuts at a keyframe rather than at the cutoff so that
retention can never orphan the rows that survive it. Round-tripping is asserted
byte-for-byte in the self-test over 125 readings and three keyframes.

Three shapes and no others, which is what makes it reviewable:

```
{"v": x}                  this value is now x
{"o": {...}, "d": [...]}  a dict: these keys changed, these are gone
{"a": {"3": {...}}}       a list of the same length: these indices changed
```

A list whose length changed is replaced whole. Index-shifting a list of running
processes is the kind of clever that returns wrong data at 2 a.m.

**Wire (next).** The event stream still sends the entire 69 KB overview on every
reading. It is gzipped against a per-connection context so the second one is
cheap, but the server still builds, compresses, and writes the whole truth to
every watcher every time. The same difference machinery applied to the wire
makes an event 0.66 KB, and the client work drops from *parse 69 KB and rebuild*
to *apply 59 leaves*. That needs `patch()` in JavaScript and a sequence number
per connection so a client that misses one can ask for a keyframe instead of
silently diverging - which is exactly why it has not been done in the same
change as the storage: on the wire, a dropped difference is a correctness bug,
and in storage it is not.

Until then, `Board` (in `server/src/board.rs`) removes the part that scaled with the
audience: the overview is built and compressed once per reading and handed to
every reader, rather than once per reader. That is the 35× above.

---

## 4. Many people: what actually breaks

Today `host` is the primary key of the `hosts` table - globally. Two people with
a laptop called `MacBook-Pro` are the same row. Nothing else in the schema
prevents it, because nothing else needs to yet.

The identity model that does work is four levels, and it is worth writing down
before any of it is built:

```
account ──┬── device (a machine, one agent)
          │      └── agent process (a claude, a codex, a runner)
          │             └── session
          └── device ...
```

- An **account** is the unit of billing and of what a person sees when they log
  in. One person, many machines.
- A **device** is enrolled once and holds its own credential. Not a shared
  account key - a per-device key, so revoking a stolen laptop does not sign
  every other machine out. `host` becomes `(account_id, device_id)`, and the
  human-readable name becomes a label the user can change.
- An **agent process** is what is running on that device. A device may run
  several Claudes, a Codex, and a CI runner at once; today they are rows in one
  reading, and that is still right.
- A **session** already has a stable id from Claude Code's own transcripts.

The schema ports to Postgres unchanged apart from the key change; that was true
when it was written and it is still true.

**What the numbers say about the shape.** A million accounts at ~2 devices each,
one reading per 37 s, is ~54,000 readings/s. Ingest is embarrassingly parallel -
each reading concerns exactly one device and nothing cross-account is computed at
write time - so it shards by `account_id` with no coordination. Reads are the
interesting half: a person watching their own board is one watcher on one shard,
and the fan-out cost is per-watcher, not per-account. The tiers, then:

| tier | shape | what changes |
|---|---|---|
| **local** *(today)* | one process, SQLite, loopback | nothing |
| **team** | one server, Postgres, TLS, per-device keys | the key change above; auth |
| **cloud** | stateless ingest → queue → sharded store; separate push tier | fan-out stops being thread-per-reader |

The cloud tier's one genuinely new component is the push tier, because
thread-per-reader does not survive it. Everything else is the same program with a
different key and a different database behind it.

---

## 5. What language this should be in

Settled with measurements rather than around them. Three candidates were built
and run on this machine, not reasoned about: a minimal fan-out server in Go
(stdlib `net/http`) and in Rust (tokio), against the Python one that exists.

| | Python *(today)* | Go | Rust |
|---|---:|---:|---:|
| ships as | assumes a `python3` | 5.5 MB binary | **0.9 MB binary** |
| idle server RSS | 29.6 MB | 10.1 MB | **2.8 MB** |
| per idle watcher | ~57 KB | 27 KB | **0.5 KB** |
| 1,000 watchers | 317 refused, 677 served | all served | all served |
| 5,000 watchers | - | 140 MB | **5.2 MB** |
| agent RSS, right now | 24.4 MB | - | - |

**Correction, from building the real thing.** The 0.5 KB in that table was
measured on a prototype that wrote raw bytes. A server that actually implements
the event stream must compress it - an uncompressed 69 KB event to every watcher
is worse than the poll it replaces - and a deflate context is not free. Measured
on the finished Rust server at 1,000 concurrent watchers:

| | per watcher |
|---|---:|
| no `Accept-Encoding` | 31.8 KB - hyper's per-connection buffers |
| with per-connection gzip | **280 KB** - the zlib window, and it dominates |

So the fan-out advantage over Go is smaller than that table claims, and the
thing that actually decides fan-out cost is not the language at all: it is
whether each watcher needs its own compression context. Sending the 0.66 KB
*difference* instead of the 69 KB reading removes the need for one - which
turns §3's "wire next" from a bandwidth optimisation into the item that sets
the memory floor of the cloud tier. It is now the highest-value piece of work
in this document.

(Numbers above 1,000 watchers are not quoted: past that, this machine's memory
compressor starts reclaiming the idle buffers and RSS stops measuring what it
looks like it measures - one run reported a server using *less* than its own
idle footprint while holding 5,000 connections.)

Two things that table does not say, and both matter:

**CPU is not the reason to move.** A full collection takes 60 ms and happens
every 30 seconds - a 0.2% duty cycle. Nothing here is compute-bound and no
rewrite will make a reading arrive sooner. Anyone arguing for a rewrite on
speed has not measured this.

**Python's ceiling is architectural, not a knob.** It refuses connections at
500 concurrent watchers and a third of them at 1,000, and raising the listen
backlog from five to 128 (done - see the changelog) moved that number without
fixing it: a thread per reader cannot be spawned fast enough, and each one
costs a 512 KB stack. A hundred watchers is fine, which is the right answer
for a board one person opens in two tabs and the wrong one for a service.

### The choice: Rust

Not because it is faster - because of where this runs.

1. **The agent lives on someone's machine forever.** It is a monitoring tool;
   its own footprint is its credibility. 24.4 MB of interpreter to watch token
   spend is the number a user finds in Activity Monitor and holds against you.
   Rust is ~3 MB and a 0.9 MB binary that needs nothing installed - the same
   binary on their Mac and on the Linux boxes their agents run on.

2. **The menu bar app is Swift, and Rust links into it.** A static library over
   the C ABI: no runtime, no GC, no second process to supervise, code-sign and
   keep alive. Go inside a host process means either carrying the Go runtime
   in-process - a known bad time with signals and GC - or shipping a child
   daemon forever. That decision is made once and lived with.

3. **The fan-out tier is the one place the language was always going to
   matter** - though building it showed the margin is thinner than the prototype
   suggested, and that the real lever is the wire format rather than the
   runtime. See the correction above.

4. **One language from the menu bar to the edge.** Choosing Go means Go now and
   Rust later for the embed, or a child-process architecture permanently.

**What it costs, plainly.** Rust is slower to write and has a smaller pool of
drive-by contributors than Go - a real price for a public repository that wants
pull requests. Two things make it payable: the scope is small (read files,
parse JSON, SQLite, HTTP - no exotic lifetimes anywhere in that list), and the
Python implementation is an executable specification with seventeen checks the
Rust one has to pass too.

**When Go would have won.** If the near-term goal were the cloud tier and
nothing else, with a team that writes Python today, Go is the faster road and
the honest recommendation. It is not the near-term goal: the surface is a menu
bar app, and a menu bar app is Rust-shaped.

Swift stays for the UI shell, and `web/index.html` goes in a `WKWebView` on day
one rather than being rewritten as native views for no user-visible gain.

## 6. Getting there without breaking what works

The Python stack works, is seventeen checks green, and is running right now. A
rewrite buys footprint, distribution and fan-out - not one feature. So the
order matters more than the speed:

**Phase 0 - freeze the format.** Ship the wire differences in Python first
(§3), then write the ingest payload and the difference format down as a spec.
Rewriting a moving target means writing it twice; this is the only phase that
is genuinely urgent, and it is the cheapest.

**Phase 1 - the agent in Rust. Done.** `agent/` is a 1.94 MB binary at 6.5 MB
resident, against the Python agent's 24.4 MB. Conformance was not a matter of
opinion: both agents ran against a frozen copy of real transcripts and every
leaf of both payloads was compared, ending at 860 leaves and zero substantive
differences. The Python implementation has been removed; its eight machine
checks live in `agent/tests/machine.rs`.

Two defects worth remembering, because both were found by measuring rather than
by reading. Reading a transcript's first forty lines was reading the whole file,
and a transcript here passes 200 MB. And the scan allocated one buffer as large
as the whole per-cycle budget. Peak memory is now a property of a 4 MB constant
rather than of the largest transcript on the machine - which is the
*deterministic resource usage* half of §5's argument, and it had to be built
rather than inherited from the language.

**Phase 2 - the server in Rust.** Same schema, same endpoints, same difference
format, `rusqlite` under it. The Python server stays up as the oracle: ingest to
both, diff `/api/v1/overview` byte for byte until they agree - and keep the
oracle until its checks have moved, which is the order Phase 1 was done in and
the reason it could be finished in one sitting.

**Phase 3 - the menu bar app.** Swift shell, Rust core linked in, the existing
board in a web view.

**Phase 4 - the edge.** The same Rust server with Postgres and per-device keys
(§4). Nothing new to design by then.

Python remains the reference implementation for the *server* until Phase 2
agrees with it. Its self-test becomes that phase's conformance suite rather than
being thrown away - as the agent's did.

## 7. Known limits

- The board is pushed the whole overview per reading (§3). Storage is
  differences; the wire is not, yet.
- `MAX_STREAMS` defaults to 8. Past it the endpoint says so and the board falls
  back to polling. 128 was measured fine; the default is conservative because a
  held stream is a held thread.
- `hosts` is keyed by hostname alone (§4).
- The server refuses connections past roughly 500 concurrent watchers (§5).
  Fine for a local board, disqualifying for a service, and the reason §6 exists.
- Retention over-keeps by up to one chain - under an hour - by design, so that a
  prune can never orphan a difference.
- Everything above was measured on one machine. The shard arithmetic in §4 is
  arithmetic, not a load test, and is labelled as such.

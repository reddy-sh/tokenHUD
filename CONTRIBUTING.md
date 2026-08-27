# Contributing to TokenHUD

Thanks for looking. This document is short because the project is opinionated,
and the opinions save everyone time.

## Before you write code

**Open an issue first for anything non-trivial.** A rejected pull request is a
worse outcome for you than a five-minute conversation, and some things will be
rejected on principle no matter how well they are written - see below.

## The constraints that are not up for negotiation

These are the project's identity. A change that breaks one will not be merged,
however good it is otherwise.

1. **Metrics leave, content never does.** No collector may read prompt text,
   completion text, source code, or tool-call arguments into a payload. Not
   behind a flag, not filtered afterwards - never collected. If your feature
   needs content, it belongs in a different product.

   The same rule has a second edge on the sharing path. What a public board may
   carry is decided in one file, `server/src/share.rs`, by **naming the fields
   that go out** - never by deleting private ones from a reading. A field you
   add to the agent does not appear on a shared board until somebody lists it
   there deliberately, and that is the property to preserve. See
   [docs/sharing.md](docs/sharing.md).
2. **Dependencies are a test.** `cargo tree --depth 1` is printed in CI so a new
   one has to be noticed in review, and every path a collector opens is declared
   in `agent/src/manifest.rs` - the build fails otherwise.
   Someone should be able to clone this onto a machine they have not prepared
   and run it with the `python3` that shipped with the OS.
3. **The dashboard is one self-contained file.** `web/index.html` has no CDN
   reference, no build step, no framework, and no external font. The charts are
   hand-written SVG. A self-test enforces the no-external-references rule.
4. **An estimate is labelled an estimate.** Never present a calculation as a
   measurement. Every dollar figure on the board says it is estimated at API
   list prices, because the CLI reports `$0` on a subscription plan and
   inventing a number without saying so would be dishonest.
5. **A broken source is not a dead host.** Every collector swallows its own
   exceptions and returns partial data. "The disk collector is down" and "the
   host is down" are different facts and the board must be able to tell you
   which one happened.

## Adding a collector

One function in `agent/src/collect.rs` returning JSON-able data, one line in
`collect()`. Nothing else in the agent, the server, or the dashboard needs to
know it exists. The function must never raise.

## Running it

```bash
cp .env.example .env
./server/target/release/tokenhud-server --new-key   # paste into .env as TOKENHUD_KEY
./scripts/run.sh                      # both processes, detached
./scripts/run.sh selftest             # every test: 24 agent, 13 server
```

The tests must pass before you open a pull request. They run the real
collectors against your real machine, a real SQLite file in a temp directory,
and a real server on a throwaway port - it mocks nothing, so a pass means it
genuinely works here.

Checks that need `~/.claude` skip cleanly on a machine without it, so CI and a
fresh clone both behave.

## Style

Match the file you are editing. Two things this codebase does deliberately:

- **Comments explain why, not what.** If a line needs a comment saying what it
  does, rename something instead. The comments worth writing are the ones that
  stop the next person "fixing" a deliberate decision - there are several, and
  they say so.
- **Names are for readers.** `following` rather than `live` when three other
  things in the file already mean "live".

## Commits and pull requests

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). One
logical change per pull request. Say what you measured, if you changed anything
that claims to be faster - this project has a habit of putting numbers in the
README and they need to stay true.

## Licence

Contributions are accepted under the MIT licence, the same terms as the rest of
the project. There is no CLA.

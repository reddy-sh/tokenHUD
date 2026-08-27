# Project Rules

Rules for anyone working in this repository, human or otherwise. They are house
style, not suggestions. A change that breaks one of them will be sent back.

For what the project itself will not compromise on (metrics leave and content
never does, the share whitelist, honest estimates), see CONTRIBUTING.md. This
file is about how the work is written.

## No em dashes

Never use an em dash. Not in code, comments, documentation, UI strings, commit
messages, or anything else in this repository.

Use a comma, a full stop, a colon, brackets, or a plain hyphen instead. If none
of those fit, the sentence wants rewriting, and two short sentences almost always
beat one long one with a dash holding it together.

Avoid the en dash for the same reason unless it is a genuine numeric range.

Note that the section rules in comments (the long lines in headers like
`// -- the scan -----`) are box-drawing characters, not dashes. Leave them alone.

## Nothing hardcoded that should be derived

If a value can be read, computed, or configured, do that instead of typing it in.
A literal is a second source of truth, and the two drift.

Specifically, do not hardcode:

- **Counts of anything the code already knows.** The landing page once claimed
  9, 26, 4, 7 and 2 supported agents in five places on one page. The agent's
  catalogue in `agent/src/integrations.rs` is the source of truth. Derive from it.
- **Prices and rates.** They belong in `agent/src/pricing.rs`, dated, with the
  reasoning beside them. Never scatter a rate through a component.
- **URLs, hostnames and repository slugs.** One constant, imported.
- **Paths.** Resolve from a home directory or an environment variable.
- **Model names as a whitelist.** A list of models used to decide what is
  priceable silently drops every model released after it was written.
- **Magic numbers.** Window lengths, caps, thresholds, timeouts and TTLs get a
  named constant with a comment saying why that number and not another.
- **Sizes, timings and benchmark figures in prose.** If the README says the
  binary is 4.5 MB and the marketing page says 4 MB, one of them is already wrong.

Two values that must agree belong in one place that both read. If they genuinely
cannot share a definition, add a test that fails when they disagree.

## Commit messages

Plain, human language that explains what changed and why. Short sentences. The
reader should understand it without knowing the codebase.

Say the number, name the file, state the effect. Avoid "refactor", "leverage",
"surface" and similar. Prefer "we were adding them all up, so every number was
too big" to "corrected an aggregation defect".

Never add `Co-Authored-By` trailers for AI tools (Devin, Claude, Copilot, and so
on), and never add "Generated with" lines. Commits attribute the human developer
only.

## Tests

A test that asserts nothing is worse than no test, because it reports a
guarantee that does not exist. This repository has shipped three of those.

- Every test file must contain at least one assertion.
- A regression test must fail against the code before the fix. Check that it does.
- Never delete or weaken a test to make a suite pass.
- Pin anything environment-dependent that the CI environment would hide. A
  daylight-saving test passes in UTC whether the bug is fixed or not, so it sets
  its own timezone.

## Numbers must mean one thing

Never render a missing value as `0`. "Free", "no rate available" and "included in
a subscription" are three different facts, and `$0.00` for all three is the most
misleading thing a usage dashboard can print. Every cost carries its basis.

Never present an estimate as a measurement, and never put two figures side by
side that were counted over different populations.

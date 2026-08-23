## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem, not the patch. -->

## Checks

- [ ] `./scripts/run.sh selftest` passes
- [ ] No new third-party dependency (stdlib only, and no CDN in `web/index.html`)
- [ ] No collector reads prompt text, completion text, source code, or tool-call
      arguments into a payload
- [ ] Any new dollar figure is labelled as an estimate
- [ ] Any performance claim in the README is still true, or updated with what I measured

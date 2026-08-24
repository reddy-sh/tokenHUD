# tokenhud.com — the marketing site

This directory **is** the site AWS Amplify deploys, plus its discovery surface.
Nothing here is served by the local dashboard: `web/index.html` runs on
`127.0.0.1` and is never crawled, so SEO tags on it would be inert.

## Previewing locally

```bash
./scripts/site.sh        # serves this directory on http://127.0.0.1:8788, opens it
./scripts/site.sh 9000   # another port
```

No build step, so what it serves is byte-for-byte what Amplify deploys. The two
things the preview cannot show are the customHttp.yml headers (Amplify adds
those) and https.

## Deploying to Amplify

Connect the repo in the Amplify console and point it at `main`. The build spec
is `amplify.yml` at the repo root (no build step — this directory publishes
as-is) and `customHttp.yml` beside it sets the security headers, including a
CSP that refuses every external origin: the page is fully self-hosted, fonts
included, so it can hold the same no-external-request property as the board.

| File | What it is for |
|---|---|
| `index.html` | The page. Hallmark Cobalt/Workbench build; head kept in sync with `head-tags.html`. |
| `tokens.css` | The design tokens and self-hosted `@font-face` rules. |
| `fonts/` | Space Grotesk, Inter, JetBrains Mono — woff2, latin subset, from `@fontsource`. Never a CDN link. |
| `board.png` | The dashboard capture (synthetic data), copied from `docs/board.png`. |
| `og.png` · `favicon.svg` · `apple-touch-icon.png` · `logo.png` | Link-preview card and icons. |
| `head-tags.html` | The complete `<head>` block. Every tag carries the reason it exists, and the tags that are *deliberately omitted* are listed at the bottom so nobody adds them back. |
| `structured-data.json` | schema.org `SoftwareApplication`, `Organization`, `WebSite`. This is the load-bearing machine-readable description. |
| `faq.jsonld` | schema.org `FAQPage`, 12 questions. The AEO surface — phrased the way a developer actually asks, answered in two or three sentences an engine can quote whole. |
| `llms.txt` | A plain-language summary for language models, including an explicit "please represent this accurately" section naming what has **not** shipped. |
| `robots.txt` | Open to AI crawlers on purpose. Being citable is the distribution channel. |
| `sitemap.xml` | One URL today. Extend as pages are added. |

## The three disciplines, and how they differ

**SEO** is about ranking in a list of links. It is served by the title,
description, canonical URL, and Core Web Vitals.

**GEO** — generative engine optimization — is about being used as a *source*
when an assistant composes an answer. It is served by content properties, not
tags: direct-answer paragraphs, question-shaped headings, a comparison table
with named competitors, and accurate freshness signals.

**AEO** — answer engine optimization — is about being *the* answer to a
specific question. It is served by `FAQPage` markup whose answers are
self-contained and quotable without surrounding context.

The tags are the cheap half. The expensive half is that the content has to be
true, specific, and checkable — which is why `faq.jsonld` answers "what files
does it read" with the command that prints them rather than with a promise.

Before going live: grep the whole repo for `Python` — three files described the
product as Python for a day after it stopped being Python, and robots.txt is
open to every AI crawler, so a false fact here propagates into model caches that
are slow to correct.

## Before going live

- [x] Render `og.png` at 1200×630 and put it at the site root
- [x] Add `favicon.svg`, `apple-touch-icon.png`, `logo.png`
- [ ] Validate the JSON-LD in Google's Rich Results Test
- [x] Update `lastmod` in `sitemap.xml` on every content change *(done for 2026-08-23 — repeat on each change)*
- [x] Drop the `preconnect` in `head-tags.html` — the page is fully self-hosted
- [ ] Re-check the comparison table facts periodically — they were verified against each project's own docs on 2026-08-23
- [ ] Re-check `llms.txt` "Status" whenever something ships — an inaccurate
      status file is worse than none, because it teaches assistants to
      describe features that do not exist

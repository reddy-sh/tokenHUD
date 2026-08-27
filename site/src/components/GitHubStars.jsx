import { useEffect, useState } from 'react'
import { apiPublic } from '../lib/cloud'

/* The star count, in the nav, without lying about it.
 *
 * It reads /api/v1/stars rather than api.github.com, and that is not a
 * preference. The site's CSP names the origins this page may connect to and
 * GitHub is not one of them; widening it so a badge could read seventeen bytes
 * would widen it for every other script on the page. GitHub also allows sixty
 * unauthenticated calls an hour per address, which a page that asked on load
 * would spend on its own readers. So the Lambda asks once, caches, and this
 * asks the Lambda. It carries no credential and needs no session: a star count
 * is a public statistic and a widget that only appeared for signed-in visitors
 * would be pointless on a marketing page.
 *
 * ── the three states, and why they are three ──────────────────────────
 *
 * This repository has zero stars today. That makes zero a REAL VALUE and not a
 * stand-in for one, which rules out every shortcut this component would
 * otherwise be written with: `count || null`, `count ? render() : hide()`, a
 * `||` default. Each of those reports a repository nobody has starred yet as a
 * repository whose count is unknown, and those are different facts about the
 * world. So the count is narrowed with `typeof` and `Number.isFinite`, never
 * with truthiness, and zero renders as "0" like any other number.
 *
 *   loading   nothing known yet and a request in flight. A fixed-width block,
 *             so the number landing does not shove the nav's links sideways
 *             after the page has settled. The width is the container's, not
 *             the block's, so the skeleton and a four-digit count occupy the
 *             same space and the swap is invisible.
 *   a number  including zero.
 *   no value  the request failed and nothing was cached. The whole widget is
 *             removed. Rendering a star next to an em dash asks the reader to
 *             work out whether the repo has no stars or the site has no answer,
 *             which is a worse outcome than the absence of a badge nobody was
 *             promised.
 *
 * A cached value outranks a failure: a count from an hour ago is a true
 * statement about an hour ago, which is worth more than a gap. That is also
 * why the cache is written only on success - a failed load must never be able
 * to overwrite a good number with nothing.
 */

const REPO = 'https://github.com/reddy-sh/tokenhud'
const CACHE_KEY = 'tokenhud_stars'

/* Every localStorage access is wrapped, because the accessor itself throws in
   a browser set to block site data - not the read, the property lookup - and a
   nav that cannot render is a considerably worse bug than a missing badge. */
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { count } = JSON.parse(raw)
    return typeof count === 'number' && Number.isFinite(count) ? count : null
  } catch {
    return null
  }
}

function writeCache(count) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ count, at: new Date().toISOString() }))
  } catch {
    /* A browser that will not store this still shows the number it just
       fetched; only the next cold load is poorer for it. Nothing to do. */
  }
}

export default function GitHubStars() {
  /* number = a count we can show, null = we have none. Starting from the cache
     means a returning visitor sees the badge in its final size immediately. */
  const [count, setCount] = useState(readCache)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        /* `apiPublic` and not `api`: it attaches no credential and asks Cognito
           for nothing, which is the whole requirement. A badge that only
           appeared once you had signed in would be invisible to everybody this
           page is written for. It is a static import because App.jsx already
           puts lib/cloud on this page's critical path - it reads
           `cloudConfigured` from it to decide what the primary button says - so
           deferring it here would move nothing and only cost a round trip. */
        const data = await apiPublic('/api/v1/stars', { signal: ctrl.signal })
        const n = data?.count
        if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('no count in the response')
        setCount(n)
        setFailed(false)
        writeCache(n)
      } catch (e) {
        /* An abort is this component unmounting, not a failure - reporting it
           would hide the badge every time React's strict mode remounts. */
        if (e?.name === 'AbortError') return
        setFailed(true)
      }
    })()
    return () => ctrl.abort()
  }, [])

  const known = count !== null
  if (failed && !known) return null

  /* toLocaleString rather than the board's `full` helper: that module carries
     chart palettes and resize hooks this page has no other use for, and it
     coerces its argument with `|| 0`, which is the one thing this component
     must never do. By here the value is already a finite number. */
  return (
    <a
      href={`${REPO}/stargazers`}
      rel="noreferrer"
      aria-label={known
        ? `${count} ${count === 1 ? 'person has' : 'people have'} starred TokenHUD on GitHub`
        : 'Star TokenHUD on GitHub'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 .5l2.06 4.44 4.69.58-3.45 3.28.92 4.7L8 11.16 3.78 13.5l.92-4.7L1.25 5.52l4.69-.58L8 .5Z" />
      </svg>
      <span
        className="tnum"
        style={{ display: 'inline-block', minWidth: '2.5ch', textAlign: 'right' }}
      >
        {known ? count.toLocaleString('en-US') : (
          <span
            aria-hidden="true"
            style={{
              display: 'block',
              height: '0.7em',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-paper-3)',
            }}
          />
        )}
      </span>
    </a>
  )
}

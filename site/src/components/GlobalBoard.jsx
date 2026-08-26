import { useCallback, useEffect, useState } from 'react'
import { apiPublic, apiUrl, cloudConfigured } from '../lib/cloud'
import { rankBoard } from '../lib/leaderboard'
import { TipProvider } from './board/charts'
import Leaderboard, { LeaderboardTiles, ModelBoard } from './board/leaderboard'
import { ago } from './board/util'

/* The global leaderboard: a public page anybody can see.
 *
 * It reads `/api/v1/leaderboard` with no credential — the entries it gets back
 * are the accounts that opted in, aggregated and stripped of anything private
 * by `mergeEntries` on the write side. The ranking runs in the browser, same
 * as the private board, so switching metric or period costs no round trip.
 *
 * The page is at `#/leaderboard` and works whether the visitor is signed in
 * or not. It is the public surface of the opt-in toggle in the portal. */

function Shell({ children }) {
  return (
    <div className="pb">
      <div className="ambient" aria-hidden="true">
        <div className="bloom bloom--1" />
        <div className="bloom bloom--2" />
        <div className="grain" />
      </div>
      {children}
    </div>
  )
}

export default function GlobalBoard() {
  const [entries, setEntries] = useState(null)
  const [computedAt, setComputedAt] = useState(null)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (first) => {
    if (!first) setRefreshing(true)
    try {
      const data = await apiPublic('/api/v1/leaderboard')
      setEntries(data.entries || [])
      setComputedAt(data.computedAt || null)
      setError(null)
    } catch (e) {
      if (first) setError(e?.message || String(e))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load(true) }, [load])

  /* Slow poll — the board is cached for five minutes on the server and sixty
     seconds at the edge, so polling faster would read the same cache. */
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(false) }, 120_000)
    return () => clearInterval(t)
  }, [load])

  /* Follow the site's dark default. */
  useEffect(() => {
    document.documentElement.removeAttribute('data-theme')
  }, [])

  if (!cloudConfigured) {
    return (
      <Shell>
        <main className="pb-main pb-center">
          <div className="sh-offline">
            <div className="sh-offline-icon">!</div>
            <h2>Not deployed</h2>
            <p>This build has no cloud backend, so the global leaderboard is not available.</p>
            <div className="sh-offline-actions">
              <a className="btn btn--primary" href="/">Back to TokenHUD</a>
            </div>
          </div>
        </main>
      </Shell>
    )
  }

  if (error && !entries) {
    return (
      <Shell>
        <main className="pb-main pb-center">
          <div className="sh-offline">
            <div className="sh-offline-icon">!</div>
            <h2>Could not load the leaderboard</h2>
            <p>{error}</p>
            <div className="sh-offline-actions">
              <button className="btn btn--primary" onClick={() => load(true)}>Retry</button>
              <a className="btn btn--ghost" href="/">Back to TokenHUD</a>
            </div>
          </div>
        </main>
      </Shell>
    )
  }

  if (!entries) {
    return (
      <Shell>
        <main className="pb-main pb-center">
          <span className="bv-spinner" />
        </main>
      </Shell>
    )
  }

  return (
    <Shell>
      <main className="pb-main">
        <header className="pb-head">
          <div className="pb-head-row">
            <a className="nav__brand" href="/" title="TokenHUD">
              <span className="nav__brand-dot" />
              <span>Token<b>HUD</b></span>
            </a>
            <span className="pb-badge">global leaderboard</span>
          </div>
          <h1 className="pb-title">Global leaderboard</h1>
          <p className="pb-sub">
            {entries.length
              ? <>
                  {entries.length} account{entries.length === 1 ? '' : 's'} opted in — tokens,
                  models and daily activity across everyone who chose to be here.
                  Nothing here says what the work was about.
                </>
              : 'Nobody has opted in yet. Be the first — sign in and flip the switch.'}
          </p>
          {computedAt && (
            <p className="pb-meta">
              Updated {ago(computedAt)} ·{' '}
              <button className="pb-refresh" onClick={() => load(false)} disabled={refreshing}>
                {refreshing ? 'refreshing...' : 'refresh'}
              </button>
            </p>
          )}
        </header>

        {entries.length > 0 && (
          <>
            <LeaderboardTiles entries={entries} />

            <TipProvider>
              <section className="pb-section">
                <Leaderboard
                  entries={entries}
                  title="Global ranking"
                  note="Every opted-in account, ranked. Token counts and model names only — no machines, no projects, no prompts, no paths."
                  defaultMetric="tokens"
                  defaultPeriod="all"
                />
              </section>

              <section className="pb-section">
                <ModelBoard entries={entries} />
              </section>
            </TipProvider>
          </>
        )}

        <section className="pb-about">
          <h2>How this works</h2>
          <p>
            Every person here runs the TokenHUD agent on their machines. They signed in,
            chose a handle, and flipped a switch — that is all it takes to appear on this
            page. What you see is their aggregate: total tokens, the models they used, and
            a day-by-day count. Machine names, file paths, project names, prompt text, and
            plan limits are stripped before anything reaches this page.
          </p>
          <p className="pb-cta">
            <a className="btn btn--primary" href="/">Run this on your own machines</a>
          </p>
        </section>
      </main>
    </Shell>
  )
}

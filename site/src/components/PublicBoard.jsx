import { useCallback, useEffect, useState } from 'react'
import Demand from './admin/leaderboard/Demand'
import Live from './admin/leaderboard/Live'
import Models from './admin/leaderboard/Models'
import Standings from './admin/leaderboard/Standings'
import { TipProvider } from './board/charts'
import { LeaderboardTiles } from './board/leaderboard'
import { ago, clock } from './board/util'

/* A shared board: the page at the end of a public link.
 *
 * It talks to no backend of its own. The link carries the slug and the API to
 * read it from, it fetches that one endpoint with no credential - the same
 * request a stranger's browser makes - and renders what comes back. There is
 * no key here to leak because there is no key here at all.
 *
 * Everything on screen came through the whitelist in server/src/share.rs.
 * Whatever the agent collects, this page can only draw what that let out. */

/* `#/b/<slug>?api=<origin>` - the slug says which board, the api says where to
   ask. Both are needed: the site is static and the server is wherever the
   person sharing runs it. */
export function parseShareHash(hash) {
  const m = /^#\/b\/([A-Za-z0-9_-]{1,64})(?:\?(.*))?$/.exec(hash || '')
  if (!m) return null
  const params = new URLSearchParams(m[2] || '')
  const api = (params.get('api') || location.origin).replace(/\/+$/, '')
  /* A link is a thing people paste around; it must not be able to point the
     page at something that is not an http(s) origin. */
  if (!/^https?:\/\//i.test(api)) return null
  return { slug: m[1], api }
}

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

function Head({ board, api, onRefresh, refreshing }) {
  const share = board?.share || {}
  return (
    <header className="pb-head">
      <div className="pb-head-row">
        <a className="nav__brand" href="/" title="TokenHUD">
          <span className="nav__brand-dot" />
          <span>Token<b>HUD</b></span>
        </a>
        <span className="pb-badge">shared board · read only</span>
      </div>
      <h1 className="pb-title">{share.title || 'TokenHUD leaderboard'}</h1>
      <p className="pb-sub">
        {board
          ? <>
            A live leaderboard of AI coding work across {board.totals?.machines || 0} machine
            {board.totals?.machines === 1 ? '' : 's'} - tokens, models and daily activity.
            Nothing here says what the work was about.
          </>
          : 'Loading…'}
      </p>
      {board && (
        <p className="pb-meta">
          Read {clock(board.generatedAt)} · {' '}
          <button className="pb-refresh" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'refreshing…' : 'refresh'}
          </button>
          {' · '}
          <span className="pb-api" title={api}>{api.replace(/^https?:\/\//, '')}</span>
        </p>
      )}
    </header>
  )
}

function Gone({ reason }) {
  return (
    <Shell>
      <main className="pb-main pb-center">
        <div className="sh-offline">
          <div className="sh-offline-icon">!</div>
          <h2>{reason === 'notfound' ? 'This board is not shared any more' : 'Could not reach this board'}</h2>
          <p>
            {reason === 'notfound'
              ? 'The link was revoked, or it was never a link. Whoever sent it can make a new one from their dashboard.'
              : 'The server behind this link did not answer. It may be switched off, or only reachable from the network it runs on.'}
          </p>
          <div className="sh-offline-actions">
            <a className="btn btn--primary" href="/">What is TokenHUD?</a>
          </div>
        </div>
      </main>
    </Shell>
  )
}

export default function PublicBoard({ route }) {
  const { slug, api } = route
  const [board, setBoard] = useState(null)
  const [status, setStatus] = useState('loading')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async first => {
    if (!first) setRefreshing(true)
    try {
      const res = await fetch(`${api}/api/v1/public/board?s=${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 404) { setStatus('notfound'); return }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      setBoard(await res.json())
      setStatus('ok')
    } catch {
      /* A board that loaded once and then failed to refresh keeps showing what
         it has: a scoreboard going blank because one poll timed out is worse
         than a scoreboard a minute out of date. */
      setStatus(s => (s === 'ok' ? 'ok' : 'error'))
    } finally {
      setRefreshing(false)
    }
  }, [api, slug])

  useEffect(() => { load(true) }, [load])

  /* Slow poll. There is no stream here - an anonymous reader gets no token
     for one - and a leaderboard does not change by the second. */
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(false) }, 60000)
    return () => clearInterval(t)
  }, [load])

  /* The shared page follows the site's dark default rather than whatever
     theme the visitor's own dashboard is set to. */
  useEffect(() => {
    document.documentElement.removeAttribute('data-theme')
  }, [])

  if (status === 'loading') {
    return (
      <Shell>
        <main className="pb-main pb-center">
          <span className="bv-spinner" />
        </main>
      </Shell>
    )
  }
  if (status === 'notfound' || status === 'error') return <Gone reason={status} />

  const entries = board?.entries || []
  const stale = entries.every(e => e.status !== 'up')

  return (
    <Shell>
      <main className="pb-main">
        <Head board={board} api={api} onRefresh={() => load(false)} refreshing={refreshing} />

        <LeaderboardTiles entries={entries} />

        {/* Everything, stacked, with jump links. A shared board is read by
            somebody who did not choose to be here - hiding half of it behind
            tabs would be asking them to hunt. */}
        <nav className="pb-jump" aria-label="Sections">
          {[
            ['standings', 'Leaderboard'],
            ['live', 'Live'],
            ['models', 'Models'],
            ['demand', 'Demand'],
          ].map(([id, text]) => <a key={id} href={'#' + id}>{text}</a>)}
        </nav>

        <TipProvider>
          <section id="standings" className="pb-section">
            <Standings board={board} hero={false} />
            <p className="bv-note">
              {board.share?.identities === 'host'
                ? 'Machines appear under the names their owner gave them.'
                : 'Machine names are replaced with pseudonyms that exist only on this link - the same machine is called something else on any other shared board.'}
            </p>
          </section>

          <section id="live" className="pb-section"><Live board={board} /></section>
          <section id="models" className="pb-section"><Models board={board} /></section>
          <section id="demand" className="pb-section"><Demand board={board} /></section>
        </TipProvider>

        <section className="pb-about">
          <h2>What this board is</h2>
          <p>
            Every machine here runs the TokenHUD agent, which reads what the local AI coding
            tools already write to disk and reports it. This page is a filtered view of that:
            token counts, model names, and one row per day. Project names, file paths, prompt
            text, session titles, tool and MCP server names, and plan limits are not part of
            what a shared board carries - the server builds this payload by naming the fields
            that go out, so a field nobody listed simply does not appear.
          </p>
          <p className="bv-note">
            Estimated value is priced at API list rates
            {board.pricingAsOf ? ` as of ${board.pricingAsOf}` : ''} and is not a bill -
            most of these machines run on flat-rate plans. Codex tokens are counted but not
            priced. {board.windowDays} days of daily history travel with the board.
            {stale && ' No machine is reporting right now, so these are the last numbers each one sent.'}
          </p>
          <p className="pb-cta">
            <a className="btn btn--primary" href="/">Run this on your own machines</a>
            <span className="bv-sub">
              Local-first, self-hostable, and the last agent that reported here was
              {' '}{ago(entries[0]?.lastActive)}.
            </span>
          </p>
        </section>
      </main>
    </Shell>
  )
}

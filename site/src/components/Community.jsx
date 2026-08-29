import { useEffect, useState } from 'react'
import { apiPublic, cloudConfigured } from '../lib/cloud'
import { boardTotals, costBasisOf } from '../lib/demand'
import { MIN_PUBLIC_ENTRANTS, rankBoard, rankGroups } from '../lib/leaderboard'
import { Cost } from './board/leaderboard'
import { compact, full, SERIES, shortModel } from './board/util'

/* The public leaderboard, previewed on the landing page.
 *
 * ── the one rule this section is written around ───────────────────────
 *
 * It never draws a row it does not have. No skeleton table, no placeholder
 * names, no "-" where a number will go, no illustrative example with a note
 * underneath admitting it is illustrative. A marketing page whose product is
 * "our numbers are checkable" cannot open with a table of numbers that are
 * not, and a shimmer in the shape of ten rows is a promise that ten rows
 * exist. GlobalBoard.jsx set this precedent already: on a build with no cloud
 * backend it says so in a card rather than spinning forever, and its header
 * says "Nobody has opted in yet. Be the first" rather than showing an empty
 * grid. This follows it.
 *
 * So the section has one honest thing to say in each state, and renders
 * nothing at all in the states where it has none:
 *
 *   no backend      the section does not exist. There is no leaderboard to
 *                   preview and no link worth offering.
 *   still asking    nothing. The section appears when it has something; it is
 *                   below the fold and nobody is waiting on it.
 *   request failed  nothing. A stranger scrolling a marketing page does not
 *                   need our 502, and GlobalBoard offers a retry on a page
 *                   they actually asked for.
 *   nobody in yet   "be the first", in full, with the count that says so.
 *   a small field   the totals, and the honest reason the ranking is withheld.
 *   a real field    totals, three breakdowns, ten rows, and the way through.
 *
 * ── why a small field shows no names ──────────────────────────────────
 *
 * MIN_PUBLIC_ENTRANTS is not decoration and not this file's idea: the board
 * component enforces the same floor, for the reason written beside the
 * constant in shared/ranking.mjs - a public ranking of three people is three
 * people in a line, each of whom can work out exactly what the others did.
 * The gate has to be repeated here rather than inherited, because this section
 * ranks the entries itself to draw a ten-row table, and a gate that lives only
 * inside the component you chose not to use is not a gate. Aggregates are
 * fine below the floor and are shown: a token total across a field names
 * nobody. Anything per-entrant is not, and is withheld together.
 *
 * The data path is the same `apiPublic` the standalone page uses - no
 * credential, because this is public, and a signed-out visitor is the entire
 * audience for this section.
 */

const TOP_ROWS = 10
const TOP_GROUPS = 5

/* The board's own medal classes, by placing. */
const MEDAL = { 1: ' lb-rank--gold', 2: ' lb-rank--silver', 3: ' lb-rank--bronze' }

/* One entry's value, carrying the basis its own tools reported.
 *
 * `totals.estUSD` is a plain number even for an account nothing here can
 * price, because the sum of no dollars is zero - so the figure alone cannot
 * tell a Codex-only account from a quiet week, and printing "$0.00" for the
 * first would be the exact confusion this codebase refuses to make. The basis
 * can tell them apart, so it is derived and handed to `Cost` with the number.
 * This mirrors a private helper of the same name inside board/leaderboard.jsx;
 * it is four lines over an exported rule rather than a fifth export, and the
 * rule itself - `costBasisOf` - is shared, which is the part that matters. */
const entryCost = entry => {
  const costBasis = costBasisOf([entry])
  return {
    estUSD: entry?.totals?.estUSD,
    priced: costBasis != null && costBasis !== 'unpriced',
    costBasis,
  }
}

/* A share-of-leader bar, the same shape the board draws. Kept local because it
   is four lines and the board's version is wired to that board's row type. */
function Bar({ pct }) {
  /* A share of nothing draws nothing. The floor exists so that a real but tiny
     share is still visible as a mark rather than as an empty track, and it must
     not be applied to a zero - a sliver of colour under a row that contributed
     none of the total is the bar telling a different story from the number
     beside it. */
  const width = pct > 0 ? Math.max(2, pct) : 0
  return (
    <div className="lb-bar" aria-hidden="true">
      <div className="fill" style={{ width: `${width}%`, background: SERIES[0] }} />
    </div>
  )
}

function GroupCard({ title, note, rows, label }) {
  if (!rows.length) return null
  return (
    <div className="int-card">
      <h3>{title}</h3>
      <p>{note}</p>
      <ul className="detected-list" style={{ display: 'block' }}>
        {rows.map(r => (
          <li key={r.key} style={{ marginTop: 'var(--space-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-sm)' }}>
              <b>{label(r)}</b>
              <span className="tnum" style={{ color: 'var(--color-ink-2)' }}>{compact(r.tokens)}</span>
            </div>
            <Bar pct={r.pct} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function Community() {
  /* null = nothing to show yet, and that covers both "still asking" and
     "asked and failed". They render identically - as nothing - so they do not
     need to be told apart, and a marketing section with an error state is a
     marketing section that will one day show a stack trace to a stranger. */
  const [entries, setEntries] = useState(null)

  useEffect(() => {
    if (!cloudConfigured) return
    const ctrl = new AbortController()
    apiPublic('/api/v1/leaderboard', { signal: ctrl.signal })
      .then(data => setEntries(data?.entries || []))
      .catch(() => { /* Stay silent and stay hidden. */ })
    return () => ctrl.abort()
  }, [])

  if (!cloudConfigured || entries === null) return null

  const totals = boardTotals(entries)
  const models = new Set(entries.flatMap(e => (e.models || []).filter(m => m.tokens > 0).map(m => m.model)))
  const published = entries.length >= MIN_PUBLIC_ENTRANTS

  /* All time for the standing, because a landing page is read once and a
     seven-day window on a quiet week would rank half the field as "unranked".
     The movers card is the one thing that needs a window, so it gets its own. */
  const standing = published ? rankBoard(entries, { metric: 'tokens', period: 'all' }) : null
  const week = published ? rankBoard(entries, { metric: 'tokens', period: 'week' }) : null
  const apps = published ? rankGroups(entries, { by: 'app', metric: 'tokens' }) : null
  const byModel = published ? rankGroups(entries, { by: 'model', metric: 'tokens' }) : null

  /* Only entrants who actually climbed. A "mover" who did not move is a row
     with nothing in it, and padding the card to three would be inventing the
     movement the card is named after. */
  const movers = week
    ? week.rows.filter(r => r.move > 0).sort((a, b) => b.move - a.move).slice(0, 3)
    : []

  return (
    <section className="wrap section reveal" id="community">
      <div className="section__head">
        <h2>Everyone who chose to be counted.</h2>
        <p>
          A public board of accounts that flipped one switch. Token counts, model names and
          day-by-day activity - no machines, no projects, no paths, no prompts. Opting in is
          a toggle in the portal, and opting out is the same toggle.
        </p>
      </div>

      {entries.length === 0 ? (
        /* The honest empty state, and the reason there is no skeleton anywhere
           in this file. Nobody has opted in; saying so is a smaller thing to
           admit than a table of invented names would be to explain. */
        <div className="int-card">
          <h3>Nobody has opted in yet <span className="tag tag--soon">be the first</span></h3>
          <p>
            There is no board here because there is no field yet - not a board still loading,
            and not one we are drawing with example rows until somebody arrives. Install the
            agent, sign in, pick a handle and flip the switch, and this section fills with the
            first real numbers anybody has put on it.
          </p>
          <p style={{ marginTop: 'var(--space-lg)' }}>
            <a className="btn btn--ghost" href="#/leaderboard">Open the leaderboard</a>
          </p>
        </div>
      ) : (
        <>
          <div className="stats tnum" style={{ marginBottom: 'var(--space-2xl)' }}>
            <div>
              <div className="stat__value">{entries.length}</div>
              <div className="stat__label">
                account{entries.length === 1 ? '' : 's'} opted in
              </div>
            </div>
            <div>
              <div className="stat__value">{compact(totals.tokens)}</div>
              <div className="stat__label">tokens counted - {full(totals.tokens)} exactly</div>
            </div>
            <div>
              {/* Cost, not a formatted number: an unpriced field and a field
                  that spent nothing are different findings, and this is the
                  helper that already knows the difference. */}
              <div className="stat__value"><Cost row={totals} /></div>
              <div className="stat__label">estimated value at API list prices - never a bill</div>
            </div>
            <div>
              <div className="stat__value">{models.size}</div>
              <div className="stat__label">
                distinct models{models.size ? ` - ${[...models].slice(0, 2).map(shortModel).join(', ')}` : ''}
              </div>
            </div>
          </div>

          {!published ? (
            <div className="int-card">
              <h3>The ranking is not published yet <span className="tag tag--soon">opens at {MIN_PUBLIC_ENTRANTS}</span></h3>
              <p>
                {entries.length} account{entries.length === 1 ? ' has' : 's have'} opted in, and the
                ranking publishes at {MIN_PUBLIC_ENTRANTS}. A board this size is not a small
                leaderboard - a placing in a field of {entries.length} says more about who was on
                holiday than about anybody&rsquo;s week, and everyone in it could work out exactly
                what everyone else did. The totals above name nobody, so they are here; the
                names, the table and the movements are not.
              </p>
            </div>
          ) : (
            <>
              <div className="int-grid">
                <GroupCard
                  title="Top apps"
                  note="Which assistant the tokens went through, whatever model answered."
                  rows={apps.rows.slice(0, TOP_GROUPS)}
                  label={r => r.label}
                />
                <GroupCard
                  title="Top models"
                  note="Which model did the work, whichever app reached for it."
                  rows={byModel.rows.slice(0, TOP_GROUPS)}
                  label={r => shortModel(r.label)}
                />
                {movers.length > 0 && (
                  <div className="int-card">
                    <h3>Top movers</h3>
                    <p>Places climbed this week against the week before it.</p>
                    <ul className="detected-list" style={{ display: 'block' }}>
                      {movers.map(r => (
                        <li key={r.id} style={{ marginTop: 'var(--space-sm)', display: 'flex', justifyContent: 'space-between', gap: 'var(--space-sm)' }}>
                          <b>{r.name}</b>
                          <span className="lb-move lb-move--up">▲ {r.move}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="compare-scroller" tabIndex={0} role="region" aria-label="Leaderboard, top ten">
                <table className="compare">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Account</th>
                      <th>Tokens</th>
                      <th>Est. value</th>
                      <th>Active days</th>
                      <th>Share of the leader</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standing.rows.slice(0, TOP_ROWS).map(r => (
                      <tr key={r.id}>
                        <th scope="row">
                          {/* An entrant with nothing in the window is unranked
                              rather than last, and the dot says "no placing"
                              where a number would say "placed low". */}
                          <span className={`lb-rank${MEDAL[r.rank] || (r.rank == null ? ' lb-rank--off' : '')}`}>
                            {r.rank ?? '·'}
                          </span>
                        </th>
                        <td><span className="lb-name">{r.name}</span></td>
                        <td className="tnum">{compact(r.value)}</td>
                        <td className="tnum"><Cost row={entryCost(r.entry)} /></td>
                        <td className="tnum">{r.entry.totals?.activeDays ?? 0}</td>
                        <td><Bar pct={standing.rows[0]?.value ? (r.value / standing.rows[0].value) * 100 : 0} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p style={{ marginTop: 'var(--space-xl)' }}>
            <a className="btn btn--primary" href="#/leaderboard">
              <span>View full leaderboard</span>
              <span aria-hidden="true">→</span>
            </a>
          </p>
        </>
      )}
    </section>
  )
}

import { useMemo, useState } from 'react'
import {
  aggregateReport, boardTotals, dailyByModel, label, modelRollup, palette,
  NO_ENTRIES, pct, reportFilename, seriesNames, swing, toolRollup, trending, UNSPLIT,
} from '../../../lib/demand'
import { TREND } from '../../../lib/leaderboard'
import { Legend, StackedBarChart } from '../../board/charts'
import { Composition, Cost, Methodology } from '../../board/leaderboard'
import { Card, Empty } from '../../board/panels'
import { compact, full, shortModel, usd } from '../../board/util'

/* Models: which ones did the work, how that is changing, and what it costs.
 *
 * Four questions, in the order they get asked:
 *
 *   share    who is doing the work today
 *   reach    on how many machines - depth and breadth are different findings
 *            and a single "tokens" column hides which one you are looking at
 *   momentum who is taking work from whom, as share points against the week
 *            before, because "up 100%" on a small base says nothing
 *   cost     what a million output tokens actually costs once cache reads and
 *            writes are in the bill, which no rate card can tell you
 */

function Download({ board }) {
  const [done, setDone] = useState(false)
  const save = () => {
    const blob = new Blob([JSON.stringify(aggregateReport(board), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = reportFilename()
    a.click()
    URL.revokeObjectURL(url)
    setDone(true)
    setTimeout(() => setDone(false), 2500)
  }
  return (
    <button className="btn btn--ghost set-btn" onClick={save}
      title="The same aggregates as on this page, as JSON. No machine identities.">
      {done ? 'Downloaded' : 'Export aggregates'}
    </button>
  )
}

/* The basis-aware money cell moved to board/leaderboard.jsx as `Cost`. It was
   written here for the Assistants table, but four surfaces print money and one
   of them printing it differently is exactly the drift it exists to prevent -
   so there is one of it now, and this page imports it like everybody else. */

export default function Models({ board }) {
  const entries = board.entries || NO_ENTRIES
  const rows = useMemo(() => modelRollup(entries), [entries])
  const tools = useMemo(() => toolRollup(entries), [entries])
  const daily = useMemo(() => dailyByModel(entries, 30), [entries])
  const names = useMemo(() => seriesNames(daily), [daily])
  /* Keyed off the table's order, not the chart's, so a model is the same
     colour in the bar beside its name as it is in the stack below it. Two
     orderings mean two palettes, and then the eye has to do a join. */
  const colors = useMemo(
    () => palette([...rows.map(r => r.model), UNSPLIT]),
    [rows],
  )
  const trend = useMemo(() => trending(entries, TREND.days), [entries])

  /* `adm-page--stack` was in this className and is defined in no stylesheet, so
     the wrapper it was on did nothing at all. Deleted rather than replaced:
     the Card is the layout. */
  if (!rows.length) {
    return <Card warn>No machine has reported a model yet, so there is nothing to break down.</Card>
  }

  const totals = boardTotals(entries)
  const fleetCache = totals.input + totals.cacheRead > 0
    ? (totals.cacheRead / (totals.input + totals.cacheRead)) * 100
    : null
  const leader = rows[0]

  return (
    <>
      <section className="hero-band">
        <div className="hero-band-head">
          <div>
            <span className="hero-eyebrow">Models</span>
            <h1>{rows.length} model{rows.length === 1 ? '' : 's'} in use</h1>
            <p className="hero-lede">
              <b>{shortModel(leader.model)}</b> is doing {pct(leader.share)} of the work across{' '}
              {leader.machines} of {entries.length} machine{entries.length === 1 ? '' : 's'}.
              {fleetCache != null && <> {pct(fleetCache)} of everything read came from cache.</>}
            </p>
          </div>
          <Download board={board} />
        </div>
        {/* The four tiles that used to sit here were the composition, in four
            boxes, with the residual missing and reasoning silently absent. The
            bar below says the same thing in one shape and says what it cannot
            account for, so the tiles are now the facts the bar does not
            carry. */}
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="hero-stat-k">Tokens</div>
            <div className="hero-stat-v tnum">{compact(totals.tokens)}</div>
            <div className="hero-stat-d">{full(totals.tokens)}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Cache rate</div>
            <div className="hero-stat-v tnum">{pct(fleetCache)}</div>
            <div className="hero-stat-d">of everything read</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Est. value</div>
            <div className="hero-stat-v tnum"><Cost row={totals} /></div>
            <div className="hero-stat-d">{totals.priced ? 'at list prices · not billed' : 'no rate card for what ran here'}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Ranked for trend</div>
            <div className="hero-stat-v tnum">{trend.rows.length}/{trend.considered}</div>
            <div className="hero-stat-d">{TREND.floor}</div>
          </div>
        </div>

        <div style={{ marginTop: 'var(--space-lg)' }}><Composition totals={totals} /></div>
      </section>

      <Card
        title="Share of the fleet's work"
        note="Tokens say depth; machines say reach. A model one machine leans on is a preference - the same number spread across the fleet is a standard."
      >
        <div className="bv-table-scroll">
          <table className="bv-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="lb-c-bar">Share</th>
                <th className="lb-c-num tnum">Tokens</th>
                <th className="lb-c-num tnum">Output</th>
                <th className="lb-c-num tnum">Cache rate</th>
                <th className="lb-c-num tnum">Reach</th>
                <th className="lb-c-num tnum">Est. value</th>
                <th className="lb-c-num tnum">$/M output</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.model}>
                  <td>
                    <span className="lb-name">{shortModel(r.model)}</span>
                    <div className="lb-meta"><span className="lb-model">{r.tool}</span></div>
                  </td>
                  <td className="lb-c-bar">
                    <div className="lb-bar">
                      <div className="fill" style={{ width: Math.max(1, r.share) + '%', background: colors[r.model] || 'var(--color-rule-strong)' }} />
                    </div>
                    <div className="lb-tierbar"><span>{pct(r.share)}</span></div>
                  </td>
                  <td className="lb-c-num tnum" title={full(r.tokens)}>{compact(r.tokens)}</td>
                  <td className="lb-c-num tnum">{compact(r.output)}</td>
                  <td className="lb-c-num tnum">{pct(r.cacheRate)}</td>
                  <td className="lb-c-num tnum" title={`${r.machines} of ${entries.length} machines`}>
                    {r.machines}/{entries.length}
                  </td>
                  <td className="lb-c-num tnum">
                    <Cost row={{ ...r, costBasis: r.priced ? 'list_price' : 'unpriced' }} />
                  </td>
                  <td className="lb-c-num tnum">
                    {r.usdPerMOutput == null
                      ? <span className="lb-unpriced" title="No rate card for this model, so there is no realised price to divide.">not priced</span>
                      : usd(r.usdPerMOutput)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="bv-note" style={{ marginTop: 'var(--space-md)' }}>
          <b>$/M output</b> is the whole bill divided by the output tokens it produced - cache
          reads and writes included. It is the realised price of a million useful tokens on
          this workload, which is a different number from any rate card and usually a much
          smaller one. <b>Cache rate</b> is cache reads over everything read: high is a long
          session reusing its context, low is one rebuilding it every turn.
        </p>
      </Card>

      <Card
        title="Adoption, day by day"
        note="Thirty days of tokens, stacked by the model that spent them. A migration looks like one band giving way to another."
      >
        {daily.length < 2 && <Empty>Not enough days yet to draw a curve.</Empty>}
        {daily.length >= 2 && (
          <>
            <StackedBarChart
              rows={daily} names={names} colors={colors}
              ariaLabel="Tokens per day, stacked by model"
              totalLabel="all models"
            />
            <Legend items={names.map(nm => ({
              color: colors[nm],
              label: label(nm),
              value: compact(daily.reduce((a, d) => a + (d.by[nm] || 0), 0)),
            }))} />
            <p className="bv-note">
              Codex reports a day&rsquo;s tokens without saying which model spent them, so that
              share is stacked as <b>unattributed</b> rather than folded into a model that did
              not earn it. A chart that quietly rounded it away would be the kind of wrong that
              only shows up in somebody else&rsquo;s spreadsheet.
            </p>
          </>
        )}
      </Card>

      <section className="bv-panel bv-cols-2">
        {/* Trending, with the rule printed on it.
            The published formula is the whole point. A badge that says "+521%"
            and will not say what it divided by is asking to be believed; the
            floor is what stops a model that moved nine thousand tokens from
            topping a chart, and a floor nobody can see is not a floor, it is a
            claim about one. Rows below it keep their share in the table above
            and are counted here so their absence is explained. */}
        <Card
          title="Trending"
          note={`Share of the last ${TREND.days} days minus share of the ${TREND.days} before it, in share points. Not percentage change - going from 2% to 4% of a fleet is two points, and calling it +100% would be true and useless.`}
        >
          {trend.considered === 0 && <Empty>No two comparable weeks yet.</Empty>}
          {trend.considered > 0 && trend.rows.length === 0 && (
            <Empty>
              Nothing cleared the floor. All {trend.considered} model
              {trend.considered === 1 ? '' : 's'} that ran in the last {TREND.days} days moved
              less than {compact(TREND.minTokens)} tokens or held under {TREND.minSharePct}% of
              the window, and a swing measured off a baseline that small is a rounding error
              with a percentage sign on it.
            </Empty>
          )}
          {trend.rows.length > 0 && (
            <div className="bv-table-scroll">
              <table className="bv-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="lb-c-num tnum">Share now</th>
                    <th className="lb-c-num tnum">Was</th>
                    <th className="lb-c-num tnum">Swing</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.rows.map(m => (
                    <tr key={m.model}>
                      <td>
                        <span className="lb-name">{label(m.model)}</span>
                        <div className="lb-meta">{compact(m.now)} tokens this window</div>
                      </td>
                      <td className="lb-c-num tnum">{pct(m.shareNow)}</td>
                      <td className="lb-c-num tnum">{m.before > 0 ? pct(m.shareBefore) : '-'}</td>
                      <td className={'lb-c-num tnum ' + (m.swing > 0.05 ? 'lb-move--up' : m.swing < -0.05 ? 'lb-move--down' : '')}>
                        {swing(m.swing)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="bv-note" style={{ marginTop: 'var(--space-md)' }}>
            <b>Formula.</b> {TREND.formula}. <b>Floor.</b> A model is ranked here only if it
            moved at least {compact(TREND.minTokens)} tokens in the window <i>and</i> held at
            least {TREND.minSharePct}% of it. Either test alone has a hole: an absolute floor
            lets a large fleet promote what is still noise inside it, and a share floor lets a
            fleet with three days of history promote anything.
            {trend.held > 0 && (
              <> {trend.held} model{trend.held === 1 ? ' is' : 's are'} below the floor and
                {trend.held === 1 ? ' is' : ' are'} not ranked for movement - the share
                {trend.held === 1 ? ' is' : 's are'} still in the table above.</>
            )}
          </p>
        </Card>

        <Card title="Assistants" note="Which product the tokens went through, whatever model answered.">
          <div className="bv-table-scroll">
            <table className="bv-table">
              <thead>
                <tr>
                  <th>Assistant</th>
                  <th className="lb-c-bar">Share</th>
                  <th className="lb-c-num tnum">Tokens</th>
                  <th className="lb-c-num tnum">Est. value</th>
                  <th className="lb-c-num tnum">Sessions</th>
                </tr>
              </thead>
              <tbody>
                {tools.map(t => (
                  <tr key={t.id}>
                    <td><span className="lb-name">{t.name}</span></td>
                    <td className="lb-c-bar">
                      <div className="lb-bar">
                        <div className="fill" style={{ width: Math.max(1, t.share) + '%', background: 'var(--color-accent)' }} />
                      </div>
                      <div className="lb-tierbar"><span>{pct(t.share)}</span></div>
                    </td>
                    <td className="lb-c-num tnum">{compact(t.tokens)}</td>
                    <td className="lb-c-num tnum"><Cost row={t} /></td>
                    <td className="lb-c-num tnum">{compact(t.sessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <Methodology
        entries={entries}
        pricingAsOf={board.pricingAsOf}
        windowDays={board.windowDays}
      />
    </>
  )
}

import { useMemo, useState } from 'react'
import {
  aggregateReport, dailyByModel, label, modelMomentum, modelRollup, palette,
  NO_ENTRIES, pct, reportFilename, seriesNames, swing, toolRollup, UNSPLIT,
} from '../../../lib/demand'
import { Legend, StackedBarChart } from '../../board/charts'
import { Card, Empty } from '../../board/panels'
import { compact, full, shortModel, usd } from '../../board/util'

/* Models: which ones did the work, how that is changing, and what it costs.
 *
 * Four questions, in the order they get asked:
 *
 *   share    who is doing the work today
 *   reach    on how many machines — depth and breadth are different findings
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
  const momentum = useMemo(() => modelMomentum(entries, 7), [entries])

  if (!rows.length) {
    return (
      <div className="adm-page--stack">
        <Card warn>No machine has reported a model yet, so there is nothing to break down.</Card>
      </div>
    )
  }

  const totals = rows.reduce((a, r) => ({
    tokens: a.tokens + r.tokens, output: a.output + r.output,
    cacheRead: a.cacheRead + r.cacheRead, input: a.input + r.input,
    cacheWrite: a.cacheWrite + r.cacheWrite,
  }), { tokens: 0, output: 0, cacheRead: 0, input: 0, cacheWrite: 0 })
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
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="hero-stat-k">Output tokens</div>
            <div className="hero-stat-v tnum">{compact(totals.output)}</div>
            <div className="hero-stat-d">what was actually written</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Cache read</div>
            <div className="hero-stat-v tnum">{compact(totals.cacheRead)}</div>
            <div className="hero-stat-d">{fleetCache == null ? 'tokens' : `${pct(fleetCache)} of all reads`}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Cache written</div>
            <div className="hero-stat-v tnum">{compact(totals.cacheWrite)}</div>
            <div className="hero-stat-d">context put up for reuse</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Fresh input</div>
            <div className="hero-stat-v tnum">{compact(totals.input)}</div>
            <div className="hero-stat-d">never seen before</div>
          </div>
        </div>
      </section>

      <Card
        title="Share of the fleet's work"
        note="Tokens say depth; machines say reach. A model one machine leans on is a preference — the same number spread across the fleet is a standard."
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
                    {r.priced ? usd(r.estUSD) : <span className="lb-unpriced" title="This build's rate card covers Anthropic models only.">not priced</span>}
                  </td>
                  <td className="lb-c-num tnum">
                    {r.usdPerMOutput == null ? '—' : usd(r.usdPerMOutput)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="bv-note" style={{ marginTop: 'var(--space-md)' }}>
          <b>$/M output</b> is the whole bill divided by the output tokens it produced — cache
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
        <Card
          title="Momentum"
          note="The last seven days against the seven before, in share points. Not percentage change — going from 2% to 4% of a fleet is two points, and calling it +100% would be true and useless."
        >
          {momentum.length === 0 && <Empty>No two comparable weeks yet.</Empty>}
          {momentum.length > 0 && (
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
                  {momentum.map(m => (
                    <tr key={m.model}>
                      <td><span className="lb-name">{label(m.model)}</span></td>
                      <td className="lb-c-num tnum">{pct(m.shareNow)}</td>
                      <td className="lb-c-num tnum">{m.before > 0 ? pct(m.shareBefore) : '—'}</td>
                      <td className={'lb-c-num tnum ' + (m.swing > 0.05 ? 'lb-move--up' : m.swing < -0.05 ? 'lb-move--down' : '')}>
                        {swing(m.swing)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Assistants" note="Which product the tokens went through, whatever model answered.">
          <div className="bv-table-scroll">
            <table className="bv-table">
              <thead>
                <tr>
                  <th>Assistant</th>
                  <th className="lb-c-bar">Share</th>
                  <th className="lb-c-num tnum">Tokens</th>
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
                    <td className="lb-c-num tnum">{compact(t.sessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </>
  )
}

import { NO_ENTRIES, concentration, growth, pct } from '../../../lib/demand'
import Leaderboard from '../../board/leaderboard'
import { Card } from '../../board/panels'
import { compact, full, usd } from '../../board/util'

/* Standings: the ranking, and one paragraph of headline above it.
 *
 * The hero exists because a table answers "who" and nobody arrives asking
 * "who" — they arrive asking "how are we doing", and a column of numbers makes
 * you do that arithmetic yourself. So the hero does it: one big total, the
 * direction it is moving, and the one fact that most often explains the shape
 * of the table under it — how much of this is a single machine.
 */

function Stat({ k, v, d, tone }) {
  return (
    <div className={'hero-stat' + (tone ? ' hero-stat--' + tone : '')}>
      <div className="hero-stat-k">{k}</div>
      <div className="hero-stat-v tnum">{v}</div>
      {d && <div className="hero-stat-d">{d}</div>}
    </div>
  )
}

function Hero({ board, right }) {
  const entries = board.entries || NO_ENTRIES
  const tokens = entries.reduce((a, e) => a + (e.totals?.tokens || 0), 0)
  const value = entries.reduce((a, e) => a + (e.totals?.estUSD || 0), 0)
  const up = entries.filter(e => e.status === 'up').length
  const g = growth(entries, 'tokens', 7)
  const c = concentration(entries)
  const leader = entries.slice().sort((a, b) => (b.totals?.tokens || 0) - (a.totals?.tokens || 0))[0]
  const models = new Set(entries.flatMap(e => (e.models || []).filter(m => m.tokens > 0).map(m => m.model)))

  const trend = g.pct == null
    ? 'no earlier week to compare against'
    : `${g.pct >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(g.pct))}% against the seven days before`

  return (
    <section className="hero-band">
      <div className="hero-band-head">
        <div>
          <span className="hero-eyebrow">
            {entries.length} machine{entries.length === 1 ? '' : 's'} ·{' '}
            {up ? `${up} reporting now` : 'none reporting right now'}
          </span>
          <h1>{compact(tokens)} tokens</h1>
          <p className="hero-lede">
            {full(tokens)} across every assistant these machines run, worth about{' '}
            <b>{usd(value)}</b> at API list prices. Last seven days: {trend}.
          </p>
        </div>
        {right}
      </div>

      <div className="hero-stats">
        <Stat k="Last 7 days" v={compact(g.current)} d={g.pct == null ? 'tokens' : `tokens · ${g.pct >= 0 ? '+' : ''}${Math.round(g.pct)}%`}
          tone={g.pct == null ? null : g.pct >= 0 ? 'up' : 'down'} />
        <Stat k="Est. value" v={usd(value)} d="at list prices · not billed" />
        <Stat k="Models in use" v={String(models.size)} d={entries.length > 1 ? 'across the fleet' : 'on this machine'} />
        <Stat k="Leader" v={leader ? leader.name : '—'}
          d={leader ? `${compact(leader.totals?.tokens || 0)} · ${pct(c.top)} of the fleet` : ''} />
        {entries.length > 2 && (
          <Stat k="Top three" v={pct(c.topThree)}
            d={c.topThree > 85 ? 'most of the work sits with three machines' : 'of all tokens'} />
        )}
      </div>
    </section>
  )
}

/* `hero` is off on a shared board, which has its own headline above this and
   would otherwise say the same thing twice in a row. */
export default function Standings({ board, meId, right, hero = true }) {
  const entries = board.entries || NO_ENTRIES
  const c = concentration(entries)

  return (
    <>
      {hero && <Hero board={board} right={right} />}

      <Leaderboard
        entries={entries}
        meId={meId}
        title="Standings"
        note="Ranked live from the last reading each machine sent. Pick what to rank by, and over how long."
        defaultMetric="tokens"
        defaultPeriod="all"
      />

      {entries.length > 2 && (
        <Card
          title="How evenly the work is spread"
          note="An average taken over a fleet where one machine does most of the work is a number about that machine wearing the fleet's name."
        >
          <div className="bv-stats bv-tiles">
            <div className="bv-stat">
              <div className="bv-stat-label">Busiest machine</div>
              <div className="bv-stat-value tnum">{pct(c.top)}</div>
              <div className="bv-stat-sub">of all tokens</div>
            </div>
            <div className="bv-stat">
              <div className="bv-stat-label">Top three</div>
              <div className="bv-stat-value tnum">{pct(c.topThree)}</div>
              <div className="bv-stat-sub">of all tokens</div>
            </div>
            <div className="bv-stat">
              <div className="bv-stat-label">Spread</div>
              <div className="bv-stat-value tnum">{c.gini.toFixed(2)}</div>
              <div className="bv-stat-sub">0 even · 1 one machine</div>
            </div>
            <div className="bv-stat">
              <div className="bv-stat-label">Median machine</div>
              <div className="bv-stat-value tnum">{compact(c.median)}</div>
              <div className="bv-stat-sub">tokens, all time</div>
            </div>
          </div>
        </Card>
      )}
    </>
  )
}

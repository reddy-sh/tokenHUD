import { useMemo } from 'react'
import { NO_ENTRIES, boardTotals, concentration, dailyTotals, freshness, growth, pct } from '../../../lib/demand'
import { HourChart, StackedBarChart } from '../../board/charts'
import { Composition, Cost } from '../../board/leaderboard'
import { Card, Empty, MeterBar } from '../../board/panels'
import { compact, full, SERIES } from '../../board/util'

/* Demand: how much, when, and from whom.
 *
 * Models answers "which". This answers the shape of the load - the questions
 * you ask before deciding how much of something to have ready:
 *
 *   the trend        is this growing, and how fast
 *   the day          when the fleet actually works, as one curve
 *   the distribution whether that load is a team's habit or one machine's
 *
 * The hour curve is the one number on this board with a withholding rule.
 * Summed over a team it is a demand curve; over one or two machines it is a
 * person's day, and the server does not publish it below three machines.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function weekdayShape(entries, days = 56) {
  const acc = Array.from({ length: 7 }, () => 0)
  const seen = Array.from({ length: 7 }, () => new Set())
  const from = new Date(Date.now() - days * 86400e3)
  for (const e of entries || []) {
    for (const d of e.byDay || []) {
      const t = new Date(d.date + 'T12:00:00')
      if (!isFinite(t.getTime()) || t < from) continue
      acc[t.getDay()] += Number(d.tokens) || 0
      seen[t.getDay()].add(d.date)
    }
  }
  /* Per occurrence, not per weekday total: eight Mondays and five Sundays in
     the window would otherwise make Monday look busier than it is. */
  return acc.map((v, i) => ({ day: WEEKDAYS[i], value: seen[i].size ? v / seen[i].size : 0 }))
}

export default function Demand({ board }) {
  const entries = board.entries || NO_ENTRIES
  const daily = useMemo(() => dailyTotals(entries, 'tokens', 30), [entries])
  const sessions = useMemo(() => dailyTotals(entries, 'sessions', 30), [entries])
  const gTokens = useMemo(() => growth(entries, 'tokens', 7), [entries])
  const gSessions = useMemo(() => growth(entries, 'sessions', 7), [entries])
  const gSpend = useMemo(() => growth(entries, 'estUSD', 7), [entries])
  const c = useMemo(() => concentration(entries), [entries])
  const week = useMemo(() => weekdayShape(entries), [entries])
  const totals = useMemo(() => boardTotals(entries), [entries])
  const fresh = useMemo(() => freshness(entries), [entries])

  const bars = daily.map(d => ({ date: d.date, by: { tokens: d.value }, total: d.value }))
  const sessionBars = sessions.map(d => ({ date: d.date, by: { sessions: d.value }, total: d.value }))
  const busiest = week.slice().sort((a, b) => b.value - a.value)[0]
  const weekMax = Math.max(1, ...week.map(w => w.value))
  const hours = board.hours
  const withheld = !hours && (board.hoursMinMachines || 0) > 0

  const trend = g => (g.pct == null ? '-' : `${g.pct >= 0 ? '+' : ''}${Math.round(g.pct)}%`)

  return (
    <>
      <section className="hero-band">
        <div className="hero-band-head">
          <div>
            <span className="hero-eyebrow">Demand</span>
            <h1>{compact(gTokens.current)} tokens this week</h1>
            <p className="hero-lede">
              {gTokens.pct == null
                ? 'No earlier week to compare against yet.'
                : <>
                  {gTokens.pct >= 0 ? 'Up' : 'Down'} {Math.abs(Math.round(gTokens.pct))}% on the
                  seven days before, across {entries.length} machine{entries.length === 1 ? '' : 's'}.
                </>}
              {busiest && busiest.value > 0 && <> Busiest day of the week: <b>{busiest.day}</b>.</>}
              {/* The stamp is the newest bucket that can no longer change, not
                  the clock. Today's bucket is still filling, and a part-day
                  read against whole ones is how a fleet appears to fall off a
                  cliff every morning. */}
              {fresh.through
                ? <> Complete through <b>{fresh.through}</b>.</>
                : <> No complete day yet - every bucket here is still filling.</>}
            </p>
          </div>
        </div>
        <div className="hero-stats">
          <div className={'hero-stat' + (gTokens.pct == null ? '' : gTokens.pct >= 0 ? ' hero-stat--up' : ' hero-stat--down')}>
            <div className="hero-stat-k">Tokens · 7d</div>
            <div className="hero-stat-v tnum">{compact(gTokens.current)}</div>
            <div className="hero-stat-d">{trend(gTokens)} on the week before</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Sessions · 7d</div>
            <div className="hero-stat-v tnum">{compact(gSessions.current)}</div>
            <div className="hero-stat-d">{trend(gSessions)} on the week before</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Est. value · 7d</div>
            {/* A week in which nothing was priceable sums to zero dollars, and
                "$0.00" is a claim that the work was free. The basis the board
                carries is the only thing that can tell those apart. */}
            <div className="hero-stat-v tnum">
              <Cost row={{ estUSD: gSpend.current, priced: totals.priced, costBasis: totals.costBasis }} />
            </div>
            <div className="hero-stat-d">{totals.priced ? `${trend(gSpend)} on the week before` : 'no rate card for what ran here'}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Per machine</div>
            {/* An average over no machines is not zero, it is undefined - and
                a tile reading "0 tokens a week" on a board nobody has enrolled
                yet is a statement about a fleet that does not exist. */}
            <div className="hero-stat-v tnum">
              {entries.length ? compact(gTokens.current / entries.length) : '-'}
            </div>
            <div className="hero-stat-d">tokens a week, on average</div>
          </div>
        </div>
      </section>

      <section className="bv-panel bv-cols-2">
        <Card title="Tokens per day" note="Thirty days, every machine summed.">
          {daily.length < 2
            ? <Empty>Not enough days yet.</Empty>
            : <StackedBarChart rows={bars} names={['tokens']} colors={{ tokens: SERIES[0] }}
              ariaLabel="Tokens per day across the fleet" totalLabel="tokens" />}
          {/* The bars above are the only bare totals on this board, and they
              are bare because the daily series genuinely has no split in it -
              a day arrives as one number. The composition underneath is all
              time, and it is here so that nobody reads the height of a bar as
              a quantity of work: on most of these fleets the majority of it is
              the same context being read back. */}
          {totals.tokens > 0 && (
            <div style={{ marginTop: 'var(--space-md)' }}>
              <p className="bv-note">
                A day arrives as one number, so these bars carry no split. All time, across
                everything on this board, it breaks down like this:
              </p>
              <Composition totals={totals} note={false} />
            </div>
          )}
        </Card>
        <Card title="Sessions per day" note="How many distinct runs those tokens came from.">
          {sessions.length < 2
            ? <Empty>Not enough days yet.</Empty>
            : <StackedBarChart rows={sessionBars} names={['sessions']} colors={{ sessions: SERIES[1] }}
              ariaLabel="Sessions per day across the fleet" totalLabel="sessions" />}
        </Card>
      </section>

      <section className="bv-panel bv-cols-2">
        <Card
          title="When the fleet works"
          note="Sessions by hour of day, summed across every machine."
        >
          {withheld && (
            <Empty>
              Withheld. Summed over a team this is a demand curve; over one or two machines
              it is somebody&rsquo;s day, and no amount of renaming the row above it changes
              that. It appears once {board.hoursMinMachines} machines are reporting.
            </Empty>
          )}
          {!withheld && !hours && <Empty>No hour data yet.</Empty>}
          {!withheld && hours && (
            <>
              <HourChart hours={hours} />
              <p className="bv-note">
                Local time on each machine, added together - so a fleet spread across
                timezones flattens this curve rather than showing two peaks.
              </p>
            </>
          )}
        </Card>

        <Card title="Shape of the week" note="Average tokens per occurrence of each weekday, over the last eight weeks.">
          {!busiest || busiest.value === 0
            ? <Empty>Not enough days yet.</Empty>
            : (
              <div className="dem-week">
                {week.map(w => (
                  <div className="dem-week-row" key={w.day}>
                    <span className="dem-week-day">{w.day}</span>
                    <div className="lb-bar">
                      <div className="fill" style={{
                        width: Math.max(w.value > 0 ? 2 : 0, (w.value / weekMax) * 100) + '%',
                        background: w.day === busiest.day ? SERIES[0] : 'var(--color-rule-strong)',
                      }} />
                    </div>
                    <span className="tnum dem-week-val">{compact(w.value)}</span>
                  </div>
                ))}
              </div>
            )}
        </Card>
      </section>

      <Card
        title="Where the demand comes from"
        note="One bar per machine, all time. A fleet whose top machine is most of the bar is one person's habit wearing a team's name - and every per-machine average taken off it will be wrong."
      >
        {!entries.length && <Empty>No machine has reported yet.</Empty>}
        {entries.length > 0 && (
          <>
            <div className="bv-stats bv-tiles" style={{ marginBottom: 'var(--space-lg)' }}>
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
                <div className="bv-stat-label">Median</div>
                <div className="bv-stat-value tnum">{compact(c.median)}</div>
                <div className="bv-stat-sub">tokens per machine</div>
              </div>
            </div>
            {entries.slice(0, 12).map(e => {
              const top = entries[0]?.totals?.tokens || 1
              return (
                <MeterBar key={e.id}
                  pct={((e.totals?.tokens || 0) / top) * 100}
                  color={SERIES[0]}
                  label={e.name}
                  right={compact(e.totals?.tokens || 0)}
                  note={`${full(e.totals?.sessions || 0)} sessions · ${e.totals?.activeDays || 0} active days`}
                />
              )
            })}
            {entries.length > 12 && (
              <p className="bv-note">…and {entries.length - 12} more machines.</p>
            )}
          </>
        )}
      </Card>
    </>
  )
}

import { useMemo, useState } from 'react'
import { METRICS, PERIODS, rankBoard } from '../../lib/leaderboard'
import { Card, Empty, Pill } from './panels'
import { ago, compact, full, SERIES, shortModel, usd } from './util'

/* The leaderboard — the same component on the private board and on a shared
 * one, because they are handed the same shape (see lib/leaderboard.js).
 *
 * It is a scoreboard, so it is built like one: a podium for the top three, a
 * ranked table under it, and one number per row that everything else explains.
 * The comparison is the product — a column of totals nobody is ranked against
 * is just the overview panel again. */

const fmt = (metric, v) => (metric.unit === 'usd' ? usd(v) : compact(v))

/* ── segmented control ──────────────────────────────────────────────── */

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="lb-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          className={'lb-seg-b' + (o.key === value ? ' on' : '')}
          aria-pressed={o.key === value}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── sparkline ──────────────────────────────────────────────────────────
 *
 * Thirty days of the ranked metric, whatever window is being ranked. A bar
 * chart of "today" is one bar; the shape is what says whether a number is a
 * habit or a spike. */

function Spark({ values, tone }) {
  const vals = values || []
  if (vals.length < 2) return <span className="lb-spark lb-spark--none" />
  const top = Math.max(...vals, 1)
  const w = 4
  const gap = 1
  return (
    <svg className="lb-spark" viewBox={`0 0 ${vals.length * (w + gap)} 24`} preserveAspectRatio="none"
      role="img" aria-label={`${vals.length} days of activity`}>
      {vals.map((v, i) => {
        const h = Math.max(v > 0 ? 1.5 : 0, (v / top) * 22)
        return <rect key={i} x={i * (w + gap)} y={24 - h} width={w} height={h} rx="1" fill={tone} />
      })}
    </svg>
  )
}

/* ── medals and movement ────────────────────────────────────────────── */

const MEDAL = { 1: 'gold', 2: 'silver', 3: 'bronze' }

function Rank({ rank }) {
  if (rank == null) return <span className="lb-rank lb-rank--off" title="Nothing in this window">—</span>
  const medal = MEDAL[rank]
  return <span className={'lb-rank' + (medal ? ' lb-rank--' + medal : '')}>{rank}</span>
}

function Move({ move, period }) {
  if (move == null) return <span className="lb-move lb-move--flat" title="Not ranked in the previous window">·</span>
  if (move === 0) return <span className="lb-move lb-move--flat" title="Same place as the window before">–</span>
  const up = move > 0
  return (
    <span className={'lb-move ' + (up ? 'lb-move--up' : 'lb-move--down')}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(move)} against the ${period.days}-day window before this one`}>
      {up ? '▲' : '▼'}{Math.abs(move)}
    </span>
  )
}

/* A flame, drawn rather than typed: the Move column already owns arrows, and
   two different meanings behind one glyph is how a table stops being read. */
const Flame = () => (
  <svg className="lb-flame" viewBox="0 0 12 14" aria-hidden="true">
    <path d="M6 0.5c2.6 2.6 4.5 4.6 4.5 7.2A4.5 4.5 0 0 1 6 13.5 4.5 4.5 0 0 1 1.5 7.7C1.5 5.8 2.6 4.4 4 3c.2 1.3.8 2.1 1.6 2.5.6-1.6.6-3.4.4-5z" />
  </svg>
)

function Streak({ streak }) {
  if (!streak || !streak.current) return <span className="lb-streak lb-streak--off">—</span>
  return (
    <span className="lb-streak" title={`Longest run: ${streak.longest} days`}>
      <Flame />{streak.current}d
    </span>
  )
}

/* ── tier ───────────────────────────────────────────────────────────── */

export function TierChip({ tier }) {
  return <span className={'lb-tier lb-tier--' + tier.tier.key}>{tier.tier.name}</span>
}

function TierBar({ tier }) {
  if (!tier.next) {
    return <div className="lb-tierbar lb-tierbar--max"><span>Top tier</span></div>
  }
  return (
    <div className="lb-tierbar" title={`${compact(tier.remaining)} more tokens to ${tier.next.name}`}>
      <div className="track"><div className="fill" style={{ width: tier.pct + '%' }} /></div>
      <span>{compact(tier.remaining)} to {tier.next.name}</span>
    </div>
  )
}

/* ── podium ─────────────────────────────────────────────────────────── */

function Podium({ rows, metric, meId }) {
  /* Only machines that scored. A podium step under somebody who did nothing
     in this window is not a placing, it is a spare plinth. */
  const top = rows.filter(r => r.rank != null && r.rank <= 3)
  if (top.length < 3) return null
  /* Second, first, third — the order a podium is actually built in. */
  const order = [top[1], top[0], top[2]]
  return (
    <div className="lb-podium">
      {order.map(r => (
        <div key={r.id}
          className={'lb-pod lb-pod--' + MEDAL[r.rank] + (r.id === meId ? ' lb-pod--me' : '')}>
          <div className="lb-pod-medal">{r.rank}</div>
          <div className="lb-pod-name">{r.name}</div>
          <div className="lb-pod-value tnum">{fmt(metric, r.value)}</div>
          <TierChip tier={r.tier} />
          <div className="lb-pod-step" />
        </div>
      ))}
    </div>
  )
}

/* ── a row's models, as chips ───────────────────────────────────────── */

function Models({ models }) {
  const top = (models || []).filter(m => m.tokens > 0).slice(0, 3)
  if (!top.length) return <span className="lb-models lb-models--none">—</span>
  const rest = (models || []).filter(m => m.tokens > 0).length - top.length
  return (
    <span className="lb-models">
      {top.map(m => (
        <span key={m.tool + m.model} className="lb-model" title={`${full(m.tokens)} tokens on ${m.model}`}>
          {shortModel(m.model)}
        </span>
      ))}
      {rest > 0 && <span className="lb-model lb-model--more">+{rest}</span>}
    </span>
  )
}

/* ── the card ───────────────────────────────────────────────────────── */

export default function Leaderboard({
  entries, meId, right, note, title = 'Leaderboard',
  defaultMetric = 'tokens', defaultPeriod = 'week',
}) {
  const [metric, setMetric] = useState(defaultMetric)
  const [period, setPeriod] = useState(defaultPeriod)
  const board = useMemo(
    () => rankBoard(entries, { metric, period, now: Date.now() }),
    [entries, metric, period],
  )
  const rows = board.rows
  const me = rows.find(r => r.id === meId)

  return (
    <Card
      title={title}
      note={note ?? 'Every machine reporting to this board, ranked. Token counts and model names only — no projects, no prompts, no paths.'}
      right={right}
    >
      <div className="lb-controls">
        <Segmented label="Rank by" options={METRICS} value={metric} onChange={setMetric} />
        <Segmented label="Over" options={PERIODS} value={period} onChange={setPeriod} />
      </div>

      {!rows.length && (
        <Empty>
          No machine has reported yet. The leaderboard fills in as agents check in — one
          row per machine, ranked by whatever you pick above.
        </Empty>
      )}

      {rows.length > 0 && (
        <p className="lb-summary">
          <b className="tnum">{fmt(board.metric, board.total)}</b> {board.metric.label.toLowerCase()}
          {' '}across {rows.length} machine{rows.length === 1 ? '' : 's'}
          {' '}{board.period.phrase}
          {me && me.rank != null && rows.length > 1 && (
            <> · you are <b>#{me.rank}</b> of {board.ranked}</>
          )}
          . <span className="lb-metric-note">{board.metric.note}</span>
        </p>
      )}

      <Podium rows={rows} metric={board.metric} meId={meId} />

      {rows.length > 0 && (
        <div className="bv-table-scroll">
          <table className="bv-table lb-table">
            <thead>
              <tr>
                <th className="lb-c-rank">#</th>
                <th>Machine</th>
                <th className="lb-c-tier">Tier</th>
                <th className="lb-c-bar">{board.metric.label}</th>
                <th className="lb-c-num tnum">{board.period.days ? board.period.label : 'All time'}</th>
                <th className="lb-c-spark">30 days</th>
                <th className="lb-c-streak">Streak</th>
                {board.period.days > 0 && <th className="lb-c-move">Move</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={r.id === meId ? 'lb-me' : undefined}>
                  <td className="lb-c-rank"><Rank rank={r.rank} /></td>
                  <td>
                    <div className="lb-who">
                      <span className={'sh-dot sh-dot--' + (r.entry.status === 'up' ? 'ok' : r.entry.status === 'stale' ? 'warn' : 'off')} />
                      <span className="lb-name">{r.name}</span>
                      {r.id === meId && <span className="lb-you">you</span>}
                    </div>
                    <div className="lb-meta">
                      <Models models={r.entry.models} />
                      {r.entry.os && <span className="lb-os">{r.entry.os === 'Darwin' ? 'macOS' : r.entry.os}</span>}
                      {r.entry.lastActive && <span title={r.entry.lastActive}>{ago(r.entry.lastActive)}</span>}
                    </div>
                  </td>
                  <td className="lb-c-tier">
                    <TierChip tier={r.tier} />
                    <TierBar tier={r.tier} />
                  </td>
                  <td className="lb-c-bar">
                    <div className="lb-bar">
                      <div className="fill" style={{
                        width: Math.max(r.value > 0 ? 2 : 0, r.pct) + '%',
                        background: r.rank && r.rank <= 3 ? SERIES[0] : 'var(--color-rule-strong)',
                      }} />
                    </div>
                  </td>
                  <td className="lb-c-num tnum">{fmt(board.metric, r.value)}</td>
                  <td className="lb-c-spark"><Spark values={r.spark} tone={r.rank && r.rank <= 3 ? SERIES[0] : 'var(--color-ink-3)'} /></td>
                  <td className="lb-c-streak"><Streak streak={r.streak} /></td>
                  {board.period.days > 0 && (
                    <td className="lb-c-move"><Move move={r.move} period={board.period} /></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 1 && (
        <p className="bv-note lb-solo">
          One machine is reporting, so there is nobody to be ahead of yet. Enroll another
          machine, or share this board — a shared link is how the comparison stops being
          with yourself.
        </p>
      )}

      {rows.length > 0 && (
        <p className="bv-note lb-foot">
          Value is estimated at API list prices and is not what anyone was charged.
          Codex tokens are counted but not priced by this build, so a Codex-heavy
          machine ranks fairly on tokens and low on value.
          {' '}Tiers are all-time tokens: {' '}
          {['Rookie', 'Builder', 'Operator', 'Veteran', 'Master', 'Legend'].join(' · ')}.
        </p>
      )}
    </Card>
  )
}

/* The row of tiles a board opens with — the fleet at a glance, before anybody
   scrolls into the ranking. Totals are summed here rather than read from the
   payload, because the private board has no payload to read them from and two
   ways of adding the same column up is one way too many. */
export function LeaderboardTiles({ entries: rows }) {
  const entries = rows || []
  const tokens = entries.reduce((n, e) => n + (e.totals?.tokens || 0), 0)
  const usdTotal = entries.reduce((n, e) => n + (e.totals?.estUSD || 0), 0)
  const models = new Set(entries.flatMap(e => (e.models || []).filter(m => m.tokens > 0).map(m => m.model)))
  const active = entries.filter(e => e.status === 'up').length
  const busiest = entries.slice().sort((a, b) => (b.totals?.tokens || 0) - (a.totals?.tokens || 0))[0]

  const tiles = [
    { k: 'Machines', v: String(entries.length), d: active ? `${active} reporting now` : 'none reporting right now' },
    { k: 'Tokens', v: compact(tokens), d: full(tokens) },
    { k: 'Est. value', v: usd(usdTotal), d: 'at API list prices · not billed' },
    { k: 'Models', v: String(models.size), d: [...models].slice(0, 2).map(shortModel).join(', ') || '—' },
    /* A name, not a number — it needs the smaller face, or one long pseudonym
       wraps to three lines and drags the whole row down with it. */
    { k: 'Leader', v: busiest ? busiest.name : '—', word: true, d: busiest ? compact(busiest.totals?.tokens || 0) + ' tokens' : '' },
  ]
  return (
    <div className="bv-stats bv-tiles">
      {tiles.map(t => (
        <div className="bv-stat" key={t.k}>
          <div className="bv-stat-label">{t.k}</div>
          <div className={'bv-stat-value' + (t.word ? ' lb-stat-word' : ' tnum')}>{t.v}</div>
          <div className="bv-stat-sub">{t.d}</div>
        </div>
      ))}
    </div>
  )
}

/* Which models did the work, across everyone on the board. Public by design:
   model names are the part of this the person sharing asked to be visible. */
export function ModelBoard({ entries }) {
  const rows = useMemo(() => {
    const by = new Map()
    for (const e of entries || []) {
      for (const m of e.models || []) {
        if (!m.tokens) continue
        const k = m.model
        const r = by.get(k) || { model: k, tool: m.tool, tokens: 0, output: 0, estUSD: 0, priced: false, machines: 0 }
        r.tokens += m.tokens
        r.output += m.output || 0
        r.estUSD += m.estUSD || 0
        r.priced = r.priced || !!m.priced
        r.machines += 1
        by.set(k, r)
      }
    }
    return [...by.values()].sort((a, b) => b.tokens - a.tokens)
  }, [entries])

  if (!rows.length) return null
  const top = rows[0].tokens || 1

  return (
    <Card title="Models" note="Every model this board ran, and how much of the work it did.">
      <div className="bv-table-scroll">
        <table className="bv-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="lb-c-bar">Share</th>
              <th className="lb-c-num tnum">Tokens</th>
              <th className="lb-c-num tnum">Output</th>
              <th className="lb-c-num tnum">Est. value</th>
              <th className="lb-c-num tnum">Machines</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.model}>
                <td>
                  <span className="lb-name">{shortModel(r.model)}</span>
                  <div className="lb-meta"><Pill tone={r.tool === 'codex' ? '' : 'ok'}>{r.tool}</Pill></div>
                </td>
                <td className="lb-c-bar">
                  <div className="lb-bar">
                    <div className="fill" style={{ width: (r.tokens / top) * 100 + '%', background: SERIES[0] }} />
                  </div>
                </td>
                <td className="lb-c-num tnum">{compact(r.tokens)}</td>
                <td className="lb-c-num tnum">{compact(r.output)}</td>
                <td className="lb-c-num tnum">{r.priced ? usd(r.estUSD) : <span className="lb-unpriced" title="This build's rate card covers Anthropic models only.">not priced</span>}</td>
                <td className="lb-c-num tnum">{r.machines}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

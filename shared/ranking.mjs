/* The ranking, shared by every surface that shows one.
 *
 * This module moved out of site/src/lib/leaderboard.js so that the browser and
 * the cloud API rank by the same code rather than two copies that drift. The
 * private board ranks the machines one account owns; the public board ranks
 * accounts against each other; both call `rankBoard` on entries of the shape
 * `profileOf` produces (shared/profile.mjs). Nothing here touches the network,
 * the DOM, or AWS — it is arithmetic over entries, which is what makes it
 * runnable in a Lambda and testable without either.
 *
 * Same discipline as amplify/functions/api/protocol.ts: a contract that has to
 * agree in more than one place lives in one file.
 */

/* ── tiers ──────────────────────────────────────────────────────────────
 *
 * A rank tells you where you came; a tier tells you what that means. The
 * thresholds are decades of tokens, because that is how this number actually
 * moves — a week of heavy agent work is not 20% more than a light one, it is
 * ten times. Linear bands would put everybody in the same one. */

export const TIERS = [
  { key: 'rookie', name: 'Rookie', min: 0 },
  { key: 'builder', name: 'Builder', min: 1e7 },
  { key: 'operator', name: 'Operator', min: 1e8 },
  { key: 'veteran', name: 'Veteran', min: 1e9 },
  { key: 'master', name: 'Master', min: 1e10 },
  { key: 'legend', name: 'Legend', min: 1e11 },
]

export function tierOf(tokens) {
  const n = Number(tokens) || 0
  let out = TIERS[0]
  for (const t of TIERS) if (n >= t.min) out = t
  return out
}

/* How far into the current tier, and what it takes to leave it. Both boards
   show this as a bar, and a bar needs a top as well as a bottom. */
export function tierProgress(tokens) {
  const n = Math.max(0, Number(tokens) || 0)
  const tier = tierOf(n)
  const next = TIERS[TIERS.indexOf(tier) + 1] || null
  if (!next) return { tier, next: null, pct: 100, remaining: 0 }
  const floor = Math.max(tier.min, 1)
  /* Log scale, to match the thresholds. On a linear one every row sits at
     the left edge of its band until the day it jumps. */
  const span = Math.log10(next.min) - Math.log10(floor)
  const at = Math.log10(Math.max(n, floor)) - Math.log10(floor)
  return {
    tier,
    next,
    pct: span > 0 ? Math.max(0, Math.min(100, (at / span) * 100)) : 0,
    remaining: Math.max(0, next.min - n),
  }
}

/* ── metrics ────────────────────────────────────────────────────────────
 *
 * `of` reads an all-time total; `ofDay` reads one row of the daily series.
 * A metric needs both, because ranking a window means summing days and
 * ranking all time means trusting the total — the daily series is capped at
 * 90 days and would quietly under-count anyone older than that. */

export const METRICS = [
  {
    key: 'tokens',
    label: 'Tokens',
    unit: 'count',
    note: 'Every token that moved: input, output, and cache reads and writes.',
    of: e => e.totals?.tokens || 0,
    ofDay: d => d.tokens || 0,
  },
  {
    key: 'spend',
    label: 'Est. value',
    unit: 'usd',
    note: 'What this work would have cost at API list prices. Not a bill.',
    of: e => e.totals?.estUSD || 0,
    ofDay: d => d.estUSD || 0,
  },
  {
    key: 'sessions',
    label: 'Sessions',
    unit: 'count',
    note: 'Distinct runs across every assistant that reports them.',
    of: e => e.totals?.sessions || 0,
    ofDay: d => d.sessions || 0,
  },
  {
    key: 'toolCalls',
    label: 'Tool calls',
    unit: 'count',
    note: 'Reads, edits, commands — every tool an assistant actually invoked.',
    of: e => e.totals?.toolCalls || 0,
    ofDay: d => d.toolCalls || 0,
  },
  {
    key: 'days',
    label: 'Active days',
    unit: 'count',
    note: 'Days with any token on them. The one metric volume cannot buy.',
    of: e => e.totals?.activeDays || 0,
    ofDay: d => ((d.tokens || 0) > 0 ? 1 : 0),
  },
]

export const metricOf = key => METRICS.find(m => m.key === key) || METRICS[0]

/* `phrase` exists so a sentence can be built without gluing the label into
   one: "in the last today" is what happens when a label is asked to be a
   preposition as well. */
export const PERIODS = [
  { key: 'day', label: 'Today', phrase: 'today', days: 1 },
  { key: 'week', label: '7 days', phrase: 'in the last 7 days', days: 7 },
  { key: 'month', label: '30 days', phrase: 'in the last 30 days', days: 30 },
  { key: 'all', label: 'All time', phrase: 'all time', days: 0 },
]

export const periodOf = key => PERIODS.find(p => p.key === key) || PERIODS[1]

/* ── dates ──────────────────────────────────────────────────────────────
 *
 * The agent files a day under the local date it happened on, so the windows
 * here are local days too. Comparing local keys as strings is exact and needs
 * no timezone arithmetic — which is the point, because timezone arithmetic on
 * a leaderboard is how somebody loses a streak at midnight. */

export function dateKey(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const shiftDays = (now, n) => dateKey(new Date(now - n * 86400e3))

/* ── streaks ────────────────────────────────────────────────────────────
 *
 * Consecutive days with work on them. Today not having started yet must not
 * break a streak — at 9 a.m. nobody has done anything — so counting begins at
 * today when today has work and at yesterday when it does not. */

export function streakOf(byDay, now = Date.now()) {
  const worked = new Set((byDay || []).filter(d => (d.tokens || 0) > 0).map(d => d.date))
  if (!worked.size) return { current: 0, longest: 0 }

  let current = 0
  const start = worked.has(shiftDays(now, 0)) ? 0 : worked.has(shiftDays(now, 1)) ? 1 : -1
  if (start >= 0) {
    for (let i = start; worked.has(shiftDays(now, i)); i++) current++
  }

  const dates = [...worked].sort()
  let longest = 0
  let run = 0
  let prev = null
  for (const d of dates) {
    const t = Date.parse(d + 'T00:00:00')
    run = prev != null && t - prev === 86400e3 ? run + 1 : 1
    prev = t
    if (run > longest) longest = run
  }
  return { current, longest }
}

/* ── ranking ────────────────────────────────────────────────────────────  */

function windowSum(entry, metric, days, now) {
  if (!days) return metric.of(entry)
  const from = shiftDays(now, days - 1)
  let n = 0
  for (const d of entry.byDay || []) if (d.date >= from) n += metric.ofDay(d)
  return n
}

/* The same sum over the window BEFORE this one, which is what turns a rank
   into a movement. Only meaningful for a bounded period: "all time" has no
   previous, and pretending otherwise would draw arrows that mean nothing. */
function priorSum(entry, metric, days, now) {
  const from = shiftDays(now, days * 2 - 1)
  const to = shiftDays(now, days)
  let n = 0
  for (const d of entry.byDay || []) if (d.date >= from && d.date < to) n += metric.ofDay(d)
  return n
}

function rankMap(entries, score) {
  const order = entries
    .map(e => ({ id: e.id, v: score(e) }))
    .sort((a, b) => b.v - a.v)
  const out = new Map()
  order.forEach((r, i) => out.set(r.id, r.v > 0 ? i + 1 : null))
  return out
}

/* The board, ranked.
 *
 * Rows come back in rank order with everything a table needs and nothing it
 * has to recompute per render: the value, the share of the leader's value,
 * a sparkline series, the movement against the previous window, and the tier.
 *
 * A zero scores no rank at all rather than a joint last place. Three machines
 * that did nothing today are not tied for third — they are simply not on the
 * board yet, and saying so is more useful than a podium of zeroes. */
export function rankBoard(entries, { metric = 'tokens', period = 'week', now = Date.now() } = {}) {
  const m = metricOf(metric)
  const p = periodOf(period)
  const list = entries || []

  const value = e => windowSum(e, m, p.days, now)
  const ranks = rankMap(list, value)
  const before = p.days ? rankMap(list, e => priorSum(e, m, p.days, now)) : null

  /* The sparkline always shows a month, whatever window is being ranked:
     a bar chart of "today" is one bar, and the shape is the interesting part. */
  const sparkFrom = shiftDays(now, 29)

  const rows = list
    .map(e => {
      const v = value(e)
      const was = before ? before.get(e.id) : null
      const at = ranks.get(e.id)
      return {
        entry: e,
        id: e.id,
        name: e.name,
        value: v,
        rank: at,
        /* Positive is upward: from rank 5 to rank 2 is +3. */
        move: at != null && was != null ? was - at : null,
        spark: (e.byDay || []).filter(d => d.date >= sparkFrom).map(d => m.ofDay(d)),
        streak: streakOf(e.byDay, now),
        tier: tierProgress(e.totals?.tokens || 0),
      }
    })
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return (b.entry.totals?.tokens || 0) - (a.entry.totals?.tokens || 0)
      if (a.rank == null) return 1
      if (b.rank == null) return -1
      return a.rank - b.rank
    })

  const top = rows.length ? Math.max(...rows.map(r => r.value)) : 0
  for (const r of rows) r.pct = top > 0 ? (r.value / top) * 100 : 0

  return {
    metric: m,
    period: p,
    rows,
    total: rows.reduce((n, r) => n + r.value, 0),
    ranked: rows.filter(r => r.rank != null).length,
  }
}

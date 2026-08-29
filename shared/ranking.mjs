/* The ranking, shared by every surface that shows one.
 *
 * This module moved out of site/src/lib/leaderboard.js so that the browser and
 * the cloud API rank by the same code rather than two copies that drift. The
 * private board ranks the machines one account owns; the public board ranks
 * accounts against each other; both call `rankBoard` on entries of the shape
 * `profileOf` produces (shared/profile.mjs). Nothing here touches the network,
 * the DOM, or AWS - it is arithmetic over entries, which is what makes it
 * runnable in a Lambda and testable without either.
 *
 * Same discipline as amplify/functions/api/protocol.ts: a contract that has to
 * agree in more than one place lives in one file.
 */

/* ── two different units ────────────────────────────────────────────────
 *
 * `rankBoard` is handed either a list of MACHINES one account owns or a list
 * of ACCOUNTS that opted into the public board, and the two are not the same
 * product. Ranking your own laptops against each other is analytics: useful,
 * private, and nobody wins it. Ranking accounts against each other is a
 * leaderboard: it is a competition, so it gets the medals - and, because a
 * competition with two entrants is not one, it also gets a floor.
 *
 * The unit is not something a caller has to remember to pass, because it is
 * already in the data: `mergeEntries` gives an account entry a COUNT of the
 * machines it collapsed, and a machine entry has no such field - a machine is
 * one machine and has nothing to count. So the entries themselves say which
 * board this is, and a caller that knows better can still say so outright.
 */

export const UNIT_MACHINE = 'machine'
export const UNIT_ACCOUNT = 'account'

export const unitOf = entries =>
  (entries || []).some(e => e && e.machines != null) ? UNIT_ACCOUNT : UNIT_MACHINE

/* Publish nothing until this many accounts are in.
 *
 * A public ranking of three people is not a ranking, it is three people in a
 * line, and every one of them can work out exactly what the others did. Five
 * is the smallest number where a placing is about the field rather than about
 * one identifiable person's week, and where "#2" survives one person taking a
 * holiday. Below it the board publishes the count and nothing else - not a
 * podium of one, and not a table with the names blurred, which is a puzzle
 * rather than a protection. */
export const MIN_PUBLIC_ENTRANTS = 5

/* ── tiers ──────────────────────────────────────────────────────────────
 *
 * A rank tells you where you came; a tier tells you what that means. The
 * thresholds are decades of tokens, because that is how this number actually
 * moves - a week of heavy agent work is not 20% more than a light one, it is
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
 * ranking all time means trusting the total - the daily series is capped at
 * 90 days and would quietly under-count anyone older than that.
 *
 * `ofGroup` reads the same measure off a GROUP rather than an entrant, which
 * is what lets the by-app and by-model axes below rank the very same measures
 * instead of inventing new ones. A metric with no `ofGroup` is one no axis can
 * answer: nothing in the payload attributes a tool call or an active day to a
 * particular app or model, and the honest thing is to leave the measure off
 * those axes rather than divide it up and hope. */

export const METRICS = [
  {
    key: 'tokens',
    label: 'Tokens',
    unit: 'count',
    note: 'Every token that moved, counted once: fresh input, cache reads, cache writes and output.',
    of: e => e.totals?.tokens || 0,
    ofDay: d => d.tokens || 0,
    ofGroup: g => g.tokens,
  },
  {
    key: 'spend',
    label: 'Est. value',
    unit: 'usd',
    note: 'What this work would have cost at API list prices. Not a bill.',
    of: e => e.totals?.estUSD || 0,
    ofDay: d => d.estUSD || 0,
    /* Null, not zero, when something in the group had no rate card. An
       unpriced row that scored 0 would rank below a row that genuinely cost
       nothing, and those are not the same fact. */
    ofGroup: g => g.estUSD,
  },
  {
    key: 'sessions',
    label: 'Sessions',
    unit: 'count',
    note: 'Distinct runs across every assistant that reports them.',
    of: e => e.totals?.sessions || 0,
    ofDay: d => d.sessions || 0,
    ofGroup: g => g.sessions,
  },
  {
    key: 'toolCalls',
    label: 'Tool calls',
    unit: 'count',
    note: 'Reads, edits, commands - every tool an assistant actually invoked.',
    of: e => e.totals?.toolCalls || 0,
    ofDay: d => d.toolCalls || 0,
    ofGroup: null,
  },
  {
    key: 'days',
    label: 'Active days',
    unit: 'count',
    note: 'Days with any token on them. The one metric volume cannot buy.',
    of: e => e.totals?.activeDays || 0,
    ofDay: d => ((d.tokens || 0) > 0 ? 1 : 0),
    ofGroup: null,
  },
]

export const metricOf = key => METRICS.find(m => m.key === key) || METRICS[0]

/* ── token composition ──────────────────────────────────────────────────
 *
 * There is no such thing as "total tokens" until you say which tokens.
 *
 * Codex's headline figure is `total_tokens` as OpenAI reports it, and on a
 * long agent session that is around 98% cached input - the same context read
 * back turn after turn. Claude Code's own chart deliberately leaves cache
 * reads out, because a number dominated by them says more about how long the
 * session was than about how much work happened in it. Put those two headline
 * numbers side by side and you have not compared two fleets; you have compared
 * two definitions, and the one with the cheapest tokens wins.
 *
 * So no surface here prints a bare total. Every total is shown as its parts,
 * and the total is defined as the sum of exactly these parts, each counted
 * once. A part the payload does not carry is `null` - "this build does not
 * report it" - and never 0, because a fleet that reports no reasoning tokens
 * and a fleet that spent none are different findings.
 *
 * Two disagreements are surfaced rather than smoothed:
 *
 *   residual  the tool reported more than it split. Codex reports a day's
 *             tokens without saying which part they were, so the difference
 *             is carried as its own band - the same rule the model chart
 *             already uses for tokens it cannot attribute to a model.
 *
 *   overlap   the parts add up to MORE than the tool's own headline, which
 *             happens because Codex's `input_tokens` already contains
 *             `cached_input_tokens` and its `output_tokens` already contains
 *             `reasoning_output_tokens`. Adding those parts double-counts.
 *             We cannot un-double-count them from here, so we say so instead
 *             of drawing bands that overflow their own bar.
 */

export const PARTS = [
  {
    key: 'input',
    label: 'Fresh input',
    note: 'Context the model had not seen before - the part that is actually new work.',
  },
  {
    key: 'cacheRead',
    label: 'Cache read',
    note: 'Context read back out of the prompt cache. Cheap, enormous, and the reason a raw total flatters a long session.',
  },
  {
    key: 'cacheWrite',
    label: 'Cache write',
    note: 'Context put up for reuse. Paid once at a premium so the reads after it are cheap.',
  },
  {
    key: 'output',
    label: 'Output',
    note: 'What the model actually wrote. The smallest band on almost every board, and the one the work is made of.',
  },
  {
    key: 'reasoning',
    label: 'Reasoning',
    note: 'Thinking tokens, where the tool reports them apart from output. Billed at the output rate.',
  },
]

export function composition(totals) {
  const t = totals || {}
  const parts = PARTS.map(p => ({
    key: p.key,
    label: p.label,
    note: p.note,
    /* Absent and zero are different answers, and this is the line where the
       difference survives or is lost for good. */
    value: t[p.key] == null ? null : Number(t[p.key]) || 0,
  }))

  const counted = parts.reduce((a, p) => a + (p.value || 0), 0)
  const reported = Number(t.tokens) || 0
  const residual = Math.max(0, reported - counted)
  const overlap = Math.max(0, counted - reported)
  const total = counted + residual

  for (const p of parts) p.pct = p.value == null || total <= 0 ? null : (p.value / total) * 100

  return {
    parts,
    /* The one defined total: these parts, each counted once, plus whatever a
       tool reported without splitting. */
    total,
    counted,
    reported,
    residual,
    residualPct: total > 0 ? (residual / total) * 100 : 0,
    overlap,
    missing: parts.filter(p => p.value == null).map(p => p.key),
  }
}

/* ── trending ───────────────────────────────────────────────────────────
 *
 * The floor, published, because the floor is the whole of the honesty here.
 *
 * Momentum is share points - this window's share of the board minus the
 * previous window's - and the reasoning for that is in site/src/lib/demand.js
 * where it is computed: going from 2% to 4% is two points, and calling it
 * "+100%" is true and useless. What was missing was the floor. A model that
 * moved four thousand tokens last week and nine thousand this week is up 125%
 * and belongs nowhere near the top of a chart, and a trending list without a
 * volume floor is a list of rounding errors sorted by how small they started.
 *
 * Two conditions, because either alone has a hole. An absolute floor alone
 * lets a big fleet promote something that is still noise inside it; a share
 * floor alone lets a fleet with three days of history promote anything. A row
 * has to clear both to be ranked for trend, and rows that do not clear them
 * are still shown with their share - they are simply not ranked for movement,
 * and the board says how many were held back and why.
 */

export const TREND = {
  days: 7,
  minTokens: 1e6,
  minSharePct: 1,
  formula: 'share of the last 7 days minus share of the 7 days before it, in share points',
  floor: 'ranked for trend only above 1M tokens and 1% of the window',
}

export const trendEligible = row =>
  (Number(row?.tokens) || 0) >= TREND.minTokens &&
  (Number(row?.sharePct) || 0) >= TREND.minSharePct

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

/* ── groupings ──────────────────────────────────────────────────────────
 *
 * An axis, not a metric.
 *
 * "By app" and "by model" are not two more things to rank; they are the same
 * measures - tokens, value, sessions - read over a different axis. Adding them
 * to METRICS would have said that "model" is a quantity, and the control would
 * then have offered "rank by model over 7 days", which is not a sentence.
 * Grouping is the second dimension: pick a measure, then pick what to total it
 * over. One entrant per row, one app per row, or one model per row.
 *
 * All-time only, and deliberately. The daily series carries a per-model token
 * split and nothing else - no per-app split at all, and no dollars per model -
 * so a windowed grouped ranking could answer one cell of that grid and would
 * have to grey out the rest. Movement over a window is a different question
 * with a different answer: it is the trending block, which has a published
 * formula and a volume floor above.
 */

const groupRowsByApp = e => (e.byTool || []).map(t => ({
  key: t.id,
  label: t.name || t.id,
  tokens: Number(t.tokens) || 0,
  output: Number(t.output) || 0,
  sessions: Number(t.sessions) || 0,
  /* Null is "counted but not priced" and travels as null all the way to the
     cell that renders it. */
  estUSD: t.estUSD == null ? null : Number(t.estUSD) || 0,
  costBasis: t.costBasis || null,
}))

const groupRowsByModel = e => (e.models || []).map(m => ({
  key: m.model || 'unknown',
  label: m.model || 'unknown',
  /* Which product ran it. Two apps can run the same model, and the row is the
     model - but a board that never said which app was reaching for it would
     be hiding the more actionable half. */
  sub: m.tool || null,
  tokens: Number(m.tokens) || 0,
  input: Number(m.input) || 0,
  output: Number(m.output) || 0,
  cacheRead: Number(m.cacheRead) || 0,
  cacheWrite: Number(m.cacheWrite) || 0,
  estUSD: m.priced ? Number(m.estUSD) || 0 : null,
  costBasis: m.priced ? 'list_price' : 'unpriced',
}))

export const GROUPINGS = [
  {
    key: 'entrant',
    label: 'Overall',
    metrics: METRICS.map(m => m.key),
    /* The only axis with a period, because it is the only one the daily series
       can be summed over for every measure. */
    periods: true,
    rows: null,
  },
  {
    key: 'app',
    label: 'By app',
    metrics: ['tokens', 'spend', 'sessions'],
    periods: false,
    note: 'Which assistant the tokens went through, whatever model answered. All time - the daily series carries no per-app split.',
    rows: groupRowsByApp,
  },
  {
    key: 'model',
    label: 'By model',
    metrics: ['tokens', 'spend'],
    periods: false,
    note: 'Which model did the work, whichever app reached for it. All time - sessions and tool calls are recorded per app, not per model.',
    rows: groupRowsByModel,
  },
]

export const groupingOf = key => GROUPINGS.find(g => g.key === key) || GROUPINGS[0]

/* The same measures, totalled over a chosen axis.
 *
 * Everything a group sums is either a count or a dollar figure that knows how
 * it was arrived at. The cost rule is the one `mergeEntries` already uses,
 * copied in behaviour rather than in code because the shapes differ: one
 * unpriced contribution makes the whole group unpriced, because a sum that
 * silently left a machine out is worse than no sum, and two contributions that
 * disagree about their basis collapse to `mixed` rather than to whichever was
 * added last. */
export function rankGroups(entries, { by = 'app', metric = 'tokens' } = {}) {
  const g = groupingOf(by)
  const m = metricOf(g.metrics.includes(metric) ? metric : g.metrics[0])
  const acc = new Map()

  for (const e of entries || []) {
    if (!g.rows) continue
    for (const r of g.rows(e)) {
      if (!r.key) continue
      const row = acc.get(r.key) || {
        key: r.key, label: r.label, sub: r.sub ?? null,
        tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0,
        estUSD: 0, priced: true, costBasis: null, entrants: 0,
      }
      for (const f of ['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'sessions']) {
        row[f] += Number(r[f]) || 0
      }
      if (r.estUSD == null) row.priced = false
      else row.estUSD += r.estUSD
      if (r.costBasis) {
        row.costBasis = row.costBasis == null || row.costBasis === r.costBasis ? r.costBasis : 'mixed'
      }
      row.entrants += 1
      acc.set(r.key, row)
    }
  }

  const rows = [...acc.values()].map(r => ({
    ...r,
    estUSD: r.priced ? r.estUSD : null,
    /* How many entrants reached for this at all. Depth and breadth are
       different findings and a single tokens column hides which one you are
       looking at. */
    reach: (entries || []).length ? (r.entrants / entries.length) * 100 : 0,
  }))

  for (const r of rows) r.value = m.ofGroup ? m.ofGroup(r) : null
  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.tokens - a.tokens)

  let place = 0
  for (const r of rows) r.rank = r.value > 0 ? ++place : null

  const top = rows.reduce((a, r) => Math.max(a, r.value || 0), 0)
  for (const r of rows) r.pct = top > 0 && r.value > 0 ? (r.value / top) * 100 : 0

  return {
    grouping: g,
    metric: m,
    rows,
    /* A total across rows that were not all priced the same way is not one
       number, and the label says so rather than the figure pretending. */
    total: rows.every(r => r.value != null) ? rows.reduce((a, r) => a + r.value, 0) : null,
    basis: rows.reduce(
      (a, r) => (r.costBasis == null || a === r.costBasis ? a : a == null ? r.costBasis : 'mixed'),
      null,
    ),
    ranked: rows.filter(r => r.rank != null).length,
  }
}

/* ── dates ──────────────────────────────────────────────────────────────
 *
 * The agent files a day under the local date it happened on, so the windows
 * here are local days too. Comparing local keys as strings is exact and needs
 * no timezone arithmetic - which is the point, because timezone arithmetic on
 * a leaderboard is how somebody loses a streak at midnight. */

export function dateKey(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* Calendar arithmetic, not clock arithmetic.
 *
 * Subtracting n * 86400e3 from a local timestamp assumes every day is 24 hours
 * long. Twice a year one of them is 23 or 25, and on those days the shift
 * lands on the wrong local date: a window silently gains or loses a day and a
 * streak resets. Reading the local calendar date and then stepping it in UTC -
 * which has no daylight saving - keeps the arithmetic on the calendar where
 * these keys live. */
export function shiftKey(key, n) {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d - n))
  const p = v => String(v).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}

const shiftDays = (now, n) => shiftKey(dateKey(new Date(now)), n)

/* ── streaks ────────────────────────────────────────────────────────────
 *
 * Consecutive days with work on them. Today not having started yet must not
 * break a streak - at 9 a.m. nobody has done anything - so counting begins at
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
    /* Is this the calendar day after the last one? Comparing keys rather than
       millisecond gaps is what makes a 23-hour spring-forward day still one
       day long. */
    run = prev != null && d === shiftKey(prev, -1) ? run + 1 : 1
    prev = d
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
 * that did nothing today are not tied for third - they are simply not on the
 * board yet, and saying so is more useful than a podium of zeroes.
 *
 * A rank here is an ordering and nothing more. Whether that ordering is drawn
 * as a placing - medals, a podium, a tier, a "#2 of 40" badge - is a question
 * about the UNIT, not about the arithmetic, and it is answered where the board
 * is rendered: an ordering of your own machines is analytics, and the same
 * function over opted-in accounts is a competition. */
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

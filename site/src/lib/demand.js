/* Fleet-level rollups: the questions a board answers that no single machine can.
 *
 * Three audiences read the same numbers for three reasons, and the rollups here
 * are chosen so that one calculation serves all three rather than three
 * dashboards being maintained in parallel.
 *
 *   Whoever runs the board wants to know where the spend went, which models
 *   are earning their keep, and whether anything is running that should not be.
 *
 *   Whoever runs the platform wants concentration and reach: is this one heavy
 *   machine or a habit across the fleet, and is load spread or spiky.
 *
 *   Whoever builds the models wants adoption and migration - which model is
 *   taking work from which, how fast, how deep the cache is running, and what
 *   the demand curve looks like across a day.
 *
 * Everything below is a sum over entries. Nothing reads a field the share
 * whitelist does not carry, which is what lets the same components render a
 * private board and a public link.
 */

import { PARTS, TREND, trendEligible } from '../../../shared/ranking.mjs'
import { shortModel } from '../components/board/util'

/* Eight hues, because a fleet routinely runs more models than the board's
   five-colour series was drawn for, and a stack whose sixth band repeats its
   first is a chart that lies quietly. The residual is deliberately not a hue:
   "we could not attribute this" should not look like a model. */
export const MODEL_SERIES = [
  'oklch(74% 0.18 55)',   /* amber - the site accent */
  'oklch(70% 0.14 230)',  /* blue */
  'oklch(74% 0.16 145)',  /* green */
  'oklch(68% 0.20 18)',   /* red-pink */
  'oklch(72% 0.15 300)',  /* violet */
  'oklch(78% 0.14 95)',   /* gold */
  'oklch(70% 0.12 195)',  /* teal */
  'oklch(66% 0.16 340)',  /* magenta */
]

export function palette(names) {
  const out = {}
  let i = 0
  for (const name of names || []) {
    out[name] = name === UNSPLIT
      ? 'var(--color-rule-strong)'
      : MODEL_SERIES[i++ % MODEL_SERIES.length]
  }
  return out
}

/* A stable "nothing yet". An inline `|| []` is a new array on every render,
   which quietly breaks every useMemo that depends on it - the same trap the
   board's fallbacks were fixed for. */
export const NO_ENTRIES = Object.freeze([])

const n = v => (Number(v) || 0)
const dayMs = 86400e3

export function dateKey(d) {
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const back = (now, i) => dateKey(new Date(now - i * dayMs))

/* ── models ─────────────────────────────────────────────────────────────
 *
 * Tokens say depth; machines say reach. A model that one machine leans on is a
 * preference; the same number spread over the fleet is a standard. Both
 * columns are here because the pair is the finding and either alone misleads.
 */

export function modelRollup(entries) {
  const by = new Map()
  for (const e of entries || []) {
    for (const m of e.models || []) {
      if (!m.tokens) continue
      const r = by.get(m.model) || {
        model: m.model, tool: m.tool, tokens: 0, input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0, estUSD: 0, priced: false, machines: 0,
      }
      r.tokens += n(m.tokens)
      r.input += n(m.input)
      r.output += n(m.output)
      r.cacheRead += n(m.cacheRead)
      r.cacheWrite += n(m.cacheWrite)
      r.estUSD += n(m.estUSD)
      r.priced = r.priced || !!m.priced
      r.machines += 1
      by.set(m.model, r)
    }
  }
  const rows = [...by.values()].sort((a, b) => b.tokens - a.tokens)
  const total = rows.reduce((a, r) => a + r.tokens, 0) || 1
  const fleet = (entries || []).length || 1
  for (const r of rows) {
    r.share = (r.tokens / total) * 100
    r.reach = (r.machines / fleet) * 100
    /* What a million output tokens actually cost, once cache reads and writes
       are in the bill. The headline rate card cannot tell you this; only a
       real workload can. */
    r.usdPerMOutput = r.output > 0 && r.priced ? (r.estUSD / r.output) * 1e6 : null
    /* Cache reads over everything read. High is the whole point of a long
       session; low means context is being rebuilt every turn. */
    const readish = r.input + r.cacheRead
    r.cacheRate = readish > 0 ? (r.cacheRead / readish) * 100 : null
  }
  return rows
}

/* Claude Code against Codex, or whatever else reports. Share of wallet, in a
   product where the wallet is tokens. */
export function toolRollup(entries) {
  const by = new Map()
  for (const e of entries || []) {
    for (const t of e.byTool || []) {
      const r = by.get(t.id) || { id: t.id, name: t.name, tokens: 0, output: 0, estUSD: 0, sessions: 0, machines: 0, priced: true, costBasis: null }
      r.tokens += n(t.tokens)
      r.output += n(t.output)
      r.sessions += n(t.sessions)
      if (t.estUSD == null) r.priced = false
      else r.estUSD += n(t.estUSD)
      /* Same rule as mergeEntries: the basis survives, and two sources
         disagreeing about it collapses to `mixed` rather than to whichever
         happened to be summed last. */
      if (t.costBasis) {
        r.costBasis = r.costBasis == null || r.costBasis === t.costBasis ? t.costBasis : 'mixed'
      }
      r.machines += 1
      by.set(t.id, r)
    }
  }
  const rows = [...by.values()].sort((a, b) => b.tokens - a.tokens)
  const total = rows.reduce((a, r) => a + r.tokens, 0) || 1
  for (const r of rows) r.share = (r.tokens / total) * 100
  return rows
}

/* ── the board's own totals ─────────────────────────────────────────────
 *
 * Four surfaces were each summing the same columns inline, which is four
 * chances for two tiles on one screen to disagree. They sum here instead.
 *
 * A part nobody reported stays null. `reasoning` is the live case: the agent
 * reads it from Codex and Copilot but the entry shape does not carry it yet,
 * so every board would render "0 reasoning tokens" - which reads as "these
 * models did no thinking" rather than "we do not have that number". Summing
 * whatever IS present would be worse still: a board where half the machines
 * report a part and half do not has an undercount, not a total.
 */
export function boardTotals(entries) {
  const list = entries || []
  const sum = f => list.reduce((a, e) => a + n(e.totals?.[f]), 0)
  const part = f => (list.some(e => e.totals?.[f] != null) ? sum(f) : null)

  const out = { tokens: sum('tokens'), sessions: sum('sessions'), toolCalls: sum('toolCalls'), requests: sum('requests') }
  for (const p of PARTS) out[p.key] = part(p.key)

  /* Value is the one column that cannot simply be added: an entry that was
     counted but never priced contributes no dollars, and folding it in as zero
     would say the work was free. One unpriced entry makes the board's value a
     figure with a hole in it, and the basis says so. */
  const priced = list.filter(e => e.totals?.estUSD != null)
  out.estUSD = priced.reduce((a, e) => a + n(e.totals.estUSD), 0)
  out.pricedEntries = priced.length
  out.entries = list.length
  out.costBasis = costBasisOf(list)
  /* A board with nothing on it has no basis at all, and the sum of no dollars
     is not $0.00 - it is a figure nobody has yet reported. Leaving this true
     for an empty board is how "$0.00" ends up under "Est. value" on a fleet
     that has never checked in. */
  out.priced = list.length > 0
    && priced.length === list.length
    && out.costBasis != null
    && out.costBasis !== 'unpriced'
  return out
}

/* One basis for the whole board, by the rule `mergeEntries` already uses: the
   bases that actually appear, folded together, and any disagreement between
   them is `mixed` rather than whichever was read last. A board with no priced
   tool on it at all is `unpriced` - which is a real answer, and a different
   one from $0. */
export function costBasisOf(entries) {
  let basis = null
  for (const e of entries || []) {
    for (const t of e.byTool || []) {
      const b = t.costBasis || (t.estUSD == null ? 'unpriced' : null)
      if (!b) continue
      basis = basis == null || basis === b ? b : 'mixed'
    }
  }
  return basis
}

/* ── freshness ──────────────────────────────────────────────────────────
 *
 * What the board is complete THROUGH, which is not what time it is.
 *
 * Every figure below the hour curve is a daily bucket, and today's bucket is
 * still filling: at nine in the morning it holds an hour of work and will hold
 * twelve by tonight. Stamping the page with the render time invites the reader
 * to compare a part-day against a run of whole ones and conclude the fleet has
 * fallen off a cliff. So the stamp is the newest COMPLETE day - the latest
 * bucket that can no longer change - and the last reading is reported beside
 * it as its own separate fact.
 */
export function freshness(entries, now = Date.now()) {
  const today = dateKey(new Date(now))
  let through = null
  const seen = new Set()
  for (const e of entries || []) {
    for (const d of e.byDay || []) {
      if (!d?.date) continue
      seen.add(d.date)
      if (d.date < today && (through == null || d.date > through)) through = d.date
    }
  }
  const readings = (entries || []).map(e => e.lastActive).filter(Boolean).sort()
  return {
    through,
    today,
    days: seen.size,
    /* Null, not "just now": a board where no machine has ever reported has no
       last reading, and saying otherwise would be inventing one. */
    lastReading: readings.length ? readings[readings.length - 1] : null,
    partialToday: seen.has(today),
  }
}

/* ── the daily series, fleet-wide ───────────────────────────────────────
 *
 * Rows shaped for StackedBarChart: `{date, by: {model: tokens}, total}`.
 *
 * The residual matters. Codex reports a day's tokens without saying which
 * model spent them, so the per-model split adds up to less than the day does.
 * That difference is carried as its own band rather than folded into a model
 * that did not earn it - a chart that silently rounded it away would be the
 * kind of wrong that only shows up in someone else's spreadsheet.
 */

export const UNSPLIT = 'unattributed'

export function dailyByModel(entries, days = 30, now = Date.now()) {
  const from = back(now, days - 1)
  const rows = new Map()
  for (const e of entries || []) {
    for (const d of e.byDay || []) {
      if (d.date < from) continue
      const r = rows.get(d.date) || { date: d.date, by: {}, total: 0 }
      let split = 0
      for (const [model, v] of Object.entries(d.byModel || {})) {
        r.by[model] = (r.by[model] || 0) + n(v)
        split += n(v)
      }
      const rest = n(d.tokens) - split
      if (rest > 0) r.by[UNSPLIT] = (r.by[UNSPLIT] || 0) + rest
      r.total += n(d.tokens)
      rows.set(d.date, r)
    }
  }
  return [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/* One row per day for a single measure, fleet-wide. */
export function dailyTotals(entries, field = 'tokens', days = 30, now = Date.now()) {
  const from = back(now, days - 1)
  const rows = new Map()
  for (const e of entries || []) {
    for (const d of e.byDay || []) {
      if (d.date < from) continue
      rows.set(d.date, (rows.get(d.date) || 0) + n(d[field]))
    }
  }
  return [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, value: v }))
}

/* The models worth drawing, biggest first, plus the residual last so it sits
   at the top of a stack where it reads as "and the rest". */
export function seriesNames(rows, limit = 6) {
  const totals = new Map()
  for (const r of rows) for (const [k, v] of Object.entries(r.by)) totals.set(k, (totals.get(k) || 0) + v)
  const named = [...totals.entries()]
    .filter(([k]) => k !== UNSPLIT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k)
  return totals.has(UNSPLIT) ? [...named, UNSPLIT] : named
}

/* ── movement ───────────────────────────────────────────────────────────
 *
 * A window against the window before it, per model. This is the migration
 * signal: not "who is biggest" but "who is taking work from whom", which is
 * the question a rank alone cannot answer.
 */

export function modelMomentum(entries, days = 7, now = Date.now()) {
  const cur = { from: back(now, days - 1), to: null }
  const prev = { from: back(now, days * 2 - 1), to: back(now, days) }
  const acc = new Map()
  const bump = (model, key, v) => {
    const r = acc.get(model) || { model, now: 0, before: 0 }
    r[key] += v
    acc.set(model, r)
  }
  for (const e of entries || []) {
    for (const d of e.byDay || []) {
      const inCur = d.date >= cur.from
      const inPrev = d.date >= prev.from && d.date < prev.to
      if (!inCur && !inPrev) continue
      let split = 0
      for (const [model, v] of Object.entries(d.byModel || {})) {
        bump(model, inCur ? 'now' : 'before', n(v))
        split += n(v)
      }
      const rest = n(d.tokens) - split
      if (rest > 0) bump(UNSPLIT, inCur ? 'now' : 'before', rest)
    }
  }
  const rows = [...acc.values()]
  const sumNow = rows.reduce((a, r) => a + r.now, 0) || 1
  const sumBefore = rows.reduce((a, r) => a + r.before, 0) || 1
  for (const r of rows) {
    r.shareNow = (r.now / sumNow) * 100
    r.shareBefore = (r.before / sumBefore) * 100
    /* Share points, not a percentage change: going from 2% to 4% of a fleet is
       +2 points, and calling it "+100%" would be true and useless. */
    r.swing = r.shareNow - r.shareBefore
    r.delta = r.now - r.before
    /* …and the floor, which is the half this was missing. A row below it keeps
       its share - it is a real number and it stays on the page - but it is not
       ranked for movement, because a swing measured off a baseline of nothing
       is a rounding error with a percentage sign on it. The thresholds are in
       shared/ranking.mjs so the board and anything that reads the exported
       report apply the same one. */
    r.eligible = trendEligible({ tokens: r.now, sharePct: r.shareNow })
  }
  return rows.sort((a, b) => b.now - a.now)
}

/* Trending: the same momentum, sorted by movement instead of by size, with
   only the rows that cleared the floor in it. Everything held back is counted
   so the page can say how many and why - an unexplained absence is its own
   kind of dishonesty. */
export function trending(entries, days = TREND.days, now = Date.now()) {
  const all = modelMomentum(entries, days, now)
  const rows = all.filter(r => r.eligible).sort((a, b) => b.swing - a.swing)
  return { rows, held: all.length - rows.length, floor: TREND, considered: all.length }
}

/* ── right now ──────────────────────────────────────────────────────────
 *
 * Live load, from the last reading each machine sent. A count of processes by
 * product and kind - never what any of them is doing.
 */

export function liveRollup(entries, now = Date.now()) {
  const byTool = new Map()
  const byKind = new Map()
  let procs = 0
  let headless = 0
  let longest = 0
  const machines = []

  for (const e of entries || []) {
    const rows = e.running || []
    if (rows.length) {
      machines.push({
        id: e.id,
        name: e.name,
        status: e.status,
        count: rows.length,
        block: e.block,
        kinds: rows.map(r => r.kind).filter(Boolean),
        tools: [...new Set(rows.map(r => r.tool))],
        oldest: Math.max(0, ...rows.map(r => n(r.elapsedSeconds))),
      })
    }
    for (const r of rows) {
      procs++
      if (r.headless) headless++
      longest = Math.max(longest, n(r.elapsedSeconds))
      byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1)
      const k = r.kind || 'unlabelled'
      byKind.set(k, (byKind.get(k) || 0) + 1)
    }
  }

  /* Five-hour blocks are a Claude Code fact that only some boards carry.
     `mergeEntries` drops them on purpose - a block is a live window on one
     machine and the public board has no machines in it - and a shared board
     only has them if share.rs sent them. Reporting "0 blocks open, 0 requests,
     0 output" on a board that was never given the field is three numbers that
     are false in the most misleading direction: they say the fleet is idle.
     So the absence is carried as null and the page says "not reported". */
  const withBlocks = (entries || []).filter(e => e.block)
  const inFlight = withBlocks.filter(e => e.block.open)
  return {
    processes: procs,
    headless,
    machinesRunning: machines.length,
    machinesTotal: (entries || []).length,
    reporting: (entries || []).filter(e => e.status === 'up').length,
    longest,
    byTool: [...byTool.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
    byKind: [...byKind.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
    machines: machines.sort((a, b) => b.count - a.count),
    blocksReported: withBlocks.length > 0,
    blockRequests: withBlocks.length ? inFlight.reduce((a, e) => a + n(e.block.requests), 0) : null,
    blockOutput: withBlocks.length ? inFlight.reduce((a, e) => a + n(e.block.outputTokens), 0) : null,
    blocksOpen: withBlocks.length ? inFlight.length : null,
    /* A machine whose last reading is old is not idle, it is quiet - and the
       difference matters when the number is being read as live load. */
    stale: (entries || []).filter(e => e.status !== 'up').length,
    now,
  }
}

/* ── concentration ──────────────────────────────────────────────────────
 *
 * How much of the fleet's work one machine is doing. A board where the top
 * machine is 90% of the tokens is one person's habit wearing a team's clothes,
 * and every average taken off it will be wrong.
 */

export function concentration(entries, field = 'tokens') {
  const vals = (entries || []).map(e => n(e.totals?.[field])).sort((a, b) => b - a)
  const total = vals.reduce((a, v) => a + v, 0)
  if (!total) return { top: 0, topThree: 0, gini: 0, median: 0 }
  const share = k => (vals.slice(0, k).reduce((a, v) => a + v, 0) / total) * 100
  /* Gini over the fleet: 0 is everybody equal, 1 is one machine and the rest
     watching. */
  const asc = [...vals].reverse()
  let cum = 0
  for (let i = 0; i < asc.length; i++) cum += (2 * (i + 1) - asc.length - 1) * asc[i]
  return {
    top: share(1),
    topThree: share(3),
    gini: asc.length > 1 ? cum / (asc.length * total) : 0,
    median: asc[Math.floor(asc.length / 2)] || 0,
  }
}

/* ── growth ─────────────────────────────────────────────────────────── */

export function growth(entries, field = 'tokens', days = 7, now = Date.now()) {
  const from = back(now, days - 1)
  const pfrom = back(now, days * 2 - 1)
  let cur = 0
  let prev = 0
  for (const e of entries || []) {
    for (const d of e.byDay || []) {
      if (d.date >= from) cur += n(d[field])
      else if (d.date >= pfrom) prev += n(d[field])
    }
  }
  return { current: cur, previous: prev, pct: prev > 0 ? ((cur - prev) / prev) * 100 : null }
}

/* ── the export ─────────────────────────────────────────────────────────
 *
 * The aggregate report, as a file. Everything in it is already on the screen
 * and already inside the share whitelist - this is the same board in a shape
 * something other than a browser can read. No machine names, no per-machine
 * rows: a model-demand report is about models.
 */

export function aggregateReport(board, now = Date.now()) {
  const entries = board?.entries || []
  const models = modelRollup(entries)
  const totals = boardTotals(entries)
  const fresh = freshness(entries, now)
  const trend = trending(entries, TREND.days, now)
  return {
    /* When the file was written, which is a different fact from what the
       numbers are complete through - and both are here, because a reader who
       only got one of them would be guessing which one they had. */
    generatedAt: new Date(now).toISOString(),
    schema: 'tokenhud.fleet-demand/2',
    scope: {
      machines: entries.length,
      windowDays: board?.windowDays ?? null,
      pricingAsOf: board?.pricingAsOf ?? null,
      completeThrough: fresh.through,
      lastReading: fresh.lastReading,
      costBasis: totals.costBasis,
      note: 'Aggregate only. No machine identities, projects, prompts, paths, tools or plan limits.',
    },
    totals: {
      tokens: totals.tokens,
      /* The composition, not just the headline: a total that is 98% cache
         reads and a total that is 98% output are the same number and not the
         same fleet. A part this build does not report stays null. */
      input: totals.input,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      output: totals.output,
      reasoning: totals.reasoning,
      estUSD: totals.priced ? Math.round(totals.estUSD * 100) / 100 : null,
      sessions: totals.sessions,
      requests: totals.requests,
      toolCalls: totals.toolCalls,
    },
    concentration: concentration(entries),
    models: models.map(m => ({
      model: m.model,
      tool: m.tool,
      tokens: m.tokens,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      sharePct: Math.round(m.share * 10) / 10,
      reachPct: Math.round(m.reach * 10) / 10,
      machines: m.machines,
      cacheRatePct: m.cacheRate == null ? null : Math.round(m.cacheRate * 10) / 10,
      estUSD: m.priced ? Math.round(m.estUSD * 100) / 100 : null,
      usdPerMOutput: m.usdPerMOutput == null ? null : Math.round(m.usdPerMOutput * 100) / 100,
    })),
    tools: toolRollup(entries).map(t => ({
      tool: t.id, tokens: t.tokens, output: t.output, sessions: t.sessions,
      sharePct: Math.round(t.share * 10) / 10,
      estUSD: t.priced ? Math.round(t.estUSD * 100) / 100 : null,
    })),
    /* The formula and the floor travel with the numbers. A trending list whose
       rule is not in the file is a list the reader has to take on trust, which
       is exactly the thing this board exists not to ask for. */
    trend: {
      windowDays: TREND.days,
      unit: 'share points',
      formula: TREND.formula,
      minTokens: TREND.minTokens,
      minSharePct: TREND.minSharePct,
      rankedForTrend: trend.rows.length,
      belowFloor: trend.held,
    },
    momentum7d: modelMomentum(entries, TREND.days, now).map(m => ({
      model: m.model,
      tokens: m.now,
      previousTokens: m.before,
      sharePct: Math.round(m.shareNow * 10) / 10,
      swingPoints: Math.round(m.swing * 10) / 10,
      rankedForTrend: m.eligible,
    })),
    dailyByModel: dailyByModel(entries, 90, now),
    hoursOfDay: board?.hours ?? null,
    hoursWithheld: board?.hours == null,
  }
}

/* A filename somebody can find again in a downloads folder. */
export function reportFilename(now = Date.now()) {
  return `tokenhud-fleet-demand-${dateKey(new Date(now))}.json`
}

/* ── formatting shared by the demand pages ──────────────────────────── */

/* Percentages people can act on. Whole numbers in the middle, one decimal at
   both ends - a cache rate of 99.7% rounded to 100% would say the last 0.3%
   does not exist, and on twenty billion tokens it very much does. */
export const pct = v => {
  if (v == null) return '-'
  if (v > 99 && v < 100) return (Math.floor(v * 10) / 10) + '%'
  if (v > 0 && v < 1) return (Math.round(v * 100) / 100) + '%'
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + '%'
}
export const swing = v =>
  v == null || Math.abs(v) < 0.05 ? '-' : (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' pts'
export const label = m => (m === UNSPLIT ? 'unattributed' : shortModel(m))

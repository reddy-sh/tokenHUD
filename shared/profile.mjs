/* A reading, folded to the shape the ranking reads.
 *
 * Moved out of site/src/lib/leaderboard.js alongside shared/ranking.mjs. The
 * browser calls it on the full readings the board holds; the cloud API calls
 * it on the reading an agent just posted, and stores the result as that
 * machine's rollup - which is what lets DynamoDB keep 6 KB per machine
 * instead of the 94 KB reading it came from.
 *
 * It mirrors `server/src/share.rs`. If a field moves in the agent, both want
 * the same edit - and the Rust side has the tests that catch it.
 */

/* ── entries ────────────────────────────────────────────────────────────
 *
 * On the private path the person looking owns every machine on the board, so
 * machines keep their real names. The shape is shared with the public payload
 * on purpose: one ranking function, and a Share dialog whose preview is the
 * real thing rather than a mock-up of it. */

const n = v => (Number(v) || 0)

/* Is the agent reporting?
 *
 * A statement about the agent, not about whether the machine is switched on -
 * three missed intervals is the usual line. The same three thresholds live in
 * server/src/board.rs (`hosts_with_status`) because the self-host board has to
 * call a machine up by the same rule the cloud does; two places calling it
 * differently would be a difference nobody could explain.
 */
export function liveness(ageSeconds) {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return 'unknown'
  if (ageSeconds < 120) return 'up'
  if (ageSeconds < 900) return 'stale'
  return 'down'
}

function mergeDays(m) {
  const rows = new Map()
  const at = date => {
    if (!date) return null
    if (!rows.has(date)) rows.set(date, { date, tokens: 0, estUSD: 0, sessions: 0, toolCalls: 0, messages: 0, byModel: {} })
    return rows.get(date)
  }
  for (const d of m.claude?.daily || []) {
    const r = at(d.date); if (!r) continue
    r.tokens += n(d.tokens); r.messages += n(d.messages)
    r.toolCalls += n(d.toolCalls); r.sessions += n(d.sessions)
    for (const [model, v] of Object.entries(d.tokensByModel || {})) {
      r.byModel[model] = (r.byModel[model] || 0) + n(v)
    }
  }
  for (const d of m.codex?.byDay || []) {
    const r = at(d.date); if (!r) continue
    r.tokens += n(d.tokens); r.sessions += n(d.sessions)
  }
  for (const d of m.usage?.byDay || []) {
    const r = at(d.date); if (!r) continue
    r.estUSD += n(d.estUSD)
  }
  return [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-90)
}

function mergeModels(m) {
  const out = []
  const claude = m.usage?.byModel || []
  const rows = claude.length ? claude : (m.claude?.models || [])
  for (const r of rows) {
    const cw = n(r.cacheWrite) + n(r.cacheCreate)
    out.push({
      model: r.model || 'unknown',
      tool: 'claude-code',
      tokens: n(r.input) + n(r.output) + n(r.cacheRead) + cw,
      input: n(r.input), output: n(r.output), cacheRead: n(r.cacheRead), cacheWrite: cw,
      estUSD: n(r.estUSD),
      priced: !!r.priced,
    })
  }
  for (const r of m.codex?.byModel || []) {
    out.push({
      model: r.model || 'unknown',
      tool: 'codex',
      tokens: n(r.tokens?.total),
      input: n(r.tokens?.input), output: n(r.tokens?.output),
      cacheRead: n(r.tokens?.cached_input), cacheWrite: 0,
      estUSD: 0, priced: false,
    })
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

export function profileOf(payload, hostRow) {
  const m = payload?.metrics || {}
  const all = m.usage?.allTime || {}
  const t = all.tokens || {}
  const cx = m.codex?.totals || {}
  const byDay = mergeDays(m)

  const byTool = []
  const claudeTokens = n(t.in) + n(t.out) + n(t.cacheRead) + n(t.cacheWrite)
  if (claudeTokens > 0) {
    byTool.push({
      id: 'claude-code', name: 'Claude Code',
      tokens: claudeTokens, output: n(t.out), estUSD: n(all.estUSD), sessions: n(all.sessions),
      /* How that dollar figure was arrived at, carried with it. A number
         without its basis is the ambiguity every one of these tools has:
         "free", "no rate for this model" and "included in a subscription" all
         render as $0 and mean entirely different things. */
      costBasis: m.usage?.costBasis || 'list_price',
    })
  }
  if (n(cx.total) > 0) {
    /* `publicEstUSD` is priced from the built-in card only. A figure the
       machine's owner priced with their own rate card stays on their own board:
       `estUSD` is a ranked metric, and ranking strangers on a number any of
       them can edit would make the leaderboard a typing contest. Null here is
       "not priced", which is a different fact from "free". */
    const pub_ = m.codex?.publicEstUSD
    byTool.push({
      id: 'codex', name: 'Codex CLI',
      tokens: n(cx.total), output: n(cx.output),
      estUSD: pub_ == null ? null : n(pub_),
      sessions: n(m.codex?.sessionCount),
      costBasis: pub_ == null ? 'unpriced' : 'list_price',
    })
  }

  const first = [
    m.claude?.firstSessionDate ? String(m.claude.firstSessionDate).slice(0, 10) : null,
    byDay[0]?.date || null,
  ].filter(Boolean).sort()[0] || null

  return {
    id: payload?.host || 'unknown',
    name: payload?.host || 'unknown',
    os: m.host?.platform || null,
    cores: m.host?.cpus ?? null,
    status: hostRow?.status || null,
    lastActive: hostRow?.last_seen || payload?.collectedAt || null,
    firstSeen: first,
    tools: (m.assistants || []).filter(a => a.hasData).map(a => ({ id: a.id, name: a.name })),
    totals: {
      tokens: claudeTokens + n(cx.total),
      input: n(t.in) + n(cx.input),
      output: n(t.out) + n(cx.output),
      cacheRead: n(t.cacheRead) + n(cx.cached_input),
      cacheWrite: n(t.cacheWrite),
      estUSD: n(all.estUSD),
      sessions: n(all.sessions) + n(m.codex?.sessionCount),
      requests: n(all.requests),
      toolCalls: n(all.toolCalls),
      messages: n(m.claude?.totalMessages),
      activeDays: byDay.filter(d => d.tokens > 0).length,
    },
    byTool,
    models: mergeModels(m),
    byDay,
    /* What is going right now, as counts. Mirrors share.rs: which product,
       what kind, headless or not, how long - never the command line. */
    running: (m.processes || []).map(p => ({
      tool: p.tool || 'claude-code',
      kind: p.kind || null,
      headless: !!p.headless,
      model: p.model || null,
      elapsedSeconds: etime(p.elapsed),
    })),
    block: m.usage?.blocks?.current
      ? {
        requests: n(m.usage.blocks.current.requests),
        outputTokens: n(m.usage.blocks.current.outputTokens),
        open: !!m.usage.blocks.current.open,
        minutesLeft: n(m.usage.blocks.current.minutesLeft),
        minutesUsed: n(m.usage.blocks.current.minutesUsed),
      }
      : null,
  }
}

/* `ps` etime, the same four shapes the server parses. */
function etime(v) {
  if (!v) return null
  const [days, rest] = String(v).includes('-') ? String(v).split('-') : [0, String(v)]
  const parts = String(rest).split(':').map(Number)
  if (parts.some(x => !isFinite(x))) return null
  const [h, mi, se] = parts.length === 3 ? parts : [0, parts[0], parts[1]]
  if (se == null) return null
  return Number(days) * 86400 + h * 3600 + mi * 60 + se
}

/* Every reporting machine on the admin board, in the public shape. */
export function profilesOf(data) {
  const hosts = data?.hosts || []
  return (data?.latest || [])
    .map(p => profileOf(p, hosts.find(h => h.host === p.host)))
    .sort((a, b) => b.totals.tokens - a.totals.tokens)
}

/* The whole board, in the shape `share.rs` serves - so the private pages and
   the shared page are handed the same object and differ only in what is in it.
   The hour curve is a board-level sum in both, never a per-machine field: over
   a team it is a demand curve, over one machine it is somebody's sleep. */
export function fleetOf(data) {
  const entries = profilesOf(data)
  const hours = {}
  for (const p of data?.latest || []) {
    for (const [k, v] of Object.entries(p?.metrics?.claude?.hours || {})) {
      hours[k] = (hours[k] || 0) + n(v)
    }
  }
  return {
    entries,
    generatedAt: data?.generatedAt || null,
    hours: Object.keys(hours).length ? hours : null,
    /* The private board is the owner looking at machines they own, so nothing
       is withheld here - the threshold is a property of publishing. */
    hoursMinMachines: 0,
    pricingAsOf: data?.latest?.[0]?.metrics?.usage?.pricing?.asOf || null,
    windowDays: 90,
    totals: {
      machines: entries.length,
      tokens: entries.reduce((a, e) => a + e.totals.tokens, 0),
      estUSD: entries.reduce((a, e) => a + e.totals.estUSD, 0),
    },
  }
}

/* Several machines, as one entry.
 *
 * The public leaderboard ranks accounts, not machines, and the ranking only
 * knows how to read one entry - so an account with four machines has to become
 * one of the same shape. Everything here is a sum except the three fields
 * where a sum would be a lie: `firstSeen` is the earliest, `lastActive` the
 * latest, and `activeDays` is recounted from the merged days, because two
 * machines working the same Tuesday worked one Tuesday.
 *
 * Nothing that names a machine survives the merge. That is deliberate: this is
 * the value that goes on a page strangers read, and the whitelist it has to
 * satisfy is the one in server/src/share.rs - counts, models, days, never a
 * hostname, a path, a project or a prompt.
 */
export function mergeEntries(entries, { id, name } = {}) {
  const list = (entries || []).filter(Boolean)

  const days = new Map()
  for (const e of list) {
    for (const d of e.byDay || []) {
      if (!d?.date) continue
      const row = days.get(d.date) || { date: d.date, tokens: 0, estUSD: 0, sessions: 0, toolCalls: 0, messages: 0, byModel: {} }
      row.tokens += n(d.tokens); row.estUSD += n(d.estUSD); row.sessions += n(d.sessions)
      row.toolCalls += n(d.toolCalls); row.messages += n(d.messages)
      for (const [model, v] of Object.entries(d.byModel || {})) {
        row.byModel[model] = (row.byModel[model] || 0) + n(v)
      }
      days.set(d.date, row)
    }
  }
  const byDay = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-90)

  const models = new Map()
  for (const e of list) {
    for (const mo of e.models || []) {
      const k = `${mo.tool}|${mo.model}`
      const row = models.get(k) || { model: mo.model, tool: mo.tool, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estUSD: 0, priced: false }
      row.tokens += n(mo.tokens); row.input += n(mo.input); row.output += n(mo.output)
      row.cacheRead += n(mo.cacheRead); row.cacheWrite += n(mo.cacheWrite); row.estUSD += n(mo.estUSD)
      row.priced = row.priced || !!mo.priced
      models.set(k, row)
    }
  }

  const tools = new Map()
  for (const e of list) {
    for (const t of e.byTool || []) {
      const row = tools.get(t.id) || { id: t.id, name: t.name, tokens: 0, output: 0, estUSD: 0, sessions: 0, priced: true, costBasis: null }
      row.tokens += n(t.tokens); row.output += n(t.output); row.sessions += n(t.sessions)
      /* estUSD is null for a tool this build counts but cannot price. Adding a
         zero for it would read as "free" rather than "not priced". */
      if (t.estUSD == null) row.priced = false
      else row.estUSD += n(t.estUSD)
      /* The basis survives the merge, and two machines disagreeing about it
         collapses to `mixed` rather than to whichever reported last: a total
         summed across different bases is not one number. */
      if (t.costBasis) {
        row.costBasis = row.costBasis == null || row.costBasis === t.costBasis
          ? t.costBasis
          : 'mixed'
      }
      tools.set(t.id, row)
    }
  }
  const byTool = [...tools.values()]
    .map(t => ({ id: t.id, name: t.name, tokens: t.tokens, output: t.output, estUSD: t.priced ? t.estUSD : null, sessions: t.sessions, costBasis: t.costBasis }))
    .sort((a, b) => b.tokens - a.tokens)

  const sum = field => list.reduce((a, e) => a + n(e.totals?.[field]), 0)
  const dates = list.map(e => e.firstSeen).filter(Boolean).sort()
  const seen = list.map(e => e.lastActive).filter(Boolean).sort()

  return {
    id: id ?? 'account',
    name: name ?? 'Anonymous',
    os: null,
    cores: null,
    status: list.some(e => e.status === 'up') ? 'up' : (list.some(e => e.status === 'stale') ? 'stale' : 'down'),
    lastActive: seen.length ? seen[seen.length - 1] : null,
    firstSeen: dates.length ? dates[0] : null,
    machines: list.length,
    tools: [...new Map(list.flatMap(e => e.tools || []).map(t => [t.id, t])).values()],
    totals: {
      tokens: sum('tokens'),
      input: sum('input'),
      output: sum('output'),
      cacheRead: sum('cacheRead'),
      cacheWrite: sum('cacheWrite'),
      estUSD: sum('estUSD'),
      sessions: sum('sessions'),
      requests: sum('requests'),
      toolCalls: sum('toolCalls'),
      messages: sum('messages'),
      /* Recounted, never summed: the same day worked on two machines is one
         active day, and a streak built on a sum would be fiction. */
      activeDays: byDay.filter(d => d.tokens > 0).length,
    },
    byTool,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    byDay,
    running: list.flatMap(e => e.running || []),
    block: null,
  }
}

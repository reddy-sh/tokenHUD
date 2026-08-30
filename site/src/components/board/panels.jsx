import { useState } from 'react'
import { ActivityChart, HourChart, Legend, StackedBarChart } from './charts'
import {
  ago, clock, compact, dur, estimateRow, full, SERIES, severityColor,
  shortModel, until, usd, usdShort, useNow, WARNING,
} from './util'

/* ── shared building blocks ─────────────────────────────────────────── */

export function Card({ title, note, right, children, warn }) {
  return (
    <div className={'bv-card' + (warn ? ' bv-card--warn' : '')}>
      {(title || right) && (
        <div className="bv-card-head">
          <div>
            {title && <h2>{title}</h2>}
            {note && <p className="bv-note">{note}</p>}
          </div>
          {right && <span className="bv-card-right">{right}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

export const Empty = ({ children }) => <p className="bv-empty">{children}</p>

/* The labelled meter the classic board drew everywhere. */
export function MeterBar({ pct, label, right, note, color, extra }) {
  return (
    <div className="bv-driver">
      <div className="top">
        <span className="pc">{label}</span>
        <span className="lb">{right || ''}</span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: Math.max(0, Math.min(100, Number(pct) || 0)) + '%', background: color }} />
      </div>
      {note != null && <div className="nt">{note}</div>}
      {extra}
    </div>
  )
}

export function Pill({ tone, children, title }) {
  return (
    <span className={'bv-pill ' + (tone || '')} title={title}>
      <span className="dot" />
      <span>{children}</span>
    </span>
  )
}

const procTool = p => p.tool || 'claude-code'

/* ── overview tiles ─────────────────────────────────────────────────── */

export function Tiles({ claude: s, live, hostFacts, usage }) {
  const tools = (s.daily || []).reduce((a, d) => a + d.toolCalls, 0)
  const active = (s.daily || []).filter(d => d.messages > 0).length
  const out = (s.models || []).reduce((a, m) => a + m.output, 0)
  const running = (live.processes || []).filter(p => procTool(p) === 'claude-code').length
  const tiles = [
    { k: 'Sessions', v: full(s.totalSessions), d: s.firstSessionDate ? 'since ' + String(s.firstSessionDate).slice(0, 10) : '' },
    { k: 'Messages', v: compact(s.totalMessages), d: full(s.totalMessages) },
    { k: 'Tool calls', v: compact(tools), d: `over ${active} active days` },
    { k: 'Output tokens', v: compact(out), d: `${(s.models || []).length} models` },
    { k: 'Est. value', v: usdShort((usage.allTime || {}).estUSD || 0), d: 'at API list prices · not billed' },
    { k: 'Running now', v: String(running), d: running ? 'claude processes' : 'idle' },
    {
      k: 'Load', v: hostFacts && hostFacts.loadavg ? String(hostFacts.loadavg[0]) : '—',
      d: hostFacts && hostFacts.cpus ? hostFacts.cpus + ' cores · ' + (hostFacts.platform || '') : '',
    },
  ]
  return (
    <div className="bv-stats bv-tiles">
      {tiles.map(t => (
        <div className="bv-stat" key={t.k}>
          <div className="bv-stat-label">{t.k}</div>
          <div className="bv-stat-value tnum">{t.v}</div>
          <div className="bv-stat-sub">{t.d}</div>
        </div>
      ))}
    </div>
  )
}

/* ── usage windows: Anthropic's own numbers, aged honestly ──────────── */

function resetCell(row, now) {   /* eslint-disable-line no-unused-vars -- now forces the 1s rerender */
  const secs = row.resetsAt ? until(row.resetsAt) : null
  if (secs == null) return 'No reset scheduled'
  if (secs <= 0) return 'Rolled over — awaiting refresh'
  return `Resets in ${dur(secs)}`
}

/* Tokens over the trailing seven days, from this board's own transcript index.
 *
 * The percentages above it come out of Claude Code's cache and are only as
 * fresh as the last time Claude Code talked to the usage endpoint. This is
 * counted here, from files already on disk, so it moves every cycle whatever
 * the cache is doing — which is the difference between a panel that has gone
 * quiet and a panel that says nothing at all. */
function tokensLast7(usage, now) {
  const rows = (usage && usage.byDay) || []
  if (!rows.length) return null
  // `now` comes from the panel's ticking clock rather than Date.now(), so the
  // window rolls with the same tick that ages the cache above it.
  const cutoff = new Date(now - 7 * 86400_000).toISOString().slice(0, 10)
  let total = 0
  for (const r of rows) if (r && r.date && r.date >= cutoff) total += Number(r.tokens) || 0
  return total || null
}

export function UsageWindows({ lim, usage }) {
  const now = useNow(1000)

  if (!lim || !lim.available) {
    const why = lim && lim.reason === 'unreadable'
      ? 'Claude Code\u2019s config was mid-write and could not be read this cycle. It will be picked up on the next one.'
      : 'No usage cache found. Claude Code writes one to ~/.claude.json after it talks to the usage endpoint — run /usage in Claude Code once and it will appear here.'
    return (
      <Card title="Usage windows" note="Your plan’s real limits, as Anthropic last reported them.">
        <Empty>{why}</Empty>
        <p className="bv-note" style={{ marginTop: 12 }}>
          The five-hour block is reconstructed from your own request timestamps and does not need this cache.
        </p>
      </Card>
    )
  }

  const age = lim.ageSeconds
  const stale = age != null && age > (lim.staleAfterSeconds || 3600)
  const live7 = tokensLast7(usage, now)
  const rows = (lim.windows || []).slice()
  const when = lim.fetchedAt ? clock(lim.fetchedAt) : 'unknown'
  const agoTxt = age == null ? '' : ` · ${dur(age)} ago`

  return (
    <Card
      title="Usage windows"
      note="Your plan’s real limits, as Anthropic last reported them — not computed here."
      right={
        <span className={'bv-sub' + (stale ? ' warn' : '')}
          title={stale
            ? 'Claude Code discards this cache after an hour — run /usage there to refresh. The countdowns stay exact; the percentages are the stale part.'
            : 'Refreshes only while Claude Code is running.'}>
          {stale ? 'stale · ' : ''}as of {when}{agoTxt}
        </span>
      }
    >
      <table className={'bv-uw' + (stale ? ' stale' : '')}>
        <thead>
          <tr><th>Metric</th><th>Used</th><th className="r">Reset window</th></tr>
        </thead>
        <tbody>
          {rows.map((w2, i) => {
            const known = w2.percent != null
            const pct = Math.max(0, Math.min(100, Number(w2.percent) || 0))
            return (
              <tr key={i}>
                <th scope="row">{w2.label}</th>
                <td>
                  <div className="bar">
                    <div className="track"
                      role="img" aria-label={known ? `${pct}% used` : 'usage unknown'}>
                      {known && <div className="fill" style={{ width: pct + '%', background: severityColor(w2.severity) }} />}
                    </div>
                    <span className="pct tnum">{known ? pct + '%' : '—'}</span>
                  </div>
                </td>
                <td className="r nt">{resetCell(w2, now)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* The figure that cannot go stale, whatever the cache is doing. Kept
          under the table rather than in it: it answers a different question —
          not "how much of the plan is gone" but "is anything still moving". */}
      {live7 != null && (
        <p className="bv-note" style={{ marginTop: 12 }}>
          <b className="tnum">{compact(live7)}</b> tokens in the last 7 days —
          counted here from your own transcripts, current as of this reading.
        </p>
      )}

      {/* The remedy belongs where the problem is stated. It used to live only
          in the stale caption's title attribute, which nobody hovers and a
          phone cannot show at all. */}
      {stale && (
        <div className="bv-warnbar" style={{ marginTop: 12 }}>
          These percentages are {dur(age)} old. TokenHUD never asks Anthropic for
          them — it reads the cache Claude Code writes, and Claude Code only
          refreshes it when it talks to the usage endpoint. Run <b>/usage</b> in
          Claude Code and the next reading will pick it up. The reset countdowns
          above are absolute and stay exact meanwhile.
        </div>
      )}
    </Card>
  )
}

/* ── recently finished ──────────────────────────────────────────────── */

export function EndedFeed({ endings, host, toolId, title, note }) {
  const rows = (endings || []).filter(e => (!host || e.host === host)
    && (!toolId || (e.tool || 'claude-code') === toolId))
  const hour = rows.filter(e => (Date.now() - new Date(e.noticed_at).getTime()) < 3600e3).length

  return (
    <Card title={title} note={note}
      right={rows.length ? <span className="bv-sub">{hour} in the last hour · {rows.length} in 24h</span> : null}>
      <ul className="bv-feed">
        {!rows.length && (
          <li className="bv-empty">
            Nothing has finished since the server started watching. Endings are noticed by comparing one
            reading with the next, so they only exist from that point on.
          </li>
        )}
        {rows.slice(0, 25).map((e, i) => {
          const gap = (new Date(e.noticed_at) - new Date(e.last_seen)) / 1000
          return (
            <li key={i} title={e.cmd || ''}>
              <div className="name">
                <span className="bv-tag">{e.kind || 'claude'}</span>
                <span className="mono">pid {e.pid}</span>
                {e.ran_seconds != null && <span className="bv-sub">ran {dur(e.ran_seconds)}</span>}
              </div>
              <div className="meta">
                <span>
                  {gap > 90
                    ? `ended between ${clock(e.last_seen)} and ${clock(e.noticed_at)}`
                    : 'ended ' + ago(e.noticed_at)}
                </span>
                {e.tool && e.tool !== 'claude-code' && <span>{e.tool}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ── tokens per day, with the table view the relief rule demands ────── */

export function TokensCard({ daily, models }) {
  const [table, setTable] = useState(false)
  const names = (models || []).map(m => m.model).slice(0, SERIES.length)
  const colors = {}; names.forEach((n, i) => { colors[n] = SERIES[i] })
  const rows = (daily || []).map(d => ({ date: d.date, by: d.tokensByModel || {}, total: d.tokens || 0 }))

  return (
    <Card title="Tokens per day" note="Stacked by model."
      right={(
        <button className="bv-toggle" aria-pressed={table} onClick={() => setTable(t => !t)}>Table</button>
      )}>
      {!table && (
        <>
          <StackedBarChart rows={rows} names={names} colors={colors} ariaLabel="Tokens per day by model" />
          <Legend items={names.map(n => ({
            color: colors[n], label: shortModel(n),
            value: compact(rows.reduce((a, r) => a + (Number(r.by[n]) || 0), 0)),
          }))} />
        </>
      )}
      {table && (
        <div className="bv-table-scroll">
          <table className="bv-table">
            <thead>
              <tr>
                <th>Day</th>
                {names.map(n => <th key={n}>{shortModel(n)}</th>)}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice().reverse().map(r => (
                <tr key={r.date}>
                  <td>{r.date}</td>
                  {names.map(n => <td key={n} className="tnum">{r.by[n] ? full(r.by[n]) : '—'}</td>)}
                  <td className="tnum">{full(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/* ── estimated value per day, its warnings, and the rate card ───────── */

export function SpendCard({ usage }) {
  const rows = usage.byDay || []
  const names = (usage.byModel || []).filter(m => m.priced).map(m => m.model).slice(0, SERIES.length)
  const colors = {}; names.forEach((n, i) => { colors[n] = SERIES[i] })
  const scan = usage.scan || {}
  const unpriced = (usage.allTime || {}).unpricedTokens || 0
  const chartRows = rows.map(r => ({ date: r.date, by: r.byModel || {}, total: r.estUSD || 0 }))

  return (
    <Card title="Estimated value per day" note={(usage.pricing || {}).note || ''}
      right={<span className="bv-headline tnum">{usd((usage.allTime || {}).estUSD || 0)}</span>}>
      {scan.bytesTotal && !scan.complete ? (
        <div className="bv-warnbar">
          Indexing transcripts — {Math.floor((scan.bytesDone / scan.bytesTotal) * 100)}% of {compact(scan.bytesTotal)}B read.
          Figures are partial and climbing.
        </div>
      ) : null}
      {unpriced ? (
        <div className="bv-warnbar">
          {compact(unpriced)} tokens ran on models with no entry in the rate card and are left out of every dollar figure.
        </div>
      ) : null}
      <StackedBarChart rows={chartRows} names={names} colors={colors} yFmt={usdShort} tipValue={usd}
        totalLabel="day" ariaLabel="Estimated API list value per day" />
      <Legend items={names.map(n => ({
        color: colors[n], label: shortModel(n),
        value: usd(chartRows.reduce((a, r) => a + (Number(r.by[n]) || 0), 0)),
      }))} />
    </Card>
  )
}

export function RateCard({ pricing }) {
  const pr = pricing || {}
  return (
    <Card title="Rate card" note="A dollar figure whose arithmetic you cannot inspect is a number to distrust.">
      {pr.rates ? (
        <>
          <div className="bv-table-scroll">
            <table className="bv-table">
              <thead><tr><th>Model</th><th>Input $/M</th><th>Output $/M</th></tr></thead>
              <tbody>
                {pr.rates.map(r => (
                  <tr key={r.model}>
                    <td>{shortModel(r.model)}</td>
                    <td className="tnum">{r.input.toFixed(2)}</td>
                    <td className="tnum">{r.output.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="bv-list">
            <li>Cache read is {pr.cacheRead}x the input rate; cache write {pr.cacheWrite5m}x (5-minute TTL) and {pr.cacheWrite1h}x (1-hour).</li>
            {(pr.caveats || []).map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      ) : <Empty>No rate card in this reading.</Empty>}
    </Card>
  )
}

/* ── what is driving usage ──────────────────────────────────────────── */

const WINDOWS = [['day', 'Last 24h'], ['week', '7 days'], ['all', 'All time']]

export function DriversCard({ usage }) {
  const [winSel, setWinSel] = useState('day')
  const w = (usage.windows || {})[winSel] || {}
  const drivers = w.drivers || []
  const colors = [SERIES[1], SERIES[4], SERIES[0], SERIES[3]]

  return (
    <Card title="What is driving it"
      right={(
        <span className="bv-winbtns">
          {WINDOWS.map(([k, label]) => (
            <button key={k} className="bv-toggle" aria-pressed={k === winSel} onClick={() => setWinSel(k)}>{label}</button>
          ))}
        </span>
      )}>
      <p className="bv-note" style={{ margin: '0 0 6px' }}>
        {w.sessions
          ? `${usd(w.estUSD)} across ${w.sessions} session${w.sessions === 1 ? '' : 's'} · ${full(w.requests)} requests`
          : 'Nothing in this window.'}
      </p>
      <div className="bv-drivers-scroll">
        {drivers.map((d, i) => (
          <MeterBar key={i} pct={d.pct} label={d.pct + '%'} right={d.label} note={d.note || ''}
            color={colors[i % colors.length]} />
        ))}
      </div>
    </Card>
  )
}

/* ── sessions: sortable, because "most recent" and "most expensive" are
      different questions ─────────────────────────────────────────────── */

const SESSION_COLS = [
  { key: 'label', label: 'Session' },
  { key: 'project', label: 'Project' },
  { key: 'last', label: 'Active' },
  { key: 'hours', label: 'Length' },
  { key: 'requests', label: 'Requests' },
  { key: 'toolCalls', label: 'Tools' },
  { key: 'maxContext', label: 'Peak ctx' },
  { key: 'estUSD', label: 'Est. value' },
]

export function SessionsTable({ usage }) {
  const [sort, setSort] = useState({ key: 'last', dir: -1 })
  const rows = (usage.sessions || []).map(r => ({ ...r, label: r.title || r.id }))
  const k = sort.key
  rows.sort((a, b) => {
    const x = a[k], y = b[k]
    const c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x || '').localeCompare(String(y || ''))
    return c * sort.dir
  })

  return (
    <Card title="Sessions"
      note="One row per Claude Code session, newest first. Value is estimated at API list prices — click a column to sort."
      right={rows.length ? <span className="bv-sub">{rows.length} indexed</span> : null}>
      <div className="bv-table-scroll tall">
        <table className="bv-table">
          <thead>
            <tr>
              {SESSION_COLS.map(c => (
                <th key={c.key} style={{ cursor: 'pointer' }}
                  onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key ? -s.dir : -1 }))}>
                  {c.label + (k === c.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : '')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={SESSION_COLS.length} className="bv-empty">No sessions indexed yet.</td></tr>}
            {rows.map(r => (
              <tr key={r.id} title={[r.path, r.branch, r.first ? 'started ' + new Date(r.first).toLocaleString() : ''].filter(Boolean).join(' · ')}>
                <td className={'bv-td-project' + (r.title ? '' : ' mono')}>{r.label}</td>
                <td>{r.project || '—'}</td>
                <td>{ago(r.last)}</td>
                <td className="tnum">{r.hours >= 1 ? r.hours.toFixed(1) + 'h' : Math.round(r.hours * 60) + 'm'}</td>
                <td className="tnum">{full(r.requests)}</td>
                <td className="tnum">{full(r.toolCalls)}</td>
                <td className="tnum" style={r.maxContext > 150000 ? { color: WARNING } : undefined}>{compact(r.maxContext)}</td>
                <td className="tnum usd" title={r.subUSD ? `${usd(r.subUSD)} of it ran as subagents` : undefined}>{usd(r.estUSD)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function HoursCard({ hours }) {
  return (
    <Card title="Sessions by hour" note="When the work actually happens, over all indexed sessions.">
      <HourChart hours={hours || {}} />
    </Card>
  )
}

export function ActivityCard({ daily }) {
  return (
    <Card title="Daily activity" note="Messages and tool calls per day.">
      <ActivityChart daily={daily || []} />
    </Card>
  )
}

/* ── all-time models table ──────────────────────────────────────────── */

export function ModelsTable({ claude, usage }) {
  const models = claude.models || []
  const card = usage.pricing || {}
  const note = claude.costReported
    ? 'Cost as reported by the CLI.'
    : 'The CLI reports $0 per model on this plan — a flat subscription has no per-request price. '
      + 'Value is these token counts priced at API list rates, for comparison only. '
      + 'These counts come from stats-cache.json'
      + (claude.lastComputedDate ? `, which Claude Code last recomputed on ${claude.lastComputedDate}` : '')
      + ', and include sessions whose transcripts have since been pruned. The per-day and per-session '
      + 'panels read the transcripts on disk instead — current to the last request, missing anything pruned. '
      + 'The two totals are not meant to match.'

  return (
    <Card title="All-time, by model" note={note}>
      <div className="bv-table-scroll">
        <table className="bv-table">
          <thead>
            <tr><th>Model</th><th>Est. value</th><th>Output</th><th>Input</th><th>Cache read</th><th>Cache write</th></tr>
          </thead>
          <tbody>
            {models.map((m, i) => {
              const e = estimateRow(card, m)
              return (
                <tr key={m.model}>
                  <td>
                    <span className="bv-swatchname">
                      <span className="sw" style={{ background: SERIES[i % SERIES.length] }} />
                      <span>{shortModel(m.model)}</span>
                    </span>
                  </td>
                  <td className="tnum usd" title={e === null ? 'No entry in the rate card — counted in tokens, left out of every dollar figure.' : undefined}>
                    {e === null ? 'unpriced' : usd(e)}
                  </td>
                  {[m.output, m.input, m.cacheRead, m.cacheCreate].map((v, j) => (
                    <td key={j} className="tnum" title={full(v)}>{compact(v)}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* ── running now ────────────────────────────────────────────────────── */

export function LiveCard({ live, toolId }) {
  const sup = live.supervisor || {}
  const procs = (live.processes || []).filter(p => procTool(p) === toolId)
  return (
    <Card title="Running now"
      note={toolId === 'codex'
        ? 'Live codex processes on this machine. Paths inside ~/.codex are not matched — only the binary.'
        : 'Live claude processes on this machine.'}
      right={toolId === 'claude-code' ? (
        <Pill tone={sup.alive ? 'ok' : sup.pid ? 'bad' : 'warn'} title={sup.startedAt ? 'since ' + sup.startedAt : ''}>
          {sup.alive ? `supervisor up · pid ${sup.pid}` : sup.pid ? 'supervisor down' : 'no supervisor'}
        </Pill>
      ) : null}>
      {!procs.length && <Empty>Nothing running.</Empty>}
      {procs.length > 0 && (
        <ul className="bv-feed">
          {procs.map(p => (
            <li key={p.pid} title={p.cmd}>
              <div className="name">
                <span className={'bv-tag' + (p.headless ? ' warn' : ' ok')}>{p.kind || procTool(p)}</span>
                <span className="mono">pid {p.pid}</span>
              </div>
              <div className="meta">
                <span>up {p.elapsed}</span>
                {p.model && <span>{shortModel(p.model)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ── feeds ──────────────────────────────────────────────────────────── */

export function ProjectsFeed({ projects }) {
  const list = projects || []
  return (
    <Card title="Projects" note="Working directories Claude Code has run in.">
      <ul className="bv-feed">
        {!list.length && <li className="bv-empty">No projects yet.</li>}
        {list.slice(0, 50).map((p, i) => (
          <li key={i} title={p.path}>
            <div className="name">
              <span className="txt">{p.label}</span>
              {p.worktree && <span className="bv-tag warn">worktree</span>}
            </div>
            <div className="meta">
              <span>{p.sessions} session{p.sessions === 1 ? '' : 's'}</span>
              <span>{p.branch || '—'}</span>
              <span>{ago(p.lastActive)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function PromptsFeed({ prompts }) {
  const list = prompts || []
  return (
    <Card title="Prompts" note="The most recent prompts, if the agent is configured to send them.">
      <ul className="bv-feed">
        {!list.length && (
          <li className="bv-empty">Not collected. The agent withholds prompt text unless TOKENHUD_SEND_PROMPTS=1.</li>
        )}
        {list.slice(0, 20).map((p, i) => (
          <li key={i}>
            <div className="txt">{p.text || '—'}</div>
            <div className="meta">
              <span>{(p.project || '').split('/').pop() || '—'}</span>
              <span>{ago(p.at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function HostsFeed({ hosts }) {
  const list = hosts || []
  return (
    <Card title="Machines" note="Every agent that reports to this server, and whether it still is.">
      <ul className="bv-feed">
        {!list.length && <li className="bv-empty">No machines reporting.</li>}
        {list.map(h => (
          <li key={h.host}>
            <div className="name">
              <Pill tone={h.status === 'up' ? 'ok' : h.status === 'stale' ? 'warn' : 'bad'}>{h.status}</Pill>
              <span>{h.host}</span>
            </div>
            <div className="meta">
              <span>agent {h.agent_version || '?'}</span>
              <span>last seen {ago(h.last_seen)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/* ── the stated absence, for a detected assistant with no collector ─── */

export function Offboard({ assistant: a }) {
  return (
    <Card title={a.name} note={a.note} warn>
      <div className="bv-sub" style={{ display: 'grid', gap: 4 }}>
        {a.sessions != null && <div>{full(a.sessions)} sessions on disk</div>}
        {(a.paths || []).map((p, i) => <div className="mono" key={i}>{p}</div>)}
        {a.bin && <div className="mono">{a.bin}</div>}
      </div>
    </Card>
  )
}

/* ── every integration TokenHUD knows about, and what to do about it ──
   The board used to list only tools it could already read, which answers
   "what can I see?" and leaves "why can't I see Gemini?" hanging. A tile
   with no numbers is only useful if it says what would give it some, so
   the ones a person can act on carry their steps. */

const INT_STATES = [
  { key: 'reading', label: 'Read by this board', tone: 'ok' },
  { key: 'ready', label: 'Ready — nothing recorded yet', tone: 'ok' },
  { key: 'needs-setup', label: 'One step away', tone: 'warn' },
  { key: 'api-only', label: 'Needs an API key', tone: 'warn' },
  { key: 'cloud-only', label: 'Web products — nothing local', tone: '' },
  { key: 'absent', label: 'Not installed here', tone: '' },
]

function IntegrationRow({ row }) {
  const [open, setOpen] = useState(false)
  const steps = row.steps || []
  const actionable = steps.length > 0
  return (
    <li className="bv-int">
      <div className="bv-int-head">
        <div className="name">
          <span>{row.name}</span>
          {row.confidence === 'documented' && (
            <span className="bv-int-flag" title="From the tool's own documentation — not yet confirmed by opening it here.">
              documented
            </span>
          )}
        </div>
        {actionable && (
          <button className="bv-int-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'Hide' : row.state === 'reading' ? 'Details' : 'How to enable'}
          </button>
        )}
      </div>
      <p className="bv-int-note">{row.headline}</p>
      {open && (
        <div className="bv-int-body">
          <ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <p className="bv-sub"><b>Where:</b> {row.where}</p>
          <p className="bv-sub"><b>What you get:</b> {row.fields}</p>
          {row.docs && (
            <a className="bv-int-docs" href={row.docs} target="_blank" rel="noreferrer">
              Official documentation →
            </a>
          )}
        </div>
      )}
    </li>
  )
}

export function IntegrationsCard({ integrations, summary }) {
  const rows = integrations || []
  const [showAll, setShowAll] = useState(false)
  if (!rows.length) return null
  const s = summary || {}
  // A tool that is here and unreadable is the whole reason for this panel,
  // so those groups lead. What is merely absent sits behind a disclosure —
  // it is a catalogue, not a to-do list.
  const quiet = new Set(['absent', 'cloud-only'])
  const groups = INT_STATES
    .map(g => ({ ...g, items: rows.filter(r => r.state === g.key) }))
    .filter(g => g.items.length && (showAll || !quiet.has(g.key)))
  const hidden = rows.filter(r => quiet.has(r.state)).length

  return (
    <Card
      title="Integrations"
      note={`${s.known || rows.length} tools tracked · ${s.reading || 0} read here · ${(s.needsSetup || 0) + (s.apiOnly || 0)} could be`}
      right={<Pill tone="ok">{s.installed || 0} installed</Pill>}
    >
      <div className="bv-int-groups">
        {groups.map(g => (
          <div key={g.key} className="bv-int-group">
            <h3>
              <Pill tone={g.tone}>{g.items.length}</Pill>
              <span>{g.label}</span>
            </h3>
            <ul>{g.items.map(r => <IntegrationRow key={r.id} row={r} />)}</ul>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button className="bv-int-more" onClick={() => setShowAll(a => !a)}>
          {showAll ? 'Hide' : `Show ${hidden} more`} — tools not on this machine
        </button>
      )}
    </Card>
  )
}

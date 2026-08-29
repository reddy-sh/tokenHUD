import { useMemo, useState } from 'react'

/* The Integrations section: every tool TokenHUD knows about, across all
 * machines. The board-embedded IntegrationsCard shows one machine at a time;
 * this page merges them so you see the fleet-wide picture: which tools are
 * read anywhere, which could be, and what each machine needs to get there.
 *
 * The data comes from each snapshot's `metrics.integrations` array. Each row
 * has: id, name, state, headline, steps[], where, fields, docs, installed,
 * hasData, access, confidence. */

/* ── brand colours for the tool cards ────────────────────────────── */
const TOOL_META = {
  'claude-code':  { accent: '#d97706', initial: 'C' },
  'codex':        { accent: '#10b981', initial: 'X' },
  'cursor':       { accent: '#a78bfa', initial: 'Cu' },
  'gemini-cli':   { accent: '#60a5fa', initial: 'G' },
  'copilot':      { accent: '#6366f1', initial: 'Co' },
  'copilot-cli':  { accent: '#6366f1', initial: 'Co' },
  'copilot-org':  { accent: '#6366f1', initial: 'Co' },
  'windsurf':     { accent: '#06b6d4', initial: 'W' },
  'antigravity':  { accent: '#f472b6', initial: 'Ag' },
  'aider':        { accent: '#34d399', initial: 'Ai' },
  'devin':        { accent: '#818cf8', initial: 'D' },
  'cline':        { accent: '#fb923c', initial: 'Cl' },
  'roo-code':     { accent: '#f87171', initial: 'R' },
  'amazon-q':     { accent: '#f59e0b', initial: 'Q' },
  'augment':      { accent: '#2dd4bf', initial: 'Au' },
  'tabnine':      { accent: '#c084fc', initial: 'T' },
  'supermaven':   { accent: '#fbbf24', initial: 'S' },
  'continue':     { accent: '#4ade80', initial: 'Cn' },
  'sourcegraph':  { accent: '#f97316', initial: 'Sg' },
  'openrouter':   { accent: '#e879f9', initial: 'Or' },
  'opencode':     { accent: '#a3e635', initial: 'Oc' },
  'kilo-code':    { accent: '#38bdf8', initial: 'K' },
  'goose':        { accent: '#fcd34d', initial: 'Go' },
  'lm-studio':    { accent: '#c4b5fd', initial: 'Lm' },
  'ollama':       { accent: '#d4d4d4', initial: 'Ol' },
  'jetbrains-ai': { accent: '#f97316', initial: 'Jb' },
  'zed':          { accent: '#a78bfa', initial: 'Z' },
  'provider-api': { accent: '#94a3b8', initial: 'Pa' },
  'replit':       { accent: '#fb923c', initial: 'Re' },
  'v0':           { accent: '#e2e8f0', initial: 'V' },
  'bolt':         { accent: '#fbbf24', initial: 'B' },
  'lovable':      { accent: '#f472b6', initial: 'L' },
}
const fallbackMeta = (id) => ({
  accent: '#94a3b8',
  initial: (id || '?').charAt(0).toUpperCase(),
})

/* Tools that have real board panels in Token Monitoring (the sidebar's
   ASSISTANT section). Only these should navigate away on click. */
const BOARD_TOOLS = new Set(['claude-code', 'codex', 'devin', 'copilot', 'copilot-cli'])

const STATE_LABEL = {
  reading:      'Connected',
  ready:        'Ready',
  'needs-setup': 'Setup needed',
  'api-only':   'API key needed',
  'cloud-only': 'Cloud only',
  absent:       'Not installed',
}

const FILTERS = [
  { key: 'all',     label: 'All' },
  { key: 'reading', label: 'Connected' },
  { key: 'action',  label: 'Action needed' },
  { key: 'other',   label: 'Other' },
]

/* When the agent hasn't been upgraded to report `integrations` yet, build
   equivalent rows from the older `assistants` array so the page isn't empty. */
function fromAssistants(assistants) {
  return (assistants || []).map(a => ({
    id: a.id,
    name: a.name,
    state: a.hasData ? 'reading' : a.supported ? 'needs-setup' : 'api-only',
    headline: a.note || (a.hasData ? 'Read by this board.' : a.supported
      ? 'Supported, but nothing recorded on this machine yet.'
      : 'Installed here. It does not write usage data this board can read.'),
    installed: a.detected ?? true,
    hasData: a.hasData ?? false,
    confidence: a.hasData ? 'verified' : 'documented',
    steps: [],
    where: '',
    fields: '',
    docs: null,
  }))
}

/* Merge integrations across all machines. For each tool, pick the "best"
   state (reading > ready > needs-setup > …) and note which machines have it. */
function mergeIntegrations(snapshots) {
  const byId = new Map()
  const stateRank = { reading: 0, ready: 1, 'needs-setup': 2, 'api-only': 3, 'cloud-only': 4, absent: 5 }

  for (const snap of snapshots) {
    const host = snap.host || snap.metrics?.host?.hostname || '?'
    const rows = snap.metrics?.integrations || fromAssistants(snap.metrics?.assistants)
    for (const row of rows) {
      const existing = byId.get(row.id)
      if (!existing) {
        byId.set(row.id, {
          ...row,
          machines: [{ host, state: row.state, installed: row.installed, hasData: row.hasData }],
          bestState: row.state,
        })
      } else {
        existing.machines.push({ host, state: row.state, installed: row.installed, hasData: row.hasData })
        if ((stateRank[row.state] ?? 99) < (stateRank[existing.bestState] ?? 99)) {
          existing.bestState = row.state
          existing.headline = row.headline
          existing.steps = row.steps
          existing.where = row.where
          existing.fields = row.fields
          existing.docs = row.docs
        }
      }
    }
  }
  return [...byId.values()]
}

/* ── status icon: checkmark, warning, or neutral ─────────────────── */
function StatusIcon({ state }) {
  if (state === 'reading')
    return (
      <span className="mkt-status mkt-status--ok" title="Connected — reading data">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </span>
    )
  if (state === 'ready')
    return (
      <span className="mkt-status mkt-status--ok" title="Ready — nothing recorded yet">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </span>
    )
  if (state === 'needs-setup')
    return (
      <span className="mkt-status mkt-status--warn" title="One step away">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </span>
    )
  return (
    <span className="mkt-status mkt-status--off" title={STATE_LABEL[state] || state}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2"/></svg>
    </span>
  )
}

/* ── a single tool card (grid view) ──────────────────────────────── */
function ToolCard({ row, multi, onSelect, onNavigate }) {
  const meta = TOOL_META[row.id] || fallbackMeta(row.id)
  const isConnected = row.bestState === 'reading' || row.bestState === 'ready'
  const canNavigate = isConnected && BOARD_TOOLS.has(row.id)

  const handleClick = () => {
    if (canNavigate && onNavigate) {
      onNavigate(row.id)
    } else {
      onSelect(row)
    }
  }

  return (
    <div
      className={'mkt-card' + (isConnected ? ' mkt-card--active' : '') + ' mkt-card--click'}
      onClick={handleClick}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() } }}
    >
      <StatusIcon state={row.bestState} />

      <div className="mkt-logo" style={{ '--tool-accent': meta.accent }}>
        <span>{meta.initial}</span>
      </div>

      <h3 className="mkt-name">{row.name}</h3>
      <span className={'mkt-label mkt-label--' + row.bestState}>
        {STATE_LABEL[row.bestState] || row.bestState}
      </span>

      <p className="mkt-note">{row.headline}</p>

      {multi && row.machines?.length > 1 && (
        <div className="mkt-machines">
          {row.machines.map((m, i) => (
            <span key={i} className="mkt-machine" title={`${m.host}: ${STATE_LABEL[m.state] || m.state}`}>
              <span className={'sh-dot sh-dot--' + (m.state === 'reading' ? 'ok' : m.state === 'ready' ? 'ok' : m.state === 'needs-setup' ? 'warn' : 'off')} />
              <span>{m.host}</span>
            </span>
          ))}
        </div>
      )}

      <span className="mkt-action">
        {canNavigate ? 'View metrics →' : isConnected ? 'Details →' : 'Setup steps →'}
      </span>
    </div>
  )
}

/* ── full-width detail view (content area) ───────────────────────── */
function DetailView({ row, multi, onBack }) {
  const meta = TOOL_META[row.id] || fallbackMeta(row.id)
  const steps = row.steps || []
  const isConnected = row.bestState === 'reading' || row.bestState === 'ready'

  return (
    <div className="mkt-detail-page">
      <button className="mkt-back" onClick={onBack}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to Integrations
      </button>

      <div className="mkt-detail-header">
        <div className="mkt-logo mkt-logo--lg" style={{ '--tool-accent': meta.accent }}>
          <span>{meta.initial}</span>
        </div>
        <div className="mkt-detail-title">
          <h2>{row.name}</h2>
          <span className={'mkt-label mkt-label--' + row.bestState}>
            {STATE_LABEL[row.bestState] || row.bestState}
          </span>
        </div>
      </div>

      <p className="mkt-detail-headline">{row.headline}</p>

      {multi && row.machines?.length > 0 && (
        <div className="mkt-detail-section">
          <h3>Machines</h3>
          <div className="mkt-machines">
            {row.machines.map((m, i) => (
              <span key={i} className="mkt-machine" title={`${m.host}: ${STATE_LABEL[m.state] || m.state}`}>
                <span className={'sh-dot sh-dot--' + (m.state === 'reading' ? 'ok' : m.state === 'ready' ? 'ok' : m.state === 'needs-setup' ? 'warn' : 'off')} />
                <span>{m.host}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {steps.length > 0 && (
        <div className="mkt-detail-section">
          <h3>{isConnected ? 'How it works' : 'How to enable'}</h3>
          <ol className="mkt-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <span className="mkt-step-n">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(row.where || row.fields) && (
        <div className="mkt-detail-section mkt-detail-meta">
          {row.where && <p><b>Where:</b> {row.where}</p>}
          {row.fields && <p><b>What you get:</b> {row.fields}</p>}
        </div>
      )}

      {row.docs && (
        <div className="mkt-detail-section">
          <a className="mkt-docs-btn" href={row.docs} target="_blank" rel="noreferrer">
            Official documentation ↗
          </a>
        </div>
      )}
    </div>
  )
}

/* ── the page ────────────────────────────────────────────────────── */

export default function IntegrationsPage({ snapshots, onNavigate }) {
  const [filter, setFilter] = useState('all')
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState(null)

  const rows = useMemo(() => mergeIntegrations(snapshots || []), [snapshots])
  const multi = (snapshots || []).length > 1

  const summary = useMemo(() => {
    const count = (st) => rows.filter(r => r.bestState === st).length
    return {
      known: rows.length,
      reading: count('reading'),
      ready: count('ready'),
      needsSetup: count('needs-setup'),
      apiOnly: count('api-only'),
      installed: rows.filter(r => r.machines?.some(m => m.installed)).length,
    }
  }, [rows])

  /* detail view */
  if (selected) {
    const fresh = rows.find(r => r.id === selected.id) || selected
    return (
      <div className="adm-page adm-page--wide mkt-page">
        <DetailView row={fresh} multi={multi} onBack={() => setSelected(null)} />
      </div>
    )
  }

  const quiet = new Set(['absent', 'cloud-only'])
  const filtered = rows.filter(r => {
    if (!showAll && quiet.has(r.bestState)) return false
    if (filter === 'reading') return r.bestState === 'reading' || r.bestState === 'ready'
    if (filter === 'action') return r.bestState === 'needs-setup' || r.bestState === 'api-only'
    if (filter === 'other') return quiet.has(r.bestState)
    return true
  })
  const hidden = rows.filter(r => quiet.has(r.bestState)).length

  if (!rows.length) {
    return (
      <div className="adm-page adm-page--wide mkt-page">
        <div className="mkt-empty">
          <div className="mkt-empty-icon">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="4" y="8" width="40" height="32" rx="4" stroke="currentColor" strokeWidth="2"/><path d="M4 16h40M16 16v24M32 16v24" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3"/><circle cx="24" cy="30" r="4" stroke="currentColor" strokeWidth="1.5"/></svg>
          </div>
          <h2>No integrations yet</h2>
          <p>Once a machine reports, every tool TokenHUD knows about will appear here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="adm-page adm-page--wide mkt-page">
      {/* header strip */}
      <div className="mkt-header">
        <div className="mkt-header-left">
          <h2>Integrations</h2>
          <p className="mkt-subtitle">
            {summary.reading} connected · {summary.needsSetup + summary.apiOnly} available · {summary.known} tracked
          </p>
        </div>
        <div className="mkt-stats">
          <div className="mkt-stat">
            <span className="mkt-stat-n">{summary.reading}</span>
            <span className="mkt-stat-l">Reading</span>
          </div>
          <div className="mkt-stat">
            <span className="mkt-stat-n">{summary.installed}</span>
            <span className="mkt-stat-l">Installed</span>
          </div>
          <div className="mkt-stat">
            <span className="mkt-stat-n">{summary.known}</span>
            <span className="mkt-stat-l">Known</span>
          </div>
        </div>
      </div>

      {/* filter tabs */}
      <div className="mkt-filters">
        {FILTERS.map(f => (
          <button key={f.key}
            className={'mkt-filter' + (filter === f.key ? ' mkt-filter--on' : '')}
            onClick={() => { setFilter(f.key); if (f.key === 'other') setShowAll(true) }}>
            {f.label}
            {f.key === 'reading' && summary.reading > 0 && <span className="mkt-filter-n">{summary.reading + summary.ready}</span>}
            {f.key === 'action' && (summary.needsSetup + summary.apiOnly) > 0 && <span className="mkt-filter-n">{summary.needsSetup + summary.apiOnly}</span>}
          </button>
        ))}
      </div>

      {/* card grid */}
      <div className="mkt-grid">
        {filtered.map(r => (
          <ToolCard key={r.id} row={r} multi={multi}
            onSelect={setSelected} onNavigate={onNavigate} />
        ))}
      </div>

      {/* show hidden tools */}
      {filter === 'all' && hidden > 0 && (
        <button className="mkt-show-more" onClick={() => setShowAll(a => !a)}>
          {showAll ? 'Hide' : `Show ${hidden} more`} — tools not on {multi ? 'any machine' : 'this machine'}
        </button>
      )}
    </div>
  )
}

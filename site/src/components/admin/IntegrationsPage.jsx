import { useMemo, useState } from 'react'
import { Card, Pill } from '../board/panels'

/* The Integrations section: every tool TokenHUD knows about, across all
 * machines. The board-embedded IntegrationsCard shows one machine at a time;
 * this page merges them so you see the fleet-wide picture: which tools are
 * read anywhere, which could be, and what each machine needs to get there.
 *
 * The data comes from each snapshot's `metrics.integrations` array. Each row
 * has: id, name, state, headline, steps[], where, fields, docs, installed,
 * hasData, access, confidence. */

const STATE_ORDER = [
  { key: 'reading', label: 'Read by this board', tone: 'ok' },
  { key: 'ready', label: 'Ready — nothing recorded yet', tone: 'ok' },
  { key: 'needs-setup', label: 'One step away', tone: 'warn' },
  { key: 'api-only', label: 'Needs an API key', tone: 'warn' },
  { key: 'cloud-only', label: 'Web products — nothing local', tone: '' },
  { key: 'absent', label: 'Not installed here', tone: '' },
]

/* Merge integrations across all machines. For each tool, pick the "best"
   state (reading > ready > needs-setup > …) and note which machines have it. */
function mergeIntegrations(snapshots) {
  const byId = new Map()
  const stateRank = { reading: 0, ready: 1, 'needs-setup': 2, 'api-only': 3, 'cloud-only': 4, absent: 5 }

  for (const snap of snapshots) {
    const host = snap.host || snap.metrics?.host?.hostname || '?'
    const rows = snap.metrics?.integrations || []
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

function IntegrationRow({ row, multi }) {
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
            {open ? 'Hide' : row.bestState === 'reading' ? 'Details' : 'How to enable'}
          </button>
        )}
      </div>
      <p className="bv-int-note">{row.headline}</p>
      {multi && row.machines && row.machines.length > 0 && (
        <div className="bv-int-machines">
          {row.machines.map((m, i) => (
            <span key={i} className="bv-int-machine">
              <span className={'sh-dot sh-dot--' + (m.state === 'reading' ? 'ok' : m.state === 'ready' ? 'ok' : m.state === 'needs-setup' ? 'warn' : 'off')} />
              {m.host}
            </span>
          ))}
        </div>
      )}
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

export default function IntegrationsPage({ snapshots }) {
  const [showAll, setShowAll] = useState(false)

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

  const quiet = new Set(['absent', 'cloud-only'])
  const groups = STATE_ORDER
    .map(g => ({ ...g, items: rows.filter(r => r.bestState === g.key) }))
    .filter(g => g.items.length && (showAll || !quiet.has(g.key)))
  const hidden = rows.filter(r => quiet.has(r.bestState)).length

  if (!rows.length) {
    return (
      <div className="adm-page adm-page--wide">
        <Card title="Integrations" warn>
          <p style={{ padding: 'var(--space-md)' }}>
            No machines have reported integration data yet. Once a machine
            reports, every tool TokenHUD knows about will appear here with its
            status and setup steps.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="adm-page adm-page--wide">
      <Card
        title="Integrations"
        note={`${summary.known} tools tracked · ${summary.reading} read here · ${summary.needsSetup + summary.apiOnly} could be`}
        right={<Pill tone="ok">{summary.installed} installed</Pill>}
      >
        <div className="bv-int-groups">
          {groups.map(g => (
            <div key={g.key} className="bv-int-group">
              <h3>
                <Pill tone={g.tone}>{g.items.length}</Pill>
                <span>{g.label}</span>
              </h3>
              <ul>{g.items.map(r => <IntegrationRow key={r.id} row={r} multi={multi} />)}</ul>
            </div>
          ))}
        </div>
        {hidden > 0 && (
          <button className="bv-int-more" onClick={() => setShowAll(a => !a)}>
            {showAll ? 'Hide' : `Show ${hidden} more`} — tools not on {multi ? 'any machine' : 'this machine'}
          </button>
        )}
      </Card>
    </div>
  )
}

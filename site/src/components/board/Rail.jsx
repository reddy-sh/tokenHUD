import { Pill } from './panels'
import { ago, full } from './util'

/* The classic board's icon set, kept as bare stroke paths. */
const ICONS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  overview: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  window: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3.5 2',
  ended: 'M12 21a9 9 0 100-18 9 9 0 000 18z M8.5 12.5l2.5 2.5 4.5-5',
  activity: 'M4 19V5 M4 19h16 M7 15l4-5 3 3 5-7',
  value: 'M12 3v18 M16.5 6.5H10a3 3 0 000 6h4a3 3 0 010 6H7.5',
  sessions: 'M4 6h16 M4 12h16 M4 18h9',
  models: 'M12 3l8 4.5-8 4.5-8-4.5z M4 12l8 4.5 8-4.5 M4 16.5l8 4.5 8-4.5',
  running: 'M3 12h3.5L9 5.5 12.5 18l2.5-6h6',
  projects: 'M3 6h6l2 2.5h10V19H3z',
  machines: 'M4 5h16v5H4z M4 14h16v5H4z M7.5 7.5h.01 M7.5 16.5h.01',
  prompts: 'M4 5h16v10H10l-5 4v-4H4z',
  plug: 'M9 3v5 M15 3v5 M6 8h12v3a6 6 0 01-6 6 6 6 0 01-6-6z M12 17v4',
  tools: 'M14.5 6.5a3.5 3.5 0 004.8 4.5l-8 8a2.1 2.1 0 01-3-3l8-8a3.5 3.5 0 01-1.8-1.5z M4 5l3 3',
  shield: 'M12 3l7 3v5c0 4.2-2.8 7.9-7 10-4.2-2.1-7-5.8-7-10V6z M9 12l2 2 4-4',
  blocks: 'M4 4h7v7H4z M13 13h7v7h-7z M13 4h7v7h-7z M4 13h7v7H4z',
  'arrow-up': 'M12 19V5 M5 12l7-7 7 7',
  trophy: 'M7 4h10v5a5 5 0 01-10 0z M7 6H4v1a3 3 0 003 3 M17 6h3v1a3 3 0 01-3 3 M10 14h4 M12 14v4 M8.5 20h7',
  gauge: 'M4 18a8 8 0 1116 0 M11.3 14.7l4.2-5.2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.1 14.6a1.5 1.5 0 00.3 1.7l.1.1a2 2 0 11-2.9 2.8l-.1-.1a1.5 1.5 0 00-2.6 1.1V21a2 2 0 11-4 0v-.1a1.5 1.5 0 00-2.6-1l-.1.1a2 2 0 11-2.8-2.9l.1-.1a1.5 1.5 0 00-1-2.6H3a2 2 0 110-4h.1a1.5 1.5 0 001-2.6l-.1-.1a2 2 0 112.9-2.8l.1.1a1.5 1.5 0 002.6-1V3a2 2 0 114 0v.1a1.5 1.5 0 002.6 1l.1-.1a2 2 0 112.8 2.9l-.1.1a1.5 1.5 0 001 2.6H21a2 2 0 110 4h-.1a1.5 1.5 0 00-1.4 1z',
  link: 'M10.5 13.5a4 4 0 006 .5l2.5-2.5a4 4 0 00-5.7-5.7L12 7.1 M13.5 10.5a4 4 0 00-6-.5L5 12.5a4 4 0 005.7 5.7L12 16.9',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  share: 'M12 3v12 M8 7l4-4 4 4 M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5',
}

export const Ic = ({ name }) => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] || ICONS.overview} /></svg>
)

/* ── the standing rail: identity, pickers, nav, and the digest ──────── */

export default function Rail({
  data, cur, tool, assistants, picked, onPickHost, toolSel, onPickTool,
  nav, active, onNav, open, onClose, intervalSeconds,
}) {
  const hosts = (data && data.hosts) || []
  const payloads = (data && data.latest) || []
  const h = cur ? hosts.find(x => x.host === cur.host) : null
  const up = hosts.filter(x => x.status === 'up').length

  const withData = (assistants || []).filter(a => a.hasData)
  const installedOnly = (assistants || []).filter(a => !a.hasData)
  const installedNames = installedOnly.map(a => a.name).join(', ')

  const kv = cur ? [
    ['agent', cur.agentVersion || '?'],
    ['last seen', ago(h ? h.last_seen : cur.collectedAt)],
    ['reports', 'every ' + Math.round(intervalSeconds / 1000) + 's'],
    ['snapshots', full(((data || {}).store || {}).snapshots || 0)],
  ] : [['status', 'no agent has reported yet']]

  return (
    <aside className={'bv-rail' + (open ? ' open' : '')} aria-label="Workspace">
      <button className="bv-rail-close" onClick={onClose} aria-label="Close sidebar" title="Close">
        <Ic name="close" />
      </button>

      <section className="bv-rail-sec">
        <p className="bv-rail-lab">Machine</p>
        <div className="bv-rail-id">
          <span className="who">{cur ? cur.host : 'no machine'}</span>
          {h && <Pill tone={h.status === 'up' ? 'ok' : h.status === 'stale' ? 'warn' : 'bad'}>{h.status}</Pill>}
        </div>
        {payloads.length > 1 && (
          <select title="Machine" value={picked || (cur ? cur.host : '')} onChange={e => onPickHost(e.target.value)}>
            {payloads.map(p => <option key={p.host} value={p.host}>{p.host}</option>)}
          </select>
        )}
        <dl className="bv-rail-kv">
          {kv.map(([k, v]) => [<dt key={k + '-t'}>{k}</dt>, <dd key={k + '-d'}>{v}</dd>])}
        </dl>
      </section>

      <section className="bv-rail-sec">
        <p className="bv-rail-lab">Assistant</p>
        {withData.length > 1 ? (
          <select title="Coding assistant" value={toolSel} onChange={e => onPickTool(e.target.value)}>
            {withData.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        ) : (
          tool && <p className="bv-rail-note">{tool.name}{tool.supported ? '' : ' · no collector reads this yet'}</p>
        )}
        {installedNames && <p className="bv-rail-sub">also installed, no usage data: {installedNames}</p>}
      </section>

      <nav className="bv-rail-nav" aria-label="Board sections">
        {nav.map(row => (
          <a key={row.id} href={'#' + row.id}
            aria-current={active === row.id ? 'location' : undefined}
            onClick={e => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
              onNav(row.id)
            }}>
            <Ic name={row.icon} />
            <span className="lb">{row.label}</span>
            <span className={'n' + (row.tone ? ' ' + row.tone : '')}>{row.badge == null ? '' : String(row.badge)}</span>
          </a>
        ))}
      </nav>

      <div className="bv-rail-foot">
        <button className="bv-railprint" title="Print the board, or save it as a PDF" onClick={() => window.print()}>
          Save as PDF
        </button>
        <a href="#p-machines" className="bv-rail-fleet" onClick={() => onNav('p-machines')}>
          <Ic name="machines" />
          <span>
            {hosts.length
              ? `${hosts.length} machine${hosts.length === 1 ? '' : 's'} reporting · ${up} up`
              : 'no machines reporting'}
          </span>
        </a>
      </div>
    </aside>
  )
}

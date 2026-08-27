import { Ic } from './icons'
import { Pill } from './panels'
import { ago, full } from './util'

/* ── the standing rail: identity, pickers, nav, and the digest ──────────
 *
 * Nothing mounts this today. BoardView is the only importer and both of its
 * callers - the cloud Portal and the self-host board - pass `embedded`, which
 * returns the panels alone before this rail is reached; the admin shell draws
 * the navigation instead. It is left standing rather than deleted because the
 * standalone board it belongs to is still a render path in BoardView, and half
 * of a path is worse than all of it. The icons it used to own moved to
 * icons.jsx, which is the part that is genuinely live. */

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

import { useRef, useState } from 'react'
import { Ic } from '../board/Rail'
import { Pill } from '../board/panels'

function MachineRow({ h, isCur, outdated, collapsed, onPick, onRename, onRemove }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  const displayName = h.label || h.host
  const subtitle = h.label ? h.host : null

  const startEdit = (e) => {
    e.stopPropagation()
    setDraft(h.label || h.host)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const doRemove = (e) => {
    e.stopPropagation()
    onRemove(h.host)
  }

  const commitEdit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    const newLabel = (trimmed === h.host || !trimmed) ? '' : trimmed
    if (newLabel !== (h.label || '')) onRename(h.machine_id, newLabel)
  }

  if (editing && !collapsed) {
    return (
      <div className="adm-item adm-item--on adm-item--editing">
        <input ref={inputRef} className="adm-rename-input"
          value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
          autoFocus
        />
      </div>
    )
  }

  return (
    <div className={'adm-item adm-item--btn adm-machine-row' + (isCur ? ' adm-item--on' : '')}
      title={collapsed ? displayName : `${h.host} · v${h.agent_version || '?'}\nDouble-click to rename`}
      onClick={onPick}
      onDoubleClick={h.machine_id ? startEdit : undefined}
      role="button" tabIndex={0}>
      <span className={'sh-dot sh-dot--' + (h.status === 'up' ? 'ok' : h.status === 'stale' ? 'warn' : 'off')} />
      {!collapsed && (
        <>
          <span className="adm-item-text">
            {displayName}
            <span className="adm-item-ver tnum">
              {subtitle ? `${subtitle} · ` : ''}v{h.agent_version || '?'}
            </span>
          </span>
          {outdated
            ? <span className="adm-item-badge">
                <Pill tone="warn">upgrade</Pill>
              </span>
            : <span className="adm-item-badge">
                <Pill tone={h.status === 'up' ? 'ok' : h.status === 'stale' ? 'warn' : 'bad'}>
                  {h.status}
                </Pill>
              </span>
          }
          <button className="adm-machine-remove" onClick={doRemove}
            title={`Remove ${displayName}`} aria-label="Remove machine">&times;</button>
        </>
      )}
    </div>
  )
}

export default function AdminSidebar({
  collapsed, onCollapse, phase,
  /* board state — null when not live */
  board,
  /* setup-time data */
  hosts, serverUrl,
  onPhase,
  latestRelease,
  onRename,
  onRemove,
}) {
  const bs = board || {}
  const nav = bs.nav || []
  const active = bs.active
  const curHost = bs.cur?.host
  const machineHosts = hosts || bs.hosts || []
  const assistants = bs.assistants || []
  const withData = assistants.filter(a => a.hasData)

  const anyOutdated = latestRelease && machineHosts.some(h =>
    h.agent_version && h.agent_version !== latestRelease
  )

  return (
    <aside className={'adm-side' + (collapsed ? ' adm-side--mini' : '')}>
      <div className="adm-side-scroll">

        {/* ── machines ── */}
        <div className="adm-group">
          {!collapsed && <span className="adm-group-label">MACHINES</span>}
          {machineHosts.length === 0 && !collapsed && (
            <div className="adm-item adm-item--dim">No machines yet</div>
          )}
          {machineHosts.map(h => (
            <MachineRow key={h.machine_id || h.host} h={h}
              isCur={h.host === curHost}
              outdated={latestRelease && h.agent_version && h.agent_version !== latestRelease}
              collapsed={collapsed}
              onPick={() => {
                if (bs.onPickHost) bs.onPickHost(h.host)
                if (phase !== 'live') onPhase('live')
              }}
              onRename={onRename}
              onRemove={onRemove}
            />
          ))}
          {!collapsed && phase === 'live' && bs.onAdd && (
            <button className="adm-item adm-item--btn adm-item--add" onClick={bs.onAdd}>
              <span className="adm-plus">+</span>
              <span>Add machine</span>
            </button>
          )}
          {!collapsed && phase === 'live' && bs.onUpgrade && anyOutdated && (
            <button className="adm-item adm-item--btn adm-item--upgrade" onClick={bs.onUpgrade}>
              <Ic name="arrow-up" />
              <span>Upgrade agents</span>
            </button>
          )}
        </div>

        {/* ── assistant picker (when multiple) ── */}
        {!collapsed && withData.length > 1 && (
          <div className="adm-group">
            <span className="adm-group-label">ASSISTANT</span>
            {withData.map(a => (
              <button key={a.id}
                className={'adm-item adm-item--btn' + (bs.toolId === a.id ? ' adm-item--on' : '')}
                onClick={() => bs.onPickTool?.(a.id)}>
                <Ic name="plug" />
                <span>{a.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* ── section nav (from board) ── */}
        {phase === 'live' && nav.length > 0 && (
          <div className="adm-group">
            {!collapsed && <span className="adm-group-label">DASHBOARD</span>}
            {nav.map(row => (
              <a key={row.id} href={'#' + row.id}
                className={'adm-item adm-item--btn' + (active === row.id ? ' adm-item--on' : '')}
                title={collapsed ? row.label : undefined}
                onClick={e => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                  bs.onNav?.(row.id)
                }}>
                <Ic name={row.icon} />
                {!collapsed && (
                  <>
                    <span className="adm-item-text">{row.label}</span>
                    {row.badge != null && (
                      <span className={'adm-nav-n' + (row.tone ? ' ' + row.tone : '')}>{row.badge}</span>
                    )}
                  </>
                )}
              </a>
            ))}
          </div>
        )}

        {/* ── setup link ── */}
        {phase !== 'live' && (
          <div className="adm-group">
            {!collapsed && <span className="adm-group-label">SETUP</span>}
            <div className={'adm-item' + (phase === 'setup' ? ' adm-item--on' : '')}
              title={collapsed ? 'Get started' : undefined}>
              <Ic name="overview" />
              {!collapsed && <span>Get started</span>}
            </div>
          </div>
        )}
      </div>

      <div className="adm-side-foot">
        <button className="adm-collapse" onClick={onCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Ic name={collapsed ? 'menu' : 'close'} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  )
}

import { Ic } from '../board/Rail'

/* The root navigation: the outermost rail, and the only one that changes what
 * the content area *is* rather than where in it you are looking.
 *
 * Two levels, because they answer different questions. This one answers "which
 * product am I in" — token monitoring, or the leaderboard. The rail beside it,
 * which only exists inside Token Monitoring, answers "which machine, and which
 * part of its board". Collapsing them is independent for the same reason: on a
 * narrow screen the machine list is what you give up first, and the section
 * switch is what you keep.
 *
 * `SECTIONS` is the whole route table. Adding a product here and a branch in
 * the shell's content area is the entire cost of a new one. */

export const SECTIONS = [
  {
    key: 'monitoring',
    label: 'Token Monitoring',
    icon: 'gauge',
    group: 'Monitoring',
    hint: 'Machines, sessions, models, spend and governance',
  },
  {
    key: 'leaderboard',
    label: 'Leaderboard',
    icon: 'trophy',
    group: 'Monitoring',
    hint: 'How every machine on this board compares',
  },
  {
    key: 'integrations',
    label: 'Integrations',
    icon: 'plug',
    group: 'Monitoring',
    hint: 'Every tool this board knows, and what it can read',
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    group: 'Workspace',
    hint: 'Connection, appearance, public links and this server',
  },
]

export default function RootRail({
  section, onSection, collapsed, onCollapse, badges, serverLabel, shared,
}) {
  const groups = []
  for (const s of SECTIONS) {
    const at = groups.find(g => g.name === s.group)
    if (at) at.rows.push(s)
    else groups.push({ name: s.group, rows: [s] })
  }

  return (
    <aside className={'adm-root' + (collapsed ? ' adm-root--mini' : '')} aria-label="Sections">
      <div className="adm-root-scroll">
        {groups.map(g => (
          <div className="adm-group" key={g.name}>
            {!collapsed && <span className="adm-group-label">{g.name.toUpperCase()}</span>}
            {g.rows.map(row => {
              const badge = badges?.[row.key]
              return (
                <button
                  key={row.key}
                  type="button"
                  className={'adm-item adm-item--btn adm-root-item' + (section === row.key ? ' adm-item--on' : '')}
                  aria-current={section === row.key ? 'page' : undefined}
                  title={collapsed ? row.label : row.hint}
                  onClick={() => onSection(row.key)}
                >
                  <Ic name={row.icon} />
                  {!collapsed && (
                    <>
                      <span className="adm-item-text">{row.label}</span>
                      {badge != null && <span className="adm-nav-n">{badge}</span>}
                    </>
                  )}
                  {collapsed && badge != null && <span className="adm-root-dot" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="adm-root-foot">
        {/* The self-host board has no user account to show, so the identity
            block shows the thing that actually identifies this session: which
            server it is reading, and whether any of it is public. */}
        <button
          type="button"
          className={'adm-whoami' + (section === 'settings' ? ' on' : '')}
          onClick={() => onSection('settings')}
          title={collapsed ? `${serverLabel} — settings` : 'Connection and preferences'}
        >
          <span className="adm-whoami-badge"><Ic name="user" /></span>
          {!collapsed && (
            <span className="adm-whoami-text">
              <b>Self-hosted</b>
              <span>{serverLabel}</span>
            </span>
          )}
          {shared && (
            <span className="adm-whoami-live" title="A public link to the leaderboard is live" />
          )}
        </button>

        <button className="adm-collapse" onClick={onCollapse}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          <Ic name={collapsed ? 'chevron-right' : 'chevron-left'} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  )
}

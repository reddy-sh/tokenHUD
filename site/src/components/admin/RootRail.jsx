import { Ic } from '../board/icons'

/* The root navigation: the outermost rail, and the only one that changes what
 * the content area *is* rather than where in it you are looking.
 *
 * Two levels, because they answer different questions. This one answers "which
 * product am I in" - token monitoring, or the leaderboard. The rail beside it,
 * which only exists inside Token Monitoring, answers "which machine, and which
 * part of its board".
 *
 * It draws as a 56px strip of icons by default, and that is the whole point of
 * it: a product switcher, not a sidebar. Expanded it stood 218px wide beside a
 * 236px sidebar for three destinations, which read as one navigation drawn
 * twice rather than as two that mean different things. It has no collapse
 * control of its own for the same reason - the shell has exactly one, in the
 * rail that actually needs folding away, and the topbar hamburger and the
 * Settings switch open this one when somebody wants the labels.
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
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    group: 'Workspace',
    /* Deliberately not a list of the cards behind it: the cloud board and the
       self-host board do not carry the same ones, and a rail that promised
       "this server" to somebody who does not run one would be the smaller
       cousin of the bug this rail's footer used to tell. */
    hint: 'Identity, appearance, live updates and what is public',
  },
]

export default function RootRail({ section, onSection, collapsed, badges, identity }) {
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
                  /* Named whether or not the label is drawn. Collapsed is this
                     rail's normal state and the icon carries no text, so
                     without this a screen reader is offered three buttons with
                     nothing to tell them apart - and so is a test. */
                  aria-label={row.label}
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
        {/* Whose board this is. The self-host board has no user account, so it
            names the thing that actually identifies the session - which server
            it is reading; the cloud board names the account. Which of the two
            it says comes from the adapter and never from here: this block used
            to read "Self-hosted" as a literal, which meant the cloud portal
            told every signed-in user they were self-hosting. The dot means
            something of this board is public, and each backend decides what
            that is - a live share link, or the global leaderboard opt-in. */}
        <button
          type="button"
          className={'adm-whoami' + (section === 'settings' ? ' on' : '')}
          onClick={() => onSection('settings')}
          aria-label={`${identity.title} - ${identity.detail}`}
          title={`${identity.title} - ${identity.detail}`}
        >
          <span className="adm-whoami-badge"><Ic name="user" /></span>
          {!collapsed && (
            <span className="adm-whoami-text">
              <b>{identity.title}</b>
              <span>{identity.detail}</span>
            </span>
          )}
          {identity.live && (
            <span className="adm-whoami-live" title="Something on this board is public" />
          )}
        </button>
      </div>
    </aside>
  )
}

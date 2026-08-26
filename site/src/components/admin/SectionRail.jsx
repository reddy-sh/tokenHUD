import { Ic } from '../board/Rail'

/* The second rail, for sections that have one.
 *
 * Deliberately presentational: it draws rows and reports which was picked, and
 * says nothing about what picking one means. Token Monitoring's rail scrolls
 * the board; the Leaderboard's swaps the page. Folding both behaviours in here
 * would make one component that is two components wearing a trench coat. */

export default function SectionRail({
  title, rows, active, onPick, collapsed, onCollapse, foot,
}) {
  return (
    <aside className={'adm-side' + (collapsed ? ' adm-side--mini' : '')} aria-label={title}>
      <div className="adm-side-scroll">
        <div className="adm-group">
          {!collapsed && <span className="adm-group-label">{title.toUpperCase()}</span>}
          {rows.map(row => (
            <button
              key={row.key}
              type="button"
              className={'adm-item adm-item--btn' + (active === row.key ? ' adm-item--on' : '')}
              aria-current={active === row.key ? 'page' : undefined}
              title={collapsed ? row.label : row.hint}
              onClick={() => onPick(row.key)}
            >
              <Ic name={row.icon} />
              {!collapsed && (
                <>
                  <span className="adm-item-text">{row.label}</span>
                  {row.badge != null && (
                    <span className={'adm-nav-n' + (row.tone ? ' ' + row.tone : '')}>{row.badge}</span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
        {!collapsed && foot}
      </div>

      <div className="adm-side-foot">
        <button className="adm-collapse" onClick={onCollapse}
          title={collapsed ? 'Expand' : 'Collapse'}>
          <Ic name={collapsed ? 'chevron-right' : 'chevron-left'} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  )
}

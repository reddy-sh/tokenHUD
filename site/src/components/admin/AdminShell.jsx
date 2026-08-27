import { useCallback, useEffect, useMemo, useState } from 'react'
import { fleetOf, rankBoard } from '../../lib/leaderboard'
import ErrorBoundary from '../ErrorBoundary'
import AdminSidebar from './AdminSidebar'
import AdminTopbar from './AdminTopbar'
import LeaderboardPage, { LEADERBOARD_KEYS, LEADERBOARD_PAGES } from './LeaderboardPage'
import RootRail, { SECTIONS } from './RootRail'
import SectionRail from './SectionRail'

/* The admin shell: the topbar, the two rails, and the content area.
 *
 * There is one of these because there was very nearly two. The cloud portal
 * and the self-host board each carried their own copy of this file's contents
 * - the same section state, the same collapse state, the same class
 * composition on `.adm-shell`, the same rails mounted in the same order, the
 * same Leaderboard wiring - differing only in where the readings came from.
 * Four things had already failed to mirror between the copies by the time they
 * were merged: the cloud board could not remove a machine, could not ever show
 * "Upgrade agents", called a handler that was a no-op, and told signed-in cloud
 * users they were self-hosted. None of those were separately introduced bugs.
 * They were one bug, four times: a change made on one side of a duplicate.
 *
 * So everything that is the same lives here, and everything that differs
 * arrives in one `adapter` object. The rule for what belongs in the adapter is
 * narrow on purpose - a backend difference, not a preference. If a value can
 * be computed from `data`, it is computed here so the two boards cannot
 * disagree about it: the fleet, the ranking, "you", the rail badges and the
 * outdated-agent check are all derived, not passed.
 *
 * The adapter:
 *
 *   data        the overview payload - {hosts, latest, endings, store,
 *               machines} - or null before the first one lands. The cloud
 *               synthesizes it from Machine rows; the self-host server serves
 *               it directly. Everything below reads this shape and only this.
 *   keys        the four localStorage keys this browser remembers the
 *               navigation in. They differ per backend so a person who uses
 *               both does not have one clobber the other.
 *   identity    who this board belongs to, for the rail's footer: {title,
 *               detail, live}. NOT a constant - the cloud board showing
 *               "Self-hosted" here was one of the four.
 *   topbar      whatever AdminTopbar should carry beyond what the shell knows
 *               (the theme toggle, the server dot, sign-out).
 *   sidebar     what Token Monitoring's rail needs that the payload does not
 *               carry: the setup phase, and the rename/remove actions.
 *   leaderboard the share controls, self-host only.
 *   monitoring  a render function for the content of Token Monitoring; it is
 *               handed `onBoardState`, which the board reports its computed
 *               nav and selection through.
 *   settings    a render function for the Settings page, handed the collapse
 *               state so its switches drive the real rails.
 *   overlay     modals that belong to the frame rather than to a section.
 */

function load(k, fb) { try { return localStorage.getItem(k) || fb } catch { return fb } }
function save(k, v) { try { localStorage.setItem(k, v) } catch {} }

const SECTION_KEYS = SECTIONS.map(x => x.key)

/* Where the "Upgrade agents" row and the Settings version check get their
   answer. Best-effort by construction: GitHub is a third party this board does
   not need, so a failure means the badge does not appear - never a wrong
   version, and never a zero standing in for "not asked". */
const RELEASES = 'https://api.github.com/repos/reddy-sh/tokenhud/releases/latest'

export default function AdminShell({ adapter }) {
  const {
    data, keys, identity, topbar, sidebar, leaderboard, monitoring, settings, overlay, onClose,
  } = adapter

  const [section, setSection] = useState(() => {
    const v = load(keys.section, 'monitoring')
    return SECTION_KEYS.includes(v) ? v : 'monitoring'
  })
  /* Which page inside the Leaderboard. Remembered separately from the section
     so switching to Token Monitoring and back lands where you left. */
  const [lbPage, setLbPage] = useState(() => {
    const v = load(keys.lbPage, 'standings')
    return LEADERBOARD_KEYS.includes(v) ? v : 'standings'
  })
  /* The root rail opens as icons, and that is the default rather than a
     remembered state. Expanded it is 218px next to the section rail's 236px,
     and 454px of navigation for a three-item route table read as one sidebar
     drawn twice - both rails styled the same, both with a footer, the word
     "Machines" in both. As a 56px product switcher it reads as what it is.
     Stored as '1'/'0' rather than '1'/'': an empty string is indistinguishable
     from an absent key through `load`, so the old encoding could not express
     "expanded" once the default stopped being it. An old '' therefore reads as
     the new default, which is the state we want them in anyway. */
  const [rootMini, setRootMini] = useState(() => load(keys.rootNav, '1') !== '0')
  const [collapsed, setCollapsed] = useState(() => load(keys.subNav, '') === '1')
  const [boardState, setBoardState] = useState(null)
  const [latestRelease, setLatestRelease] = useState(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(RELEASES, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j?.tag_name) setLatestRelease(j.tag_name.replace(/^v/, '')) })
      .catch(() => { /* unknown is a fact the pages below are written to state */ })
    return () => ctrl.abort()
  }, [])

  const setRoot = useCallback(v => { setRootMini(v); save(keys.rootNav, v ? '1' : '0') }, [keys.rootNav])
  const setSub = useCallback(v => { setCollapsed(v); save(keys.subNav, v ? '1' : '') }, [keys.subNav])
  const toggleRoot = useCallback(() => setRoot(!rootMini), [setRoot, rootMini])
  const toggleCollapse = useCallback(() => setSub(!collapsed), [setSub, collapsed])
  const goto = useCallback(key => { setSection(key); save(keys.section, key) }, [keys.section])
  const gotoLb = useCallback(key => { setLbPage(key); save(keys.lbPage, key) }, [keys.lbPage])

  /* The whole fleet in the shape share.rs serves, computed here rather than
     inside the board: the Leaderboard is its own section and must not need the
     board mounted to have something to show. Same object as a shared link
     carries, so the pages below render both. */
  const fleet = useMemo(() => fleetOf(data), [data])
  const profiles = fleet.entries

  /* "You" on the leaderboard is the machine Token Monitoring is pointed at.
     `boardState` survives the board unmounting, so switching sections does not
     move the marker; before the board has ever mounted, fall back to the same
     machine it would default to. */
  const meId = boardState?.cur?.host || data?.latest?.[0]?.host || null

  /* Two counts the Leaderboard's rail badges with. Cheap sums, and they read
     from the same object the pages do, so a badge cannot disagree with the
     page it points at. */
  const liveCount = useMemo(
    () => profiles.reduce((a, e) => a + (e.running || []).length, 0),
    [profiles],
  )
  const modelCount = useMemo(
    () => new Set(profiles.flatMap(e => (e.models || []).filter(m => m.tokens > 0).map(m => m.model))).size,
    [profiles],
  )
  const myRank = useMemo(() => {
    if (!meId || profiles.length < 2) return null
    const row = rankBoard(profiles, { metric: 'tokens', period: 'all' }).rows.find(r => r.id === meId)
    return row ? row.rank : null
  }, [profiles, meId])

  const hosts = data?.hosts || []
  /* Token Monitoring and the Leaderboard each have a second rail; Settings is
     one page and does not. The grid is told which, rather than being handed an
     empty sidebar to render. */
  const hasSubNav = section === 'monitoring' || section === 'leaderboard'

  return (
    <div className="dashboard-frame adm">
      <AdminTopbar
        {...topbar}
        onCollapse={toggleRoot}
        onClose={onClose}
        crumb={SECTIONS.find(x => x.key === section)?.label}
      />
      <div className={'adm-shell'
        + (rootMini ? ' adm-shell--rootmini' : '')
        + (collapsed ? ' adm-shell--submini' : '')
        + (hasSubNav ? '' : ' adm-shell--nosub')}>

        <RootRail
          section={section} onSection={goto}
          collapsed={rootMini}
          identity={identity}
          badges={{
            monitoring: hosts.length || null,
            leaderboard: myRank ? '#' + myRank : null,
          }}
        />

        {section === 'leaderboard' && (
          <SectionRail
            title="Leaderboard"
            rows={LEADERBOARD_PAGES.map(row => ({
              ...row,
              badge: row.key === 'standings' && myRank ? '#' + myRank
                : row.key === 'live' ? String(liveCount) || null
                  : row.key === 'models' ? String(modelCount) || null
                    : null,
              tone: row.key === 'live' && liveCount ? 'on' : null,
            }))}
            active={lbPage}
            onPick={gotoLb}
            collapsed={collapsed}
            onCollapse={toggleCollapse}
          />
        )}

        {section === 'monitoring' && (
          <AdminSidebar
            collapsed={collapsed} onCollapse={toggleCollapse}
            board={boardState}
            hosts={hosts}
            latestRelease={latestRelease}
            {...sidebar}
          />
        )}

        <main className="adm-content">
          {/* Around the content and not around the app: a panel that throws
              must not take the navigation with it, because navigating away is
              how you get back to a board that works. */}
          <ErrorBoundary resetKey={section}>
            {section === 'monitoring' && monitoring({ onBoardState: setBoardState })}
            {section === 'leaderboard' && (
              <LeaderboardPage
                board={fleet}
                page={lbPage}
                meId={meId}
                {...leaderboard}
                onGoToMachines={() => goto('monitoring')}
              />
            )}
            {section === 'settings' && settings({
              rootCollapsed: rootMini, onRootCollapsed: setRoot,
              subCollapsed: collapsed, onSubCollapsed: setSub,
              hosts, latestRelease,
            })}
          </ErrorBoundary>
        </main>
      </div>

      {overlay}
    </div>
  )
}

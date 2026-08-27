import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { profilesOf, rankBoard } from '../lib/leaderboard'
import { TipProvider } from './board/charts'
import {
  CodexDays, CodexLimits, CodexModels, CodexPolicy, CodexProjects, CodexSessions, CodexSplit, CodexTiles,
  CodexValue,
} from './board/codex'
import { AddMachineModal, MachinesPanel, UpgradeModal } from './board/enroll'
import { ExtensionsCard, governanceBadges, McpCard, PermissionsCard, ToolCallsCard } from './board/governance'
import { Ic } from './board/icons'
import Leaderboard from './board/leaderboard'
import {
  ActivityCard, Card, DriversCard, EndedFeed, HostsFeed, HoursCard, IntegrationsCard, LiveCard,
  ModelsTable, Offboard, ProjectsFeed, PromptsFeed, RateCard, SessionsTable, SpendCard, Tiles,
  TokensCard, UsageWindows,
} from './board/panels'
import Rail from './board/Rail'
import { compact, usdShort } from './board/util'

/* intervalSeconds arrives over the network, so it is input, not
   configuration: anything outside a sane band falls back to the default. */
const DEFAULT_INTERVAL = 30000
function intervalOf(p) {
  const ms = Number(p && p.intervalSeconds) * 1000
  return ms >= 1000 && ms <= 86400000 ? ms : DEFAULT_INTERVAL
}

const procTool = p => p.tool || 'claude-code'

/* Frozen fallbacks, shared by every render.
 *
 * These are not a tidiness pass. `nav` is a useMemo whose dependencies are
 * these very values, and the board reports `nav` up to its host shell in an
 * effect that then sets state. A fallback written inline - `m.governance ||
 * {}` - is a NEW object on every render, so the memo never hits, the effect
 * always fires, the shell always re-renders, and the board loops until React
 * gives up with "maximum update depth exceeded". A reading missing any one of
 * these subtrees (an older agent, a collector that found nothing) was enough
 * to trigger it. Hoisting them makes "absent" a stable value instead of a
 * fresh one. */
const NO_ROWS = Object.freeze([])
const NO_FACTS = Object.freeze({})
const NO_CLAUDE = Object.freeze({ daily: [], models: [], hours: {}, totalSessions: 0, totalMessages: 0 })
const NO_USAGE = Object.freeze({ sessions: [], byModel: [], byDay: [], windows: {}, allTime: {} })
const ONLY_CLAUDE = Object.freeze([
  { id: 'claude-code', name: 'Claude Code', detected: true, supported: true, hasData: true },
])

function Section({ id, children, cols }) {
  return (
    <section id={id} data-nav-id className={'bv-panel' + (cols ? ' bv-cols-' + cols : '')} tabIndex={-1}>
      {children}
    </section>
  )
}

/* The board is presentation only: Portal owns the AppSync subscription and
   hands the synthesized overview down, so every panel below reads the same
   shape the self-host server used to serve. `cloud` carries the actions the
   machine panels call - mint an enrollment, revoke, remove.

   `embedded` mode: hides topbar + Rail - the parent provides its own shell.
   The board reports computed nav / state via `onBoardState` so the parent's
   sidebar can render machine lists, section nav, and badges. */
export default function BoardView({
  data, loading, error, streaming, lastUpdate,
  live, onToggleLive, onRetry, connLabel, onClose, onSignOut, cloud,
  theme, onToggleTheme,
  embedded, onBoardState,
}) {
  const [picked, setPicked] = useState(null)     /* which machine */
  const [toolSel, setToolSel] = useState('claude-code')
  const [railOpen, setRailOpen] = useState(false)
  const [active, setActive] = useState(null)     /* which nav row is lit */
  const [addOpen, setAddOpen] = useState(false)  /* the add-machine modal */
  const [upgradeOpen, setUpgradeOpen] = useState(false)  /* the upgrade modal */
  const pinRef = useRef(0)                       /* a click pins the highlight briefly */

  /* ── which panel you are looking at ── */
  useEffect(() => {
    let tick = 0
    const elect = () => {
      tick = 0
      if (Date.now() < pinRef.current) return
      const els = document.querySelectorAll('[data-nav-id]')
      if (!els.length) return
      const top = 64, bot = innerHeight * 0.45
      /* In embedded mode the scroll container is .adm-content, not .bv-board. */
      const sc = embedded
        ? document.querySelector('.adm-content')
        : document.querySelector('.bv-board')
      const atEnd = sc ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : true
      let best = null, bestCover = 0, lastSeen = null
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.bottom > 0 && r.top < innerHeight) lastSeen = el
        const cover = Math.min(r.bottom, bot) - Math.max(r.top, top)
        if (cover <= 0) continue
        if (cover > bestCover) { best = el; bestCover = cover }
      }
      const win = (atEnd ? lastSeen : null) || best
      if (win) setActive(win.id)
    }
    const soon = () => { if (!tick) tick = requestAnimationFrame(elect) }
    /* capture: the board scrolls inside the dashboard frame, and scroll
       events do not bubble out of a scroll container */
    addEventListener('scroll', soon, { passive: true, capture: true })
    addEventListener('resize', soon)
    elect()
    return () => { removeEventListener('scroll', soon, { capture: true }); removeEventListener('resize', soon) }
  }, [toolSel, data == null, embedded])

  const onNav = useCallback(id => {
    setActive(id)
    pinRef.current = Date.now() + 800
    setRailOpen(false)
  }, [])

  /* ── carve the payload the same way the classic board did ── */
  const payloads = data?.latest || NO_ROWS
  const cur = useMemo(() => {
    if (!payloads.length) return null
    return (picked && payloads.find(p => p.host === picked)) || payloads[0]
  }, [payloads, picked])

  const m = (cur && cur.metrics) || NO_FACTS
  const claude = m.claude || NO_CLAUDE
  const processes = m.processes || NO_ROWS
  const liveObj = useMemo(
    () => ({ processes, supervisor: m.daemon || NO_FACTS }),
    [processes, m.daemon],
  )
  const usage = m.usage && m.usage.available ? m.usage : NO_USAGE
  const assistants = m.assistants || ONLY_CLAUDE
  const withData = assistants.filter(a => a.hasData)
  const tool = withData.find(a => a.id === toolSel) || withData[0] || null
  const toolId = (tool && tool.id) || 'claude-code'
  const gov = m.governance || NO_FACTS
  const codex = m.codex || NO_FACTS
  const intSummary = m.integrationSummary || NO_FACTS
  const endings = data?.endings || NO_ROWS
  const hosts = data?.hosts || NO_ROWS
  const machines = data?.machines || NO_ROWS
  const offboard = !!(tool && !tool.supported)

  /* Every reporting machine, folded to the shape a shared board uses. The
     private board ranks the same objects the public one does, so what is on
     screen here and what a visitor sees differ in exactly one thing: the
     names. */
  const profiles = useMemo(() => profilesOf(data), [data])
  const myId = cur ? cur.host : null

  /* All-time tokens, which is the ranking the sidebar badge and the panel's
     default agree on. A badge that said #2 next to a table that said #3
     because the two counted different windows would be a small lie told
     every render. */
  const myRank = useMemo(() => {
    if (!myId) return null
    const row = rankBoard(profiles, { metric: 'tokens', period: 'all' }).rows.find(r => r.id === myId)
    return row ? row.rank : null
  }, [profiles, myId])

  /* ── the rail digest: every number read from the same array the panel
        it links to renders, so it cannot drift from it ── */
  const nav = useMemo(() => {
    if (!cur || offboard) return []
    const up = hosts.filter(x => x.status === 'up').length
    const running = processes.filter(p => procTool(p) === toolId).length
    const endedHour = endings.filter(e => (e.tool || 'claude-code') === toolId
      && (Date.now() - new Date(e.noticed_at).getTime()) < 3600e3).length
    const govB = governanceBadges({
      toolId,
      gov: toolId === 'codex' ? gov.codex : gov.claude,
      used: toolId === 'codex' ? codex.tools : usage.tools,
    })
    /* Embedded, the leaderboard is a section of the ROOT navigation and this
       rail is only about one machine, so it does not appear here. Standalone -
       the cloud portal - has no root rail, so it keeps it inline, badged with
       your own place. */
    const leaderRow = embedded ? null : {
      id: 'p-leaderboard', label: 'Leaderboard', icon: 'trophy',
      badge: myRank ? '#' + myRank : String(profiles.length),
      tone: myRank === 1 ? 'on' : null,
    }
    const shared = [
      { id: 'p-running-now', label: 'Running now', icon: 'running', badge: String(running), tone: running ? 'on' : null },
      ...(toolId === 'claude-code'
        ? [{ id: 'p-projects', label: 'Projects', icon: 'projects', badge: String((m.projects || []).length) }]
        : []),
      { id: 'p-mcp-servers', label: 'MCP servers', icon: 'plug', badge: govB.mcp.text, tone: govB.mcp.tone },
      { id: 'p-tool-calls', label: 'Tool calls', icon: 'tools', badge: govB.toolCalls.text },
      { id: 'p-permissions', label: 'Permissions', icon: 'shield', badge: govB.permissions.text },
      { id: 'p-extensions', label: 'Extensions', icon: 'blocks', badge: govB.extensions.text },
      /* Embedded, the shell's own rail already opens with a MACHINES group
         listing every machine by name, with its liveness and its remove
         control. A second "Machines" row four rows below it - same word, same
         rail, different job - was the loudest reason the two rails read as one
         duplicated sidebar. The panel it scrolled to is still on the board;
         only the row that named it twice is gone. */
      ...(embedded ? [] : [
        { id: 'p-machines', label: 'Machines', icon: 'machines', badge: up + '/' + hosts.length, tone: hosts.length && up < hosts.length ? 'bad' : null },
      ]),
      {
        id: 'p-integrations',
        label: 'Integrations',
        icon: 'plug',
        badge: (intSummary.reading || 0) + '/' + (intSummary.known || 0),
        tone: (intSummary.needsSetup || 0) > 0 ? 'warn' : null,
      },
      ...(toolId === 'claude-code'
        ? [{ id: 'p-prompts', label: 'Prompts', icon: 'prompts', badge: String((m.prompts || []).length) }]
        : []),
    ]
    if (toolId === 'codex') {
      const lead = (codex.limits || []).find(w => w.percent != null)
      return [
          { id: 'p-codex-overview', label: 'Codex overview', icon: 'overview', badge: compact((codex.totals || {}).total || 0) },
        ...(leaderRow ? [leaderRow] : []),
        {
          id: 'p-codex-value', label: 'Codex value', icon: 'value',
          badge: codex.priced ? usdShort(codex.estUSD || 0) : 'n/p',
        },
        { id: 'p-codex-plan', label: 'Codex plan', icon: 'window', badge: lead ? Math.round(lead.percent) + '%' : null },
        {
          id: 'p-codex-policy', label: 'Codex policy', icon: 'shield', badge: (codex.policy || {}).sandbox || null,
          tone: (codex.policy || {}).sandbox === 'danger-full-access' || (codex.policy || {}).network === true ? 'bad' : null,
        },
        { id: 'p-codex-sessions', label: 'Codex sessions', icon: 'sessions', badge: compact((codex.sessions || []).length) },
        { id: 'p-codex-models', label: 'Codex models', icon: 'models', badge: String((codex.byModel || []).length) },
        { id: 'p-codex-activity', label: 'Codex activity', icon: 'activity', badge: String((codex.byDay || []).length) + 'd' },
        { id: 'p-codex-projects', label: 'Codex projects', icon: 'projects', badge: String((codex.projects || []).length) },
        { id: 'p-codex-finished', label: 'Codex finished', icon: 'ended', badge: endedHour ? String(endedHour) : null },
        ...shared,
      ]
    }
    const lim = m.limits || {}
    const lead = (lim.windows || []).find(w => w.active)
    const days = (claude.daily || []).filter(x => x.messages > 0).length
    return [
      { id: 'p-overview', label: 'Overview', icon: 'overview', badge: null },
      ...(leaderRow ? [leaderRow] : []),
      {
        id: 'p-usage-windows', label: 'Usage windows', icon: 'window',
        badge: lead && lead.percent != null ? lead.percent + '%' : null,
        tone: lead && lead.severity === 'critical' ? 'bad' : null,
      },
      { id: 'p-activity', label: 'Activity', icon: 'activity', badge: days + 'd' },
      { id: 'p-value', label: 'Value', icon: 'value', badge: usdShort((usage.allTime || {}).estUSD || 0) },
      { id: 'p-sessions', label: 'Sessions', icon: 'sessions', badge: compact((usage.sessions || []).length) },
      { id: 'p-models', label: 'Models', icon: 'models', badge: String((claude.models || []).length) },
      ...shared,
      { id: 'p-recently-finished', label: 'Recently finished', icon: 'ended', badge: endedHour ? String(endedHour) : null },
    ]
  }, [cur, offboard, hosts, processes, endings, toolId, gov, codex, usage, intSummary, m.projects, m.prompts, m.limits, claude.daily, claude.models, myRank, profiles.length, embedded])

  /* ── report state to parent when embedded ──
        Dependencies, not a bare effect: the shell turns this into state, so
        an effect that fired on every render would be a render loop. */
  useEffect(() => {
    if (!embedded || !onBoardState) return
    onBoardState({
      nav, active, cur, hosts, machines, assistants, tool, toolId,
      picked, onPickHost: setPicked,
      toolSel, onPickTool: setToolSel,
      onNav, onAdd: () => setAddOpen(true), onUpgrade: () => setUpgradeOpen(true),
    })
  }, [embedded, onBoardState, nav, active, cur, hosts, machines, assistants, tool, toolId, picked, toolSel, onNav])

  /* ── error / loading states, before any board exists ──
        Error is checked first on purpose: nothing has loaded in either case,
        so a spinner tested first would swallow the failure and spin forever
        over a board that is never coming. */
  if (error && !data) {
    return (
      <div className="bv-wrap">
        <div className="bv-error">
          <h3>Could not load your board</h3>
          <p>{error}</p>
          <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
            <button className="btn btn--primary" onClick={onRetry}>Retry</button>
            <button className="btn btn--ghost" onClick={onClose}>Back to the site</button>
            <button className="btn btn--ghost" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="bv-wrap">
        <div className="bv-loading">
          <span className="bv-spinner" />
          Loading your board...
        </div>
      </div>
    )
  }

  const govForTool = toolId === 'codex' ? gov.codex : gov.claude
  const usedForTool = toolId === 'codex' ? codex.tools : usage.tools

  /* The leaderboard sits second on both assistants' boards - under the
     overview, above everything that is about one machine. It is the only
     panel on the board that is about more than one.
     Embedded, the Leaderboard is a section of the root navigation instead, so
     this whole block is skipped. Nothing else may live inside it: the global
     opt-in used to, and because every caller embeds the board, no cloud user
     could reach it. It is a row in Settings now. */
  const leaderboardSection = embedded ? null : (
    <Section id="p-leaderboard">
      <Leaderboard
        entries={profiles}
        meId={myId}
        defaultMetric="tokens"
        defaultPeriod="all"
      />
    </Section>
  )

  const sharedTail = (
    <>
      {toolId === 'claude-code' ? (
        <Section id="p-running-now" cols={2}>
          <LiveCard live={liveObj} toolId={toolId} />
          <div id="p-projects" data-nav-id className="bv-stack">
            <ProjectsFeed projects={m.projects} />
          </div>
        </Section>
      ) : (
        <Section id="p-running-now"><LiveCard live={liveObj} toolId={toolId} /></Section>
      )}
      <Section id="p-mcp-servers"><McpCard toolId={toolId} gov={govForTool} used={usedForTool} /></Section>
      <Section id="p-tool-calls"><ToolCallsCard toolId={toolId} used={usedForTool} /></Section>
      <Section id="p-permissions"><PermissionsCard toolId={toolId} gov={govForTool} /></Section>
      <Section id="p-extensions"><ExtensionsCard toolId={toolId} gov={govForTool} used={usedForTool} /></Section>
      <Section id="p-machines">
        <div className="bv-stack">
          <HostsFeed hosts={hosts} />
          <MachinesPanel machines={machines} cloud={cloud} onAdd={() => setAddOpen(true)} />
        </div>
      </Section>
      <Section id="p-integrations">
        <IntegrationsCard integrations={m.integrations} summary={m.integrationSummary} />
      </Section>
      {toolId === 'claude-code' && <Section id="p-prompts"><PromptsFeed prompts={m.prompts} /></Section>}
    </>
  )

  /* ── panels only: parent provides the shell ── */
  const panels = (
    <>
      {!payloads.length && (
        <Card warn>
          No machine has reported yet. Register one below - it hands you the two
          commands that install the agent and enroll it here.
        </Card>
      )}

      {offboard && tool && <Offboard assistant={tool} />}

      {(!cur || offboard) && (
        <Section id="p-machines">
          <div className="bv-stack">
            <HostsFeed hosts={hosts} />
            <MachinesPanel machines={machines} cloud={cloud} onAdd={() => setAddOpen(true)} />
          </div>
        </Section>
      )}

      {!offboard && cur && toolId === 'claude-code' && (
        <>
          <Section id="p-overview">
            <Tiles claude={claude} live={liveObj} hostFacts={m.host || {}} usage={usage} />
          </Section>
          {leaderboardSection}
          <Section id="p-usage-windows" cols={2}>
            <UsageWindows lim={m.limits} />
            <HoursCard hours={claude.hours} />
          </Section>
          <Section id="p-activity" cols={2}>
            <ActivityCard daily={claude.daily} />
            <TokensCard daily={claude.daily} models={claude.models} />
          </Section>
          <Section id="p-value" cols={2}>
            <SpendCard usage={usage} />
            <RateCard pricing={usage.pricing} />
          </Section>
          <Section id="p-sessions" cols={2}>
            <DriversCard usage={usage} />
            <SessionsTable usage={usage} />
          </Section>
          <Section id="p-models">
            <ModelsTable claude={claude} usage={usage} />
          </Section>
          {sharedTail}
          <Section id="p-recently-finished">
            <EndedFeed endings={endings} host={cur.host} toolId="claude-code" title="Recently finished"
              note="Claude Code runs that were going at one reading and gone by the next - including the notification you never saw." />
          </Section>
        </>
      )}

      {!offboard && cur && toolId === 'codex' && (
        <>
          <Section id="p-codex-overview">
            <CodexTiles cx={codex} live={liveObj} />
          </Section>
          {leaderboardSection}
          <Section id="p-codex-value">
            <CodexValue cx={codex} />
          </Section>
          <Section id="p-codex-plan" cols={2}>
            <CodexLimits cx={codex} />
            <CodexPolicy cx={codex} gov={gov.codex} />
          </Section>
          <Section id="p-codex-sessions">
            <CodexSessions cx={codex} />
          </Section>
          <Section id="p-codex-models" cols={2}>
            <CodexModels cx={codex} />
            <CodexSplit cx={codex} />
          </Section>
          <Section id="p-codex-activity">
            <CodexDays cx={codex} />
          </Section>
          <Section id="p-codex-projects">
            <CodexProjects cx={codex} />
          </Section>
          <Section id="p-codex-finished">
            <EndedFeed endings={endings} host={cur.host} toolId="codex" title="Recently finished"
              note="Codex processes that were running at one reading and gone by the next." />
          </Section>
          {sharedTail}
        </>
      )}

      {addOpen && (
        <AddMachineModal cloud={cloud} onClose={() => setAddOpen(false)} />
      )}
      {upgradeOpen && (
        <UpgradeModal cloud={cloud} onClose={() => setUpgradeOpen(false)} />
      )}

    </>
  )

  if (embedded) {
    return (
      <TipProvider>
        <div className="bv-board">
          <main className="bv-main">{panels}</main>
        </div>
      </TipProvider>
    )
  }

  /* ── full standalone render with topbar + Rail ── */
  return (
    <TipProvider>
      <div className="bv-wrap bv-board">
        {/* top bar */}
        <div className="bv-topbar">
          <div className="bv-topbar-left">
            <button className="bv-menubtn" aria-label="Show sidebar" onClick={() => setRailOpen(o => !o)}>
              <Ic name="menu" />
            </button>
            <span className="nav__brand">
              <span className="nav__brand-dot" />
              <span>Token<b>HUD</b></span>
            </span>
            {lastUpdate && (
              <span className="bv-updated tnum">
                Updated {lastUpdate.toLocaleTimeString()}{streaming ? ' · live' : live ? '' : ' · paused'}
              </span>
            )}
            {error && <span className="bv-stale">stale</span>}
          </div>
          <div className="bv-topbar-right">
            <button className={'bv-live' + (live ? ' on' : '')} aria-pressed={live}
              title={live ? 'Following the agents.' : 'Frozen. Nothing is being fetched.'}
              onClick={onToggleLive}>
              <span className="dot" /><span>{live ? 'Live' : 'Paused'}</span>
            </button>
            {onToggleTheme && (
              <button className="adm-theme" onClick={onToggleTheme}
                title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
                {theme === 'dark' ? '\u2600' : '\u263E'}
              </button>
            )}
            <span className="bv-server-url">{connLabel}</span>
            <button className="btn btn--ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onSignOut}>
              Sign out
            </button>
            <button className="bv-modal-close" style={{ position: 'static', lineHeight: 1 }}
              onClick={onClose} aria-label="Close the board">×</button>
          </div>
        </div>

        <p className="bv-printonly">
          {cur
            ? `TokenHUD · ${cur.host} · reading of ${new Date(cur.collectedAt).toLocaleString()}`
            : 'TokenHUD · no agent has reported yet'}
        </p>

        <div className="bv-layout">
          {railOpen && <div className="bv-scrim" onClick={() => setRailOpen(false)} />}
          <Rail
            data={data} cur={cur} tool={tool} assistants={assistants}
            picked={picked} onPickHost={h => setPicked(h)}
            toolSel={toolId} onPickTool={t => setToolSel(t)}
            nav={nav} active={active} onNav={onNav}
            open={railOpen} onClose={() => setRailOpen(false)}
            intervalSeconds={intervalOf(cur)}
          />

          <main className="bv-main">{panels}</main>
        </div>

        {addOpen && (
          <AddMachineModal cloud={cloud} onClose={() => setAddOpen(false)} />
        )}
        {upgradeOpen && (
          <UpgradeModal cloud={cloud} onClose={() => setUpgradeOpen(false)} />
        )}

      </div>
    </TipProvider>
  )
}

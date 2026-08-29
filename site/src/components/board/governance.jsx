import { Card, Empty, MeterBar } from './panels'
import { compact, CRITICAL, full, SERIES, WARNING } from './util'

/* ── governance: configured beside called, never merged ─────────────── */

export function McpCard({ toolId, gov, used }) {
  gov = gov || {}; used = used || {}
  const codex = toolId === 'codex'
  const configured = gov.mcpServers || []
  const calls = new Map((used.byServer || []).map(r => [r.server, r]))
  const rows = []

  for (const s of configured) {
    const hit = calls.get(s.name)
    calls.delete(s.name)
    rows.push({
      name: s.name, scope: s.scope, transport: s.transport, target: s.target,
      env: (s.env || []).concat(s.headers || []),
      state: s.needsAuth ? 'needs sign-in' : s.enabled ? 'enabled' : 'disabled',
      tone: s.needsAuth ? WARNING : null,
      hit,
    })
  }
  /* Anything called but not in a settings file came from a plugin or a
     project-level .mcp.json. Leaving it out would claim a completeness the
     panel does not have. */
  for (const [name, hit] of calls) {
    rows.push({ name, scope: 'plugin or project', transport: '', target: '', env: [], state: 'in use', tone: null, hit })
  }

  const nUsed = (used.byServer || []).length
  const idle = configured.filter(s => !(used.byServer || []).some(r => r.server === s.name)).length

  return (
    <Card title="MCP servers"
      note={codex
        ? 'From ~/.codex/config.toml, beside the calls counted in the rollouts.'
        : 'From Claude Code’s settings files, beside the calls counted in the transcripts.'}
      right={<span className="bv-sub">{configured.length} configured · {nUsed} called</span>}>
      <div className="bv-table-scroll">
        <table className="bv-table">
          <thead><tr><th>Server</th><th>Scope</th><th>Reaches</th><th>Credentials</th><th>State</th><th>Calls</th></tr></thead>
          <tbody>
            {!rows.length && (
              <tr><td colSpan={6} className="bv-empty">No MCP server is configured for this assistant, and none has been called.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="bv-sub">{r.scope}</td>
                <td className="mono" title={r.transport || ''}>{r.target || '-'}</td>
                <td className="bv-sub" title={r.env.length ? 'Names only - no value is ever read.' : undefined}>
                  {r.env.length ? r.env.join(', ') : '-'}
                </td>
                <td style={r.tone ? { color: r.tone } : undefined}>{r.state}</td>
                <td className={r.hit ? 'tnum' : 'tnum bv-sub'}
                  title={r.hit ? `${r.hit.tools} distinct tool${r.hit.tools === 1 ? '' : 's'} used` : 'Configured, never called on this machine.'}>
                  {r.hit ? full(r.hit.calls) : '0'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="bv-note" style={{ marginTop: 12 }}>
        {(gov.note || '')}
        {idle ? ` ${idle} of the ${configured.length} configured server${configured.length === 1 ? '' : 's'} `
          + `${idle === 1 ? 'has' : 'have'} never been called from this machine.` : ''}
      </p>
    </Card>
  )
}

export function ToolCallsCard({ toolId, used }) {
  used = used || {}
  const codex = toolId === 'codex'
  const byTool = used.byTool || []
  const tt = used.total || 0

  return (
    <Card title="Tool calls" note={used.note || ''}
      right={tt ? <span className="bv-sub">{full(tt)} calls · {used.distinct} names</span> : null}>
      {tt > 0 && (
        <>
          <MeterBar pct={(used.mcpCalls || 0) / tt * 100} label={Math.round((used.mcpCalls || 0) / tt * 100) + '%'}
            right="through an MCP server" note={full(used.mcpCalls || 0) + ' calls'} color={SERIES[1]} />
          <MeterBar pct={(used.builtinCalls || 0) / tt * 100} label={Math.round((used.builtinCalls || 0) / tt * 100) + '%'}
            right="built-in tools" note={full(used.builtinCalls || 0) + ' calls'} color={SERIES[0]} />
        </>
      )}
      <div className="bv-table-scroll tall">
        <table className="bv-table">
          <thead><tr><th>Tool</th><th>Server</th><th>Calls</th></tr></thead>
          <tbody>
            {!byTool.length && (
              <tr>
                <td colSpan={3} className="bv-empty">
                  No tool calls counted yet. The index is rebuilt from scratch on a version change, so this fills in as the scan catches up.
                </td>
              </tr>
            )}
            {byTool.map(r => {
              const m = codex ? String(r.name).split('__') : String(r.name).replace(/^mcp__/, '').split('__')
              const isMcp = codex ? m.length > 1 : String(r.name).startsWith('mcp__')
              return (
                <tr key={r.name}>
                  <td className="mono">{isMcp ? m.slice(1).join('__') : r.name}</td>
                  <td className="bv-sub">{isMcp ? m[0] : '-'}</td>
                  <td className="tnum">{full(r.calls)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

const Chips = ({ items, empty }) => (
  items.length ? (
    <div className="bv-chips">
      {items.map((it, i) => (
        <span key={i} className={'bv-chip' + (it.off ? ' off' : '')} title={it.title}>
          <span>{it.name}</span>
          {it.n != null && <span className="n">{full(it.n)}</span>}
        </span>
      ))}
    </div>
  ) : <Empty>{empty}</Empty>
)

export function PermissionsCard({ toolId, gov }) {
  gov = gov || {}
  const codex = toolId === 'codex'
  const perm = gov.permissions || {}, hooks = gov.hooks || []

  if (codex) {
    const feats = gov.features || []
    return (
      <Card title="Permissions"
        note="Codex governs by approval policy and sandbox rather than by rule lists - those are on the policy card above.">
        <p className="bv-gov-h">features</p>
        <Chips items={feats.map(f => ({ name: f.name, off: !f.on }))} empty="none declared" />
        {gov.sources && (
          <p className="bv-note" style={{ marginTop: 14 }}>Read from {(gov.sources || []).join(', ')}</p>
        )}
      </Card>
    )
  }

  const mode = perm.defaultMode
  const dangerous = (gov.posture || {}).skipDangerousModePrompt
  const buckets = [['allow', perm.allow], ['deny', perm.deny], ['ask', perm.ask]]
  const any = buckets.some(([, v]) => (v || []).length)

  return (
    <Card title="Permissions"
      note="Every rule that stands between this assistant and your machine, and everything that runs on a hook."
      right={(
        <span className="bv-badges">
          {mode && <span className="bv-badge">{mode}</span>}
          {dangerous && (
            <span className="bv-badge warn" title="skipDangerousModePermissionPrompt is on: --dangerously-skip-permissions will not ask.">
              skips the danger prompt
            </span>
          )}
        </span>
      )}>
      <p className="bv-gov-h">permission rules</p>
      {!any && <Empty>No rule is configured; every tool call is asked for.</Empty>}
      {any && (
        <ul className="bv-rules">
          {buckets.flatMap(([name, list]) => (list || []).map((r, i) => (
            <li key={name + i}>
              <span className="tag" style={name === 'deny' ? { color: CRITICAL } : undefined}>{name}</span>
              <span className="mono">{r.rule}</span>
              <span className="spacer" />
              <span className="bv-sub">{r.scope}</span>
            </li>
          )))}
        </ul>
      )}
      {(perm.additionalDirectories || []).length > 0 && (
        <>
          <p className="bv-gov-h">additional directories</p>
          <Chips items={perm.additionalDirectories.map(d => ({ name: d }))} empty="" />
        </>
      )}
      <p className="bv-gov-h">hooks</p>
      {!hooks.length && <Empty>Nothing runs on a hook.</Empty>}
      {hooks.length > 0 && (
        <div className="bv-chips">
          {hooks.map((h, i) => (
            <span key={i} className="bv-chip" title={(h.matchers || []).length ? 'matches: ' + h.matchers.join(', ') : 'every call'}>
              <span>{h.event}</span>
              <span className="n">{(h.programs || []).join(', ') || h.count}</span>
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}

export function ExtensionsCard({ toolId, gov, used }) {
  gov = gov || {}; used = used || {}
  const codex = toolId === 'codex'
  const skillCalls = new Map((used.skills || []).map(r => [r.skill, r.calls]))
  const agentCalls = new Map((used.agents || []).map(r => [r.agent, r.calls]))

  const skills = (gov.skills || []).map(n => ({ name: n, n: skillCalls.get(n) || 0 }))
  for (const [n, c] of skillCalls) if (!(gov.skills || []).includes(n)) skills.push({ name: n, n: c, title: 'from a plugin' })

  const agents = (gov.agents || []).map(n => ({ name: n, n: agentCalls.get(n) || 0 }))
  for (const [n, c] of agentCalls) if (!(gov.agents || []).includes(n)) agents.push({ name: n, n: c, title: 'built in, or from a plugin' })

  return (
    <Card title="Extensions"
      note={codex
        ? 'Installed for Codex, from config.toml and ~/.codex/skills.'
        : 'Installed here, with how often each was actually invoked - counted from the transcripts, not from a usage cache.'}>
      <p className="bv-gov-h">plugins</p>
      <Chips empty="None installed."
        items={(gov.plugins || []).map(p => ({
          name: p.name, off: !p.enabled,
          title: (p.enabled ? 'enabled' : 'installed but switched off') + (p.installed ? '' : ' · not found on disk'),
        }))} />
      <p className="bv-gov-h">skills</p>
      <Chips items={skills} empty="None installed." />
      <p className="bv-gov-h">subagents</p>
      <Chips items={agents} empty="None defined, and none has been spawned." />
    </Card>
  )
}

export function governanceBadges({ toolId, gov, used }) {
  gov = gov || {}; used = used || {}
  const codex = toolId === 'codex'
  const configured = gov.mcpServers || []
  const calledNames = new Set((used.byServer || []).map(r => r.server))
  const extra = [...calledNames].filter(n => !configured.some(s => s.name === n)).length
  const perm = gov.permissions || {}
  return {
    mcp: { text: String(configured.length + extra), tone: configured.some(s => s.needsAuth) ? 'bad' : null },
    toolCalls: { text: compact(used.total || 0) },
    permissions: {
      text: codex ? String((gov.features || []).length)
        : String((perm.allow || []).length + (perm.deny || []).length + (perm.ask || []).length),
    },
    extensions: { text: String((gov.plugins || []).length + (gov.skills || []).length + (gov.agents || []).length) },
  }
}

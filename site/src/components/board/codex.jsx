import { CodexDayChart } from './charts'
import { Card, Empty, MeterBar } from './panels'
import { ago, clock, compact, CRITICAL, dur, full, SERIES, until, usd, useNow, WARNING, windowLabel } from './util'

/* ── Codex CLI: its own rollouts, its own plan windows, and a dollar column
      only where somebody supplied a rate for it.
   
   This build ships no OpenAI rate card and will not invent one. What it does
   ship is the mechanism: `~/.tokenhud/rates.json`. With a card, these models
   price like any other; without one they are counted and marked unpriced,
   which is a different fact from being free. ──────────────────────────── */

const procTool = p => p.tool || 'claude-code'

export function CodexTiles({ cx, live }) {
  const tot = cx.totals || {}, tools = cx.tools || {}, sessions = cx.sessions || []
  const running = ((live || {}).processes || []).filter(p => procTool(p) === 'codex').length

  if (!cx.available) {
    return (
      <Card>
        <Empty>Codex CLI has recorded nothing this board can read{cx.reason ? ' - ' + cx.reason + '.' : '.'}</Empty>
      </Card>
    )
  }

  /* From the payload, not from `sessions`: that list is the newest 60 and
     summing it under a tile beside `sessionCount` compared two different
     populations. */
  const turns = cx.turnCount || 0
  const win = sessions.map(s => s.contextWindow).find(Boolean)
  const tiles = [
    { k: 'Sessions', v: full(cx.sessionCount || 0), d: sessions.length ? 'newest ' + ago(sessions[0].last) : '' },
    { k: 'Turns', v: compact(turns), d: full(turns) },
    { k: 'Total tokens', v: compact(tot.total || 0), d: full(tot.total || 0) },
    { k: 'Output', v: compact(tot.output || 0), d: compact(tot.reasoning || 0) + ' of it reasoning' },
    { k: 'Cache read', v: compact(tot.cached_input || 0), d: compact(tot.cache_write || 0) + ' written, of ' + compact(tot.input || 0) + ' input' },
    { k: 'Tool calls', v: compact(tools.total || 0), d: (tools.distinct || 0) + ' distinct' },
    { k: 'Context window', v: win ? compact(win) : '-', d: win ? 'as the model reported it' : 'not reported' },
    { k: 'Running now', v: String(running), d: running ? 'codex processes' : 'idle' },
  ]
  return (
    <div className="bv-stats bv-tiles">
      {tiles.map(t => (
        <div className="bv-stat" key={t.k}>
          <div className="bv-stat-label">{t.k}</div>
          <div className="bv-stat-value tnum">{t.v}</div>
          <div className="bv-stat-sub">{t.d}</div>
        </div>
      ))}
    </div>
  )
}

export function CodexLimits({ cx }) {
  const now = useNow(1000)   /* eslint-disable-line no-unused-vars -- keeps the countdowns live */
  const rows = cx.limits || []
  const sessions = cx.sessions || []
  const newest = sessions.length ? sessions[0].last : null
  const colors = [SERIES[0], SERIES[1], SERIES[3]]

  return (
    <Card title="Plan windows"
      note="Reported by the provider beside a token count, not derived here - so they carry a reset instant and no estimate."
      right={newest && rows.length ? <span className="bv-sub">as of {ago(newest)}</span> : null}>
      {!rows.length && (
        <Empty>
          No plan window in the rollouts yet. Codex writes one beside a token count, so one appears after the next turn.
        </Empty>
      )}
      {rows.map((w, i) => {
        const span = windowLabel(w.windowMinutes)
        const secs = w.resetsAt ? until(w.resetsAt) : null
        return (
          <MeterBar key={i} pct={w.percent} color={colors[i % colors.length]}
            label={Math.round(w.percent) + '%'}
            right={w.kind.charAt(0).toUpperCase() + w.kind.slice(1) + (span ? ' · ' + span : '')}
            note={secs != null ? 'resets in ' + dur(secs) + ' · ' + clock(w.resetsAt) : ''} />
        )
      })}
    </Card>
  )
}

export function CodexPolicy({ cx, gov }) {
  const pol = cx.policy || {}, cfg = (gov || {}).posture || {}
  const net = typeof pol.network === 'boolean' ? (pol.network ? 'allowed' : 'blocked') : null
  const pairs = [
    ['approval', pol.approval, cfg.approvalPolicy],
    ['sandbox', pol.sandbox, cfg.sandboxMode],
    ['network', net, null],
    ['model', pol.model, cfg.model],
    ['effort', null, cfg.effortLevel],
  ]
  return (
    <Card title="Policy"
      note="Enforced beside configured. The interesting row is the one where they disagree.">
      <div className="bv-table-scroll">
        <table className="bv-table">
          <thead><tr><th>Setting</th><th>Enforced, last session</th><th>Default in config.toml</th></tr></thead>
          <tbody>
            {pairs.map(([k, ran, def]) => {
              const disagree = ran && def && ran !== def
              const danger = k === 'network' && ran === 'allowed'
              return (
                <tr key={k} title={disagree ? 'The session ran under a different setting than the file declares.' : undefined}>
                  <td>{k}</td>
                  <td className="mono" style={disagree || danger ? { color: WARNING } : undefined}>{ran || '-'}</td>
                  <td className="mono">{def || '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {pol.session && (
        <p className="bv-note" style={{ marginTop: 10 }}>
          From session {String(pol.session).slice(0, 8)}, {ago(pol.at)}.{' '}
          {(cfg.trustedProjects || 0)} project{cfg.trustedProjects === 1 ? '' : 's'} marked trusted in config.toml.
        </p>
      )}
    </Card>
  )
}

export function CodexSessions({ cx }) {
  const sessions = cx.sessions || []
  return (
    <Card title="Sessions"
      note="One row per rollout, newest first. Token counts are cumulative per session as Codex records them - taken, never summed."
      right={sessions.length ? <span className="bv-sub">{sessions.length} shown</span> : null}>
      <div className="bv-table-scroll tall">
        <table className="bv-table">
          <thead>
            <tr>
              <th>Session</th><th>Project</th><th>Model</th><th>Turns</th>
              <th>Tokens</th><th>Output</th><th>Sandbox</th><th>Active</th>
            </tr>
          </thead>
          <tbody>
            {!sessions.length && <tr><td colSpan={8} className="bv-empty">No sessions recorded.</td></tr>}
            {sessions.map(s => (
              <tr key={s.id} title={[s.project, s.branch].filter(Boolean).join(' · ')}>
                <td className="mono">{String(s.id).slice(0, 8)}</td>
                <td>{(s.project || '-').split('/').pop() || '-'}</td>
                <td>{s.model || '-'}</td>
                <td className="tnum">{full(s.turns || 0)}</td>
                <td className="tnum">{compact((s.tokens || {}).total || 0)}</td>
                <td className="tnum">{compact((s.tokens || {}).output || 0)}</td>
                <td style={s.sandbox === 'danger-full-access' ? { color: CRITICAL } : undefined}>{s.sandbox || '-'}</td>
                <td>{ago(s.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function CodexModels({ cx }) {
  return (
    <Card title="Tokens by model" note={cx.pricedNote || 'Counted, not priced.'}>
      <div className="bv-table-scroll">
        <table className="bv-table">
          <thead><tr><th>Model</th><th>Total</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Reasoning</th></tr></thead>
          <tbody>
            {(cx.byModel || []).map(r => {
              const k = r.tokens || {}
              return (
                <tr key={r.model}>
                  <td>{r.model}</td>
                  {[k.total, k.input, k.cached_input, k.cache_write, k.output, k.reasoning].map((v, i) => (
                    <td key={i} className="tnum">{compact(v || 0)}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function CodexSplit({ cx }) {
  const tot = cx.totals || {}
  const total = tot.total || 0
  const parts = [
    ['input', tot.input, SERIES[0]],
    ['cached input', tot.cached_input, SERIES[1]],
    ['output', tot.output, SERIES[3]],
    ['reasoning', tot.reasoning, SERIES[4]],
  ]
  return (
    <Card title="Where the tokens went"
      note="Cumulative per session, summed. Cached input is reported separately because Codex bills it separately.">
      {!total && <Empty>Nothing counted yet.</Empty>}
      {total > 0 && parts.map(([label, v, c]) => {
        const pct = (v || 0) / total * 100
        return <MeterBar key={label} pct={pct} label={Math.round(pct) + '%'} right={label} note={compact(v || 0) + ' tokens'} color={c} />
      })}
    </Card>
  )
}

export function CodexDays({ cx }) {
  return (
    <Card title="Tokens per day"
      note={cx.byDayNote || 'Total tokens per local day, from the rollouts.'}>
      <CodexDayChart rows={cx.byDay} />
    </Card>
  )
}

export function CodexProjects({ cx }) {
  const list = cx.projects || []
  return (
    <Card title="Projects" note="Working directories Codex has run in, from each rollout's own cwd.">
      <ul className="bv-feed">
        {!list.length && <li className="bv-empty">No rollout has recorded a working directory yet.</li>}
        {list.slice(0, 12).map((p, i) => (
          <li key={i} title={p.path}>
            <div className="name"><span className="txt">{p.label}</span></div>
            <div className="meta">
              <span>{p.sessions} session{p.sessions === 1 ? '' : 's'}</span>
              <span>{full(p.turns)} turns</span>
              <span>{compact(p.tokens)} tokens</span>
              <span>{p.branch || '-'}</span>
              <span>{ago(p.lastActive)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/* Codex value - and the reason there may not be one.
 *
 * This build ships no OpenAI rate card and will not invent one: a number nobody
 * can vouch for is worse than no number. So the panel prices what the user's
 * own `~/.tokenhud/rates.json` covers and, where it covers nothing, says what
 * would give it a figure instead of showing a silent blank or a $0 that reads
 * as "free". */
export function CodexValue({ cx }) {
  const priced = !!cx.priced
  const models = cx.byModel || []
  const unpricedTokens = models
    .filter(m => !m.priced)
    .reduce((a, m) => a + ((m.tokens || {}).total || 0), 0)

  return (
    <Card
      title="Estimated value"
      note={priced
        ? 'At the rates in your own card - this machine only, and never ranked.'
        : 'Counted, not priced.'}
      right={priced
        ? <span className="bv-headline tnum">{usd(cx.estUSD || 0)}</span>
        : <span className="lb-unpriced">not priced</span>}
    >
      {priced ? (
        <>
          <p className="bv-sub">
            Priced from <code>~/.tokenhud/rates.json</code>
            {cx.ratesAsOf ? <> · rates dated {cx.ratesAsOf}</> : null}.
            {unpricedTokens > 0 && (
              <> {compact(unpricedTokens)} tokens ran on models your card does not
              name, and are counted but left out of this figure.</>
            )}
          </p>
          <p className="bv-note">
            This is your number, from your file. It stays on this board - a
            shared or public leaderboard ranks on the rate card that ships with
            the build, the same one for everybody, so that a place on it cannot
            be bought by editing a rate.
          </p>
          <div className="bv-table-scroll">
            <table className="bv-table">
              <thead><tr><th>Model</th><th className="tnum">Tokens</th><th className="tnum">Est. value</th></tr></thead>
              <tbody>
                {models.map(r => (
                  <tr key={r.model}>
                    <td>{r.model}</td>
                    <td className="tnum">{compact((r.tokens || {}).total || 0)}</td>
                    <td className="tnum">
                      {r.priced
                        ? usd(r.estUSD || 0)
                        : <span className="lb-unpriced" title="Your rate card does not name this model.">not priced</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <Empty>
          {compact((cx.totals || {}).total || 0)} tokens counted, and no dollar figure -
          this build&rsquo;s rate card covers Anthropic models only, and inventing
          OpenAI prices would make this a guess wearing a measurement&rsquo;s clothes.
          To price it, put the rates you trust in <code>~/.tokenhud/rates.json</code>:
          <pre style={{ marginTop: 'var(--space-sm)' }}>{`{
  "asOf": "2026-08-27",
  "rates": { "gpt-5-codex": { "input": 1.25, "output": 10.00 } }
}`}</pre>
          Dollars per million tokens. The board picks it up on the next reading.
        </Empty>
      )}
    </Card>
  )
}

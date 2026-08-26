import { NO_ENTRIES, liveRollup } from '../../../lib/demand'
import { Card, Empty, MeterBar, Pill } from '../../board/panels'
import { ago, compact, dur, full, SERIES } from '../../board/util'

/* Live: what the fleet is running at this instant.
 *
 * This is the half of the signal that a daily rollup cannot give you. A month
 * of tokens says what a fleet did; a count of running agents says what it is
 * doing, and those two answer different questions — capacity against history.
 *
 * Every number here is a count. What each of those agents is working on is not
 * on this page and is not in the payload it reads: the whitelist carries the
 * product, the kind of session, whether it is headless and how long it has been
 * up, and stops there.
 *
 * The honest caveat is loud on purpose. "Right now" is the last reading each
 * machine sent, which is up to an interval old — and a machine that stopped
 * reporting is quiet, not idle.
 */

const KIND_TONE = { 'IDE session': 'ok', headless: 'warn' }

function Chips({ rows, total }) {
  if (!rows.length) return <span className="bv-sub">—</span>
  return (
    <div className="live-chips">
      {rows.map(r => (
        <span className="live-chip" key={r.key}>
          <b className="tnum">{r.count}</b>
          <span>{r.key}</span>
          <span className="live-chip-pct">{Math.round((r.count / (total || 1)) * 100)}%</span>
        </span>
      ))}
    </div>
  )
}

export default function Live({ board }) {
  const entries = board.entries || NO_ENTRIES
  const live = liveRollup(entries)
  const freshest = entries
    .map(e => e.lastActive)
    .filter(Boolean)
    .sort()
    .slice(-1)[0]

  return (
    <>
      <section className="hero-band">
        <div className="hero-band-head">
          <div>
            <span className="hero-eyebrow">Right now</span>
            <h1>
              {live.processes} agent{live.processes === 1 ? '' : 's'} running
            </h1>
            <p className="hero-lede">
              across {live.machinesRunning} of {live.machinesTotal} machine
              {live.machinesTotal === 1 ? '' : 's'}
              {live.headless > 0 && <> · {live.headless} headless</>}
              {freshest && <> · newest reading {ago(freshest)}</>}.
            </p>
          </div>
        </div>

        <div className="hero-stats">
          <div className="hero-stat">
            <div className="hero-stat-k">Reporting</div>
            <div className="hero-stat-v tnum">{live.reporting}/{live.machinesTotal}</div>
            <div className="hero-stat-d">{live.stale ? `${live.stale} gone quiet` : 'all checking in'}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Blocks open</div>
            <div className="hero-stat-v tnum">{live.blocksOpen}</div>
            <div className="hero-stat-d">five-hour windows in flight</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Requests in flight</div>
            <div className="hero-stat-v tnum">{compact(live.blockRequests)}</div>
            <div className="hero-stat-d">this block, across the fleet</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Output this block</div>
            <div className="hero-stat-v tnum">{compact(live.blockOutput)}</div>
            <div className="hero-stat-d">tokens</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-k">Longest running</div>
            <div className="hero-stat-v tnum">{live.longest ? dur(live.longest) : '—'}</div>
            <div className="hero-stat-d">of the agents up now</div>
          </div>
        </div>
      </section>

      <section className="bv-panel bv-cols-2">
        <Card title="By product" note="Which assistant the running agents belong to.">
          <Chips rows={live.byTool} total={live.processes} />
        </Card>
        <Card title="By kind" note="How they were started — an editor session, a headless run, a subagent.">
          <Chips rows={live.byKind} total={live.processes} />
        </Card>
      </section>

      <Card
        title="Machines with something running"
        note="One row per machine that had an agent up at its last reading."
      >
        {!live.machines.length && (
          <Empty>
            Nothing is running on any machine as of the last reading. That is a real
            answer, not a missing one — agents come and go between readings, and the
            Recently finished panel in Token Monitoring is where the ones that ended
            are listed.
          </Empty>
        )}
        {live.machines.length > 0 && (
          <div className="bv-table-scroll">
            <table className="bv-table">
              <thead>
                <tr>
                  <th>Machine</th>
                  <th className="lb-c-num tnum">Running</th>
                  <th>Kinds</th>
                  <th className="lb-c-num tnum">Longest up</th>
                  <th className="lb-c-bar">This 5h block</th>
                  <th className="lb-c-num tnum">Requests</th>
                </tr>
              </thead>
              <tbody>
                {live.machines.map(mch => {
                  const used = mch.block ? Math.min(100, (mch.block.minutesUsed / 300) * 100) : 0
                  return (
                    <tr key={mch.id}>
                      <td>
                        <div className="lb-who">
                          <span className={'sh-dot sh-dot--' + (mch.status === 'up' ? 'ok' : mch.status === 'stale' ? 'warn' : 'off')} />
                          <span className="lb-name">{mch.name}</span>
                        </div>
                        <div className="lb-meta">{mch.tools.join(', ')}</div>
                      </td>
                      <td className="lb-c-num tnum">{mch.count}</td>
                      <td>
                        <div className="bv-badges">
                          {[...new Set(mch.kinds)].slice(0, 3).map(k => (
                            <Pill key={k} tone={KIND_TONE[k] || ''}>{k}</Pill>
                          ))}
                          {!mch.kinds.length && <span className="bv-sub">—</span>}
                        </div>
                      </td>
                      <td className="lb-c-num tnum">{mch.oldest ? dur(mch.oldest) : '—'}</td>
                      <td className="lb-c-bar">
                        {mch.block
                          ? <MeterBar pct={used} color={SERIES[0]}
                            label={mch.block.open ? 'open' : 'closed'}
                            right={mch.block.minutesLeft ? dur(mch.block.minutesLeft * 60) + ' left' : ''} />
                          : <span className="bv-sub">—</span>}
                      </td>
                      <td className="lb-c-num tnum">{mch.block ? full(mch.block.requests) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="bv-note" style={{ marginTop: 'var(--space-md)' }}>
          &ldquo;Right now&rdquo; means the last reading each machine sent, so this is up to one
          reporting interval old. A machine that stopped reporting shows its last known
          state and is marked as such — quiet is not the same as idle, and a board that
          conflated them would understate load exactly when it mattered.
          Counts only: what any of these agents is working on is not collected here.
        </p>
      </Card>
    </>
  )
}

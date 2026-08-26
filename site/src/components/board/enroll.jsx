import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Empty, Pill } from './panels'
import { ago, useNow } from './util'

/* Machine registration, cloud edition. The actions live in the `cloud`
   object Portal builds (mint / revoke / remove) — these components never
   talk to a server themselves. The one-shot link model is unchanged from
   the self-host board: the command is shown once, only hashes are stored,
   and a closed modal cannot resurrect a token. */

const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/install.sh | sh'

/* Two vocabularies, one panel. The cloud tier registers a named machine and
   waits for it (registered → enrolling → active); a self-hosted server has no
   row until a machine claims a link, and then a person approves it (pending →
   approved). Both are listed here rather than translated, so a status on
   screen is the status the server actually holds. */
const STATUS_TONE = {
  registered: 'warn', enrolling: 'warn', active: 'ok', revoked: 'bad',
  pending: 'warn', approved: 'ok', denied: 'bad',
}
const STATUS_LABEL = {
  registered: 'waiting', enrolling: 'enrolling', active: 'active', revoked: 'revoked',
  pending: 'needs approval', approved: 'active', denied: 'denied',
}

function CopyRow({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    try {
      navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard may be unavailable; the text is selectable */ }
  }
  return (
    <div className="bv-enroll-cmd">
      <code>{text}</code>
      <button className="bv-toggle" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

/* ── shared: mint a one-time install token from the server ────────── */

async function mintInstallToken(cloud) {
  const url = cloud.ingestUrl
  const key = cloud.apiKeyRef?.current || ''
  const res = await fetch(`${url}/api/v1/install-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-TokenHUD-Key': key } : {}),
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j.error || 'HTTP ' + res.status)
  }
  return (await res.json()).token
}

/* ── helpers ──────────────────────────────────────────────────────── */

function copyText(text) {
  /* navigator.clipboard.writeText requires a secure context AND the
     document to be focused. When it fails (http localhost, iframe, etc.)
     fall back to the old execCommand approach. */
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => execCopy(text))
    } else {
      execCopy(text)
    }
  } catch { execCopy(text) }
}
function execCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

async function fetchOverviewHosts(cloud) {
  const url = cloud.ingestUrl
  const key = cloud.apiKeyRef?.current || ''
  const res = await fetch(`${url}/api/v1/overview`, {
    headers: key ? { 'X-TokenHUD-Key': key } : {},
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return []
  const j = await res.json()
  return j.hosts || []
}

/* ── add-machine modal ───────────────────────────────────────────
   Phases:
   1. generate — mint install token, build the one-liner
   2. command  — show the command with Copy button
   3. waiting  — after copy, poll the server for a new host
   4. done     — new host detected, or duplicate/version mismatch  */

export function AddMachineModal({ cloud, onClose }) {
  const [phase, setPhase] = useState('generate') // generate | command | waiting | done
  const [oneLiner, setOneLiner] = useState(null)
  const [enrollCmd, setEnrollCmd] = useState(null)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)
  const [, tick] = useState(0)
  const isCloud = typeof cloud.mint === 'function'

  /* Snapshot of hosts at the moment the modal opened. */
  const baselineRef = useRef(null)

  /* What we found after waiting. */
  const [result, setResult] = useState(null) // { type: 'new'|'existing'|'upgrade', host }
  const [elapsed, setElapsed] = useState(0)
  const waitStart = useRef(null)

  /* Phase 1: generate the command. */
  const generate = useCallback(async () => {
    setPhase('generate')
    setError(null)
    setResult(null)
    try {
      if (isCloud) {
        /* Cloud mode: register the machine via cloud.mint() and show
           the install + enroll commands. The machine card appears in
           the board immediately; it moves to "active" once the agent
           completes enrollment. */
        const enrollment = await cloud.mint()
        setOneLiner(INSTALL_CMD)
        setEnrollCmd(enrollment.command)
        setPhase('command')
      } else {
        /* Self-host mode: mint a one-shot install token from the
           local server and build the curl one-liner. */
        baselineRef.current = await fetchOverviewHosts(cloud)
        const token = await mintInstallToken(cloud)
        const url = cloud.ingestUrl
        const scriptUrl = `${url}/api/v1/install-script?server=${encodeURIComponent(url)}&t=${token}`
        setOneLiner(`curl -fsSL "${scriptUrl}" | sh`)
        setPhase('command')
      }
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [cloud, isCloud])

  useEffect(() => {
    if (started.current) return
    started.current = true
    generate()
  }, [generate])

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* Copy and move to waiting phase (self-host only; in cloud mode the
     "Done" button closes the modal directly). */
  const doCopy = () => {
    if (!oneLiner) return
    copyText(oneLiner)
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
      waitStart.current = Date.now()
      setElapsed(0)
      setPhase('waiting')
    }, 800)
  }

  /* Phase 3: poll the server every 3s for a new host.

     Detection — three things to spot, checked in this order:
     1. Brand-new hostname → "Machine connected"
     2. Same hostname, different agent_version → "Agent upgraded"
     3. Same hostname, `last_seen` moved forward → "Already running"
        (covers re-installs on the same machine, which is the common case
        for a single-machine setup) */
  useEffect(() => {
    if (phase !== 'waiting') return
    let cancelled = false
    const baseline = baselineRef.current || []
    const baseByHost = {}
    for (const h of baseline) baseByHost[h.host] = h

    const poll = async () => {
      try {
        const hosts = await fetchOverviewHosts(cloud)
        if (cancelled) return

        /* 1. A hostname that wasn't there before. */
        const newHost = hosts.find(h => !baseByHost[h.host])
        if (newHost) {
          setResult({ type: 'new', host: newHost })
          setPhase('done')
          return
        }

        /* 2. Same hostname, version changed → upgrade. */
        const upgraded = hosts.find(h => {
          const b = baseByHost[h.host]
          return b && h.agent_version && b.agent_version
            && h.agent_version !== b.agent_version
        })
        if (upgraded) {
          setResult({
            type: 'upgrade', host: upgraded,
            oldVersion: baseByHost[upgraded.host].agent_version,
          })
          setPhase('done')
          return
        }

        /* 3. Same hostname, last_seen moved forward (fresh reading).
              Compare timestamps: if the current last_seen is newer than
              the baseline, the agent is alive. */
        const refreshed = hosts.find(h => {
          const b = baseByHost[h.host]
          if (!b) return false
          /* last_seen is an ISO string from the server. */
          const nowSeen = h.last_seen ? new Date(h.last_seen).getTime() : 0
          const baseSeen = b.last_seen ? new Date(b.last_seen).getTime() : 0
          return nowSeen > baseSeen
        })
        if (refreshed) {
          setResult({ type: 'existing', host: refreshed })
          setPhase('done')
          return
        }
      } catch { /* network blip, keep polling */ }
    }

    const timer = setInterval(() => {
      if (cancelled) return
      setElapsed(Math.floor((Date.now() - (waitStart.current || Date.now())) / 1000))
      poll()
    }, 3000)
    poll() // first check immediately

    const tickTimer = setInterval(() => {
      if (!cancelled) tick(n => n + 1)
      setElapsed(Math.floor((Date.now() - (waitStart.current || Date.now())) / 1000))
    }, 1000)

    return () => { cancelled = true; clearInterval(timer); clearInterval(tickTimer) }
  }, [phase, cloud])

  const elapsedText = elapsed < 60
    ? `${elapsed}s`
    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`

  return (
    <div className="bv-modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bv-modal enroll-modal" role="dialog" aria-label="Add a machine">
        <button className="bv-modal-close" onClick={onClose} aria-label="Close">×</button>

        {/* ── generating ── */}
        {phase === 'generate' && !error && (
          <>
            <h2>Add a machine</h2>
            <p className="enroll-sub">Generating install command…</p>
          </>
        )}

        {phase === 'generate' && error && (
          <>
            <h2>Add a machine</h2>
            <div className="bv-warnbar">
              {error}
              <button className="bv-toggle" onClick={generate} style={{ marginLeft: 8 }}>Retry</button>
            </div>
          </>
        )}

        {/* ── command ready, waiting for copy ── */}
        {phase === 'command' && !isCloud && (
          <>
            <h2>Add a machine</h2>
            <p className="enroll-sub">
              Run this on the machine you want to monitor. It installs the
              agent, connects it to your server, and starts reporting.
              The link is single-use and expires in 5 minutes.
            </p>

            <div className="enroll-cmd-hero" onClick={doCopy}>
              <pre className="enroll-cmd-text">{oneLiner}</pre>
              <button className="enroll-cmd-copy" type="button">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </>
        )}

        {phase === 'command' && isCloud && (
          <>
            <h2>Add a machine</h2>
            <p className="enroll-sub">
              Run these commands on the machine you want to monitor.
              The enrollment link is single-use and expires in 15 minutes.
            </p>

            <p className="enroll-step">1. Install the agent</p>
            <CopyRow text={oneLiner} />

            <p className="enroll-step" style={{ marginTop: 12 }}>2. Enroll this machine</p>
            <CopyRow text={enrollCmd} />

            <button className="btn btn--primary" onClick={onClose} style={{ marginTop: 16, width: '100%' }}>
              Done
            </button>
          </>
        )}

        {/* ── waiting for agent to connect ── */}
        {phase === 'waiting' && (
          <>
            <h2>Waiting for agent…</h2>
            <p className="enroll-sub">
              Run the command on the target machine. The agent will appear
              here once it sends its first reading.
            </p>
            <div className="enroll-waiting">
              <span className="enroll-spinner" />
              <span className="tnum">{elapsedText}</span>
            </div>
          </>
        )}

        {/* ── done: new machine detected ── */}
        {phase === 'done' && result?.type === 'new' && (
          <>
            <h2>Machine connected</h2>
            <p className="enroll-sub">
              <strong>{result.host.host}</strong> is now reporting
              (agent {result.host.agent_version}).
            </p>
            <div className="enroll-done">
              <span className="enroll-done-check">✓</span>
              <span>Ready</span>
            </div>
            <button className="btn btn--primary" onClick={onClose} style={{ marginTop: 16, width: '100%' }}>
              Done
            </button>
          </>
        )}

        {/* ── done: existing machine (already running) ── */}
        {phase === 'done' && result?.type === 'existing' && (
          <>
            <h2>Already running</h2>
            <p className="enroll-sub">
              <strong>{result.host.host}</strong> already has an agent running
              (version {result.host.agent_version}). It just sent a fresh reading.
            </p>
            <div className="enroll-done">
              <span className="enroll-done-check" style={{ color: 'var(--color-warn)' }}>⚠</span>
              <span>Agent already active on this machine</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn--primary" onClick={onClose} style={{ flex: 1 }}>
                OK
              </button>
            </div>
          </>
        )}

        {/* ── done: version changed (upgrade detected) ── */}
        {phase === 'done' && result?.type === 'upgrade' && (
          <>
            <h2>Agent upgraded</h2>
            <p className="enroll-sub">
              <strong>{result.host.host}</strong> upgraded
              from {result.oldVersion} to {result.host.agent_version}.
            </p>
            <div className="enroll-done">
              <span className="enroll-done-check">✓</span>
              <span>Upgrade complete</span>
            </div>
            <button className="btn btn--primary" onClick={onClose} style={{ marginTop: 16, width: '100%' }}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ── upgrade-agent modal ─────────────────────────────────────────── */

export function UpgradeModal({ cloud, onClose }) {
  const [phase, setPhase] = useState('generate')
  const [oneLiner, setOneLiner] = useState(null)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  const isCloud = typeof cloud.mint === 'function'
  const generate = useCallback(async () => {
    setPhase('generate')
    setError(null)
    try {
      if (isCloud) {
        /* Cloud mode: re-running the install script upgrades in place. */
        setOneLiner(INSTALL_CMD)
        setPhase('command')
      } else {
        const token = await mintInstallToken(cloud)
        const url = cloud.ingestUrl
        const scriptUrl = `${url}/api/v1/upgrade-script?server=${encodeURIComponent(url)}&t=${token}`
        setOneLiner(`curl -fsSL "${scriptUrl}" | sh`)
        setPhase('command')
      }
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [cloud, isCloud])

  useEffect(() => {
    if (started.current) return
    started.current = true
    generate()
  }, [generate])

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const doCopy = () => {
    if (!oneLiner) return
    copyText(oneLiner)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bv-modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bv-modal enroll-modal" role="dialog" aria-label="Upgrade agent">
        <button className="bv-modal-close" onClick={onClose} aria-label="Close">×</button>

        <h2>Upgrade agent</h2>

        {phase === 'generate' && !error && (
          <p className="enroll-sub">Generating command…</p>
        )}

        {phase === 'generate' && error && (
          <div className="bv-warnbar">
            {error}
            <button className="bv-toggle" onClick={generate} style={{ marginLeft: 8 }}>Retry</button>
          </div>
        )}

        {phase === 'command' && (
          <>
            <p className="enroll-sub">
              Run this on the machine to upgrade. It downloads the latest release,
              backs up the current binaries, verifies the new ones, and rolls back
              automatically if anything fails. Single-use link, expires in 5 minutes.
            </p>

            <div className="enroll-cmd-hero" onClick={doCopy}>
              <pre className="enroll-cmd-text">{oneLiner}</pre>
              <button className="enroll-cmd-copy" type="button">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── every machine on the account, and the doors out ────────────────── */

function AssistantChips({ assistants }) {
  const list = Array.isArray(assistants) ? assistants : []
  if (!list.length) return null
  return (
    <div className="bv-chips" style={{ margin: '8px 0 0' }}>
      {list.map(a => (
        <span key={a.id} className={'bv-chip' + (a.hasData || a.detected ? '' : ' off')}
          title={a.note || ''}>
          <span>{a.name}</span>
          {a.hasData && <span className="n">data</span>}
        </span>
      ))}
    </div>
  )
}

const UNINSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/reddy-sh/tokenhud/main/scripts/uninstall-agent.sh | sh'

/* Removing a machine from the account only removes its server record. The
   portal cannot execute a command on somebody else's computer, so make the
   necessary local action explicit and give it to them before the record goes
   away. This also prevents a still-running agent from looking like it was
   uninstalled just because its next heartbeat was rejected. */
function UninstallMachineModal({ machine, onClose, onRemove }) {
  const [copied, setCopied] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState(null)
  const name = machine.label || machine.hostname || 'this machine'

  const copy = () => {
    copyText(UNINSTALL_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const removeFromPortal = async () => {
    setRemoving(true)
    setError(null)
    try {
      await onRemove(machine.id)
      onClose()
    } catch (e) {
      setError(e?.message || String(e))
      setRemoving(false)
    }
  }

  return (
    <div className="bv-modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bv-modal enroll-modal" role="dialog" aria-modal="true" aria-label={`Uninstall ${name}`}>
        <button className="bv-modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Uninstall the agent</h2>
        <p className="enroll-sub">
          Run this on <strong>{name}</strong>. It stops the agent, removes its
          login service and binary, and deletes TokenHUD&apos;s local data. The
          portal cannot run it on that computer for you.
        </p>
        <div className="enroll-cmd-hero" onClick={copy}>
          <pre className="enroll-cmd-text">{UNINSTALL_CMD}</pre>
          <button className="enroll-cmd-copy" type="button">
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="enroll-hint">
          Once it has run, remove the revoked machine from this portal. That
          only clears its account record; it does not run the uninstall command.
        </p>
        {error && <div className="bv-warnbar">{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="bv-toggle" onClick={onClose} disabled={removing}>Cancel</button>
          <button className="btn btn--primary" onClick={removeFromPortal} disabled={removing}>
            {removing ? 'Removing…' : 'I ran it — remove from portal'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function MachinesPanel({ machines, cloud, onAdd }) {
  const list = machines || []
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [uninstalling, setUninstalling] = useState(null)
  const now = useNow(1000)

  const act = (id, fn) => {
    setBusy(id)
    setError(null)
    fn(id)
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setBusy(null))
  }

  /* Status counts for the filter bar. */
  const counts = { all: list.length, active: 0, pending: 0, revoked: 0 }
  for (const m of list) {
    if (m.status === 'active' || m.status === 'approved') counts.active++
    else if (m.status === 'pending' || m.status === 'registered' || m.status === 'enrolling') counts.pending++
    else if (m.status === 'revoked' || m.status === 'denied') counts.revoked++
  }

  /* Filter + search. */
  const q = search.toLowerCase()
  const filtered = list.filter(mc => {
    if (filter === 'active' && mc.status !== 'active' && mc.status !== 'approved') return false
    if (filter === 'pending' && mc.status !== 'pending' && mc.status !== 'registered' && mc.status !== 'enrolling') return false
    if (filter === 'revoked' && mc.status !== 'revoked' && mc.status !== 'denied') return false
    if (q && !(mc.label || '').toLowerCase().includes(q)
          && !(mc.hostname || '').toLowerCase().includes(q)
          && !(mc.platform || '').toLowerCase().includes(q)
          && !(mc.installId || '').toLowerCase().includes(q)) return false
    return true
  })

  const showToolbar = list.length > 3

  return (
    <Card title="Machines"
      note="Each machine holds its own key. Revoking one shuts one door — its next report is refused and the agent stops. Re-joining takes a fresh registration."
      right={<button className="btn btn--primary" style={{ padding: '4px 14px', fontSize: 'var(--text-xs)' }} onClick={onAdd}>Add machine</button>}>

      {/* Summary chips when fleet is large. */}
      {showToolbar && (
        <div className="mc-toolbar">
          <div className="mc-filters">
            {[
              ['all',     'All',     counts.all],
              ['active',  'Active',  counts.active],
              ['pending', 'Pending', counts.pending],
              ['revoked', 'Revoked', counts.revoked],
            ].map(([id, label, n]) => n > 0 || id === 'all' ? (
              <button key={id} className={'mc-filter' + (filter === id ? ' mc-filter--on' : '')}
                onClick={() => setFilter(id)}>
                {label} <span className="mc-filter-n">{n}</span>
              </button>
            ) : null)}
          </div>
          <input className="mc-search" type="text" value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search machines\u2026" aria-label="Search machines" />
        </div>
      )}

      {error && <div className="bv-warnbar">{error}</div>}
      {!list.length && (
        <Empty>
          No machine is registered yet. Add one — it hands you the install and enroll
          commands, and the board fills in as soon as the agent reports.
        </Empty>
      )}
      {list.length > 0 && !filtered.length && (
        <Empty>No machines match the current filter.</Empty>
      )}
      {filtered.length > 0 && (
        <ul className="bv-feed">
          {filtered.map(mc => {
            const left = mc.status === 'registered' && mc.enrollTokenExpiresAt
              ? Math.floor((new Date(mc.enrollTokenExpiresAt).getTime() - now) / 1000)
              : null
            const awaiting = mc.status === 'pending' && !!cloud.approve
            const live = mc.status === 'active' || mc.status === 'approved'
              || mc.status === 'registered' || mc.status === 'enrolling'
            return (
              <li key={mc.id}>
                <div className="name">
                  <Pill tone={STATUS_TONE[mc.status] || ''}>{STATUS_LABEL[mc.status] || mc.status}</Pill>
                  <span>{mc.label}</span>
                  {awaiting && (
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--space-xs)' }}>
                      <button className="btn btn--primary" style={{ padding: '2px 12px', fontSize: 'var(--text-xs)' }}
                        disabled={busy === mc.id} onClick={() => act(mc.id, cloud.approve)}>
                        Approve
                      </button>
                      <button className="bv-toggle"
                        disabled={busy === mc.id} onClick={() => act(mc.id, cloud.deny)}>
                        Deny
                      </button>
                    </span>
                  )}
                  {!awaiting && live && (
                    <button className="bv-toggle" style={{ marginLeft: 'auto' }}
                      disabled={busy === mc.id} onClick={() => act(mc.id, cloud.revoke)}>
                      {mc.status === 'active' || mc.status === 'approved' ? 'Revoke' : 'Cancel'}
                    </button>
                  )}
                  {(mc.status === 'revoked' || mc.status === 'denied') && cloud.remove && (
                    <button className="bv-toggle" style={{ marginLeft: 'auto' }}
                      disabled={busy === mc.id} onClick={() => setUninstalling(mc)}>
                      Remove
                    </button>
                  )}
                </div>
                <div className="meta">
                  {mc.status === 'registered' ? (
                    <>
                      <span className="bv-paircode" style={{ fontSize: 'var(--text-xs)' }}
                        title="Must match the code the enrolling terminal prints">{mc.code}</span>
                      {left != null && left > 0 && (
                        <span className="tnum">link expires {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
                      )}
                      {left != null && left <= 0 && <span>link expired unclaimed — cancel it and mint a new one</span>}
                    </>
                  ) : (
                    <>
                      {awaiting && (
                        <span className="bv-paircode" style={{ fontSize: 'var(--text-xs)' }}
                          title="Must match the code the enrolling terminal prints">{mc.code}</span>
                      )}
                      <span>{mc.platform || '—'}</span>
                      <span>agent {mc.agentVersion || '?'}</span>
                      {mc.hostname && mc.hostname !== mc.label && <span>hostname {mc.hostname}</span>}
                      {mc.installId && <span className="mono">id {String(mc.installId).slice(0, 8)}</span>}
                      {awaiting && mc.manifestDigest && (
                        <span className="mono" title="What this machine agreed to read. A release that reads more changes this digest and asks again.">
                          manifest {mc.manifestDigest}
                        </span>
                      )}
                      <span>{mc.decided_at ? `enrolled ${ago(mc.decided_at)}` : `asked ${ago(mc.created_at)}`}</span>
                      {mc.status === 'revoked' && <span>needs a fresh registration to rejoin</span>}
                    </>
                  )}
                </div>
                {mc.status !== 'registered' && <AssistantChips assistants={mc.assistants} />}
              </li>
            )
          })}
        </ul>
      )}
      {uninstalling && (
        <UninstallMachineModal
          machine={uninstalling}
          onClose={() => setUninstalling(null)}
          onRemove={cloud.remove}
        />
      )}
    </Card>
  )
}

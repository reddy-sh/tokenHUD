import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fleetOf, rankBoard } from '../lib/leaderboard'
import AdminSidebar from './admin/AdminSidebar'
import AdminTopbar from './admin/AdminTopbar'
import LeaderboardPage, { LEADERBOARD_KEYS, LEADERBOARD_PAGES } from './admin/LeaderboardPage'
import RootRail, { SECTIONS } from './admin/RootRail'
import SectionRail from './admin/SectionRail'
import Settings from './admin/Settings'
import { ShareModal } from './board/share'
import BoardView from './BoardView'

/* The self-host admin portal.
 *
 * Two levels of navigation, because they answer different questions and
 * collapsing one should not cost you the other.
 *
 *   RootRail      which product: Token Monitoring, Leaderboard, Settings.
 *                 Changes what the content area IS. Toggled by the topbar
 *                 hamburger.
 *   AdminSidebar  inside Token Monitoring only: which machine, which
 *                 assistant, and which part of that machine's board. Changes
 *                 where in the content area you are looking. Has its own
 *                 collapse control, because on a narrow screen the machine
 *                 list is the first thing you give up and the product switch
 *                 is the last.
 *
 * The Leaderboard is at the root rather than in the sidebar because it is the
 * one view that is about the fleet instead of a machine: nothing on it is
 * scoped by which laptop is selected, so it has no business living behind a
 * machine picker. */

const SK_KEY = 'tokenhud_api_key'
const SK_URL = 'tokenhud_server_url'
const SK_SECTION = 'tokenhud_section'
const SK_LBPAGE = 'tokenhud_lb_page'
const SECTION_KEYS = SECTIONS.map(x => x.key)
const SK_ROOTNAV = 'tokenhud_nav_root'
const SK_SUBNAV = 'tokenhud_nav_sub'
const DEFAULT_URL = 'http://127.0.0.1:8787'

function load(k, fb) { try { return localStorage.getItem(k) || fb } catch { return fb } }
function save(k, v) { try { localStorage.setItem(k, v) } catch {} }

async function apiFetch(url, key, path, body) {
  const res = await fetch(url + path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      ...(key ? { 'X-TokenHUD-Key': key } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status)
  return json
}

/* ── theme ─────────────────────────────────────────────────────────── */

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('tokenhud_theme') || 'dark' } catch { return 'dark' }
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('tokenhud_theme', theme) } catch {}
  }, [theme])
  const toggle = useCallback(() => setTheme(t => t === 'dark' ? 'light' : 'dark'), [])
  return { theme, toggle }
}

/* AdminSidebar and AdminTopbar are now in admin/AdminSidebar.jsx and
   admin/AdminTopbar.jsx, shared with the cloud Portal. */

/* ── handshake step ────────────────────────────────────────────────── */

function HStep({ done, active, label, detail }) {
  return (
    <div className={'sh-hs ' + (done ? 'sh-hs--done' : active ? 'sh-hs--active' : '')}>
      <span className={'sh-dot ' + (done ? 'sh-dot--ok' : active ? 'sh-dot--pulse' : '')} />
      <div>
        <span className="sh-hs-label">{label}</span>
        {detail && <span className="sh-hs-detail">{detail}</span>}
      </div>
    </div>
  )
}

/* ── probing splash ────────────────────────────────────────────────── */

function Probing() {
  return (
    <div className="dashboard-frame sh-center">
      <div style={{ textAlign: 'center' }}>
        <span className="bv-spinner" />
        <div className="sh-probe-label">Connecting to server&hellip;</div>
      </div>
    </div>
  )
}

/* ── server offline ────────────────────────────────────────────────── */

function Offline({ serverUrl, onRetry, onClose }) {
  return (
    <div className="dashboard-frame sh-center">
      <div className="sh-offline">
        <div className="sh-offline-icon">!</div>
        <h2>Server not reachable</h2>
        <p>Could not connect to <code>{serverUrl}</code></p>
        <div className="sh-cmd-block">
          <pre className="sh-cmd">./scripts/start-server.sh</pre>
        </div>
        <p className="sh-hint">Start the server, then try again.</p>
        <div className="sh-offline-actions">
          <button className="btn btn--primary" onClick={onRetry}>Retry</button>
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

/* ── setup content (renders inside admin shell content area) ───────── */

function SetupContent({ serverUrl, data, apiKeyRef, onLive }) {
  const [key, setKey] = useState(apiKeyRef.current)
  const [verified, setVerified] = useState(!!apiKeyRef.current)
  const [enrollment, setEnrollment] = useState(null)
  const [handshake, setHandshake] = useState([])
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data?.hosts?.length > 0) {
      const t = setTimeout(onLive, 600)
      return () => clearTimeout(t)
    }
  }, [data?.hosts?.length, onLive])

  useEffect(() => {
    if (!apiKeyRef.current || !data?.machines) return
    const pending = data.machines.filter(m => m.status === 'pending')
    const enrolling = data.machines.filter(m => m.status === 'enrolling')
    const active = data.machines.filter(m => m.status === 'active')
    if (enrolling.length || pending.length)
      setHandshake(h => [...new Set([...h, 'claimed'])])
    for (const m of pending)
      apiFetch(serverUrl, apiKeyRef.current, '/api/v1/machines/decide', {
        installId: m.installId, action: 'approve',
      }).then(() => setHandshake(h => [...new Set([...h, 'approved'])])).catch(() => {})
    if (active.length) setHandshake(h => [...new Set([...h, 'approved', 'active'])])
  }, [data?.machines, serverUrl, apiKeyRef])

  const verifyKey = async e => {
    e.preventDefault()
    const k = key.trim()
    if (!k) return
    setBusy(true); setError(null)
    try {
      const r = await apiFetch(serverUrl, k, '/api/v1/overview')
      if (!Array.isArray(r.machines))
        throw new Error('Key was not accepted')
      apiKeyRef.current = k
      save(SK_KEY, k)
      setVerified(true)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const mint = async () => {
    setBusy(true); setError(null)
    try {
      const r = await apiFetch(serverUrl, apiKeyRef.current, '/api/v1/enroll/new', {})
      const link = `${serverUrl}#${r.token}`
      setEnrollment({
        token: r.token, code: r.code,
        enrollCmd: `tokenhud-agent enroll "${link}"`,
        fullCmd: `curl -fsSL https://tokenhud.com/install.sh | sh\ntokenhud-agent enroll "${link}"`,
      })
      setHandshake(['minted'])
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const copy = (text, id) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="adm-page">
      <h1 className="sh-title">Set up AI monitoring</h1>
      <p className="sh-subtitle">
        Connect an agent to start tracking token usage, costs, and sessions across your AI coding tools.
      </p>

      {/* Step 1: Server */}
      <div className="sh-step sh-step--done">
        <div className="sh-step-head">
          <span className="sh-step-num">1</span>
          <div className="sh-step-info">
            <span className="sh-step-label">Server detected</span>
            <span className="sh-step-meta">{serverUrl.replace(/^https?:\/\//, '')}</span>
          </div>
          <span className="sh-check">&check;</span>
        </div>
      </div>

      {/* Step 2: Authenticate */}
      <div className={'sh-step ' + (verified ? 'sh-step--done' : 'sh-step--active')}>
        <div className="sh-step-head">
          <span className="sh-step-num">2</span>
          <div className="sh-step-info">
            <span className="sh-step-label">{verified ? 'Authenticated' : 'Authenticate'}</span>
            {verified && <span className="sh-step-meta">Key verified</span>}
          </div>
          {verified && <span className="sh-check">&check;</span>}
        </div>
        {!verified && (
          <div className="sh-step-body">
            {error && <div className="sh-error">{error}</div>}
            <form onSubmit={verifyKey} className="sh-key-row">
              <input type="password" value={key}
                onChange={e => { setKey(e.target.value); setError(null) }}
                placeholder="Paste ingest key from .env"
                autoComplete="off" autoFocus className="sh-input" />
              <button className="btn btn--primary sh-verify-btn" type="submit"
                disabled={busy || !key.trim()}>
                {busy ? 'Verifying\u2026' : 'Verify'}
              </button>
            </form>
            <p className="sh-hint">
              Find the key in <code>.env</code> next to the server, or run <code>tokenhud-server --new-key</code>
            </p>
          </div>
        )}
      </div>

      {/* Step 3: Install agent */}
      <div className={'sh-step ' + (enrollment ? 'sh-step--active' : verified ? 'sh-step--ready' : 'sh-step--locked')}>
        <div className="sh-step-head">
          <span className="sh-step-num">3</span>
          <div className="sh-step-info">
            <span className="sh-step-label">Install &amp; connect the agent</span>
            {!verified && <span className="sh-step-meta">Complete step 2 first</span>}
          </div>
        </div>
        {verified && !enrollment && (
          <div className="sh-step-body">
            {error && <div className="sh-error">{error}</div>}
            <p className="sh-hint" style={{ margin: '0 0 12px' }}>
              Generate a one-time enrollment link. Single-use, expires in 15 minutes.
            </p>
            <button className="btn btn--primary" onClick={mint} disabled={busy}>
              {busy ? 'Generating\u2026' : <>Generate install command <span aria-hidden>&rarr;</span></>}
            </button>
          </div>
        )}
        {enrollment && (
          <div className="sh-step-body">
            <div className="sh-cmd-label">Run this on the machine you want to monitor:</div>
            <div className="sh-cmd-block">
              <pre className="sh-cmd">{enrollment.fullCmd}</pre>
              <button className="sh-copy" onClick={() => copy(enrollment.fullCmd, 'full')}>
                {copied === 'full' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="sh-cmd-label" style={{ marginTop: 16 }}>Already have the agent?</div>
            <div className="sh-cmd-block sh-cmd-block--compact">
              <pre className="sh-cmd">{enrollment.enrollCmd}</pre>
              <button className="sh-copy" onClick={() => copy(enrollment.enrollCmd, 'enroll')}>
                {copied === 'enroll' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="sh-handshake">
              <div className="sh-handshake-title">Secure handshake</div>
              <HStep done={handshake.includes('minted')} label="Enrollment token minted"
                detail="One-shot · expires in 15 min" />
              <HStep done={handshake.includes('claimed')}
                active={handshake.includes('minted') && !handshake.includes('claimed')}
                label="Agent connected"
                detail={enrollment.code ? `Pairing code: ${enrollment.code}` : 'Waiting\u2026'} />
              <HStep done={handshake.includes('approved')}
                active={handshake.includes('claimed') && !handshake.includes('approved')}
                label="Identity verified &amp; approved" />
              <HStep done={handshake.includes('active')}
                active={handshake.includes('approved') && !handshake.includes('active')}
                label="Per-machine key exchanged"
                detail="Independently revocable" />
            </div>
          </div>
        )}
      </div>

      <div className="sh-skip">
        Already running the agent with a shared key?{' '}
        <button onClick={onLive}>Open the dashboard</button>
        &nbsp;&mdash; shared-key agents show up automatically.
      </div>
    </div>
  )
}

/* ── main component ────────────────────────────────────────────────── */

export default function SelfHost({ onClose }) {
  const [phase, setPhase] = useState('probing')
  /* Which product. Remembered, because coming back to the board you were
     reading is what a dashboard is for. */
  const [section, setSection] = useState(() => {
    const v = load(SK_SECTION, 'monitoring')
    return SECTION_KEYS.includes(v) ? v : 'monitoring'
  })
  /* Which page inside the Leaderboard. Remembered separately from the section
     so switching to Token Monitoring and back lands where you left. */
  const [lbPage, setLbPage] = useState(() => {
    const v = load(SK_LBPAGE, 'standings')
    return LEADERBOARD_KEYS.includes(v) ? v : 'standings'
  })
  const [rootMini, setRootMini] = useState(() => load(SK_ROOTNAV, '') === '1')
  const [collapsed, setCollapsed] = useState(() => load(SK_SUBNAV, '') === '1')
  const [shareOpen, setShareOpen] = useState(false)
  const [shareSeq, setShareSeq] = useState(0)
  const [sharedLive, setSharedLive] = useState(false)
  const { theme, toggle: toggleTheme } = useTheme()
  const serverUrl = useRef(load(SK_URL, DEFAULT_URL).replace(/\/+$/, '') || DEFAULT_URL)
  const apiKeyRef = useRef(load(SK_KEY, ''))
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [live, setLive] = useState(true)
  const [nonce, setNonce] = useState(0)
  const [probeSeq, setProbeSeq] = useState(0)
  const [boardState, setBoardState] = useState(null)
  const esRef = useRef(null)
  const [latestRelease, setLatestRelease] = useState(null)

  /* ── auto-probe on mount and on retry ── */
  useEffect(() => {
    let cancelled = false
    setPhase('probing')
    ;(async () => {
      const url = serverUrl.current
      try {
        const json = await apiFetch(url, apiKeyRef.current, '/api/v1/overview')
        if (cancelled) return
        save(SK_URL, url)
        setData(json)
        setLastUpdate(new Date())
        /* Auto-fetch the admin key from the server (loopback only).
           This lets the portal mint enrollments and generate install
           scripts without the user ever touching a key. */
        if (!apiKeyRef.current) {
          try {
            const kr = await apiFetch(url, '', '/api/v1/portal-key')
            if (kr.key) { apiKeyRef.current = kr.key; save(SK_KEY, kr.key) }
          } catch { /* not available — server is remote or key not set */ }
        }
        /* Fetch the latest release from GitHub so we can flag outdated
           agents. Fire-and-forget — if it fails we just don't show the
           badge, which is the right fallback. */
        fetch('https://api.github.com/repos/reddy-sh/tokenhud/releases/latest', {
          signal: AbortSignal.timeout(8000),
        })
          .then(r => r.ok ? r.json() : null)
          .then(j => { if (j?.tag_name && !cancelled) setLatestRelease(j.tag_name.replace(/^v/, '')) })
          .catch(() => {})
        setPhase(json.hosts?.length > 0 ? 'live' : 'setup')
      } catch {
        if (cancelled) return
        setPhase('offline')
      }
    })()
    return () => { cancelled = true }
  }, [probeSeq])

  const fetchData = useCallback(async () => {
    const url = serverUrl.current
    try {
      const json = await apiFetch(url, apiKeyRef.current, '/api/v1/overview')
      setData(json)
      setLastUpdate(new Date())
      setError(null)
      return json
    } catch (e) {
      setError(e.message)
      return null
    }
  }, [])

  /* ── SSE + polling ── */
  useEffect(() => {
    if (phase !== 'live' && phase !== 'setup') return
    if (!live) return
    let cancelled = false
    fetchData()

    ;(async () => {
      const url = serverUrl.current
      const key = apiKeyRef.current
      let streamUrl = `${url}/api/v1/stream`
      if (key) {
        try {
          const { token } = await apiFetch(url, key, '/api/v1/stream-token', {})
          const u = new URL(streamUrl)
          u.searchParams.set('st', token)
          streamUrl = u.toString()
        } catch {}
      }
      if (cancelled) return
      try {
        const es = new EventSource(streamUrl)
        esRef.current = es
        es.addEventListener('open', () => setStreaming(true))
        es.addEventListener('reading', e => {
          try {
            setData(JSON.parse(e.data))
            setLastUpdate(new Date())
            setError(null)
            setStreaming(true)
          } catch {}
        })
        es.onerror = () => { es.close(); esRef.current = null; setStreaming(false) }
      } catch {}
    })()

    const poll = setInterval(() => {
      const es = esRef.current
      if (!es || es.readyState !== 1) fetchData()
    }, phase === 'setup' ? 4000 : 15000)

    return () => {
      cancelled = true
      clearInterval(poll)
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      setStreaming(false)
    }
  }, [phase, live, nonce, fetchData])

  useEffect(() => {
    const h = () => {
      if (document.hidden || !live) return
      const es = esRef.current
      if (!es || es.readyState !== 1) setNonce(n => n + 1)
    }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [live])

  const disconnect = useCallback(() => {
    try { localStorage.removeItem(SK_KEY); localStorage.removeItem(SK_URL) } catch {}
    onClose()
  }, [onClose])

  const cloud = useMemo(() => {
    const url = () => serverUrl.current
    const key = () => apiKeyRef.current
    const decide = (installId, action) =>
      apiFetch(url(), key(), '/api/v1/machines/decide', { installId, action })
    return {
      ingestUrl: serverUrl.current,
      needsApproval: true,
      apiKeyRef,
      setKey: k => { apiKeyRef.current = k; save(SK_KEY, k) },
      mint: async () => {
        const m = await apiFetch(url(), key(), '/api/v1/enroll/new', {})
        const link = `${url()}#${m.token}`
        return {
          token: m.token, code: m.code, expiresAt: m.expiresAt, link,
          command: `tokenhud-agent enroll "${link}"`,
          label: 'this machine',
        }
      },
      approve: id => decide(id, 'approve'),
      deny: id => decide(id, 'deny'),
      revoke: id => decide(id, 'revoke'),
      remove: id => decide(id, 'revoke'),

      /* Public links to the leaderboard. Minting, editing and revoking need
         the board key; `read` deliberately does not send it — it is the
         request a stranger's browser makes, which is what makes the Share
         dialog's preview the real thing rather than a rehearsal of it. */
      share: {
        list: () => apiFetch(url(), key(), '/api/v1/share'),
        create: body => apiFetch(url(), key(), '/api/v1/share', body),
        update: body => apiFetch(url(), key(), '/api/v1/share', body),
        revoke: slug => apiFetch(url(), key(), '/api/v1/share/revoke', { slug }),
        read: async (slug, apiUrl) => {
          const res = await fetch(
            `${apiUrl || url()}/api/v1/public/board?s=${encodeURIComponent(slug)}`,
            { signal: AbortSignal.timeout(12000) },
          )
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        },
      },
    }
  }, [])

  /* Is anything public right now? Asked once, here, so the rail's dot, the
     Leaderboard's button and the Settings list cannot disagree about it. */
  useEffect(() => {
    if (phase !== 'live' && phase !== 'setup') return
    let cancelled = false
    cloud.share.list()
      .then(r => { if (!cancelled) setSharedLive(!!r.shares?.some(x => !x.revokedAt)) })
      .catch(() => { if (!cancelled) setSharedLive(false) })
    return () => { cancelled = true }
  }, [phase, shareSeq, cloud])

  const toggleCollapse = useCallback(() => {
    setCollapsed(c => { save(SK_SUBNAV, c ? '' : '1'); return !c })
  }, [])
  const toggleRoot = useCallback(() => {
    setRootMini(c => { save(SK_ROOTNAV, c ? '' : '1'); return !c })
  }, [])
  const goto = useCallback(key => { setSection(key); save(SK_SECTION, key) }, [])
  const gotoLb = useCallback(key => { setLbPage(key); save(SK_LBPAGE, key) }, [])

  /* The board wants `id` on a machine row; the server calls it `installId`.
     Memoised, and above the early returns so the hook count never changes.
     Memoised specifically because the board reports its computed state back
     up here as state — a fresh `shaped` on every render would hand it a new
     `data` every time, and the two of us would re-render each other until
     React gave up. */
  const shaped = useMemo(
    () => (data && Array.isArray(data.machines)
      ? { ...data, machines: data.machines.map(m => ({ ...m, id: m.installId })) }
      : data),
    [data],
  )

  /* The whole fleet in the shape share.rs serves, computed here rather than
     inside the board: the Leaderboard is its own section and must not need the
     board mounted to have something to show. Same object as a shared link
     carries, so the pages below render both. */
  const fleet = useMemo(() => fleetOf(shaped), [shaped])
  const profiles = fleet.entries

  /* "You" on the leaderboard is the machine Token Monitoring is pointed at.
     `boardState` survives the board unmounting, so switching sections does not
     move the marker; before the board has ever mounted, fall back to the same
     machine it would default to. */
  const meId = boardState?.cur?.host || shaped?.latest?.[0]?.host || null

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

  /* ── routing: probing and offline don't get the admin shell ── */
  if (phase === 'probing') return <Probing />
  if (phase === 'offline') {
    return <Offline serverUrl={serverUrl.current} onClose={onClose}
      onRetry={() => setProbeSeq(n => n + 1)} />
  }

  /* Token Monitoring and the Leaderboard each have a second rail; Settings is
     one page and does not. The grid is told which, rather than being handed an
     empty sidebar to render. */
  const hasSubNav = section === 'monitoring' || section === 'leaderboard'
  const serverLabel = serverUrl.current.replace(/^https?:\/\//, '')

  return (
    <div className="dashboard-frame adm">
      <AdminTopbar
        onCollapse={toggleRoot}
        serverUrl={serverUrl.current} serverOk
        onClose={onClose}
        theme={theme} onTheme={toggleTheme}
        streaming={streaming} lastUpdate={lastUpdate}
        live={live} onToggleLive={() => setLive(l => !l)}
        error={error}
        crumb={SECTIONS.find(x => x.key === section)?.label}
      />
      <div className={'adm-shell'
        + (rootMini ? ' adm-shell--rootmini' : '')
        + (collapsed ? ' adm-shell--submini' : '')
        + (hasSubNav ? '' : ' adm-shell--nosub')}>

        <RootRail
          section={section} onSection={goto}
          collapsed={rootMini} onCollapse={toggleRoot}
          serverLabel={serverLabel}
          shared={sharedLive}
          badges={{
            monitoring: (data?.hosts || []).length || null,
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
            phase={phase}
            board={boardState}
            hosts={data?.hosts || []}
            serverUrl={serverUrl.current}
            onPhase={setPhase}
            latestRelease={latestRelease}
            onRename={(machineId, label) => {
              apiFetch(serverUrl.current, apiKeyRef.current,
                '/api/v1/machines/rename', { machineId, label })
                .then(() => fetchData())
                .catch(() => {})
            }}
            onRemove={(id) => {
              /* The self-host remove API uses the hostname (the `host`
                 column in SQLite). The sidebar now passes the machine id;
                 find the matching host entry to get the hostname. */
              const entry = (data?.hosts || []).find(h => h.machine_id === id)
              const host = entry?.host || id
              apiFetch(serverUrl.current, apiKeyRef.current,
                '/api/v1/machines/remove', { host })
                .then(() => fetchData())
                .catch(() => {})
            }}
          />
        )}

        <main className="adm-content">
          {section === 'monitoring' && phase === 'setup' && (
            <SetupContent
              serverUrl={serverUrl.current}
              data={data}
              apiKeyRef={apiKeyRef}
              onLive={() => setPhase('live')}
            />
          )}
          {section === 'monitoring' && phase === 'live' && (
            <BoardView
              data={shaped}
              loading={data == null}
              error={error}
              streaming={streaming}
              lastUpdate={lastUpdate}
              live={live}
              onToggleLive={() => setLive(l => !l)}
              onRetry={() => setNonce(n => n + 1)}
              connLabel={serverLabel}
              onClose={onClose}
              onSignOut={disconnect}
              cloud={cloud}
              theme={theme}
              onToggleTheme={toggleTheme}
              embedded
              onBoardState={setBoardState}
            />
          )}
          {section === 'leaderboard' && (
            <LeaderboardPage
              board={fleet}
              page={lbPage}
              meId={meId}
              share={cloud.share}
              shared={sharedLive}
              onShare={() => setShareOpen(true)}
              onGoToMachines={() => goto('monitoring')}
            />
          )}
          {section === 'settings' && (
            <Settings
              serverUrl={serverUrl.current}
              hasKey={!!apiKeyRef.current}
              onDisconnect={disconnect}
              theme={theme} onTheme={toggleTheme}
              live={live} onToggleLive={() => setLive(l => !l)}
              streaming={streaming} lastUpdate={lastUpdate}
              rootCollapsed={rootMini} onRootCollapsed={v => { setRootMini(v); save(SK_ROOTNAV, v ? '1' : '') }}
              subCollapsed={collapsed} onSubCollapsed={v => { setCollapsed(v); save(SK_SUBNAV, v ? '1' : '') }}
              data={data}
              hosts={data?.hosts || []}
              latestRelease={latestRelease}
              share={cloud.share}
              shareSeq={shareSeq}
              onManageShare={() => setShareOpen(true)}
            />
          )}
        </main>
      </div>

      {shareOpen && cloud.share && (
        <ShareModal share={cloud.share} onClose={() => { setShareOpen(false); setShareSeq(n => n + 1) }} />
      )}
    </div>
  )
}

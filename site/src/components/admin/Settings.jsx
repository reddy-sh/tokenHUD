import { useCallback, useEffect, useState } from 'react'
import { Card, Empty, Pill } from '../board/panels'
import { shareLink } from '../board/share'
import { ago, compact, full } from '../board/util'

/* Settings — the workspace half of the root navigation.
 *
 * A self-hosted board has no user account, so "user settings" here means the
 * things this browser and this server actually hold: which server it is
 * talking to, whether the admin key is stored, how the board looks, whether it
 * is following the agents, and which links to it are public. Everything on
 * this page is read from live state or writes to it — nothing is a stub for a
 * preference that does not exist yet. */

function Row({ label, children, note }) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span>{label}</span>
        {note && <span className="bv-sub">{note}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  )
}

function Switch({ on, onChange, labelOn = 'On', labelOff = 'Off' }) {
  return (
    <button type="button" className={'set-switch' + (on ? ' on' : '')}
      role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="knob" />
      <span className="txt">{on ? labelOn : labelOff}</span>
    </button>
  )
}

function bytes(n) {
  const v = Number(n) || 0
  if (v >= 1e9) return (v / 1e9).toFixed(1) + ' GB'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB'
  if (v >= 1e3) return (v / 1e3).toFixed(0) + ' kB'
  return v + ' B'
}

export default function Settings({
  serverUrl, hasKey, onDisconnect,
  theme, onTheme,
  live, onToggleLive, streaming, lastUpdate,
  rootCollapsed, onRootCollapsed, subCollapsed, onSubCollapsed,
  data, hosts, latestRelease,
  share, shareSeq, onManageShare,
}) {
  const [shares, setShares] = useState(null)
  const [apiUrl, setApiUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!share) return
    share.list()
      .then(r => { setShares(r.shares || []); setApiUrl(r.apiUrl || '') })
      .catch(() => setShares([]))
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- shareSeq is the
       signal that the dialog changed something, not a value this reads. */
  }, [share, shareSeq])

  useEffect(refresh, [refresh])

  const store = data?.store || {}
  const streams = data?.streams || {}
  const live_shares = (shares || []).filter(s => !s.revokedAt)
  const versions = [...new Set((hosts || []).map(h => h.agent_version).filter(Boolean))]
  const outdated = latestRelease ? versions.filter(v => v !== latestRelease) : []

  return (
    <div className="adm-page adm-page--wide">
      <header className="adm-head">
        <div>
          <h1>Settings</h1>
          <p>What this browser is connected to, how the board behaves, and what of it is public.</p>
        </div>
      </header>

      <Card title="Connection" note="This board is a browser talking to a server you run. Nothing is stored anywhere else.">
        <Row label="Server" note="Where the agents report and this board reads">
          <code className="set-mono">{serverUrl}</code>
        </Row>
        <Row label="Admin key" note="Held in this browser's local storage; needed to mint enrollments and share links">
          {hasKey
            ? <Pill tone="ok">stored</Pill>
            : <Pill tone="warn">not set</Pill>}
        </Row>
        <Row label="Disconnect" note="Forgets the server address and the key on this browser. The server keeps running.">
          <button className="btn btn--ghost sh-danger" onClick={onDisconnect}>Disconnect</button>
        </Row>
      </Card>

      <Card title="Appearance">
        <Row label="Theme">
          <div className="lb-seg" role="group" aria-label="Theme">
            {[['dark', 'Dark'], ['light', 'Light']].map(([k, l]) => (
              <button key={k} type="button"
                className={'lb-seg-b' + (theme === k ? ' on' : '')}
                aria-pressed={theme === k}
                onClick={() => { if (theme !== k) onTheme() }}>{l}</button>
            ))}
          </div>
        </Row>
        <Row label="Section navigation" note="The outer rail: Token Monitoring, Leaderboard, Settings">
          <Switch on={!rootCollapsed} onChange={v => onRootCollapsed(!v)} labelOn="Expanded" labelOff="Icons only" />
        </Row>
        <Row label="Machine navigation" note="The inner rail inside Token Monitoring">
          <Switch on={!subCollapsed} onChange={v => onSubCollapsed(!v)} labelOn="Expanded" labelOff="Icons only" />
        </Row>
      </Card>

      <Card
        title="Live updates"
        note="The board is pushed to, not polled: the server sends an event the moment a reading lands, and a slow poll backstops a dropped connection."
      >
        <Row label="Follow the agents" note={streaming ? 'Streaming now' : live ? 'Polling — the event stream is not connected' : 'Frozen'}>
          <Switch on={live} onChange={onToggleLive} labelOn="Live" labelOff="Paused" />
        </Row>
        <Row label="Last reading">
          <span className="tnum">{lastUpdate ? ago(lastUpdate.toISOString()) : '—'}</span>
        </Row>
        <Row label="Open streams" note="Readers the server is currently pushing to">
          <span className="tnum">{full(streams.open ?? 0)} / {full(streams.max ?? 0)}</span>
        </Row>
      </Card>

      <Card
        title="Public links"
        note="A shared leaderboard: token counts, model names and daily activity. Never projects, prompts, paths, tools or plan limits."
        right={share && <button className="btn btn--ghost set-btn" onClick={onManageShare}>Manage sharing</button>}
      >
        {!share && <Empty>Sharing needs the self-hosted server — this board is reading a cloud account.</Empty>}
        {share && shares == null && <Empty>Loading…</Empty>}
        {share && shares != null && !live_shares.length && (
          <Empty>
            Nothing is public. <b>Manage sharing</b> mints a link, and shows you exactly what it
            would carry before you copy it.
          </Empty>
        )}
        {live_shares.map(s => (
          <div className="set-share" key={s.slug}>
            <div>
              <div className="set-share-title">{s.title}</div>
              <div className="bv-sub">
                {s.identities === 'host' ? 'real machine names' : 'pseudonyms'} ·
                {' '}{s.views} view{s.views === 1 ? '' : 's'}
                {s.lastView ? `, last ${ago(s.lastView)}` : ''} · created {ago(s.createdAt)}
              </div>
              <code className="set-mono set-share-url">{shareLink(s.slug, apiUrl)}</code>
            </div>
            <button className="btn btn--ghost sh-danger set-btn" disabled={busy}
              onClick={async () => {
                setBusy(true)
                try { await share.revoke(s.slug) } catch { /* the listing below will show it did not */ }
                setBusy(false)
                refresh()
              }}>
              Make private
            </button>
          </div>
        ))}
        {shares != null && shares.some(s => s.revokedAt) && (
          <p className="bv-note">
            {shares.filter(s => s.revokedAt).length} link
            {shares.filter(s => s.revokedAt).length === 1 ? ' has' : 's have'} been revoked. A
            revoked link answers exactly as an invented one does, so it cannot be told apart
            from a slug that never existed.
          </p>
        )}
      </Card>

      <Card title="This server" note="What the store is holding, on disk, right now.">
        <div className="bv-stats bv-tiles">
          {[
            { k: 'Machines', v: String(store.hosts ?? (hosts || []).length), d: 'reporting' },
            { k: 'Snapshots', v: compact(store.snapshots || 0), d: `${compact(store.keyframes || 0)} keyframes` },
            { k: 'Endings', v: compact(store.endings || 0), d: 'noticed between readings' },
            { k: 'Database', v: bytes(store.bytes), d: 'one SQLite file' },
          ].map(t => (
            <div className="bv-stat" key={t.k}>
              <div className="bv-stat-label">{t.k}</div>
              <div className="bv-stat-value tnum">{t.v}</div>
              <div className="bv-stat-sub">{t.d}</div>
            </div>
          ))}
        </div>
        {store.db && (
          <p className="bv-note" style={{ marginTop: 'var(--space-md)' }}>
            <code className="set-mono">{store.db}</code>
          </p>
        )}
      </Card>

      <Card title="Agents">
        <Row label="Versions reporting">
          <span>{versions.length ? versions.join(', ') : '—'}</span>
        </Row>
        <Row label="Latest release" note={latestRelease ? undefined : 'GitHub was not reachable; the check is best-effort'}>
          <span>{latestRelease || 'unknown'}</span>
        </Row>
        {outdated.length > 0 && (
          <p className="bv-note">
            {outdated.length === 1 ? 'One version is' : `${outdated.length} versions are`} behind
            {' '}{latestRelease}. Token Monitoring offers the upgrade command in its machine list.
          </p>
        )}
      </Card>
    </div>
  )
}

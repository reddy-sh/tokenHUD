import { useCallback, useEffect, useState } from 'react'
import { Card, Empty, Pill } from '../board/panels'
import { shareLink } from '../board/share'
import { ago, compact, full } from '../board/util'
import GlobalOptIn from '../portal/GlobalOptIn'

/* Settings - the workspace half of the root navigation, for both boards.
 *
 * The two backends do not own the same things, so this page does not pretend
 * they do. A self-hosted board is a browser talking to a server you run: the
 * things it can settle are which server, whether the admin key is held here,
 * what the store is holding on disk, and which links to it are public. A cloud
 * board has an account instead of a server, and the only publishing decision
 * it has is whether your aggregate appears on the global leaderboard.
 *
 * So every card here is rendered from something that was passed in, and a card
 * whose subject does not exist on this backend is absent rather than empty.
 * That distinction is the whole design of the page: an absent card says "this
 * board has no such thing", where a card of dashes or zeroes would say "it has
 * one and it is empty", which for four of these would be a lie. Nothing on
 * this page is a stub for a preference that does not exist yet.
 *
 * `pushes` is the one prop that describes the backend rather than a value: the
 * self-host server sends an event the moment a reading lands, the cloud API is
 * polled on the agents' own cadence, and the copy for those is not the same
 * sentence with a word changed. */

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
  /* exactly one of these two: a server you run, or an account you signed into */
  connection, account,
  theme, onTheme,
  live, onToggleLive, streaming, lastUpdate, pushes, streams,
  rootCollapsed, onRootCollapsed, subCollapsed, onSubCollapsed,
  /* what of this board is public: share links (self-host), the global
     leaderboard opt-in (cloud) */
  share, shareSeq, onManageShare, publicBoard,
  store, hosts, latestRelease,
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

      {connection && (
        <Card title="Connection" note="This board is a browser talking to a server you run. Nothing is stored anywhere else.">
          <Row label="Server" note="Where the agents report and this board reads">
            <code className="set-mono">{connection.serverUrl}</code>
          </Row>
          <Row label="Admin key" note="Held in this browser's local storage; needed to mint enrollments and share links">
            {connection.hasKey
              ? <Pill tone="ok">stored</Pill>
              : <Pill tone="warn">not set</Pill>}
          </Row>
          <Row label="Disconnect" note="Forgets the server address and the key on this browser. The server keeps running.">
            <button className="btn btn--ghost sh-danger" onClick={connection.onDisconnect}>Disconnect</button>
          </Row>
        </Card>
      )}

      {account && (
        <Card title="Account" note="Your machines report to this account. The session lives in this browser; the machines' keys do not.">
          <Row label="Signed in as">
            <code className="set-mono">{account.email}</code>
          </Row>
          <Row label="Sign out" note="Ends the session in this browser. The agents keep reporting - revoke a machine to stop one.">
            <button className="btn btn--ghost" onClick={account.onSignOut}>Sign out</button>
          </Row>
        </Card>
      )}

      <Card title="Appearance">
        {onTheme && (
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
        )}
        <Row label="Section navigation" note="The outer rail: Token Monitoring, Leaderboard, Settings">
          <Switch on={!rootCollapsed} onChange={v => onRootCollapsed(!v)} labelOn="Expanded" labelOff="Icons only" />
        </Row>
        <Row label="Machine navigation" note="The inner rail inside Token Monitoring">
          <Switch on={!subCollapsed} onChange={v => onSubCollapsed(!v)} labelOn="Expanded" labelOff="Icons only" />
        </Row>
      </Card>

      <Card
        title="Live updates"
        note={pushes
          ? 'The board is pushed to, not polled: the server sends an event the moment a reading lands, and a slow poll backstops a dropped connection.'
          : 'The agents report every thirty seconds and this board reads on the same cadence. A connection held open per tab would redraw the same numbers at a standing cost.'}
      >
        <Row label="Follow the agents"
          note={!live ? 'Frozen'
            : pushes ? (streaming ? 'Streaming now' : 'Polling - the event stream is not connected')
              : 'Reading on the agents’ own cadence'}>
          <Switch on={live} onChange={onToggleLive} labelOn="Live" labelOff="Paused" />
        </Row>
        <Row label="Last reading">
          <span className="tnum">{lastUpdate ? ago(lastUpdate.toISOString()) : '-'}</span>
        </Row>
        {streams && (
          <Row label="Open streams" note="Readers the server is currently pushing to">
            <span className="tnum">{full(streams.open ?? 0)} / {full(streams.max ?? 0)}</span>
          </Row>
        )}
      </Card>

      {share && (
        <Card
          title="Public links"
          note="A shared leaderboard: token counts, model names and daily activity. Never projects, prompts, paths, tools or plan limits."
          right={<button className="btn btn--ghost set-btn" onClick={onManageShare}>Manage sharing</button>}
        >
          {shares == null && <Empty>Loading…</Empty>}
          {shares != null && !live_shares.length && (
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
      )}

      {/* The one publishing decision a cloud board has. It lived on the board
          under the private leaderboard, inside a block the embedded board never
          renders - and every caller embeds it - so no cloud user could reach
          it and the global page could never gain an entry. It belongs here
          anyway: it is a preference about this account, not a panel about a
          machine. */}
      {publicBoard && <GlobalOptIn publicBoard={publicBoard} />}

      {store && (
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
      )}

      <Card title="Agents">
        <Row label="Versions reporting">
          <span>{versions.length ? versions.join(', ') : '-'}</span>
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

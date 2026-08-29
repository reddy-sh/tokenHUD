import { useEffect, useState } from 'react'
import { Ic } from '../board/icons'

export function agoText(date) {
  if (!date) return ''
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export default function AdminTopbar({
  onCollapse, serverUrl, serverOk, onClose, onSignOut,
  theme, onTheme, streaming, lastUpdate, live, onToggleLive, error, crumb,
  connLabel,
}) {
  /* Re-render every second so the "ago" text stays current. */
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="adm-bar">
      <div className="adm-bar-left">
        <button className="adm-toggle" onClick={onCollapse} aria-label="Toggle navigation">
          <Ic name="menu" />
        </button>
        <span className="nav__brand">
          <span className="nav__brand-dot" />
          <span>Token<b>HUD</b></span>
        </span>
        {crumb && <span className="adm-crumb">{crumb}</span>}
        {lastUpdate && (
          <span className="adm-updated tnum" title={`Last refreshed ${lastUpdate.toLocaleString()}`}>
            {agoText(lastUpdate)}
            {streaming ? ' · live' : live ? '' : ' · paused'}
          </span>
        )}
        {error && <span className="bv-stale">stale</span>}
      </div>
      <div className="adm-bar-right">
        {onToggleLive && (
          <button className={'bv-live' + (live ? ' on' : '')} aria-pressed={live}
            title={live ? 'Following the agents.' : 'Frozen. Nothing is being fetched.'}
            onClick={onToggleLive}>
            <span className="dot" /><span>{live ? 'Live' : 'Paused'}</span>
          </button>
        )}
        {serverOk && serverUrl && (
          <span className="adm-server">
            <span className="sh-dot sh-dot--ok" />
            {serverUrl.replace(/^https?:\/\//, '')}
          </span>
        )}
        {connLabel && (
          <span className="bv-server-url">{connLabel}</span>
        )}
        {onTheme && (
          <button className="adm-theme" onClick={onTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle theme">
            {theme === 'dark' ? '\u2600' : '\u263E'}
          </button>
        )}
        {onSignOut && (
          <button className="btn btn--ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onSignOut}>
            Sign out
          </button>
        )}
        <button className="bv-modal-close" style={{ position: 'static', lineHeight: 1 }}
          onClick={onClose} aria-label="Close">&times;</button>
      </div>
    </div>
  )
}

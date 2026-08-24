import { useState, useCallback, useEffect, useRef } from 'react'

export default function Dashboard({ onClose }) {
  const [apiKey, setApiKey] = useState('')
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8787')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleConnect = useCallback(async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const url = serverUrl.replace(/\/+$/, '')
      const headers = {}
      if (apiKey.trim()) headers['X-TokenHUD-Key'] = apiKey.trim()

      const res = await fetch(`${url}/healthz`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        setConnected(true)
      } else {
        setError(`Server responded with ${res.status}. Check the URL and API key.`)
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        setError('Connection timed out. Is the TokenHUD server running?')
      } else {
        setError('Could not reach the server. Make sure TokenHUD is running on your machine.')
      }
    } finally {
      setLoading(false)
    }
  }, [apiKey, serverUrl])

  if (connected) {
    return (
      <div className="dashboard-frame">
        <div className="dashboard-frame__bar">
          <span>Token<b>HUD</b> Dashboard</span>
          <button className="dashboard-close" onClick={onClose} aria-label="Close dashboard">×</button>
        </div>
        <iframe
          src={serverUrl}
          title="TokenHUD Dashboard"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    )
  }

  return (
    <div className="dashboard-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <button className="dashboard-close" onClick={onClose} aria-label="Close">×</button>
      <div className="dashboard-card">
        <h2>Connect to your board</h2>
        <p>
          Enter your TokenHUD server URL and API key to open your live dashboard.
          The key is in your <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', background: 'var(--color-paper-3)', padding: '2px 6px', borderRadius: 'var(--radius-xs)' }}>.env</code> file.
        </p>

        <form onSubmit={handleConnect}>
          <input
            ref={inputRef}
            type="url"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="http://127.0.0.1:8787"
            aria-label="Server URL"
          />
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="API key (from .env)"
            aria-label="API key"
          />

          {error && (
            <p style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)', margin: '0 0 var(--space-md)', textAlign: 'left' }}>
              {error}
            </p>
          )}

          <button className="btn btn--primary" type="submit" disabled={loading}>
            {loading ? 'Connecting...' : 'Connect'}
            {!loading && <span aria-hidden="true">→</span>}
          </button>
        </form>

        <p style={{ marginTop: 'var(--space-lg)', fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)' }}>
          Not running yet?{' '}
          <a href="https://github.com/reddy-sh/tokenhud#get-started" style={{ color: 'var(--color-accent)' }}>
            Get started in 30 seconds →
          </a>
        </p>
      </div>
    </div>
  )
}

import { useCallback, useState } from 'react'
import { Card } from '../board/panels'

/* The global leaderboard opt-in, shown below the private leaderboard.
 *
 * Joining is a two-step act: pick a handle, then flip the switch. Neither is
 * a default. Leaving deletes the roster row on the server — "my numbers are
 * not on that page" is true of the database, not just of the query.
 *
 * `publicBoard` carries the profile state (`handle`, `publicLeaderboard`,
 * `publicId`) and a `save(patch)` that posts to `/api/v1/profile`. */

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,23}$/

export default function GlobalOptIn({ publicBoard }) {
  const { handle, publicLeaderboard, save } = publicBoard
  const [draft, setDraft] = useState(handle || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = useCallback(async (patch) => {
    setBusy(true)
    setError(null)
    try {
      const next = await save(patch)
      if (next.handle) setDraft(next.handle)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [save])

  const canSaveHandle = draft.trim().toLowerCase() !== (handle || '') && HANDLE_RE.test(draft.trim().toLowerCase())

  return (
    <Card
      title="Global leaderboard"
      note="Opt in to appear on the public leaderboard at tokenhud.com. Token counts, model names and daily activity — never projects, prompts or paths."
    >
      {error && <div className="bv-warnbar">{error}</div>}

      <div className="set-row">
        <div className="set-row-label">
          <span>Handle</span>
          <span className="bv-sub">2-24 characters, a-z 0-9 and hyphens</span>
        </div>
        <div className="set-row-control" style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="your-handle"
            maxLength={24}
            style={{ width: '16ch', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
          />
          <button
            className="btn btn--ghost"
            disabled={busy || !canSaveHandle}
            onClick={() => submit({ handle: draft.trim().toLowerCase() })}
          >
            Save
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-row-label">
          <span>Show on public board</span>
          <span className="bv-sub">
            {publicLeaderboard
              ? 'Your aggregate appears on the global leaderboard'
              : 'Off — your numbers stay private'}
          </span>
        </div>
        <div className="set-row-control">
          <button
            type="button"
            className={'set-switch' + (publicLeaderboard ? ' on' : '')}
            role="switch"
            aria-checked={!!publicLeaderboard}
            disabled={busy || (!publicLeaderboard && !handle)}
            onClick={() => submit({ publicLeaderboard: !publicLeaderboard })}
          >
            <span className="knob" />
            <span className="txt">{publicLeaderboard ? 'Public' : 'Private'}</span>
          </button>
        </div>
      </div>

      {!handle && !publicLeaderboard && (
        <p className="bv-note">
          Choose a handle first — the public board shows it instead of your email.
        </p>
      )}

      {publicLeaderboard && (
        <p className="bv-note">
          Your aggregate is live on the <a href="#/leaderboard">global leaderboard</a>.
          Opting out removes it immediately.
        </p>
      )}
    </Card>
  )
}

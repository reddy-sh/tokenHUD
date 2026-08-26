import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rankBoard } from '../../lib/leaderboard'
import { ago, compact, usd } from './util'

/* Sharing a board.
 *
 * The dialog has one job beyond minting a link, and it is the important one:
 * showing what the link actually says. A privacy control nobody can check is
 * a promise, and this one is checkable — the preview under the switch is the
 * real public payload, fetched from the real public endpoint with no
 * credential, ranked by the code the public page runs. If a project name were
 * ever going to leak, it would be visible right there before the link is
 * copied.
 *
 * `share` is the adapter the host portal passes down (see SelfHost.jsx):
 *
 *   list()                    → { shares, apiUrl, reachable }
 *   create({title, identities})
 *   update({slug, title, identities})
 *   revoke(slug)
 *   read(slug, apiUrl)        → the public payload, fetched anonymously
 */

/* The URL a person actually sends someone: this page, with the slug in the
   hash and the API it should read from beside it. The site is static and the
   API is wherever the server runs, so the link has to carry both — there is
   no third place that knows. */
export function shareLink(slug, apiUrl) {
  const here = location.origin + location.pathname
  const api = apiUrl ? `?api=${encodeURIComponent(apiUrl)}` : ''
  return `${here}#/b/${slug}${api}`
}

function Copy({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="btn btn--primary sh-copy-btn"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {})
        setDone(true)
        setTimeout(() => setDone(false), 2000)
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

/* ── what a shared board says, and what it does not ─────────────────── */

const CARRIES = [
  'Token counts — input, output, cache reads and writes',
  'Model names, and the tokens and estimated value against each',
  'Sessions, requests, tool calls, messages, active days',
  'One row per date: tokens, estimated value, counts',
  'Operating system and core count',
]

const WITHHOLDS = [
  'Project names, paths, git branches and worktrees',
  'Prompt text and session titles',
  'Running processes and their command lines',
  'Tool names, MCP servers, skills, plugins, permissions',
  'Plan limits, usage percentages, the account identifier',
]

function Disclosure({ identities }) {
  return (
    <div className="sh-disc">
      <div className="sh-disc-col sh-disc-col--yes">
        <h4>Goes out</h4>
        <ul>
          {CARRIES.map(x => <li key={x}>{x}</li>)}
          <li>
            {identities === 'host'
              ? <b>Machine names, as you named them</b>
              : 'A pseudonym per machine — never the machine name'}
          </li>
        </ul>
      </div>
      <div className="sh-disc-col sh-disc-col--no">
        <h4>Never goes out</h4>
        <ul>
          {WITHHOLDS.map(x => <li key={x}>{x}</li>)}
          {identities !== 'host' && <li>Machine names and hostnames</li>}
        </ul>
      </div>
    </div>
  )
}

/* ── the preview ────────────────────────────────────────────────────── */

function Preview({ board, error, loading }) {
  const ranked = useMemo(
    () => (board ? rankBoard(board.entries, { metric: 'tokens', period: 'all' }) : null),
    [board],
  )
  if (loading) return <p className="bv-note">Fetching the link the way a stranger would…</p>
  if (error) return <div className="sh-error">Could not read the shared board back: {error}</div>
  if (!ranked) return null
  return (
    <div className="sh-preview">
      <div className="sh-preview-head">
        <span>What a visitor sees</span>
        <span className="bv-sub">fetched from the public link, with no key</span>
      </div>
      <ul className="sh-preview-rows">
        {ranked.rows.slice(0, 5).map(r => (
          <li key={r.id}>
            <span className="lb-rank">{r.rank ?? '—'}</span>
            <span className="lb-name">{r.name}</span>
            <span className="bv-sub">{r.tier.tier.name}</span>
            <span className="tnum">{compact(r.value)} tokens</span>
            <span className="tnum bv-sub">{usd(r.entry.totals?.estUSD || 0)}</span>
          </li>
        ))}
      </ul>
      {ranked.rows.length > 5 && (
        <p className="bv-sub">…and {ranked.rows.length - 5} more.</p>
      )}
    </div>
  )
}

/* ── the dialog ─────────────────────────────────────────────────────── */

export function ShareModal({ share, onClose }) {
  const [state, setState] = useState({ loading: true })
  const [title, setTitle] = useState('')
  const [identities, setIdentities] = useState('alias')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState({ loading: false })
  const started = useRef(false)

  const live = state.shares?.find(s => !s.revokedAt) || null
  const apiUrl = state.apiUrl || ''

  const refresh = useCallback(async () => {
    try {
      const r = await share.list()
      setState({ ...r, loading: false })
      const first = r.shares?.find(s => !s.revokedAt)
      if (first) {
        setTitle(first.title || '')
        setIdentities(first.identities || 'alias')
      }
      return r
    } catch (e) {
      setState({ loading: false })
      setError(e?.message || String(e))
      return null
    }
  }, [share])

  useEffect(() => {
    if (started.current) return
    started.current = true
    refresh()
  }, [refresh])

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* Read the link back the way a stranger would — no key, same endpoint. */
  useEffect(() => {
    if (!live || !apiUrl) { setPreview({ loading: false }); return }
    let cancelled = false
    setPreview({ loading: true })
    share.read(live.slug, apiUrl)
      .then(board => { if (!cancelled) setPreview({ loading: false, board }) })
      .catch(e => { if (!cancelled) setPreview({ loading: false, error: e?.message || String(e) }) })
    return () => { cancelled = true }
  }, [live, apiUrl, share])

  const act = async fn => {
    setBusy(true); setError(null)
    try { await fn(); await refresh() }
    catch (e) { setError(e?.message || String(e)) }
    finally { setBusy(false) }
  }

  const url = live ? shareLink(live.slug, apiUrl) : ''
  const loopbackOnly = state.reachable === false

  return (
    <div className="bv-modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bv-modal share-modal" role="dialog" aria-label="Share this board">
        <button className="bv-modal-close" onClick={onClose} aria-label="Close">×</button>

        <h2>{live ? 'This board is public' : 'Share this board'}</h2>
        <p className="enroll-sub">
          A public link to the leaderboard: how much your machines ran, which models did it,
          and how that changed day to day. Anyone with the link can read it — nobody can find
          it without one.
        </p>

        {error && <div className="sh-error">{error}</div>}

        {state.loading && <p className="bv-note">Loading…</p>}

        {!state.loading && (
          <>
            <label className="sh-field">
              <span>Board title</span>
              <input
                className="sh-input" value={title} maxLength={80}
                placeholder="TokenHUD leaderboard"
                onChange={e => setTitle(e.target.value)}
              />
            </label>

            <fieldset className="sh-field sh-ident">
              <legend>Machine names</legend>
              {[
                { k: 'alias', t: 'Pseudonyms', d: 'Each machine gets a name like “amber-otter”, derived from the link. A different link gives different names, so two shared boards cannot be lined up against each other.' },
                { k: 'host', t: 'Real names', d: 'Machines appear as you named them. Right for a team board where everybody already knows whose laptop is whose.' },
              ].map(o => (
                <label key={o.k} className={'sh-radio' + (identities === o.k ? ' on' : '')}>
                  <input type="radio" name="identities" value={o.k}
                    checked={identities === o.k}
                    onChange={() => setIdentities(o.k)} />
                  <span>
                    <b>{o.t}</b>
                    <span className="bv-sub">{o.d}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <Disclosure identities={identities} />

            {!live && (
              <div className="sh-actions">
                <button className="btn btn--primary" disabled={busy}
                  onClick={() => act(() => share.create({ title, identities }))}>
                  {busy ? 'Creating…' : 'Create public link'}
                </button>
              </div>
            )}

            {live && (
              <>
                <div className="sh-linkrow">
                  <input className="sh-input sh-link" readOnly value={url}
                    onFocus={e => e.target.select()} aria-label="Public link" />
                  <Copy text={url} />
                  <a className="btn btn--ghost" href={url} target="_blank" rel="noreferrer">Open</a>
                </div>

                <p className="bv-note sh-linknote">
                  {live.views > 0
                    ? <>Opened {live.views} time{live.views === 1 ? '' : 's'}{live.lastView ? `, last ${ago(live.lastView)}` : ''}.</>
                    : <>Nobody has opened it yet.</>}
                  {' '}Created {ago(live.createdAt)}.
                </p>

                {loopbackOnly && (
                  <div className="bv-warnbar">
                    This server is bound to 127.0.0.1, so the link works on this machine and
                    nowhere else. To share it for real, put the server on an address others
                    can reach and set <code>TOKENHUD_PUBLIC_URL</code> to it.
                  </div>
                )}

                <div className="sh-actions">
                  <button className="btn btn--ghost" disabled={busy}
                    onClick={() => act(() => share.update({ slug: live.slug, title, identities }))}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                  <button className="btn btn--ghost sh-danger" disabled={busy}
                    onClick={() => act(() => share.revoke(live.slug))}>
                    Make private
                  </button>
                </div>

                <Preview {...preview} />
              </>
            )}

            {state.shares?.some(s => s.revokedAt) && (
              <details className="sh-past">
                <summary>Links you have revoked ({state.shares.filter(s => s.revokedAt).length})</summary>
                <ul>
                  {state.shares.filter(s => s.revokedAt).map(s => (
                    <li key={s.slug}>
                      <code>…{s.slug.slice(-6)}</code> · {s.title} · {s.views} view{s.views === 1 ? '' : 's'} ·
                      {' '}revoked {ago(s.revokedAt)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* The button that lives in the leaderboard's header. It says whether the board
   is public, because that is a thing somebody should be able to learn without
   opening a dialog.

   `live` is passed in rather than fetched here: the shell already asks, and two
   components asking the same question separately is how a rail's dot and a
   button's label end up disagreeing after a revoke. */
export function ShareButton({ live, onOpen }) {
  return (
    <button className={'lb-share' + (live ? ' lb-share--on' : '')} onClick={onOpen}>
      <span className="dot" />
      <span>{live ? 'Public link' : 'Share'}</span>
    </button>
  )
}

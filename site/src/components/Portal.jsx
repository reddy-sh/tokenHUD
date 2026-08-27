import { fetchUserAttributes, signOut } from 'aws-amplify/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, apiUrl } from '../lib/cloud'
import { newToken, pairingCode, sha256Hex } from '../lib/enrollment'
import { buildOverview } from '../lib/overview'
import AdminShell from './admin/AdminShell'
import Settings from './admin/Settings'
import { useNow } from './board/util'
import BoardView from './BoardView'
import AuthCard from './portal/AuthCard'

/* The portal: sign in, register machines, watch the board.
 *
 * Everything below the sign-in card is the shared admin shell - the same
 * component the self-host board mounts, handed a different adapter. This file
 * is now only the cloud half of that adapter: where the readings come from,
 * what the actions do, and who is signed in. It used to be the shell as well,
 * hand-copied, which is why the cloud board quietly lost four things the
 * self-host board had.
 *
 * Data comes from one polled endpoint. There is no live socket: the agents
 * report every thirty seconds, so a board that refreshed faster than that
 * would be redrawing the same numbers - and holding a subscription open per
 * tab is the one part of this backend that would have cost real money at rest.
 * Polling on the agents' own cadence shows everything a push would have, at
 * the price of one request.
 *
 * A backgrounded tab stops polling entirely and catches up when it is looked
 * at again, which is both cheaper and what somebody returning to the tab
 * actually wants: the current board, not a replay. */

/* Slightly under the agent's 30 s so a reading is never a full cycle old on
   screen, and far enough under that a missed poll is invisible. */
const POLL_MS = 20_000

/* The cloud board's own navigation keys. Prefixed apart from the self-host
   board's so somebody who runs both does not have one overwrite the other. */
const KEYS = {
  section: 'tokenhud_cloud_section',
  lbPage: 'tokenhud_cloud_lb_page',
  rootNav: 'tokenhud_cloud_nav_root',
  subNav: 'tokenhud_cloud_nav_sub',
}

export default function Portal({ onClose, user, onUser, onSelfHost }) {
  const [machines, setMachines] = useState(null)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [live, setLive] = useState(true)
  const [nonce, setNonce] = useState(0) /* bump to force a reload */
  const [lastUpdate, setLastUpdate] = useState(null)
  const [synced, setSynced] = useState(false)

  /* Every fetch this component has in flight, so a sign-out or a close does
     not land a response into an unmounted tree. */
  const inflight = useRef(null)

  const loadData = useCallback(async (signal) => {
    const board = await api('/api/v1/overview', { signal })
    setMachines(board.machines ?? [])
    setLastUpdate(new Date())
    setSynced(true)
    setError(null)
  }, [])

  /* The machine feed. */
  useEffect(() => {
    if (!user) return
    const ctrl = new AbortController()
    inflight.current = ctrl
    let timer = null

    const tick = async () => {
      /* A hidden tab costs a request and shows nobody anything. */
      if (document.hidden) return
      try {
        await loadData(ctrl.signal)
      } catch (e) {
        if (e?.name === 'AbortError') return
        setSynced(false)
        setError(e?.message || String(e))
      }
    }

    /* The first load runs even when the tab is hidden - the portal was just
       opened, so somebody is looking whatever the visibility API believes. */
    loadData(ctrl.signal).catch(e => {
      if (e?.name === 'AbortError') return
      setSynced(false)
      setError(e?.message || String(e))
    })
    if (live) timer = setInterval(tick, POLL_MS)

    /* Coming back to the tab should show the board now, not at the next tick. */
    const onVisible = () => { if (!document.hidden && live) tick() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      ctrl.abort()
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      setSynced(false)
    }
  }, [user, live, nonce, loadData])

  /* The account: the handle, and whether it is on the public board. Read once
     - it only changes when this page changes it. */
  useEffect(() => {
    if (!user) return
    let cancelled = false
    api('/api/v1/profile')
      .then(p => { if (!cancelled) setProfile(p) })
      .catch(() => { /* the board is the point; the opt-in card can wait */ })
    return () => { cancelled = true }
  }, [user, nonce])

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !user) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, user])

  const handleSignOut = useCallback(async () => {
    inflight.current?.abort()
    try { await signOut() } catch { /* the session is gone either way */ }
    onUser(null)
    setMachines(null)
    setProfile(null)
    onClose()
  }, [onClose, onUser])

  /* ── the cloud actions the board's machine panels call ── */
  const cloud = useMemo(() => ({
    /* enroll.jsx calls this `ingestUrl` for both backends: on the self-host
       board it is the address of your own server, here it is the API. */
    ingestUrl: apiUrl,
    /* Mint a one-shot enrollment. The token is generated here and hashed here;
       only the hash is sent. It exists in exactly two places - the command
       shown once, and the agent's memory while it enrolls - which is the same
       discipline the self-host store keeps. */
    mint: async (label) => {
      const token = newToken()
      const [enrollTokenHash, code] = await Promise.all([sha256Hex(token), pairingCode(token)])
      const enrollTokenExpiresAt = new Date(Date.now() + 900_000).toISOString()
      const { machine } = await api('/api/v1/machines', {
        method: 'POST',
        body: {
          label: (label || '').trim() || 'machine',
          pairingCode: code,
          enrollTokenHash,
          enrollTokenExpiresAt,
        },
      })
      /* Show it immediately rather than at the next poll: somebody who just
         pressed the button should see the card it made. */
      setMachines(prev => [machine, ...(prev ?? [])])
      /* Use the site origin (platform.tokenhud.com) rather than the raw
         Lambda URL. Amplify Hosting proxies /api/* to the function, so
         the agent reaches the same handler without the internal URL
         leaking into clipboard-pasted commands. */
      const publicBase = location.origin
      const link = `${publicBase}#${token}`
      return {
        token,
        code,
        expiresAt: enrollTokenExpiresAt,
        link,
        command: `tokenhud-agent enroll "${link}"`,
        label: machine.label,
      }
    },
    rename: async (id, label) => {
      await api('/api/v1/machines/rename', { method: 'POST', body: { id, label } })
      setMachines(prev => (prev ?? []).map(m => (m.id === id ? { ...m, label } : m)))
    },
    /* Revoking clears the key hash: the next heartbeat gets a 401 and the
       agent stops. Re-joining takes a fresh registration. */
    revoke: async (id) => {
      await api('/api/v1/machines/revoke', { method: 'POST', body: { id } })
      setMachines(prev => (prev ?? []).map(m => (
        m.id === id ? { ...m, status: 'revoked', snapshot: null } : m
      )))
    },
    remove: async (id) => {
      await api('/api/v1/machines/remove', { method: 'POST', body: { id } })
      setMachines(prev => (prev ?? []).filter(m => m.id !== id))
    },
  }), [])

  /* ── the public leaderboard, which nobody joins by accident ── */
  const publicBoard = useMemo(() => ({
    ...profile,
    save: async (patch) => {
      const next = await api('/api/v1/profile', { method: 'POST', body: patch })
      setProfile(p => ({ ...p, ...next }))
      return next
    },
  }), [profile])

  const now = useNow(1000)
  const data = useMemo(
    () => (machines == null ? null : buildOverview(machines, now)),
    [machines, now],
  )

  /* The rail hands a removal back with the identity it drew the row with, and
     on this board that is the machine's label: `buildOverview` folds a Machine
     row into `{host: m.label, …}` and emits no `host` field anywhere. This
     used to match on `x.host || x.id`, neither of which a cloud machine has,
     so the lookup failed every time and removing a machine did nothing at all
     - no error, no request, the row simply stayed. The self-host board removes
     by hostname because its rows have one; here the label is the name, and the
     id is what the API wants. */
  const removeMachine = useCallback((host) => {
    const m = (machines || []).find(x => x.label === host || x.id === host)
    if (m) cloud.remove(m.id).catch(() => {})
  }, [machines, cloud])

  /* App is still asking Cognito whether a session exists - don't flash the
     sign-in card at a returning visitor. */
  if (user === undefined) return null

  if (!user) {
    return <AuthCard onClose={onClose} onSelfHost={onSelfHost} onSignedIn={async () => {
      const attrs = await fetchUserAttributes().catch(() => ({}))
      onUser(attrs.email || 'signed in')
    }} />
  }

  return (
    <AdminShell adapter={{
      data,
      keys: KEYS,
      onClose,
      /* The account, not the server: this board has no server to name. The
         dot means the aggregate is on the public leaderboard, which is the
         only thing a cloud board publishes. */
      identity: {
        title: 'Cloud account',
        detail: user,
        live: !!profile?.publicLeaderboard,
      },
      topbar: {
        onSignOut: handleSignOut,
        streaming: synced,
        lastUpdate,
        live,
        onToggleLive: () => setLive(l => !l),
        error,
        connLabel: user,
      },
      /* No `phase`: there is no setup wizard here, a machine is enrolled from
         the board itself. No `onRename` either - the rail only offers renaming
         on rows that carry a `machine_id`, and a cloud host row does not. */
      sidebar: { onRemove: removeMachine },
      monitoring: ({ onBoardState }) => (
        <BoardView
          data={data}
          loading={machines == null}
          error={error}
          streaming={synced}
          lastUpdate={lastUpdate}
          live={live}
          onToggleLive={() => setLive(l => !l)}
          onRetry={() => setNonce(n => n + 1)}
          connLabel={user}
          onClose={onClose}
          onSignOut={handleSignOut}
          cloud={cloud}
          embedded
          onBoardState={onBoardState}
        />
      ),
      settings: ({ rootCollapsed, onRootCollapsed, subCollapsed, onSubCollapsed, hosts, latestRelease }) => (
        <Settings
          account={{ email: user, onSignOut: handleSignOut }}
          live={live} onToggleLive={() => setLive(l => !l)}
          lastUpdate={lastUpdate}
          rootCollapsed={rootCollapsed} onRootCollapsed={onRootCollapsed}
          subCollapsed={subCollapsed} onSubCollapsed={onSubCollapsed}
          publicBoard={publicBoard}
          hosts={hosts}
          latestRelease={latestRelease}
        />
      ),
    }} />
  )
}

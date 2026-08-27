/* The board components were written against the server's overview JSON -
 * {hosts, latest, endings, store, machines} with its particular mix of
 * snake_case rows and camelCase payloads. Rather than rewrite every panel,
 * the cloud path synthesizes the same shape from the Machine rows AppSync
 * hands us. Anything the board reads is produced here; nothing else is. */

/* a.json() values can arrive parsed or as the raw AWSJSON string. */
export function asJson(v) {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return null }
}

/* Same liveness thresholds as the server: a statement about the agent,
   not about whether the machine is switched on. */
function liveness(ageSeconds) {
  if (ageSeconds == null) return 'unknown'
  if (ageSeconds < 120) return 'up'
  if (ageSeconds < 900) return 'stale'
  return 'down'
}

export function buildOverview(machines, now = Date.now()) {
  const rows = machines ?? []
  const reporting = rows
    .filter(m => m.status === 'active' && m.lastSeenAt && m.snapshot)
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))

  const hosts = reporting.map(m => {
    const age = (now - Date.parse(m.lastSeenAt)) / 1000
    return {
      host: m.label,
      last_seen: m.lastSeenAt,
      agent_version: m.agentVersion,
      ageSeconds: Number.isFinite(age) ? age : null,
      status: liveness(Number.isFinite(age) ? age : null),
    }
  })

  const latest = reporting.map(m => asJson(m.snapshot)).filter(Boolean)

  const endings = rows
    .flatMap(m => asJson(m.endings) ?? [])
    .sort((a, b) => ((a.noticed_at ?? '') < (b.noticed_at ?? '') ? 1 : -1))
    .slice(0, 40)

  return {
    generatedAt: new Date(now).toISOString(),
    hosts,
    latest,
    endings,
    store: { snapshots: rows.reduce((n, m) => n + (m.heartbeatCount ?? 0), 0) },
    machines: rows
      .map(m => ({
        id: m.id,
        installId: m.installId,
        label: m.label,
        hostname: m.hostname,
        platform: m.platform,
        agentVersion: m.agentVersion,
        manifestDigest: m.manifestDigest,
        assistants: asJson(m.assistants),
        code: m.status === 'registered' || m.status === 'enrolling' ? m.pairingCode : null,
        status: m.status,
        created_at: m.createdAt,
        decided_at: m.enrolledAt,
        enrollTokenExpiresAt: m.enrollTokenExpiresAt,
      }))
      .sort((a, b) => ((a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1)),
  }
}

// The parts of the agent's wire protocol that are pure arithmetic over data:
// secrets, the pairing code, the endings diff, the staleness rule, the size
// trim, and the day rows a reading leaves behind. They live apart from the
// handler because they are the half that
// must agree byte-for-byte with two other implementations - the self-host
// server in Rust (server/src/board.rs, server/src/store.rs) and the browser
// (site/src/lib/enrollment.js) - and a shared contract deserves to be
// testable without standing up AWS. protocol.test.mjs pins them.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const sha256Hex = (s: string) =>
  createHash('sha256').update(s).digest('hex');

// 32 random bytes, base64url without padding - 43 chars over A-Za-z0-9-_,
// the shape of both enrollment tokens and per-machine keys.
export const newSecret = () => randomBytes(32).toString('base64url');

// Must match server/src/board.rs pairing_code: the terminal prints what the
// agent got back, the portal derives it from the raw token it briefly held.
// The alphabet drops 0/O/1/I/L/U - a code someone reads aloud must not have
// two spellings.
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function pairingCode(token: string): string {
  const digest = createHash('sha256').update(`tokenhud-pair:${token}`).digest();
  let code = '';
  for (let i = 0; i < 6; i++) code += PAIR_ALPHABET[digest[i] % PAIR_ALPHABET.length];
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// a.json() values can come back parsed or as the raw AWSJSON string
// depending on the read path - normalize before touching them.
export function asJson(v: unknown): any {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ps etime: [[dd-]hh:]mm:ss → seconds, best effort.
export function etimeSeconds(elapsed: unknown): number | null {
  if (typeof elapsed !== 'string') return null;
  const m = elapsed.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (
    (dd ? parseInt(dd, 10) * 86400 : 0) +
    (hh ? parseInt(hh, 10) * 3600 : 0) +
    parseInt(mm, 10) * 60 +
    parseInt(ss, 10)
  );
}

const procKey = (p: any) => `${p?.pid}|${p?.tool}|${p?.cmd}`;

export const ENDINGS_KEEP = 40;

// Anything running in the previous reading and gone from this one has ended.
// Same derivation as server/src/store.rs, kept on the machine row.
export function diffEndings(
  prevSnap: any,
  kept: any[],
  label: string,
  fallbackLastSeen: string | null,
  snap: any,
  noticedAt: string,
): any[] {
  const prev: any[] = Array.isArray(prevSnap?.metrics?.processes) ? prevSnap.metrics.processes : [];
  const cur: any[] = Array.isArray(snap?.metrics?.processes) ? snap.metrics.processes : [];
  const still = new Set(cur.map(procKey));
  const ended = prev
    .filter((p) => !still.has(procKey(p)))
    .map((p) => ({
      host: label,
      pid: p?.pid ?? null,
      kind: p?.kind ?? '',
      tool: p?.tool ?? 'claude-code',
      cmd: p?.cmd ?? '',
      ran_seconds: etimeSeconds(p?.elapsed),
      last_seen: prevSnap?.collectedAt ?? fallbackLastSeen ?? noticedAt,
      noticed_at: noticedAt,
    }));
  return [...ended, ...(Array.isArray(kept) ? kept : [])].slice(0, ENDINGS_KEEP);
}

// An older reading arriving is normal, not an error: the agent spools while
// the server is away and, on reconnect, posts the current reading first and
// only then replays the buffer oldest-first. Diffing one of those against the
// newer stored reading would report every agent that started during the gap as
// ended; storing it would rewind "what is running now". Either is worse than
// ignoring it. The self-host server draws the same line in SQL:
// `WHERE excluded.last_seen > hosts.last_seen`.
export function isStale(incoming: any, stored: any, storedLastSeen: string | null): boolean {
  const incomingAt = Date.parse(incoming?.collectedAt ?? '');
  const storedAt = Date.parse(stored?.collectedAt ?? storedLastSeen ?? '');
  return Number.isFinite(incomingAt) && Number.isFinite(storedAt) && incomingAt <= storedAt;
}

// The trim budget, applied to the reading as JSON.
//
// A reading is never stored as JSON any more - `packSnapshot` gzips it, and
// gzip takes a measured 94 KB reading down to about 25 KB base64 - so this is
// no longer the number that has to clear DynamoDB's 400 KB item limit;
// PACKED_BUDGET is. It stays because a pathological reading (the agent will
// post up to 8 MB) must be cut down before it is worth compressing at all.
export const SNAPSHOT_BUDGET = 340 * 1024;

const TRIM_ORDER: string[][] = [
  ['metrics', 'usage', 'sessions'],
  ['metrics', 'prompts'],
  ['metrics', 'usage', 'tools', 'byTool'],
  ['metrics', 'governance'],
  ['metrics', 'codex', 'sessions'],
  ['metrics', 'claude', 'daily'],
];

export function trimToBudget(snap: any, budget = SNAPSHOT_BUDGET): any {
  for (const path of TRIM_ORDER) {
    if (JSON.stringify(snap).length <= budget) return snap;
    let at = snap;
    for (const seg of path.slice(0, -1)) at = at?.[seg];
    const leaf = path[path.length - 1];
    if (at && leaf in at) {
      delete at[leaf];
      snap.trimmed = true;
    }
  }
  return snap;
}

/* ── storing a reading ──────────────────────────────────────────────── */

// What a stored reading may weigh once packed. DynamoDB's hard limit is 400 KB
// for the whole item and the LIVE row holds nothing else of size, so this is
// the limit with headroom for the keys and the timestamps.
export const PACKED_BUDGET = 300 * 1024;

/* A reading, ready to be one DynamoDB attribute.
 *
 * gzip then base64, because DynamoDB's binary type would survive the round
 * trip but not the JSON the API hands back - and a reading that has to be
 * re-encoded on the way out is a reading that gets re-encoded wrongly one day.
 * Measured on a real 94 KB reading: 19 KB gzipped, 26 KB base64. That ratio is
 * the whole reason a heartbeat costs 26 write units instead of 94.
 *
 * The trim runs against the *packed* size, so a reading is only cut down when
 * compressing it was not enough - which for anything a healthy agent sends is
 * never. `trimmed: true` rides in the reading itself, so the board says it is
 * showing a fraction rather than presenting one as the whole. */
export function packSnapshot(snap: any, budget = PACKED_BUDGET): string {
  let packed = gzipSync(Buffer.from(JSON.stringify(snap), 'utf8')).toString('base64');
  if (packed.length <= budget) return packed;
  for (const path of TRIM_ORDER) {
    let at = snap;
    for (const seg of path.slice(0, -1)) at = at?.[seg];
    const leaf = path[path.length - 1];
    if (at && leaf in at) {
      delete at[leaf];
      snap.trimmed = true;
    }
    packed = gzipSync(Buffer.from(JSON.stringify(snap), 'utf8')).toString('base64');
    if (packed.length <= budget) return packed;
  }
  return packed;
}

/* The inverse. Returns null rather than throwing: one unreadable row must not
   take down a board that has four other machines on it. */
export function unpackSnapshot(packed: unknown): any {
  if (typeof packed !== 'string' || packed.length === 0) return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
  } catch {
    return null;
  }
}

/* What the next heartbeat needs to remember about this one.
 *
 * `diffEndings` and `isStale` between them read exactly two things off the
 * previous reading - when it was collected, and what was running - so that is
 * all the machine row keeps. Storing the whole previous reading beside the
 * current one would double the row that every heartbeat reads and writes, to
 * carry 2 KB of it that anybody actually looks at. */
export function previousOf(snap: any): { collectedAt: unknown; metrics: { processes: unknown } } {
  return {
    collectedAt: snap?.collectedAt ?? null,
    metrics: { processes: Array.isArray(snap?.metrics?.processes) ? snap.metrics.processes : [] },
  };
}

/* ── the days a reading leaves behind ───────────────────────────────── */

// Four hundred days, measured from the day itself and not from the ingest that
// wrote it. That difference is the whole reason this is a function rather than
// a constant added to `now`: the agent re-derives ninety days from disk on
// every heartbeat, so a row written today for a day three months ago would
// otherwise be retained for four hundred days *from today* - and a backfill
// arriving every thirty seconds would keep pushing the horizon out, which is
// indefinite retention with extra steps. Anchored to the day, a day expires on
// its own schedule no matter how many times it is rewritten, and the window
// really is a window.
//
// Four hundred rather than three hundred and sixty-five so that a
// year-over-year comparison has a full year on both sides of it, and so that
// "the last twelve months" does not start losing its oldest day the moment it
// is asked for.
export const DAY_RETENTION_SECONDS = 400 * 24 * 3600;

const DAY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* A count that is present, or nothing at all.
 *
 * Absent and zero are different facts and this is the boundary where they
 * would otherwise be flattened: `Number(v) || 0` turns a day nobody has a
 * figure for into a day that measurably contained none. The rows this builds
 * come from `mergeDays` in shared/profile.mjs, which does initialise its
 * counters to zero - so in practice everything here is present - but the store
 * is where that assumption would go unnoticed if the shared shape changed. */
const numeric = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export type DayRollup = {
  date: string;
  tokens?: number;
  estUSD?: number;
  sessions?: number;
  toolCalls?: number;
  messages?: number;
  byModel?: Record<string, number>;
  ttl: number;
};

/* The counts a day may carry, as a list rather than five assignments.
 *
 * Written this way because it is the whitelist, and a whitelist that is a list
 * is one a reviewer can check against `mergeEntries` at a glance. A field
 * added here is a field published for four hundred days. */
const DAY_COUNTS = ['tokens', 'estUSD', 'sessions', 'toolCalls', 'messages'] as const;

/* One row per day of the rollup, carrying counts and nothing else.
 *
 * This is the share whitelist written out as a field list, and it is the same
 * one `mergeEntries` already publishes: a date, five counts, and tokens per
 * model. No machine name, no project, no path, no branch, no prompt - the
 * things a `byDay` entry never held and this must never start holding, because
 * these rows outlive by more than a year the reading they were derived from.
 * If a field is added to `byDay` in shared/profile.mjs, adding it here is a
 * decision about publishing, not a merge conflict to resolve.
 *
 * `ttl` is the table's expiry attribute; see DAY_RETENTION_SECONDS. A day
 * already past its own horizon is dropped rather than written and immediately
 * swept, which is what a ninety-day backfill on a fleet that has been away
 * would otherwise ask for. */
export function dayRollups(byDay: unknown, now = Date.now()): DayRollup[] {
  if (!Array.isArray(byDay)) return [];
  const rows: DayRollup[] = [];
  for (const day of byDay) {
    const date = typeof day?.date === 'string' ? day.date : '';
    if (!DAY_DATE.test(date)) continue;
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnight)) continue;
    const ttl = Math.floor(midnight / 1000) + DAY_RETENTION_SECONDS;
    if (ttl * 1000 <= now) continue;

    // Left off the row rather than written as undefined. The document client
    // is configured to strip undefined and would do the same thing, but a row
    // that is only correct because of a marshalling option is a row that stops
    // being correct the day somebody reasonably turns that option off.
    const row: DayRollup = { date, ttl };
    for (const field of DAY_COUNTS) {
      const value = numeric(day[field]);
      if (value !== undefined) row[field] = value;
    }

    const byModel: Record<string, number> = {};
    for (const [model, tokens] of Object.entries(day?.byModel ?? {})) {
      const value = numeric(tokens);
      if (model && value !== undefined) byModel[model] = value;
    }
    // An empty map would say the models were counted and came to nothing.
    if (Object.keys(byModel).length) row.byModel = byModel;

    rows.push(row);
  }
  return rows;
}

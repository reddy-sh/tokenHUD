// The cloud end of TokenHUD: one function, one table, three kinds of caller.
//
//   the agent    enrolls and heartbeats, holding a per-machine key
//   the portal   reads and manages, holding a Cognito ID token
//   a stranger   reads the public leaderboard, holding nothing
//
// The agent was written against the self-host server (server/src/http.rs) and
// is not changed for the cloud: the three routes it calls answer with the same
// JSON keys and the same status codes, because the agent's behaviour is keyed
// to them — 401/403 means "stop, the key is bad", 400/413/422 means "drop this
// reading", anything else means "buffer and retry". The enrollment link
// format, the pairing-code derivation and the 43-character base64url secrets
// are shared contracts; change them here and the terminal and the portal stop
// agreeing.
//
// One deliberate difference from the self-host flow: machines are approved at
// claim time. The one-shot link was minted seconds earlier by the signed-in
// owner, so there is no pending card to approve — the pairing code is still
// shown both ends for eye-matching.
//
// ── on what this costs ──────────────────────────────────────────────────
//
// A heartbeat is the only request that happens on a schedule, so it is the
// only one whose cost compounds. It is three reads and three writes, and the
// sizes are the design: the machine row carries a rollup (~6 KB), never the
// reading; the reading goes to its own row, gzipped (~26 KB from ~94 KB); the
// account aggregate is rebuilt at most once a minute rather than once a
// heartbeat. That is ~35 write units every 30 seconds per machine, which sits
// inside DynamoDB's perpetual 25-WCU free allowance up to about twenty
// machines. The shape this replaced wrote the whole 94 KB reading, and a
// second copy of it into a secondary index, on every single heartbeat.

import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
    firstNameFrom, looksGenerated, machineName, shortUid,
} from '../../../shared/machine-name.mjs';
import { liveness, mergeEntries, profileOf } from '../../../shared/profile.mjs';
import { cached, fail, json, preflight, type Cors } from './http';
import { callerOf, type Caller } from './jwt';
import {
    diffEndings, hashesEqual, isStale, newSecret, packSnapshot, previousOf, sha256Hex, unpackSnapshot,
} from './protocol';
import * as store from './store';

const MAX_BODY = 8 * 1024 * 1024; // same cap as the server, compressed and inflated
const ENROLL_MAX = 64 * 1024;
const REGISTER_MAX = 8 * 1024;

// The aggregate is what the leaderboard ranks and the portal totals. It does
// not have to be a heartbeat old to be useful, and rebuilding it on every
// heartbeat would make an account's read cost grow with the square of its
// machines. A minute is finer than anybody reads a leaderboard.
const AGGREGATE_MAX_AGE_MS = 60_000;
const BOARD_MAX_AGE_MS = 5 * 60_000;
const BOARD_CACHE_SECONDS = 60;

// A Lambda function URL response is capped at 6 MB. Readings are ~94 KB each,
// so a large fleet could reach it — and a truncated JSON body is a worse
// failure than a board that says a machine's detail did not fit.
const OVERVIEW_SNAPSHOT_BUDGET = 4 * 1024 * 1024;

// Super admins see every machine on every account. Keep this a compile-time
// constant so it is never wider than what the code reviews say it is.
const SUPER_ADMINS = new Set([
  'sankara@reddy.sh',
]);
const isSuperAdmin = (c: Caller) => SUPER_ADMINS.has(c.email ?? '');

/* ── the event ──────────────────────────────────────────────────────── */

function rawBody(event: LambdaFunctionURLEvent): Buffer | null {
  if (event.body == null) return null;
  return Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
}

function parseJson(
  body: Buffer | null,
  max: number,
  { allowEmpty = false } = {},
): { value?: any; error?: string; status?: number } {
  if (!body || body.length === 0) {
    return allowEmpty ? { value: {} } : { error: 'body missing', status: 400 };
  }
  if (body.length > max) return { error: 'body too large', status: 413 };
  try {
    return { value: JSON.parse(body.toString('utf8')) };
  } catch (e) {
    return { error: `bad json: ${e}`, status: 400 };
  }
}

const str = (v: unknown, max = 200) =>
  (typeof v === 'string' && v.length <= max ? v : '');

/* A name nobody else on this board is using.
 *
 * The generated names carry six random characters precisely so this never
 * fires, but a person renaming machines by hand can still collide, and the
 * board's own rename endpoint refuses duplicates — so registration must not be
 * able to create one behind its back. */
function uniqueLabel(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired} · ${n}`)) n++;
  return `${desired} · ${n}`;
}

/* Six characters of collision insurance, from the runtime's real CSPRNG. */
const newUid = () => shortUid((n: number) => randomBytes(n));

/* ── the public identity of an account ──────────────────────────────── */

// The Cognito sub is an internal identifier and has no business appearing on a
// page strangers read. This is stable, derived, and tells a reader nothing.
const publicIdOf = (sub: string) => sha256Hex(`tokenhud-public:${sub}`).slice(0, 12);

const HANDLE = /^[a-z0-9][a-z0-9-]{1,23}$/;

/* ── the account aggregate ──────────────────────────────────────────── */

/* Every machine an account owns, summed into one rankable entry.
 *
 * `fresh` is the rollup the caller has just computed but not necessarily read
 * back yet — DynamoDB would serve it, but only after the write, and paying for
 * a second read of something already in memory is the kind of small waste that
 * adds up at one every thirty seconds. */
async function rebuildAggregate(
  sub: string,
  now: string,
  fresh?: { id: string; rollup: any; lastSeenAt?: string },
): Promise<any> {
  const rows = await store.listMachineRollups(sub);
  const at = Date.parse(now);

  const entries = rows
    .map((row) => {
      const use = fresh && fresh.id === row.id ? fresh : row;
      if (!use.rollup) return null;
      const seen = use.lastSeenAt ? Date.parse(use.lastSeenAt) : NaN;
      return {
        ...use.rollup,
        status: liveness(Number.isFinite(seen) ? (at - seen) / 1000 : null),
        lastActive: use.lastSeenAt ?? use.rollup.lastActive ?? null,
      };
    })
    .filter(Boolean);

  const profile = await store.getProfile(sub);
  const entry = mergeEntries(entries, {
    id: publicIdOf(sub),
    name: profile?.handle ?? 'Anonymous',
  });

  await store.putAggregate(sub, entry, now);
  // The roster is the public board's input, and an account is in it only while
  // it has said yes. Nothing here puts an account on the page that did not.
  if (profile?.publicLeaderboard && profile?.handle) {
    await store.putRosterEntry(sub, entry, now);
  }
  return entry;
}

async function refreshAggregateIfStale(
  sub: string,
  now: string,
  fresh?: { id: string; rollup: any; lastSeenAt?: string },
): Promise<void> {
  const aggAt = await store.aggregateAge(sub);
  const age = aggAt ? Date.parse(now) - Date.parse(aggAt) : Infinity;
  if (Number.isFinite(age) && age < AGGREGATE_MAX_AGE_MS) return;
  await rebuildAggregate(sub, now, fresh);
}

/* ── POST /api/v1/machines — the portal registers one ───────────────── */

// The raw enrollment token never reaches this function. The browser mints it,
// hashes it, and sends the hash; the token itself lives in the command shown
// once and in the agent's memory while it enrolls. Same discipline as the
// self-host server, where no secret survives in the store.
async function register(
  event: LambdaFunctionURLEvent,
  caller: Caller,
  cors: Cors,
): Promise<LambdaFunctionURLResult> {
  const { value: req, error, status } = parseJson(rawBody(event), REGISTER_MAX);
  if (error) return fail(status ?? 400, error, cors);

  const label = str(req?.label, 120).trim();
  const enrollTokenHash = str(req?.enrollTokenHash, 64);
  const pairingCode = str(req?.pairingCode, 7);
  const expiresAt = str(req?.enrollTokenExpiresAt, 40);
  // The label is optional on purpose. At this point in the handshake nobody
  // knows what this machine is called — the agent has not run yet — so a name
  // supplied here can only be one a person typed. When they did not type one,
  // this function names the machine itself and `claim` finishes the job once
  // the agent reports its hostname.
  if (
    !/^[0-9a-f]{64}$/.test(enrollTokenHash) ||
    !/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(pairingCode) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return fail(400, 'a registration needs a token hash, a pairing code and an expiry', cors);
  }
  // A link that outlives the sitting it was minted in is a link somebody
  // pastes into a terminal a week later and cannot explain.
  const window = Date.parse(expiresAt) - Date.now();
  if (window <= 0 || window > 3600_000) {
    return fail(400, 'the enrollment window must be in the future and under an hour', cors);
  }

  const taken = new Set((await store.listMachines(caller.sub)).map((m) => m.label));

  // `uid` and `ownerFirst` are minted here and never change, so the name this
  // machine gets now and the name it gets when the agent enrols differ in
  // exactly one part — the hostname. A card that gained a real name is
  // recognisably the same card, which it would not be if the whole string
  // were rebuilt from scratch.
  const uid = newUid();
  const ownerFirst = firstNameFrom(caller.email);
  // A label a person typed is theirs and survives enrolment untouched. One
  // that only looks generated — including the "machine · 11" shape this
  // replaces — is treated as no label at all.
  const chosen = label && !looksGenerated(label) ? label : '';
  const labelAuto = !chosen;
  const name = uniqueLabel(
    chosen || machineName({ email: caller.email, uid, fallbackHost: 'pending' }),
    taken,
  );

  const id = randomUUID();
  const now = new Date().toISOString();
  await store.putMachine({
    pk: store.userPk(caller.sub), sk: store.machineSk(id),
    id, sub: caller.sub, label: name,
    labelAuto, uid, ownerFirst,
    status: 'registered',
    pairingCode,
    enrollTokenHash,
    enrollTokenExpiresAt: expiresAt,
    heartbeatCount: 0,
    createdAt: now,
  });
  await store.putTokenPointer(enrollTokenHash, caller.sub, id);

  return json(201, { machine: publicMachine({ id, label: name, status: 'registered', pairingCode, enrollTokenExpiresAt: expiresAt, createdAt: now, heartbeatCount: 0 }) }, cors);
}

/* ── POST /api/v1/enroll — the agent claims the link ────────────────── */

const VALID_INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/;

async function claim(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const { value: req, error, status } = parseJson(rawBody(event), ENROLL_MAX);
  // 413 keeps the agent's "drop this and move on" behaviour for a body that
  // could never fit; 400 says the same about one that could never parse.
  if (error) return fail(status ?? 400, error);

  const token = str(req?.token, 100);
  const secret = str(req?.secret, 100);
  const installId = str(req?.installId, 64);
  const host = str(req?.host, 120);
  if (
    token.length < 20 || secret.length < 16 ||
    !VALID_INSTALL_ID.test(installId) || host.length === 0
  ) {
    return fail(400, 'enrollment needs a token, a secret, an installId, and a host');
  }

  const tokenHash = sha256Hex(token);
  const m = await store.machineByTokenHash(tokenHash);
  if (!m) return fail(410, 'unknown enrollment link');
  if (m.enrollTokenExpiresAt && Date.parse(m.enrollTokenExpiresAt) < Date.now()) {
    return fail(410, 'enrollment link expired');
  }
  if (m.status === 'revoked') return fail(410, 'denied on this board — ask for a fresh link');
  if (m.status === 'active' && m.keyHash) {
    return fail(410, 'this machine is already enrolled — revoke it on the board first');
  }
  // One link binds to one machine; a retry from the same machine refreshes it.
  if (m.installId && m.installId !== installId) return fail(410, 'enrollment link already used');

  // The hostname has just arrived, and this is the only moment it ever will —
  // so this is where an auto-named machine stops being `sankara-pending-k3f9dq`
  // and becomes `sankara-sankaras-macbook-pro-k3f9dq`. Rows written before
  // this existed have no `labelAuto`, so their names are judged by shape,
  // which is what rescues the "machine · 11" fleet on the next enrolment.
  const auto = m.labelAuto ?? looksGenerated(m.label);
  const uid = m.uid || newUid();
  let label = m.label;
  if (auto) {
    const taken = new Set(
      (await store.listMachines(m.sub)).filter((x) => x.id !== m.id).map((x) => x.label),
    );
    label = uniqueLabel(machineName({ first: m.ownerFirst, hostname: host, uid }), taken);
  }

  await store.updateMachine(m.sub, m.id, {
    installId,
    hostname: host,
    label,
    labelAuto: auto,
    uid,
    platform: str(req?.platform, 120),
    agentVersion: str(req?.agentVersion, 40),
    manifestDigest: str(req?.manifestDigest, 128),
    assistants: req?.assistants ?? null,
    pollSecretHash: sha256Hex(secret),
    status: 'enrolling',
  });

  return json(200, { status: 'pending', code: m.pairingCode ?? '?' });
}

/* ── GET /api/v1/enroll/await — the key, exactly once ───────────────── */

async function poll(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const qs = event.queryStringParameters ?? {};
  const token = str(qs.token, 100);
  const secret = str(qs.secret, 100);
  if (token.length < 20) return fail(400, 'token is required');
  if (secret.length < 16) return fail(400, 'secret is required');

  const tokenHash = sha256Hex(token);
  const m = await store.machineByTokenHash(tokenHash);
  // Unknown token, a registration nobody claimed yet, or a wrong poll secret
  // all look the same from outside: a leaked link identifies nothing.
  if (!m || !m.pollSecretHash || !hashesEqual(m.pollSecretHash, sha256Hex(secret))) {
    return fail(404, 'unknown or expired enrollment');
  }

  if (m.status === 'enrolling') {
    const key = newSecret();
    const keyHash = sha256Hex(key);
    const won = await store.deliverKey(m.sub, m.id, keyHash, new Date().toISOString());
    if (!won) return json(200, { status: 'approved', delivered: true });

    // Only after the key is committed: a pointer to a key that failed to
    // persist would authenticate a machine the row does not know about.
    await store.putKeyPointer(keyHash, m.sub, m.id);
    // Burning the link is the last step, so a crash before it leaves a link
    // that resolves to an active machine — which the branches above refuse —
    // rather than a machine nobody can reach.
    await store.dropTokenPointer(tokenHash);

    return json(200, { status: 'approved', key, installId: m.installId, label: m.label });
  }
  if (m.status === 'active') return json(200, { status: 'approved', delivered: true });
  if (m.status === 'revoked') return json(200, { status: 'revoked', code: m.pairingCode });
  return fail(404, 'unknown or expired enrollment');
}

/* ── POST /api/v1/ingest — the heartbeat ────────────────────────────── */

async function ingest(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const key = event.headers?.['x-tokenhud-key'] ?? '';
  if (!key) return fail(401, 'bad or missing X-TokenHUD-Key');
  const keyHash = sha256Hex(key);
  const m = await store.machineByKeyHash(keyHash);
  // The pointer found it; the machine row decides. A revoked machine's pointer
  // can outlive the revocation by a moment, and that moment must not be a door.
  if (!m || m.status !== 'active' || !m.keyHash || !hashesEqual(m.keyHash, keyHash)) {
    return fail(401, 'bad or missing X-TokenHUD-Key');
  }

  let body = rawBody(event);
  if (!body || body.length === 0 || body.length > MAX_BODY) {
    return fail(413, 'body missing or too large');
  }
  if ((event.headers?.['content-encoding'] ?? '').includes('gzip')) {
    try {
      body = gunzipSync(body, { maxOutputLength: MAX_BODY + 1 });
    } catch {
      return fail(413, 'body missing or too large');
    }
  }

  let snap: any;
  try {
    snap = JSON.parse(body.toString('utf8'));
  } catch (e) {
    return fail(400, `bad json: ${e}`);
  }
  if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) {
    return fail(400, 'snapshot must be a JSON object');
  }

  // A machine key writes its own row and nothing else: the enrolled identity
  // wins over whatever the payload claims, exactly as the server does it.
  snap.host = m.label;
  snap.installId = m.installId;

  const now = new Date().toISOString();

  // A reading older than the one already stored is accepted (202, so the
  // agent's spool drains) and counted, and nothing else about it is believed —
  // see isStale in protocol.ts for why diffing or storing it would both lie.
  if (isStale(snap, m.prev, m.lastSeenAt ?? null)) {
    await store.countHeartbeat(m.sub, m.id);
    return json(202, { ok: true, host: m.label });
  }

  const endings = diffEndings(m.prev, m.endings ?? [], m.label, m.lastSeenAt ?? null, snap, now);
  // The rollup is computed before the reading is packed, because packing may
  // trim the reading and a rollup of the trimmed thing would under-count.
  const rollup = profileOf(snap, { status: 'up', last_seen: now });

  // The reading first, the row second. If this fails the row is not advanced,
  // the agent gets a 5xx, buffers, and retries — which leaves the board one
  // reading behind rather than pointing at a row whose reading never landed.
  await store.putLive(m.id, packSnapshot(snap), now);

  const interval = Number.isFinite(snap.intervalSeconds) && snap.intervalSeconds > 0
    ? Math.floor(snap.intervalSeconds)
    : 30;

  await store.updateMachine(m.sub, m.id, {
    rollup,
    prev: previousOf(snap),
    endings,
    lastSeenAt: now,
    liveAt: now,
    intervalSeconds: interval,
    agentVersion: str(snap.agentVersion, 40) || m.agentVersion,
    heartbeatCount: (m.heartbeatCount ?? 0) + 1,
  });

  await refreshAggregateIfStale(m.sub, now, { id: m.id, rollup, lastSeenAt: now });

  return json(202, { ok: true, host: m.label });
}

/* ── GET /api/v1/overview — the portal's board ──────────────────────── */

// Everything a machine row says about itself, minus everything that is a
// secret or a derivative of one. The board never needs a hash.
function publicMachine(m: Record<string, any>) {
  return {
    id: m.id,
    installId: m.installId ?? null,
    label: m.label,
    hostname: m.hostname ?? null,
    platform: m.platform ?? null,
    agentVersion: m.agentVersion ?? null,
    manifestDigest: m.manifestDigest ?? null,
    assistants: m.assistants ?? null,
    // The code is for eye-matching a machine that is still joining. Once it is
    // active there is nothing left to match and it stops being shown.
    pairingCode: m.status === 'registered' || m.status === 'enrolling' ? m.pairingCode ?? null : null,
    status: m.status,
    createdAt: m.createdAt ?? null,
    enrolledAt: m.enrolledAt ?? null,
    enrollTokenExpiresAt: m.enrollTokenExpiresAt ?? null,
    lastSeenAt: m.lastSeenAt ?? null,
    intervalSeconds: m.intervalSeconds ?? null,
    heartbeatCount: m.heartbeatCount ?? 0,
    endings: m.endings ?? [],
  };
}

/* Give a real name to machines that enrolled before names meant anything.
 *
 * The naming happens at registration and at enrolment, which does nothing for
 * a machine that is already active — and the fleet this was written for is
 * entirely already active, sitting on the board as "machine", "machine · 2",
 * "machine · 11". Everything needed to fix them is here and nowhere else: the
 * owner's email is on the caller, and the hostname was recorded when the agent
 * enrolled. So the board renames them the first time their owner looks at it.
 *
 * Guarded three ways. Only auto-generated names are touched, so a name a
 * person typed is never overwritten. Only the caller's own machines are
 * touched, because the super admin sees every account's rows and must not
 * stamp their own first name across all of them. And the write only happens
 * when the name would actually change, so this costs nothing on every
 * subsequent poll. */
async function backfillNames(caller: Caller, rows: store.Machine[]): Promise<void> {
  const mine = rows.filter((m) => m.sub === caller.sub);
  const stale = mine.filter(
    (m) => (m.labelAuto ?? looksGenerated(m.label)) && (m.hostname || m.label),
  );
  if (!stale.length) return;

  const taken = new Set(mine.map((m) => m.label));
  const first = firstNameFrom(caller.email);

  for (const m of stale) {
    const uid = m.uid || newUid();
    // A machine that enrolled has a hostname; one still waiting to keeps the
    // provisional shape until it does, rather than being named after nothing.
    const desired = machineName({
      first, hostname: m.hostname, uid, fallbackHost: m.hostname ? undefined : 'pending',
    });
    if (desired === m.label) continue;
    taken.delete(m.label);
    const label = uniqueLabel(desired, taken);
    taken.add(label);
    try {
      await store.updateMachine(caller.sub, m.id, { label, labelAuto: true, uid, ownerFirst: first });
      // The caller is about to be handed these rows, so update them in place
      // rather than making the new name wait for the next poll.
      m.label = label; m.labelAuto = true; m.uid = uid; m.ownerFirst = first;
    } catch {
      // A rename that loses a race is not worth failing a board render over —
      // the next poll tries again.
    }
  }
}

async function overview(caller: Caller, event: LambdaFunctionURLEvent, cors: Cors) {
  const admin = isSuperAdmin(caller);
  const rows = admin
    ? await store.listAllMachines()
    : await store.listMachines(caller.sub);
  rows.sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1));

  await backfillNames(caller, rows);

  // `?live=0` asks for the rows without the readings — a much smaller answer,
  // and all the portal needs while it is only watching liveness.
  const wantLive = (event.queryStringParameters?.live ?? '1') !== '0';
  const reporting = rows.filter((m) => m.status === 'active' && m.lastSeenAt);

  const readings = wantLive
    ? await Promise.all(reporting.map((m) => store.getLive(m.id).catch(() => null)))
    : [];

  let spent = 0;
  const byId = new Map<string, any>();
  readings.forEach((live, i) => {
    const snap = unpackSnapshot(live?.packed);
    if (!snap) return;
    const size = JSON.stringify(snap).length;
    if (spent + size > OVERVIEW_SNAPSHOT_BUDGET) return;
    spent += size;
    byId.set(reporting[i].id, snap);
  });

  const machines = rows.map((m) => ({
    ...publicMachine(m),
    // Super admin sees which account owns each machine.
    ...(admin ? { owner: m.sub } : {}),
    snapshot: byId.get(m.id) ?? null,
    // Says which of the two reasons a reading is missing: the caller did not
    // ask for it, or it did not fit. A board that cannot tell them apart shows
    // "no data" for a machine that is reporting perfectly well.
    snapshotOmitted: wantLive && byId.get(m.id) === undefined && reporting.includes(m),
  }));

  return json(200, {
    generatedAt: new Date().toISOString(),
    machines,
    account: { publicId: publicIdOf(caller.sub), email: caller.email, superAdmin: admin },
  }, cors);
}

/* ── the portal's machine actions ───────────────────────────────────── */

async function machineAction(
  path: string,
  event: LambdaFunctionURLEvent,
  caller: Caller,
  cors: Cors,
): Promise<LambdaFunctionURLResult> {
  const { value: req, error, status } = parseJson(rawBody(event), REGISTER_MAX);
  if (error) return fail(status ?? 400, error, cors);
  const id = str(req?.id, 64);
  if (!id) return fail(400, 'id is required', cors);

  // Super admins pass the owner's sub so the action reaches the right
  // partition. Normal callers always act on their own machines.
  const admin = isSuperAdmin(caller);
  const ownerSub = admin && typeof req?.owner === 'string' ? req.owner : caller.sub;

  const m = await store.getMachine(ownerSub, id);
  if (!m) return fail(404, 'no such machine on this account', cors);

  if (path === '/api/v1/machines/rename') {
    const label = str(req?.label, 120).trim();
    if (!label) return fail(400, 'a machine needs a name', cors);
    const taken = (await store.listMachines(ownerSub))
      .some((other) => other.id !== id && other.label === label);
    if (taken) return fail(409, 'another machine on this board already has that name', cors);
    // Naming a machine by hand opts it out of ever being renamed again.
    await store.updateMachine(ownerSub, id, { label, labelAuto: false });
    return json(200, { ok: true, label }, cors);
  }

  if (path === '/api/v1/machines/revoke') {
    // Clearing the key hash is what stops the agent: the next heartbeat gets a
    // 401 and it stops rather than buffering. The pointers go too, so nothing
    // can resolve to this machine on the strength of a credential it no longer
    // has.
    await store.updateMachine(ownerSub, id, {
      status: 'revoked',
      keyHash: null,
      enrollTokenHash: null,
      enrollTokenExpiresAt: null,
      pollSecretHash: null,
    });
    if (m.keyHash) await store.dropKeyPointer(m.keyHash);
    if (m.enrollTokenHash) await store.dropTokenPointer(m.enrollTokenHash);
    await store.dropLive(id);
    await rebuildAggregate(ownerSub, new Date().toISOString());
    return json(200, { ok: true }, cors);
  }

  if (path === '/api/v1/machines/remove') {
    if (m.keyHash) await store.dropKeyPointer(m.keyHash);
    if (m.enrollTokenHash) await store.dropTokenPointer(m.enrollTokenHash);
    await store.dropLive(id);
    await store.deleteMachine(ownerSub, id);
    await rebuildAggregate(ownerSub, new Date().toISOString());
    return json(200, { ok: true }, cors);
  }

  return fail(404, 'not found', cors);
}

/* ── the account profile, and the leaderboard opt-in ────────────────── */

async function readProfile(caller: Caller, cors: Cors) {
  const p = await store.getProfile(caller.sub);
  return json(200, {
    publicId: publicIdOf(caller.sub),
    email: caller.email,
    handle: p?.handle ?? null,
    publicLeaderboard: !!p?.publicLeaderboard,
  }, cors);
}

/* Joining and leaving the public board.
 *
 * Both directions are the account's to choose and neither is a default: a new
 * account is off, opting in needs a handle to be shown under, and opting out
 * deletes the roster row rather than hiding it behind a flag. "My numbers are
 * not on that page" should be true of the database, not just of the query that
 * reads it. */
async function writeProfile(
  event: LambdaFunctionURLEvent,
  caller: Caller,
  cors: Cors,
): Promise<LambdaFunctionURLResult> {
  const { value: req, error, status } = parseJson(rawBody(event), REGISTER_MAX, { allowEmpty: true });
  if (error) return fail(status ?? 400, error, cors);

  const existing = await store.getProfile(caller.sub);
  let handle = existing?.handle ?? null;

  if (req?.handle !== undefined) {
    const wanted = str(req.handle, 24).trim().toLowerCase();
    if (!HANDLE.test(wanted)) {
      return fail(400, 'a handle is 2–24 characters of a–z, 0–9 and hyphens, and starts with a letter or digit', cors);
    }
    if (wanted !== handle) {
      if (!(await store.claimHandle(wanted, caller.sub))) {
        return fail(409, 'that handle is taken', cors);
      }
      if (handle) await store.releaseHandle(handle);
      handle = wanted;
    }
  }

  const wantsPublic = req?.publicLeaderboard === undefined
    ? !!existing?.publicLeaderboard
    : !!req.publicLeaderboard;
  if (wantsPublic && !handle) {
    return fail(400, 'the public board shows a handle — choose one before joining it', cors);
  }

  const now = new Date().toISOString();
  await store.putProfile(caller.sub, {
    handle: handle ?? undefined,
    publicId: publicIdOf(caller.sub),
    publicLeaderboard: wantsPublic,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  // Take effect now, not at the next heartbeat: somebody who just left should
  // be able to reload the public page and be gone from it.
  if (wantsPublic) {
    const agg = await store.getAggregate(caller.sub);
    const entry = agg?.entry
      ? { ...agg.entry, id: publicIdOf(caller.sub), name: handle }
      : null;
    if (entry) await store.putRosterEntry(caller.sub, entry, now);
    else await rebuildAggregate(caller.sub, now);
  } else {
    await store.dropRosterEntry(caller.sub);
  }

  return json(200, { publicId: publicIdOf(caller.sub), handle, publicLeaderboard: wantsPublic }, cors);
}

/* ── GET /api/v1/leaderboard — the public board ─────────────────────── */

/* The public board's input, gathered on read.
 *
 * There is no scheduled job behind this and no second function: the roster is
 * read when somebody asks and the result is cached for five minutes, so
 * nothing runs while nobody is looking. CloudFront holds the answer for a
 * further sixty seconds, which is what turns a burst of readers into one
 * invocation.
 *
 * It returns entries rather than a ranking. Ranking them is `rankBoard`, and
 * the page runs it in the browser — the same function, on the same shape, as
 * the signed-in board a few pixels away. That is not only tidier: it means
 * switching metric or period on the public page costs nothing at all, where
 * ranking here would have meant one cached object per combination and a round
 * trip every time somebody pressed a button.
 *
 * Everything in an entry came through `mergeEntries`, which is where the
 * privacy boundary is: counts, models and days, never a machine name, a path,
 * a project or a prompt. */
const BOARD_MAX_ENTRIES = 250;

async function leaderboard(): Promise<LambdaFunctionURLResult> {
  const cache = await store.getBoardCache();
  const age = cache?.computedAt ? Date.now() - Date.parse(cache.computedAt) : Infinity;

  if (cache?.packed && Number.isFinite(age) && age < BOARD_MAX_AGE_MS) {
    const entries = unpackJson(cache.packed);
    if (entries) return cached({ computedAt: cache.computedAt, entries }, BOARD_CACHE_SECONDS);
  }

  const entries = (await store.listRoster())
    .map((row) => row.entry)
    .filter(Boolean)
    .sort((a, b) => (b?.totals?.tokens ?? 0) - (a?.totals?.tokens ?? 0))
    // A bound, because an unbounded page is a page that one day does not load.
    // The cut is by all-time tokens, so nobody who would have appeared in any
    // window's top few is dropped by it.
    .slice(0, BOARD_MAX_ENTRIES);

  const computedAt = new Date().toISOString();
  // Gzipped because a few hundred entries is a few hundred kilobytes of very
  // repetitive JSON and the item limit is 400 KB.
  await store.putBoardCache(
    gzipSync(Buffer.from(JSON.stringify(entries), 'utf8')).toString('base64'),
    computedAt,
  );

  return cached({ computedAt, entries }, BOARD_CACHE_SECONDS);
}

function unpackJson(packed: string): any[] | null {
  try {
    const parsed = JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ── the router ─────────────────────────────────────────────────────── */

// Throttling is not an error the caller can fix, and it is the one failure
// this design makes likely on purpose: the table runs on provisioned capacity
// inside the free allowance rather than on-demand, so a burst past it is
// answered rather than billed. 503 is what makes the agent buffer and retry,
// which is exactly the right thing for it to do.
const THROTTLED = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
]);

export const handler = async (
  event: LambdaFunctionURLEvent,
): Promise<LambdaFunctionURLResult> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const cors: Cors = { origin: event.headers?.origin };

  try {
    if (method === 'OPTIONS') {
      return preflight(path === '/api/v1/leaderboard' ? { public: true } : cors);
    }

    if (method === 'GET' && path === '/healthz') {
      return { statusCode: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'ok' };
    }

    /* The agent. No CORS on these: the agent is not a browser, and a page on
       another origin has no business reaching them. */
    if (method === 'POST' && path === '/api/v1/enroll') return await claim(event);
    if (method === 'GET' && path === '/api/v1/enroll/await') return await poll(event);
    if (method === 'POST' && path === '/api/v1/ingest') return await ingest(event);

    /* A stranger. */
    if (method === 'GET' && path === '/api/v1/leaderboard') return await leaderboard();

    /* The portal. Everything below needs a verified Cognito ID token. */
    const portal =
      (method === 'GET' && (path === '/api/v1/overview' || path === '/api/v1/profile')) ||
      (method === 'POST' && (path === '/api/v1/machines' || path === '/api/v1/profile' || path.startsWith('/api/v1/machines/')));
    if (!portal) return fail(404, 'not found', cors);

    const caller = await callerOf(event.headers ?? {});
    if (!caller) return fail(401, 'sign in first', cors);

    if (method === 'GET' && path === '/api/v1/overview') return await overview(caller, event, cors);
    if (method === 'GET' && path === '/api/v1/profile') return await readProfile(caller, cors);
    if (method === 'POST' && path === '/api/v1/profile') return await writeProfile(event, caller, cors);
    if (method === 'POST' && path === '/api/v1/machines') return await register(event, caller, cors);
    return await machineAction(path, event, caller, cors);
  } catch (e: any) {
    if (THROTTLED.has(e?.name)) {
      return fail(503, 'the store is busy — try again shortly', cors);
    }
    // A store hiccup is transient: 500 makes the agent buffer and retry,
    // which is the right failure mode for a heartbeat.
    console.error(e);
    return fail(500, String(e), cors);
  }
};

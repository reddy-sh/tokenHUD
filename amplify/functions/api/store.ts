// Everything that touches DynamoDB, in one place.
//
// One table, no secondary indexes. That is a cost decision before it is a
// design one: an Amplify-managed GSI projects every attribute, so the previous
// shape of this backend copied the whole reading into an index on every single
// heartbeat and paid for it twice. Here the two lookups the hot path needs —
// "which machine holds this key" and "which machine does this enrollment token
// belong to" — are their own small items, which makes each of them one
// strongly-consistent GetItem: cheaper than an index, and correct on the first
// try rather than after the retry an eventually-consistent index needs.
//
//   pk                   sk                what
//   ─────────────────────────────────────────────────────────────────────
//   U#<sub>              PROFILE           handle, and the leaderboard opt-in
//   U#<sub>              M#<machineId>     machine: identity, auth, rollup
//   U#<sub>              AGG               that account's machines, summed
//   M#<machineId>        LIVE              the latest reading, gzipped   (7d)
//   KEY#<sha256>         AUTH              machine key   → account, machine
//   TOK#<sha256>         ENROLL            enroll token  → account, machine (15m)
//   HANDLE#<lower>       CLAIM             handle        → account
//   LB#roster            U#<sub>           an opted-in account's entry
//   LB#global            CACHE             the ranked board, gzipped     (1h)
//
// Nothing here holds a secret in the clear. Keys and tokens are stored as
// SHA-256 and looked up by it, the same discipline as the self-host server's
// SQLite store — see server/src/store.rs.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DeleteCommand,
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME as string;

// removeUndefinedValues because the handler builds rows out of optional fields
// and DynamoDB rejects an explicit undefined; convertClassInstanceToMap is off
// because everything written here is a plain object and turning that check on
// only hides a mistake.
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/* ── keys ───────────────────────────────────────────────────────────── */

export const userPk = (sub: string) => `U#${sub}`;
export const machineSk = (id: string) => `M#${id}`;

const LIVE_TTL_SECONDS = 7 * 24 * 3600;
const ENROLL_TTL_SECONDS = 15 * 60;
const BOARD_TTL_SECONDS = 3600;

const epoch = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

/* ── machines ───────────────────────────────────────────────────────── */

export type Machine = Record<string, any>;

/* The authoritative read. Strongly consistent because everything that calls it
   is about to make a decision that must not be made on a stale copy: whether a
   key is still good, whether a link has already been used. */
export async function getMachine(sub: string, id: string): Promise<Machine | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: machineSk(id) },
    ConsistentRead: true,
  }));
  return Item ?? null;
}

/* A pointer item resolved, then the machine itself read by primary key.
   Two GetItems, both small, both strongly consistent — which is the whole
   reason the pointer exists instead of an index. */
async function machineVia(pointerPk: string, pointerSk: string): Promise<Machine | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: pointerPk, sk: pointerSk },
    ConsistentRead: true,
  }));
  if (!Item?.sub || !Item?.machineId) return null;
  return getMachine(Item.sub, Item.machineId);
}

export const machineByKeyHash = (keyHash: string) => machineVia(`KEY#${keyHash}`, 'AUTH');
export const machineByTokenHash = (tokenHash: string) => machineVia(`TOK#${tokenHash}`, 'ENROLL');

export async function listMachines(sub: string): Promise<Machine[]> {
  const out: Machine[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await doc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :m)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': userPk(sub), ':m': 'M#' },
      ExclusiveStartKey: start,
    }));
    out.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return out;
}

export async function putMachine(item: Machine): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
}

/* A partial write over the machine row.
 *
 * `null` means remove: revoking a machine has to take the key hash away, and a
 * row that keeps a revoked key hash under a different status is a row one bug
 * away from letting a revoked agent back in. */
export async function updateMachine(
  sub: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    names[`#${k}`] = k;
    if (v === null) { removes.push(`#${k}`); continue; }
    sets.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
  }
  if (!sets.length && !removes.length) return;
  const expression = [
    sets.length ? `SET ${sets.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ].filter(Boolean).join(' ');
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: machineSk(id) },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ...(sets.length ? { ExpressionAttributeValues: values } : {}),
  }));
}

/* The aggregate's input, and nothing else.
 *
 * A machine row also carries the previous reading's process list and up to
 * forty endings — about 4 KB that the aggregate has no use for. Projecting
 * halves what this query reads, and it runs on the heartbeat path, so the
 * halving is the difference between a read cost that grows with machines and
 * one that grows with machines twice. */
export async function listMachineRollups(sub: string): Promise<Machine[]> {
  const out: Machine[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await doc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :m)',
      ProjectionExpression: 'id, label, #rollup, lastSeenAt, #status',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk', '#status': 'status', '#rollup': 'rollup' },
      ExpressionAttributeValues: { ':pk': userPk(sub), ':m': 'M#' },
      ExclusiveStartKey: start,
    }));
    out.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return out;
}

/* Hand over the per-machine key, at most once, ever.
 *
 * The condition is the whole point. Two polls arriving together both read a
 * machine that is still `enrolling` and both mint a key; without a condition
 * both would write, the second would win, and the agent holding the first
 * would 401 forever with nothing to explain it. `attribute_not_exists(keyHash)`
 * makes the second write fail instead, and the loser is told the key was
 * already delivered — which is what the self-host server says, and it says it
 * for the same reason: `UPDATE ... WHERE key_hash IS NULL`.
 *
 * False means somebody else got there first. */
export async function deliverKey(
  sub: string,
  id: string,
  keyHash: string,
  now: string,
): Promise<boolean> {
  try {
    await doc.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: userPk(sub), sk: machineSk(id) },
      UpdateExpression:
        'SET keyHash = :kh, #status = :active, enrolledAt = :now REMOVE enrollTokenHash, enrollTokenExpiresAt',
      ConditionExpression: 'attribute_not_exists(keyHash) AND #status = :enrolling',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':kh': keyHash, ':active': 'active', ':enrolling': 'enrolling', ':now': now,
      },
    }));
    return true;
  } catch (e: any) {
    if (e?.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/* The heartbeat's counter, on a reading that is not going to be stored.
 *
 * A replayed reading from the agent's spool still means the agent is alive and
 * still deserves to be counted; it just must not become "what is running now".
 * ADD rather than SET so two heartbeats in the same instant both land. */
export async function countHeartbeat(sub: string, id: string): Promise<void> {
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: machineSk(id) },
    UpdateExpression: 'ADD heartbeatCount :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}

export async function deleteMachine(sub: string, id: string): Promise<void> {
  await doc.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: machineSk(id) },
  }));
}

/* ── the pointer items ──────────────────────────────────────────────── */

export async function putKeyPointer(keyHash: string, sub: string, machineId: string) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: `KEY#${keyHash}`, sk: 'AUTH', sub, machineId },
  }));
}

export async function dropKeyPointer(keyHash: string) {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `KEY#${keyHash}`, sk: 'AUTH' } }));
}

/* The enrollment pointer expires by itself. A link nobody used should not
   outlive the offer, and a TTL says so without a sweeper to run or pay for. */
export async function putTokenPointer(tokenHash: string, sub: string, machineId: string) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `TOK#${tokenHash}`, sk: 'ENROLL', sub, machineId, ttl: epoch(ENROLL_TTL_SECONDS),
    },
  }));
}

export async function dropTokenPointer(tokenHash: string) {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `TOK#${tokenHash}`, sk: 'ENROLL' } }));
}

/* ── the latest reading ─────────────────────────────────────────────── */

/* Its own item, because the heartbeat reads the machine row on the way in and
   the board reads it twenty times a minute — neither should have to carry
   26 KB of gzip to do it. The TTL is the retention policy: a machine that
   stopped reporting a week ago stops costing storage without anyone deciding. */
export async function putLive(machineId: string, packed: string, at: string) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: `M#${machineId}`, sk: 'LIVE', packed, at, ttl: epoch(LIVE_TTL_SECONDS) },
  }));
}

export async function getLive(machineId: string): Promise<{ packed?: string; at?: string } | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `M#${machineId}`, sk: 'LIVE' },
  }));
  return Item ?? null;
}

export async function dropLive(machineId: string) {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `M#${machineId}`, sk: 'LIVE' } }));
}

/* ── the account profile and its handle ─────────────────────────────── */

export type Profile = {
  handle?: string;
  publicId?: string;
  publicLeaderboard?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export async function getProfile(sub: string): Promise<Profile | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: 'PROFILE' },
    ConsistentRead: true,
  }));
  return (Item as Profile) ?? null;
}

export async function putProfile(sub: string, profile: Profile) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: userPk(sub), sk: 'PROFILE', ...profile },
  }));
}

/* Handles are first-come, and the condition is what makes that true rather
   than merely likely: two people typing the same handle into the same second
   both read "free" and only one write lands. Returns false for the loser. */
export async function claimHandle(handle: string, sub: string): Promise<boolean> {
  try {
    await doc.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: `HANDLE#${handle.toLowerCase()}`, sk: 'CLAIM', sub, handle },
      ConditionExpression: 'attribute_not_exists(pk) OR #sub = :sub',
      ExpressionAttributeNames: { '#sub': 'sub' },
      ExpressionAttributeValues: { ':sub': sub },
    }));
    return true;
  } catch (e: any) {
    if (e?.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

export async function releaseHandle(handle: string) {
  await doc.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: `HANDLE#${handle.toLowerCase()}`, sk: 'CLAIM' },
  }));
}

/* ── the account aggregate, and the public roster ───────────────────── */

export type Aggregate = { aggAt?: string; entry?: any };

/* Only the timestamp, so the heartbeat can ask "is this stale?" for one read
   unit no matter how big the aggregate has grown. */
export async function aggregateAge(sub: string): Promise<string | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: 'AGG' },
    ProjectionExpression: 'aggAt',
  }));
  return (Item?.aggAt as string) ?? null;
}

export async function getAggregate(sub: string): Promise<Aggregate | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: userPk(sub), sk: 'AGG' },
  }));
  return (Item as Aggregate) ?? null;
}

export async function putAggregate(sub: string, entry: any, aggAt: string) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: userPk(sub), sk: 'AGG', entry, aggAt },
  }));
}

/* The roster is the public leaderboard's whole input, and an account is in it
   only while it has said yes. Opting out deletes the row rather than flagging
   it: "my numbers are not on that page" should be true of the database, not
   just of the query that reads it. */
export async function putRosterEntry(sub: string, entry: any, at: string) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'LB#roster', sk: userPk(sub), entry, at },
  }));
}

export async function dropRosterEntry(sub: string) {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: 'LB#roster', sk: userPk(sub) } }));
}

export async function listRoster(): Promise<any[]> {
  const out: any[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await doc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': 'LB#roster' },
      ExclusiveStartKey: start,
    }));
    out.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return out;
}

/* ── the ranked board, cached ───────────────────────────────────────── */

export async function getBoardCache(): Promise<{ computedAt?: string; packed?: string } | null> {
  const { Item } = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'LB#global', sk: 'CACHE' },
  }));
  return Item ?? null;
}

export async function putBoardCache(packed: string, computedAt: string) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'LB#global', sk: 'CACHE', packed, computedAt, ttl: epoch(BOARD_TTL_SECONDS) },
  }));
}

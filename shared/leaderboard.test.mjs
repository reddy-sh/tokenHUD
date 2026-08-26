// The ranking runs in two places now — the browser, on the machines one
// account owns, and the API, on accounts against each other — so it is worth
// pinning here rather than discovering a difference on a public page.
//
//   npm test          (from the repo root)
//
// `mergeEntries` gets the closest attention because it is the newest and it is
// the one that feeds a page strangers read: what it drops is a privacy
// boundary, and what it double-counts is a leaderboard that lies.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveness, mergeEntries } from './profile.mjs';
import { rankBoard, streakOf, tierOf, tierProgress } from './ranking.mjs';

const DAY = 86400e3;
const NOW = Date.parse('2026-08-24T12:00:00Z');
const dayKey = (back) => {
  const d = new Date(NOW - back * DAY);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Totals are summed from the days so the fixture is internally consistent.
// The real `profileOf` reads them from the agent's all-time figures instead,
// which cover more than the 90-day series — so `mergeEntries` sums the totals
// rather than recomputing them from `byDay`, and a fixture where the two
// disagree would test nothing.
const sum = (days, field) => days.reduce((a, d) => a + (d[field] || 0), 0);
const entry = (id, days, extra = {}) => ({
  id,
  name: id,
  totals: {
    tokens: sum(days, 'tokens'),
    estUSD: sum(days, 'estUSD'),
    sessions: sum(days, 'sessions'),
    toolCalls: sum(days, 'toolCalls'),
    activeDays: days.filter((d) => d.tokens > 0).length,
  },
  byDay: days,
  byTool: [], models: [], tools: [],
  ...extra,
});

/* ── tiers ──────────────────────────────────────────────────────────── */

test('tiers are decades, and the boundary belongs to the tier above', () => {
  assert.equal(tierOf(0).key, 'rookie');
  assert.equal(tierOf(9_999_999).key, 'rookie');
  assert.equal(tierOf(1e7).key, 'builder');
  assert.equal(tierOf(1e8).key, 'operator');
  assert.equal(tierOf(1e9).key, 'veteran');
  assert.equal(tierOf(1e10).key, 'master');
  assert.equal(tierOf(1e11).key, 'legend');
  assert.equal(tierOf(1e15).key, 'legend', 'the top tier has no ceiling');
});

test('tier progress is logarithmic, so a bar moves before the last day', () => {
  // Halfway through a decade in log terms is 10^0.5 ≈ 3.16x, not 5.5x. On a
  // linear bar everybody sits at the left edge until the day they jump.
  const half = tierProgress(1e7 * Math.sqrt(10));
  assert.ok(Math.abs(half.pct - 50) < 0.001, `expected ~50, got ${half.pct}`);
  assert.equal(half.tier.key, 'builder');
  assert.equal(half.next.key, 'operator');

  const top = tierProgress(1e12);
  assert.equal(top.next, null);
  assert.equal(top.pct, 100);
});

/* ── streaks ────────────────────────────────────────────────────────── */

test('a day that has not started yet does not break a streak', () => {
  // At 9 a.m. nobody has done anything. Counting from today would end every
  // streak overnight.
  const worked = [1, 2, 3].map((back) => ({ date: dayKey(back), tokens: 1 }));
  assert.equal(streakOf(worked, NOW).current, 3);
});

test('a gap ends the current streak but not the longest', () => {
  const days = [0, 1, 4, 5, 6, 7].map((back) => ({ date: dayKey(back), tokens: 1 }));
  const s = streakOf(days, NOW);
  assert.equal(s.current, 2);
  assert.equal(s.longest, 4);
});

test('a day with no tokens on it is not a worked day', () => {
  const days = [{ date: dayKey(0), tokens: 0 }, { date: dayKey(1), tokens: 5 }];
  assert.equal(streakOf(days, NOW).current, 1);
});

/* ── ranking ────────────────────────────────────────────────────────── */

test('the window is what is ranked, not the all-time total', () => {
  const veteran = entry('veteran', [{ date: dayKey(40), tokens: 1e9 }]);
  const busy = entry('busy', [{ date: dayKey(1), tokens: 10 }, { date: dayKey(2), tokens: 10 }]);
  const week = rankBoard([veteran, busy], { metric: 'tokens', period: 'week', now: NOW });
  assert.equal(week.rows[0].id, 'busy', 'nothing in the last 7 days is nothing');
  assert.equal(week.rows[0].rank, 1);

  const all = rankBoard([veteran, busy], { metric: 'tokens', period: 'all', now: NOW });
  assert.equal(all.rows[0].id, 'veteran');
});

test('a zero scores no rank rather than a joint last place', () => {
  const rows = rankBoard(
    [entry('a', [{ date: dayKey(1), tokens: 5 }]), entry('idle', []), entry('also-idle', [])],
    { metric: 'tokens', period: 'week', now: NOW },
  );
  assert.equal(rows.rows[0].rank, 1);
  assert.equal(rows.rows[1].rank, null);
  assert.equal(rows.rows[2].rank, null);
  assert.equal(rows.ranked, 1);
});

test('movement is measured against the window before this one', () => {
  // `climber` did nothing last week and a lot this week; `fader` the reverse.
  const climber = entry('climber', [
    { date: dayKey(1), tokens: 100 },
    { date: dayKey(9), tokens: 1 },
  ]);
  const fader = entry('fader', [
    { date: dayKey(1), tokens: 1 },
    { date: dayKey(9), tokens: 100 },
  ]);
  const board = rankBoard([climber, fader], { metric: 'tokens', period: 'week', now: NOW });
  const at = (id) => board.rows.find((r) => r.id === id);
  assert.equal(at('climber').rank, 1);
  assert.equal(at('climber').move, 1, 'up one place, expressed positively');
  assert.equal(at('fader').move, -1);
});

test('all time has no previous window, so it draws no arrows', () => {
  const board = rankBoard([entry('a', [{ date: dayKey(1), tokens: 5 }])], {
    metric: 'tokens', period: 'all', now: NOW,
  });
  assert.equal(board.rows[0].move, null);
});

/* ── liveness ───────────────────────────────────────────────────────── */

test('liveness is about the agent reporting, not the machine being on', () => {
  assert.equal(liveness(0), 'up');
  assert.equal(liveness(119), 'up');
  assert.equal(liveness(120), 'stale');
  assert.equal(liveness(899), 'stale');
  assert.equal(liveness(900), 'down');
  assert.equal(liveness(null), 'unknown');
  assert.equal(liveness(NaN), 'unknown');
});

/* ── merging an account's machines ──────────────────────────────────── */

const laptop = entry('laptop', [{ date: dayKey(1), tokens: 100, estUSD: 1, sessions: 2 }], {
  status: 'up',
  lastActive: '2026-08-24T11:59:00Z',
  firstSeen: '2026-08-01',
  os: 'darwin',
  cores: 10,
  tools: [{ id: 'claude-code', name: 'Claude Code' }],
  byTool: [{ id: 'claude-code', name: 'Claude Code', tokens: 100, output: 10, estUSD: 1, sessions: 2 }],
  models: [{ model: 'sonnet', tool: 'claude-code', tokens: 100, input: 60, output: 40, estUSD: 1, priced: true }],
});

const desktop = entry('desktop', [{ date: dayKey(1), tokens: 50, estUSD: 0.5, sessions: 1 }], {
  status: 'down',
  lastActive: '2026-08-20T09:00:00Z',
  firstSeen: '2026-07-15',
  os: 'linux',
  cores: 32,
  tools: [{ id: 'codex', name: 'Codex CLI' }],
  byTool: [{ id: 'codex', name: 'Codex CLI', tokens: 50, output: 5, estUSD: null, sessions: 1 }],
  models: [{ model: 'sonnet', tool: 'claude-code', tokens: 50, input: 30, output: 20, estUSD: 0.5, priced: true }],
});

test('merging sums the counts and keeps the outer edges of the dates', () => {
  const m = mergeEntries([laptop, desktop], { id: 'abc123', name: 'reddy' });
  assert.equal(m.id, 'abc123');
  assert.equal(m.name, 'reddy');
  assert.equal(m.machines, 2);
  assert.equal(m.totals.tokens, 150);
  assert.equal(m.totals.estUSD, 1.5);
  assert.equal(m.firstSeen, '2026-07-15', 'the earliest, not the latest');
  assert.equal(m.lastActive, '2026-08-24T11:59:00Z', 'the latest, not the earliest');
  assert.equal(m.status, 'up', 'one machine reporting makes the account live');
});

test('the same day on two machines is one active day, not two', () => {
  const m = mergeEntries([laptop, desktop]);
  assert.equal(m.byDay.length, 1);
  assert.equal(m.byDay[0].tokens, 150);
  assert.equal(m.totals.activeDays, 1, 'summing would have said 2, and a streak built on it would be fiction');
});

test('the same model on two machines is one row', () => {
  const m = mergeEntries([laptop, desktop]);
  assert.equal(m.models.length, 1);
  assert.equal(m.models[0].model, 'sonnet');
  assert.equal(m.models[0].tokens, 150);
  assert.equal(m.models[0].input, 90);
});

test('a tool that is counted but not priced does not become free', () => {
  // Codex is counted and not priced in this build. Adding a zero for it would
  // read as "this cost nothing" rather than "we cannot say".
  const m = mergeEntries([laptop, desktop]);
  const codex = m.byTool.find((t) => t.id === 'codex');
  assert.equal(codex.estUSD, null);
  assert.equal(m.byTool.find((t) => t.id === 'claude-code').estUSD, 1);
});

test('nothing that names a machine survives the merge', () => {
  // The merged entry is what goes on a page strangers read. The whitelist it
  // has to satisfy is server/src/share.rs: counts, models and days — never a
  // hostname, a path, a project or a prompt.
  const m = mergeEntries([laptop, desktop], { id: 'abc123', name: 'reddy' });
  const text = JSON.stringify(m);
  for (const leak of ['laptop', 'desktop', 'darwin', 'linux']) {
    assert.ok(!text.includes(leak), `"${leak}" reached the public entry`);
  }
  assert.equal(m.os, null);
  assert.equal(m.cores, null);
});

test('an account with no machines merges to a well-formed empty entry', () => {
  const m = mergeEntries([], { id: 'nobody', name: 'nobody' });
  assert.equal(m.totals.tokens, 0);
  assert.equal(m.machines, 0);
  assert.deepEqual(m.byDay, []);
  assert.equal(m.status, 'down');
  // The ranking has to survive it, because a new account is exactly this.
  const board = rankBoard([m], { metric: 'tokens', period: 'week', now: NOW });
  assert.equal(board.rows[0].rank, null);
});

test('merged entries rank the same way machine entries do', () => {
  const heavy = mergeEntries([laptop, desktop], { id: 'heavy', name: 'heavy' });
  const light = mergeEntries([desktop], { id: 'light', name: 'light' });
  const board = rankBoard([light, heavy], { metric: 'tokens', period: 'week', now: NOW });
  assert.equal(board.rows[0].id, 'heavy');
  assert.equal(board.rows[0].value, 150);
  assert.equal(board.rows[1].value, 50);
  assert.equal(board.rows[1].pct, (50 / 150) * 100);
});

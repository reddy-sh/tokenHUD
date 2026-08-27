// The ranking runs in two places now - the browser, on the machines one
// account owns, and the API, on accounts against each other - so it is worth
// pinning here rather than discovering a difference on a public page.
//
//   npm test          (from the repo root)
//
// `mergeEntries` gets the closest attention because it is the newest and it is
// the one that feeds a page strangers read: what it drops is a privacy
// boundary, and what it double-counts is a leaderboard that lies.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveness, mergeEntries, profileOf } from './profile.mjs';
import {
  composition, MIN_PUBLIC_ENTRANTS, rankBoard, rankGroups, shiftKey, streakOf, tierOf,
  tierProgress, TREND, trendEligible, unitOf,
} from './ranking.mjs';

const DAY = 86400e3;
const NOW = Date.parse('2026-08-24T12:00:00Z');
const dayKey = (back) => {
  const d = new Date(NOW - back * DAY);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Totals are summed from the days so the fixture is internally consistent.
// The real `profileOf` reads them from the agent's all-time figures instead,
// which cover more than the 90-day series - so `mergeEntries` sums the totals
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

test('a streak survives a daylight-saving transition', () => {
  // Subtracting 86400e3 from a local timestamp assumes every day is 24 hours.
  // In a DST zone one is 23 and one is 25, and the old arithmetic broke every
  // streak that crossed one - twice a year, for everyone in such a zone.
  //
  // The timezone is pinned because CI runs in UTC, which has no daylight
  // saving: under UTC the old, broken arithmetic passes this test too, and a
  // guard that only fires on a developer's laptop is not a guard.
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // 2026-03-08 is the spring-forward date in US Pacific.
    const days = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09']
      .map((date) => ({ date, tokens: 1 }));
    assert.equal(streakOf(days, Date.parse('2026-03-09T18:00:00Z')).longest, 4);

    // …and the autumn transition, where a day is 25 hours long.
    const back = ['2026-10-31', '2026-11-01', '2026-11-02']
      .map((date) => ({ date, tokens: 1 }));
    assert.equal(streakOf(back, Date.parse('2026-11-02T18:00:00Z')).longest, 3);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('shifting a day key is calendar arithmetic, not clock arithmetic', () => {
  assert.equal(shiftKey('2026-03-09', 1), '2026-03-08', 'across spring forward');
  assert.equal(shiftKey('2026-11-02', 1), '2026-11-01', 'across autumn back');
  assert.equal(shiftKey('2026-03-01', 1), '2026-02-28', 'across a month');
  assert.equal(shiftKey('2026-01-01', 1), '2025-12-31', 'across a year');
  assert.equal(shiftKey('2024-03-01', 1), '2024-02-29', 'across a leap day');
  assert.equal(shiftKey('2026-08-01', -1), '2026-08-02', 'and forwards');
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

test('a rate card the machine owner wrote cannot buy a place on the board', () => {
  // `estUSD` is a ranked metric. If a user's own rate card reached it, first
  // place would go to whoever typed the largest number into a JSON file.
  const machine = (codexPublic) => profileOf({
    host: 'm1',
    metrics: {
      usage: { available: true, allTime: { estUSD: 5, sessions: 1, tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } } },
      codex: {
        available: true, sessionCount: 1,
        totals: { total: 1000, output: 100 },
        estUSD: 999999,            // what their own card says, for their own board
        publicEstUSD: codexPublic, // what the built-in card says - all that may travel
        costBasis: 'api_equivalent',
      },
    },
  }, { status: 'up', last_seen: '2026-08-24T12:00:00Z' });

  const gamed = machine(null).byTool.find((t) => t.id === 'codex');
  assert.equal(gamed.estUSD, null, 'a self-priced figure must not reach the board');
  assert.equal(gamed.costBasis, 'unpriced');
  assert.equal(gamed.tokens, 1000, 'the tokens still count - only the price is withheld');

  const legitimate = machine(12.5).byTool.find((t) => t.id === 'codex');
  assert.equal(legitimate.estUSD, 12.5, 'a built-in-card figure is comparable and travels');
  assert.equal(legitimate.costBasis, 'list_price');
});

test('a cost carries the basis it was arrived at, and a disagreement becomes mixed', () => {
  // "$0" means three different things across these tools - free, no rate for
  // this model, and included in a subscription. The number alone cannot say
  // which, so the basis travels with it.
  const withBasis = (id, basis, usd) => ({
    ...entry(`m-${id}-${basis}`, [{ date: dayKey(1), tokens: 10 }]),
    byTool: [{ id, name: id, tokens: 10, output: 5, estUSD: usd, sessions: 1, costBasis: basis }],
  });

  const one = mergeEntries([withBasis('claude-code', 'list_price', 1)]);
  assert.equal(one.byTool[0].costBasis, 'list_price');

  const same = mergeEntries([
    withBasis('claude-code', 'list_price', 1),
    withBasis('claude-code', 'list_price', 2),
  ]);
  assert.equal(same.byTool[0].costBasis, 'list_price', 'agreement stays itself');
  assert.equal(same.byTool[0].estUSD, 3);

  const clash = mergeEntries([
    withBasis('claude-code', 'list_price', 1),
    withBasis('claude-code', 'credits', 2),
  ]);
  assert.equal(
    clash.byTool[0].costBasis, 'mixed',
    'a total summed across two different bases is not one number, and must say so',
  );
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
  // has to satisfy is server/src/share.rs: counts, models and days - never a
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

/* ── which board is this ────────────────────────────────────────────── */

test('a merged account entry knows it is an account and a machine entry does not', () => {
  // The unit decides whether a podium and a "#1 of 3" badge appear at all, so
  // it must not depend on a caller remembering a prop. `mergeEntries` is the
  // only thing that produces a machine COUNT, because a machine is one machine
  // and has nothing to count.
  assert.equal(unitOf([laptop, desktop]), 'machine');
  assert.equal(unitOf([mergeEntries([laptop, desktop], { id: 'a', name: 'a' })]), 'account');
  assert.equal(unitOf([mergeEntries([], { id: 'new', name: 'new' })]), 'account',
    'an account with no machines yet is still an account, not a machine');
  assert.equal(unitOf([]), 'machine', 'an empty board is nobody, and nobody gets no medals');
});

test('the public floor is a field, not a formality', () => {
  // The number itself is a product decision and may move; what must not move
  // is that it is more than a podium's worth. A threshold of three publishes
  // exactly the podium-of-three this exists to prevent.
  assert.ok(MIN_PUBLIC_ENTRANTS > 3, 'a threshold of three still publishes a podium');
});

/* ── token composition ──────────────────────────────────────────────── */

test('a part nobody reports is missing, not zero', () => {
  // The live case: the agent reads reasoning tokens from Codex and Copilot but
  // the entry shape does not carry them, so every board would otherwise print
  // "0 reasoning tokens" - which reads as "these models did no thinking".
  const c = composition({ tokens: 100, input: 40, cacheRead: 30, cacheWrite: 10, output: 20 });
  const reasoning = c.parts.find((p) => p.key === 'reasoning');
  assert.equal(reasoning.value, null);
  assert.equal(reasoning.pct, null);
  assert.deepEqual(c.missing, ['reasoning']);

  const zeroed = composition({ tokens: 100, input: 40, cacheRead: 30, cacheWrite: 10, output: 20, reasoning: 0 });
  assert.equal(zeroed.parts.find((p) => p.key === 'reasoning').value, 0,
    'a reported zero is a reported zero and stays one');
  assert.deepEqual(zeroed.missing, []);
});

test('the total is the parts, and what the parts cannot account for is its own band', () => {
  // Codex reports a day's tokens without saying which part they were. That
  // difference is carried rather than folded into a part that did not earn it.
  const c = composition({ tokens: 100, input: 40, cacheRead: 20, cacheWrite: 0, output: 10 });
  assert.equal(c.counted, 70);
  assert.equal(c.reported, 100);
  assert.equal(c.residual, 30);
  assert.equal(c.total, 100, 'the parts plus the residual are the defined total');
  assert.equal(c.overlap, 0);
  assert.equal(c.parts.find((p) => p.key === 'input').pct, 40);
});

test('parts that overlap the headline are reported rather than drawn over it', () => {
  // Codex's `input_tokens` already contains `cached_input_tokens`, and its
  // `output_tokens` already contains `reasoning_output_tokens`. Adding the
  // parts double-counts, and we cannot un-double-count from here - so the
  // disagreement is a number on the page instead of a bar that overflows.
  const c = composition({ tokens: 100, input: 90, cacheRead: 80, cacheWrite: 0, output: 10 });
  assert.equal(c.counted, 180);
  assert.equal(c.overlap, 80);
  assert.equal(c.residual, 0, 'an overlap is not a residual and must not be shown as one');
  assert.equal(c.total, 180, 'the bands are drawn from the parts, which is what the total is');
});

test('a composition of nothing is empty rather than a bar of zeroes', () => {
  const c = composition(null);
  assert.equal(c.total, 0);
  assert.equal(c.residual, 0);
  assert.equal(c.parts.every((p) => p.pct == null), true);
});

/* ── grouping axes ──────────────────────────────────────────────────── */

test('by app is the same measure over a different axis, not a new measure', () => {
  const board = rankGroups([laptop, desktop], { by: 'app', metric: 'tokens' });
  const rows = Object.fromEntries(board.rows.map((r) => [r.key, r]));
  assert.equal(board.rows[0].key, 'claude-code', 'ranked by the chosen measure');
  assert.equal(rows['claude-code'].tokens, 100);
  assert.equal(rows.codex.tokens, 50);
  assert.equal(rows['claude-code'].rank, 1);
  assert.equal(rows.codex.rank, 2);
  // The measure is the one the entrant board offers, read off a group.
  const overall = rankBoard([laptop, desktop], { metric: 'tokens', period: 'all', now: NOW });
  assert.equal(
    board.rows.reduce((a, r) => a + r.tokens, 0),
    overall.rows.reduce((a, r) => a + r.value, 0),
    'the axis re-cuts the same tokens; it does not find new ones',
  );
});

test('by model collapses one model across machines and counts how many reached for it', () => {
  const board = rankGroups([laptop, desktop], { by: 'model', metric: 'tokens' });
  assert.equal(board.rows.length, 1, 'the same model on two machines is one row');
  assert.equal(board.rows[0].tokens, 150);
  assert.equal(board.rows[0].entrants, 2, 'depth and breadth are different findings');
  assert.equal(board.rows[0].reach, 100);
  assert.equal(board.rows[0].sub, 'claude-code');
});

test('a grouping offers only the measures its axis can answer', () => {
  // Nothing in the payload attributes a tool call or an active day to an app
  // or a model. Asking for one falls back to a measure the axis has rather
  // than returning a column of zeroes that look like findings.
  const board = rankGroups([laptop, desktop], { by: 'model', metric: 'toolCalls' });
  assert.equal(board.metric.key, 'tokens');
  assert.ok(board.rows.every((r) => r.value === r.tokens));
});

test('one unpriced contribution makes a grouped total unpriced, and a clash makes it mixed', () => {
  // The same rule `mergeEntries` uses: a sum that silently left a machine out
  // is worse than no sum, and two bases added together are not one number.
  const board = rankGroups([laptop, desktop], { by: 'app', metric: 'spend' });
  const codex = board.rows.find((r) => r.key === 'codex');
  assert.equal(codex.estUSD, null, 'counted but never priced is not $0');
  assert.equal(codex.value, null);
  assert.equal(codex.rank, null, 'an unpriced row scores no place rather than last place');

  const priced = board.rows.find((r) => r.key === 'claude-code');
  assert.equal(priced.estUSD, 1);
  assert.equal(priced.rank, 1);

  const clash = rankGroups(
    [
      { ...laptop, byTool: [{ id: 'x', name: 'x', tokens: 10, estUSD: 1, sessions: 1, costBasis: 'list_price' }] },
      { ...desktop, byTool: [{ id: 'x', name: 'x', tokens: 10, estUSD: 2, sessions: 1, costBasis: 'credits' }] },
    ],
    { by: 'app', metric: 'spend' },
  );
  assert.equal(clash.rows[0].costBasis, 'mixed');
  assert.equal(clash.rows[0].estUSD, 3, 'the sum is allowed, but only while it says what it is');
});

test('a grouping of an empty board is empty rather than a row of zeroes', () => {
  const board = rankGroups([], { by: 'app', metric: 'tokens' });
  assert.deepEqual(board.rows, []);
  assert.equal(board.ranked, 0);
});

/* ── the trending floor ─────────────────────────────────────────────── */

test('a tiny baseline cannot top the trending chart', () => {
  // This is the whole of the fix. A model that moved four thousand tokens last
  // week and nine thousand this week is "up 125%" and belongs nowhere near a
  // chart; OpenRouter's unexplained +521% badges are exactly this shape.
  assert.equal(trendEligible({ tokens: 9_000, sharePct: 40 }), false, 'below the token floor');
  assert.equal(trendEligible({ tokens: 5e9, sharePct: 0.2 }), false, 'below the share floor');
  assert.equal(trendEligible({ tokens: TREND.minTokens, sharePct: TREND.minSharePct }), true,
    'the floor is inclusive - a row that exactly clears it has cleared it');
  assert.equal(trendEligible({}), false, 'nothing at all does not clear a floor');
});

test('both floors are needed, because either alone has a hole', () => {
  // An absolute floor alone lets a large fleet promote what is still noise
  // inside it; a share floor alone lets a fleet with three days of history
  // promote anything at all.
  assert.ok(TREND.minTokens > 0 && TREND.minSharePct > 0);
  assert.equal(trendEligible({ tokens: TREND.minTokens * 1000, sharePct: TREND.minSharePct / 2 }), false);
  assert.equal(trendEligible({ tokens: TREND.minTokens / 2, sharePct: 90 }), false);
});

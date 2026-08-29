import { expect, test } from '@playwright/test'
import { rankBoard, streakOf, tierOf, tierProgress, TREND } from '../src/lib/leaderboard.js'

/* The leaderboard and its share link.
 *
 * Two halves. The ranking is pure, so it is tested as a function - windows,
 * streaks and tiers are arithmetic and deserve arithmetic's kind of test. The
 * rest is tested through the real board with the API stubbed at the network,
 * which is the only way to check the thing that actually matters: that the
 * shared page renders from the public payload and nothing else. */

/* ── the ranking, as arithmetic ──────────────────────────────────────── */

const DAY = 86400e3
const key = (now, back) => {
  const d = new Date(now - back * DAY)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* Midday, so a test never straddles a local midnight while it runs. */
const NOW = new Date(2026, 7, 25, 12, 0, 0).getTime()

const entry = (id, days, totals = {}) => ({
  id,
  name: id,
  totals: { tokens: 0, estUSD: 0, sessions: 0, toolCalls: 0, activeDays: days.length, ...totals },
  models: [],
  byDay: days.map(([back, tokens]) => ({
    date: key(NOW, back), tokens, estUSD: tokens / 1000, sessions: 1, toolCalls: 2, messages: 3,
  })),
})

test.describe('ranking', () => {
  test('a window sums only the days inside it', () => {
    const a = entry('a', [[0, 100], [3, 1000], [40, 999999]])
    const week = rankBoard([a], { metric: 'tokens', period: 'week', now: NOW })
    const month = rankBoard([a], { metric: 'tokens', period: 'month', now: NOW })
    expect(week.rows[0].value).toBe(1100)
    expect(month.rows[0].value).toBe(1100)
    expect(rankBoard([a], { metric: 'tokens', period: 'day', now: NOW }).rows[0].value).toBe(100)
  })

  test('all time trusts the total rather than the 90-day series', () => {
    /* The daily series is capped, so a long-running machine would be
       under-counted if "all time" were a sum of it. */
    const a = entry('a', [[0, 5]], { tokens: 21_000_000_000 })
    const all = rankBoard([a], { metric: 'tokens', period: 'all', now: NOW })
    expect(all.rows[0].value).toBe(21_000_000_000)
  })

  test('a machine with nothing in the window is unranked, not last', () => {
    const board = rankBoard(
      [entry('busy', [[0, 10]]), entry('idle', [[40, 10]])],
      { metric: 'tokens', period: 'week', now: NOW },
    )
    expect(board.rows[0].rank).toBe(1)
    expect(board.rows[1].rank).toBe(null)
    expect(board.ranked).toBe(1)
  })

  test('movement compares this window with the one before it', () => {
    /* `a` was ahead last week and did nothing this week; `b` is the reverse. */
    const a = entry('a', [[8, 500], [9, 500]])
    const b = entry('b', [[1, 900], [10, 1]])
    const board = rankBoard([a, b], { metric: 'tokens', period: 'week', now: NOW })
    const rows = Object.fromEntries(board.rows.map(r => [r.id, r]))
    expect(rows.b.rank).toBe(1)
    expect(rows.b.move).toBe(1)      // was 2nd last week, 1st now
    expect(rows.a.rank).toBe(null)   // nothing at all this week
  })

  test('all time has no previous window, so no movement', () => {
    const board = rankBoard([entry('a', [[0, 1]], { tokens: 5 })], { metric: 'tokens', period: 'all', now: NOW })
    expect(board.rows[0].move).toBe(null)
  })
})

test.describe('streaks', () => {
  test('consecutive days ending today', () => {
    expect(streakOf([0, 1, 2, 3].map(b => ({ date: key(NOW, b), tokens: 1 })), NOW).current).toBe(4)
  })

  test('a day that has not started yet does not break one', () => {
    /* At 9 a.m. nobody has worked today. Counting from yesterday is the
       difference between a streak and a bug people notice every morning. */
    expect(streakOf([1, 2, 3].map(b => ({ date: key(NOW, b), tokens: 1 })), NOW).current).toBe(3)
  })

  test('a gap ends the current run but the longest one is remembered', () => {
    const days = [0, 1, 5, 6, 7, 8].map(b => ({ date: key(NOW, b), tokens: 1 }))
    expect(streakOf(days, NOW)).toEqual({ current: 2, longest: 4 })
  })

  test('a day with no tokens on it is not a day worked', () => {
    const days = [{ date: key(NOW, 0), tokens: 0 }, { date: key(NOW, 1), tokens: 7 }]
    expect(streakOf(days, NOW).current).toBe(1)
  })
})

test.describe('tiers', () => {
  test('the bands are decades of tokens', () => {
    expect(tierOf(0).key).toBe('rookie')
    expect(tierOf(9.9e6).key).toBe('rookie')
    expect(tierOf(1e7).key).toBe('builder')
    expect(tierOf(1e9).key).toBe('veteran')
    expect(tierOf(2.2e10).key).toBe('master')
    expect(tierOf(1e12).key).toBe('legend')
  })

  test('progress is logarithmic, so a band is not all left edge', () => {
    /* Halfway between 1e9 and 1e10 in log terms is ~3.16e9. On a linear
       scale that would read as 24%. */
    expect(Math.round(tierProgress(3.162e9).pct)).toBe(50)
    expect(tierProgress(1e12).next).toBe(null)
  })
})

/* ── the boards, with the API stubbed at the network ─────────────────── */

const SERVER = 'http://127.0.0.1:19999'
const SLUG = 'testslug00000000'

function reading(host, scale) {
  const d = n => ({
    date: key(Date.now(), n), tokens: 1_000_000 * scale, messages: 20, toolCalls: 5, sessions: 1,
    /* Two models on the same day, so an adoption stack has something to
       stack and the residual has something to be a residual of. */
    tokensByModel: { 'claude-opus-5': 600_000 * scale, 'claude-fable-5': 300_000 * scale },
  })
  return {
    host,
    agentVersion: '0.2.0-test',
    collectedAt: new Date().toISOString(),
    metrics: {
      host: { hostname: host, platform: 'Darwin', cpus: 8 },
      processes: [
        { pid: 11, tool: 'claude-code', kind: 'IDE session', headless: false, elapsed: '01:00:00', cmd: '/Users/pat/secret-project/x' },
        { pid: 12, tool: 'claude-code', kind: 'headless', headless: true, elapsed: '00:05:00', cmd: '/Users/pat/secret-project/y' },
      ],
      projects: [{ path: '/Users/pat/secret-project', label: 'secret-project', branch: 'main' }],
      prompts: [{ text: 'the merger memo', project: '/Users/pat' }],
      assistants: [{ id: 'claude-code', name: 'Claude Code', detected: true, supported: true, hasData: true }],
      claude: {
        present: true, totalSessions: 10, totalMessages: 100,
        firstSessionDate: '2026-06-02T00:00:00Z',
        daily: [0, 1, 2].map(d),
        models: [{ model: 'claude-opus-5', input: 1, output: 2 }],
        hours: { 9: 3, 14: 5 },
      },
      usage: {
        available: true,
        pricing: { asOf: '2026-06-24', rates: [] },
        sessions: [],
        allTime: {
          estUSD: 100 * scale, sessions: 10, requests: 500, toolCalls: 40,
          tokens: { in: 1e6 * scale, out: 2e6 * scale, cacheRead: 1e9 * scale, cacheWrite: 1e7 * scale },
        },
        byModel: [{ model: 'claude-opus-5', estUSD: 100 * scale, priced: true, input: 1e6 * scale, output: 2e6 * scale, cacheRead: 1e9 * scale, cacheWrite: 1e7 * scale }],
        byDay: [0, 1, 2].map(n => ({ date: key(Date.now(), n), estUSD: scale })),
        blocks: { current: { requests: 40 * scale, outputTokens: 9000 * scale, open: true, minutesLeft: 120, minutesUsed: 180 } },
      },
    },
  }
}

const HOSTS = [
  ['big-machine', 20],
  ['mid-machine', 5],
  ['small-machine', 1],
]

function overview() {
  return {
    generatedAt: new Date().toISOString(),
    hosts: HOSTS.map(([h]) => ({ host: h, last_seen: new Date().toISOString(), agent_version: '0.2.0-test', ageSeconds: 4, status: 'up' })),
    latest: HOSTS.map(([h, s]) => reading(h, s)),
    endings: [],
    store: { snapshots: 3 },
    machines: [],
  }
}

/* The shape share.rs serves: the whitelist, and nothing that names the work. */
function publicBoard() {
  return {
    share: { slug: SLUG, title: 'Team board', identities: 'alias', createdAt: new Date().toISOString(), views: 3 },
    generatedAt: new Date().toISOString(),
    windowDays: 90,
    pricingAsOf: '2026-06-24',
    hours: { 9: 6, 14: 9 },
    hoursMinMachines: 3,
    totals: { machines: 2, tokens: 3_000_000_000, estUSD: 210 },
    entries: [
      { id: 'aaa', name: 'amber-otter', os: 'Darwin', cores: 8, status: 'up', lastActive: new Date().toISOString(), firstSeen: '2026-06-02', tools: [{ id: 'claude-code', name: 'Claude Code' }], totals: { tokens: 2_000_000_000, output: 3e6, estUSD: 140, sessions: 9, requests: 400, toolCalls: 30, messages: 90, activeDays: 3 }, byTool: [], models: [{ model: 'claude-opus-5', tool: 'claude-code', tokens: 2e9, output: 3e6, estUSD: 140, priced: true }], byDay: [0, 1, 2].map(n => ({ date: key(Date.now(), n), tokens: 5e5, estUSD: 2, sessions: 1, toolCalls: 3, messages: 4, byModel: { 'claude-opus-5': 4e5 } })), running: [{ tool: 'claude-code', kind: 'IDE session', headless: false, model: null, elapsedSeconds: 3600 }], block: { requests: 12, outputTokens: 4000, open: true, minutesLeft: 90, minutesUsed: 210 } },
      { id: 'bbb', name: 'quiet-heron', os: 'Linux', cores: 16, status: 'stale', lastActive: new Date().toISOString(), firstSeen: '2026-07-01', tools: [{ id: 'codex', name: 'Codex CLI' }], totals: { tokens: 1_000_000_000, output: 1e6, estUSD: 70, sessions: 4, requests: 100, toolCalls: 10, messages: 20, activeDays: 2 }, byTool: [], models: [{ model: 'gpt-5.3-codex', tool: 'codex', tokens: 1e9, output: 1e6, estUSD: 0, priced: false }], byDay: [0, 1].map(n => ({ date: key(Date.now(), n), tokens: 2e5, estUSD: 0, sessions: 1, toolCalls: 1, messages: 2, byModel: {} })), running: [], block: null },
    ],
  }
}

/* The board's own API, stubbed. `shares` is mutable so create/revoke can be
   observed rather than merely called. */
async function stubApi(page, { shares = [] } = {}) {
  const state = { shares: [...shares] }
  await page.addInitScript(([url]) => {
    localStorage.setItem('tokenhud_server_url', url)
    localStorage.setItem('tokenhud_api_key', 'test-key')
    localStorage.setItem('tokenhud_theme', 'dark')
  }, [SERVER])

  await page.route(`${SERVER}/api/v1/stream**`, r => r.abort())
  await page.route(`${SERVER}/api/v1/overview`, r =>
    r.fulfill({ json: overview(), headers: { 'access-control-allow-origin': '*' } }))
  await page.route(`${SERVER}/api/v1/public/board**`, r =>
    r.fulfill({ json: publicBoard(), headers: { 'access-control-allow-origin': '*' } }))
  await page.route(`${SERVER}/api/v1/share`, async r => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON() || {}
      state.shares = [{
        slug: SLUG, title: body.title || 'TokenHUD leaderboard',
        identities: body.identities || 'alias',
        createdAt: new Date().toISOString(), revokedAt: null, views: 0, lastView: null,
      }]
      await r.fulfill({ json: { slug: SLUG, ...body, apiUrl: SERVER, reachable: true }, headers: { 'access-control-allow-origin': '*' } })
      return
    }
    await r.fulfill({ json: { shares: state.shares, apiUrl: SERVER, reachable: true }, headers: { 'access-control-allow-origin': '*' } })
  })
  await page.route(`${SERVER}/api/v1/share/revoke`, async r => {
    state.shares = state.shares.map(s => ({ ...s, revokedAt: new Date().toISOString() }))
    await r.fulfill({ json: { ok: true }, headers: { 'access-control-allow-origin': '*' } })
  })
  return state
}

/* The shell, at Token Monitoring — the section it opens on.
   When a cloud backend is configured the CTA opens the sign-in card
   rather than the self-host board, so we click through to local mode. */
async function openBoard(page) {
  await page.goto('/')
  await page.click('.nav__cta')
  /* If the sign-in overlay appears, switch to self-host mode. */
  const selfHost = page.locator('button:text-is("use a local server instead")')
  if (await selfHost.isVisible({ timeout: 2000 }).catch(() => false)) {
    await selfHost.click()
  }
  await expect(page.locator('.adm-root')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.adm-side')).toBeVisible()
}

/* By accessible name, not by text: the root rail is a strip of icons unless
   somebody opens it, so for most of these tests its buttons have no text at
   all. The name is on the button either way. */
const rootItem = (page, name) => page.locator('.adm-root').getByRole('button', { name, exact: true })

/* Open the root rail's labels. Its default is 56px of icons - it is a product
   switcher, not a sidebar - so anything that reads a label or a badge off it
   has to ask for them first, the same way a person would. */
async function expandRoot(page) {
  await page.locator('button.adm-toggle').click()
  await expect(page.locator('.adm-shell')).not.toHaveClass(/adm-shell--rootmini/)
}

/* By heading, not by text: "Connection" also appears in the Live updates
   card's note, and a filter that matched it would pass for the wrong reason. */
const card = (page, name) =>
  page.locator('.bv-card').filter({ has: page.getByRole('heading', { name, exact: true }) })

const subItem = (page, name) => page.locator('.adm-side .adm-item--btn', { hasText: name })

async function openLeaderboard(page, sub) {
  await openBoard(page)
  await rootItem(page, 'Leaderboard').click()
  await expect(page.locator('.adm-side')).toBeVisible()
  if (sub) await subItem(page, sub).click()
  else await expect(page.locator('.lb-table')).toBeVisible()
}

test.describe('root navigation', () => {
  test('two products and a workspace section, as a strip of icons', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    /* Three destinations, and no labels: the rail opens as a 56px product
       switcher beside the machine rail rather than as a second sidebar. */
    await expect(page.locator('.adm-shell')).toHaveClass(/adm-shell--rootmini/)
    await expect(page.locator('.adm-root .adm-root-item')).toHaveCount(3)
    await expect(page.locator('.adm-root .adm-item-text')).toHaveCount(0)
    await expect(rootItem(page, 'Token Monitoring')).toHaveClass(/adm-item--on/)
    await expect(page.locator('.adm-crumb')).toHaveText('Token Monitoring')

    /* Asked for, the labels are there and in that order. */
    await expandRoot(page)
    await expect(page.locator('.adm-root .adm-root-item')).toHaveText([
      /Token Monitoring/, /Leaderboard/, /Integrations/, /Settings/,
    ])
  })

  test('each section brings its own second rail, or none', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    await expect(page.locator('.adm-side .adm-group-label').first()).toHaveText('MACHINES')

    await rootItem(page, 'Leaderboard').click()
    /* A rail of its own - the machines are not what you pick between here. */
    await expect(page.locator('.adm-side .adm-group-label').first()).toHaveText('LEADERBOARD')
    await expect(page.locator('.adm-side .adm-item--btn')).toHaveText([
      /Leaderboard/, /Live/, /Models/, /Demand/,
    ])
    /* …and the board it used to scroll is gone with it: Leaderboard means
       only the leaderboard. */
    await expect(page.locator('#p-overview')).toHaveCount(0)
    await expect(page.locator('#p-machines')).toHaveCount(0)

    /* Settings is one page, so it gets no rail at all. */
    await rootItem(page, 'Settings').click()
    await expect(page.locator('.adm-side')).toHaveCount(0)
    await expect(page.locator('.adm-shell')).toHaveClass(/adm-shell--nosub/)

    await rootItem(page, 'Token Monitoring').click()
    await expect(page.locator('.adm-side .adm-group-label').first()).toHaveText('MACHINES')
    await expect(page.locator('#p-overview')).toBeVisible()
  })

  test('the leaderboard is no longer a row in the machine rail', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    await expect(page.locator('.adm-side')).toContainText('Overview')
    await expect(page.locator('.adm-side .adm-item', { hasText: 'Leaderboard' })).toHaveCount(0)
    await expect(page.locator('#p-leaderboard')).toHaveCount(0)
  })

  test('the machine rail says Machines once', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    /* It said it twice: the group heading over the machine list, and a
       "Machines" row four rows below it in the board's own navigation. Same
       word, same rail, two meanings - which is most of why two rails read as
       one sidebar drawn twice. The heading stays; the row is gone. */
    await expect(page.locator('.adm-side .adm-group-label', { hasText: 'MACHINES' })).toHaveCount(1)
    /* The board's own navigation rows are links; the machine list is not. */
    await expect(page.locator('.adm-side a.adm-item', { hasText: 'Machines' })).toHaveCount(0)
    /* The panel it pointed at is still on the board - only the row went. */
    await expect(page.locator('#p-machines')).toHaveCount(1)
  })

  test('the two rails fold independently, and only one has a Collapse button', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    const shell = page.locator('.adm-shell')

    /* One Collapse control in the whole shell, in the rail that is worth
       folding away. Two footers each offering "Collapse" was the other half
       of why the rails read as duplicates of each other. */
    await expect(page.locator('.adm-collapse')).toHaveCount(1)
    await expect(page.locator('.adm-side .adm-collapse')).toHaveCount(1)

    /* The topbar hamburger is the root rail's, and it opens rather than
       closes: icons are where this rail starts. */
    await expect(shell).toHaveClass(/adm-shell--rootmini/)
    await page.locator('button.adm-toggle').click()
    await expect(shell).not.toHaveClass(/adm-shell--rootmini/)
    await expect(shell).not.toHaveClass(/adm-shell--submini/)
    await expect(page.locator('.adm-root .adm-item-text')).toHaveCount(0)
    /* Collapsed to icons, not gone: it is the only way to change section. */
    await expect(page.locator('.adm-root .adm-root-item')).toHaveCount(4)

    /* The machine rail folds on its own, and leaves the other one alone. */
    await page.locator('.adm-side .adm-collapse').click()
    await expect(shell).toHaveClass(/adm-shell--submini/)
    await expect(shell).not.toHaveClass(/adm-shell--rootmini/)

    await page.locator('button.adm-toggle').click()
    await expect(shell).toHaveClass(/adm-shell--rootmini/)
    await expect(shell).toHaveClass(/adm-shell--submini/)
    /* Collapsed to icons, not gone: it is the only way to change section. */
    await expect(page.locator('.adm-root .adm-root-item')).toHaveCount(3)
  })

  test('the section you were in is where you come back to', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page)
    await page.reload()
    await openBoard(page)
    await expect(page.locator('.lb-table')).toBeVisible()
    await expect(rootItem(page, 'Leaderboard')).toHaveClass(/adm-item--on/)
    await expect(page.locator('.adm-side .adm-group-label').first()).toHaveText('LEADERBOARD')
  })
})

test.describe('the Leaderboard section', () => {
  test('ranks every reporting machine, biggest first', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page)

    const rows = page.locator('.lb-table tbody tr')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('big-machine')
    await expect(rows.nth(1)).toContainText('mid-machine')
    await expect(rows.nth(2)).toContainText('small-machine')
    /* Ordered, and deliberately not crowned. Every entry on this page belongs
       to one account, so a podium here is a competition with a single
       competitor: whichever machine you sit at most takes gold every week, and
       a medal that can only ever say that says nothing. Medals, steps and the
       "#1 of 3" badge belong to the community board, where the entrants are
       different people. This asserts the absence because the absence is the
       decision - a podium reappearing here would be a regression nobody would
       otherwise notice. */
    await expect(page.locator('.lb-podium')).toHaveCount(0)
    /* The fleet at a glance, above the ranking. The stat names the machine
       that did the most work without calling it the winner. */
    await expect(page.locator('.hero-band')).toContainText('3 machines')
    await expect(page.locator('.hero-stat', { hasText: 'Busiest machine' })).toContainText('big-machine')
  })

  test('the machine Token Monitoring is pointed at is marked', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page)
    await expect(page.locator('tr.lb-me')).toContainText('big-machine')
    await expect(page.locator('tr.lb-me .lb-you')).toHaveText('you')
  })

  test('switching metric and window changes what is ranked', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page)
    const first = page.locator('.lb-table tbody tr').first()

    await expect(first.locator('.lb-c-num')).toContainText('B')

    await page.locator('.lb-seg-b', { hasText: 'Est. value' }).click()
    await expect(first.locator('.lb-c-num')).toContainText('$')

    /* "Active days" is a small integer for everyone, which is exactly the
       case where a formatter that assumed billions would look silly. */
    await page.locator('.lb-seg-b', { hasText: 'Active days' }).click()
    await expect(first.locator('.lb-c-num')).toHaveText(/^\d+$/)
  })

  test('the root badge is your place on the board', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    /* As icons the rail carries a dot per badge - enough to say "there is
       something here", which is all 56px can honestly say. */
    await expect(rootItem(page, 'Leaderboard').locator('.adm-root-dot')).toHaveCount(1)

    await expandRoot(page)
    await expect(rootItem(page, 'Leaderboard').locator('.adm-nav-n')).toHaveText('#1')
    await expect(rootItem(page, 'Token Monitoring').locator('.adm-nav-n')).toHaveText('3')
  })
})

test.describe('the Leaderboard pages', () => {
  test('Standings is the ranking and a headline, and nothing else', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page)

    await expect(page.locator('.hero-band h1')).toContainText('tokens')
    await expect(page.locator('.lb-table')).toBeVisible()
    /* Models moved to their own page - this one does not carry them. */
    await expect(page.locator('.bv-card', { hasText: "Share of the fleet's work" })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Export aggregates' })).toHaveCount(0)
  })

  test('Live counts what is running and never says what it is doing', async ({ page }) => {
    await stubApi(page, {})
    await openLeaderboard(page, 'Live')

    /* Two processes per machine, three machines. */
    await expect(page.locator('.hero-band h1')).toHaveText('6 agents running')
    await expect(page.locator('.live-chip').first()).toContainText('claude-code')
    await expect(page.locator('.bv-card', { hasText: 'Machines with something running' })).toBeVisible()
    /* The command lines were in the reading and are not on the page. */
    await expect(page.locator('body')).not.toContainText('secret-project')
  })

  test('Models carries share, reach, cache rate and realised cost', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page, 'Models')

    const table = page.locator('.bv-card', { hasText: "Share of the fleet's work" })
    await expect(table).toBeVisible()
    await expect(table).toContainText('opus-5')
    await expect(table.locator('thead')).toContainText('Cache rate')
    await expect(table.locator('thead')).toContainText('Reach')
    await expect(table.locator('thead')).toContainText('$/M output')
    /* Reach is machines, not a percentage dressed up as one. */
    await expect(table.locator('tbody tr').first()).toContainText('3/3')
    await expect(page.locator('.bv-card', { hasText: 'Adoption, day by day' })).toBeVisible()
    await expect(page.locator('.bv-card', { hasText: 'Trending' })).toBeVisible()
  })

  test('the aggregate export is models and totals, never machines', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page, 'Models')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export aggregates' }).click(),
    ])
    const stream = await download.createReadStream()
    let text = ''
    for await (const chunk of stream) text += chunk
    const report = JSON.parse(text)

    /* Second revision of the shape. A reader that parsed the first one cannot
       parse this one safely - the totals gained their composition, the scope
       gained what it is complete through, and `momentum7d` rows gained the
       flag saying whether they cleared the floor - so the version moved with
       them rather than the fields appearing under a number that promised
       otherwise. */
    expect(report.schema).toBe('tokenhud.fleet-demand/2')
    /* The floor travels with the numbers it filtered, and it is the floor that
       actually did the filtering rather than a second copy typed into the
       export. A trending list whose rule is not in the file is a list that has
       to be taken on trust; a rule retyped beside it is free to drift from the
       one the board ranked by, which is the same dishonesty arriving a release
       later. Read from TREND so this fails the moment they disagree. */
    expect(report.trend.minTokens).toBe(TREND.minTokens)
    expect(report.trend.minSharePct).toBe(TREND.minSharePct)
    expect(report.trend.formula).toBe(TREND.formula)
    expect(report.trend.windowDays).toBe(TREND.days)
    expect(report.scope.machines).toBe(3)
    expect(report.models.length).toBeGreaterThan(0)
    expect(report.models[0]).toHaveProperty('sharePct')
    expect(report.models[0]).toHaveProperty('cacheRatePct')
    /* The whole point: a demand report is about models, so nothing in it
       names a machine, a project or a path. */
    for (const banned of ['big-machine', 'mid-machine', 'small-machine', 'secret-project', '/Users/pat', 'merger']) {
      expect(text).not.toContain(banned)
    }
  })

  test('Demand shows the trend, the day, and how evenly it is spread', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page, 'Demand')

    await expect(page.locator('.hero-band h1')).toContainText('this week')
    await expect(page.locator('.bv-card', { hasText: 'Tokens per day' })).toBeVisible()
    await expect(page.locator('.bv-card', { hasText: 'When the fleet works' })).toBeVisible()
    await expect(page.locator('.bv-card', { hasText: 'Where the demand comes from' })).toBeVisible()
  })

  test('the page you were on inside the Leaderboard is remembered too', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page, 'Demand')
    await page.reload()
    await openBoard(page)
    await rootItem(page, 'Leaderboard').click()
    await expect(subItem(page, 'Demand')).toHaveClass(/adm-item--on/)
    await expect(page.locator('.hero-band h1')).toContainText('this week')
  })
})

test.describe('settings', () => {
  test('shows what this browser is connected to and what of it is public', async ({ page }) => {
    await stubApi(page, {
      shares: [{ slug: SLUG, title: 'Team board', identities: 'alias', createdAt: new Date().toISOString(), revokedAt: null, views: 4, lastView: null }],
    })
    await openBoard(page)
    await rootItem(page, 'Settings').click()

    await expect(page.locator('.adm-head h1')).toHaveText('Settings')
    await expect(card(page, 'Connection')).toContainText(SERVER)
    await expect(card(page, 'Public links')).toContainText('Team board')
    await expect(card(page, 'Public links')).toContainText('4 views')
    await expect(card(page, 'This server')).toContainText('Snapshots')
  })

  test('the navigation switches drive the rails', async ({ page }) => {
    await stubApi(page)
    await openBoard(page)
    await rootItem(page, 'Settings').click()

    /* Icons is where the root rail starts, so this switch is how somebody
       opens it for good rather than how they fold it away. */
    const rootSwitch = page.locator('.set-row', { hasText: 'Section navigation' }).locator('.set-switch')
    await expect(rootSwitch).toHaveText(/Icons only/)
    await rootSwitch.click()
    await expect(page.locator('.adm-shell')).not.toHaveClass(/adm-shell--rootmini/)
    await expect(rootSwitch).toHaveText(/Expanded/)

    /* And it is remembered, which the old encoding could not express once
       "icons" became the default. */
    await page.reload()
    await page.click('.nav__cta')
    await expect(page.locator('.adm-shell')).not.toHaveClass(/adm-shell--rootmini/)
  })

  test('making a link private from settings takes it away', async ({ page }) => {
    await stubApi(page, {
      shares: [{ slug: SLUG, title: 'Team board', identities: 'alias', createdAt: new Date().toISOString(), revokedAt: null, views: 0, lastView: null }],
    })
    await openBoard(page)
    await rootItem(page, 'Settings').click()
    await expect(page.locator('.set-share')).toHaveCount(1)

    await page.locator('.set-share').getByRole('button', { name: 'Make private' }).click()
    await expect(page.locator('.set-share')).toHaveCount(0)
    await expect(card(page, 'Public links')).toContainText('Nothing is public')
  })
})

test.describe('sharing', () => {
  test('the dialog mints a link and says what the link carries', async ({ page }) => {
    await stubApi(page)
    await openLeaderboard(page)

    await page.locator('.lb-share').click()
    const modal = page.locator('.share-modal')
    await expect(modal).toBeVisible()

    /* The promise, in the dialog, before anything is public. */
    await expect(modal.locator('.sh-disc-col--yes')).toContainText('Token counts')
    await expect(modal.locator('.sh-disc-col--no')).toContainText('Project names')
    await expect(modal.locator('.sh-disc-col--no')).toContainText('Prompt text')
    await expect(modal.locator('.sh-disc-col--no')).toContainText('Machine names and hostnames')

    await modal.locator('input.sh-input').first().fill('Team board')
    await modal.getByRole('button', { name: 'Create public link' }).click()

    const link = modal.locator('input.sh-link')
    await expect(link).toBeVisible()
    /* The link has to carry both halves: which board, and which API to ask. */
    await expect(link).toHaveValue(new RegExp(`#/b/${SLUG}\\?api=`))
    await expect(link).toHaveValue(/api=http%3A%2F%2F127\.0\.0\.1%3A19999/)
  })

  test('the preview is the real public payload, fetched with no key', async ({ page }) => {
    let sawKeyOnPublicRead = null
    page.on('request', r => {
      if (r.url().includes('/api/v1/public/board')) {
        sawKeyOnPublicRead = r.headers()['x-tokenhud-key'] ?? null
      }
    })
    await stubApi(page, {
      shares: [{ slug: SLUG, title: 'Team board', identities: 'alias', createdAt: new Date().toISOString(), revokedAt: null, views: 3, lastView: null }],
    })
    await openLeaderboard(page)
    await page.locator('.lb-share').click()

    const rows = page.locator('.sh-preview-rows li')
    await expect(rows.first()).toContainText('amber-otter')
    await expect(rows).toHaveCount(2)
    expect(sawKeyOnPublicRead).toBe(null)
  })

  test('making it private takes the link away', async ({ page }) => {
    await stubApi(page, {
      shares: [{ slug: SLUG, title: 'Team board', identities: 'alias', createdAt: new Date().toISOString(), revokedAt: null, views: 0, lastView: null }],
    })
    await openLeaderboard(page)
    await page.locator('.lb-share').click()
    await expect(page.locator('input.sh-link')).toBeVisible()

    await page.getByRole('button', { name: 'Make private' }).click()
    await expect(page.locator('input.sh-link')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Create public link' })).toBeVisible()
  })
})

test.describe('the shared board', () => {
  const url = `/#/b/${SLUG}?api=${encodeURIComponent(SERVER)}`

  test('renders the leaderboard from the public payload alone', async ({ page }) => {
    await stubApi(page)
    await page.goto(url)

    await expect(page.locator('.pb-title')).toHaveText('Team board')
    await expect(page.locator('.pb-badge')).toContainText('read only')

    const rows = page.locator('.lb-table tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('amber-otter')
    await expect(rows.nth(1)).toContainText('quiet-heron')

    /* Everything, stacked, with jump links - a shared board hides nothing
       behind a tab its reader did not know to press. */
    await expect(page.locator('.pb-section')).toHaveCount(4)
    await expect(page.locator('.pb-jump a')).toHaveText(['Leaderboard', 'Live', 'Models', 'Demand'])

    /* Models are the part that is public on purpose. */
    await expect(page.locator('.pb-main')).toContainText('opus-5')
    await expect(page.locator('.pb-main')).toContainText('gpt-5.3-codex')
    /* Counted, not priced - never a zero dressed up as free. */
    await expect(page.locator('.pb-main')).toContainText('not priced')
  })

  test('carries no admin chrome and asks for no credential', async ({ page }) => {
    const keys = []
    page.on('request', r => { if (r.headers()['x-tokenhud-key']) keys.push(r.url()) })
    await stubApi(page)
    await page.goto(url)
    await expect(page.locator('.lb-table')).toBeVisible()

    await expect(page.locator('.adm-side')).toHaveCount(0)
    await expect(page.locator('.lb-share')).toHaveCount(0)
    await expect(page.locator('.nav__cta')).toHaveCount(0)
    expect(keys).toEqual([])
  })

  test('a withheld hour curve says so rather than showing an empty chart', async ({ page }) => {
    await stubApi(page)
    /* What the server sends for a board too small to publish a day curve. */
    await page.route(`${SERVER}/api/v1/public/board**`, r =>
      r.fulfill({
        json: { ...publicBoard(), hours: null, hoursMinMachines: 3 },
        headers: { 'access-control-allow-origin': '*' },
      }))
    await page.goto(url)
    const card = page.locator('.bv-card').filter({ has: page.getByRole('heading', { name: 'When the fleet works', exact: true }) })
    await expect(card).toContainText('Withheld')
    await expect(card).toContainText('3 machines are reporting')
    /* …and the chart is genuinely absent, not drawn empty. */
    await expect(card.locator('svg.chart')).toHaveCount(0)
  })

  test('a link that is not shared any more explains itself', async ({ page }) => {
    await stubApi(page)
    await page.route(`${SERVER}/api/v1/public/board**`, r =>
      r.fulfill({ status: 404, json: { error: 'no such shared board' }, headers: { 'access-control-allow-origin': '*' } }))
    await page.goto(url)
    await expect(page.locator('.sh-offline h2')).toContainText('not shared any more')
  })

  test('a malformed link falls through to the site rather than a blank page', async ({ page }) => {
    await stubApi(page)
    /* `api` has to be an http(s) origin - a link is a thing people paste. */
    await page.goto(`/#/b/${SLUG}?api=javascript%3Aalert(1)`)
    await expect(page.locator('.hero__display')).toBeVisible()
  })
})

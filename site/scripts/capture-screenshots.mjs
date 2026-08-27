#!/usr/bin/env node
/* Capture fresh screenshots of the TokenHUD board for og.png, board.png,
   and the GitHub social preview. Runs against the dev server with the
   self-host API stubbed so the admin shell renders with real-looking data.

   Usage: npx playwright test --config='' -- node scripts/capture-screenshots.mjs
   Or:    node scripts/capture-screenshots.mjs          (needs playwright installed)
*/

import { dirname, join } from 'path'
import { chromium } from 'playwright'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const DEV_PORT = process.env.PORT || '5176'
const BASE = `http://localhost:${DEV_PORT}`

/* ── mock data: realistic overview payload ─────────────────────────── */
const NOW = new Date().toISOString()
const DAY = 86400e3

function mockOverview() {
  const byDay = Array.from({ length: 47 }, (_, i) => {
    const d = new Date(Date.now() - i * DAY)
    const p = n => String(n).padStart(2, '0')
    const tokens = Math.floor(800000 + Math.random() * 1600000)
    return {
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      tokens,
      estUSD: +(tokens * 0.000004).toFixed(2),
      sessions: Math.floor(1 + Math.random() * 4),
      toolCalls: Math.floor(200 + Math.random() * 800),
      messages: Math.floor(50 + Math.random() * 200),
    }
  })

  return {
    generatedAt: NOW,
    hosts: [
      { host: 'studio-mbp', label: 'studio-mbp', last_seen: NOW, agent_version: '0.2.6', ageSeconds: 12, status: 'up' },
      { host: 'dev-linux', label: 'dev-linux', last_seen: new Date(Date.now() - 3600e3).toISOString(), agent_version: '0.2.6', ageSeconds: 3600, status: 'down' },
    ],
    latest: [
      {
        host: 'studio-mbp',
        agentVersion: '0.2.6',
        collectedAt: NOW,
        metrics: {
          host: { hostname: 'studio-mbp', os: 'Darwin', arch: 'arm64', cpus: 14 },
          claude: {
            sessions: 59,
            messages: 62100,
            toolCalls: 28400,
            activeDays: 47,
            totalInputTokens: 31200000,
            totalOutputTokens: 59700000,
            totalCacheReadTokens: 890000000,
            totalCacheWriteTokens: 2100000,
            estValueUSD: 27400,
            models: [
              { model: 'claude-sonnet-4-20250514', tokens: 41200000, estUSD: 14200 },
              { model: 'claude-opus-4-20250918', tokens: 18400000, estUSD: 9800 },
              { model: 'claude-haiku-4-20250912', tokens: 119000, estUSD: 23 },
            ],
            byDay,
          },
          processes: [
            { pid: 90210, args: 'agent · explore', started: new Date(Date.now() - 7200e3).toISOString() },
            { pid: 90445, args: 'agent · code', started: new Date(Date.now() - 1800e3).toISOString() },
            { pid: 91002, args: 'agent · plan', started: new Date(Date.now() - 600e3).toISOString() },
          ],
          usage: {
            available: true,
            session: { pct: 0.22, resetsAt: new Date(Date.now() + 14400e3).toISOString(), label: 'Session (5h)' },
            weekly: { pct: 0.08, resetsAt: new Date(Date.now() + 432000e3).toISOString(), label: 'Weekly (7 day)' },
            reportedAt: new Date(Date.now() - 300e3).toISOString(),
          },
          assistants: [
            { id: 'claude-code', name: 'Claude Code', hasData: true, supported: true, sessions: 59 },
            { id: 'codex', name: 'Codex CLI', hasData: true, supported: true, sessions: 12 },
            { id: 'cursor', name: 'Cursor', hasData: false, supported: false },
            { id: 'gemini-cli', name: 'Gemini CLI', hasData: false, supported: false },
            { id: 'windsurf', name: 'Windsurf', hasData: false, supported: false },
          ],
          integrations: [
            { id: 'claude-code', name: 'Claude Code', state: 'reading', headline: 'Read by this board.', installed: true, hasData: true, confidence: 'verified', steps: [], where: '~/.claude/projects/**/*.jsonl', fields: 'input, output, cache tokens per message', docs: null },
            { id: 'codex', name: 'Codex CLI', state: 'reading', headline: 'Read by this board.', installed: true, hasData: true, confidence: 'verified', steps: [], where: '~/.codex/sessions/**/*.jsonl', fields: 'input, output tokens per session', docs: null },
            { id: 'copilot-cli', name: 'GitHub Copilot CLI', state: 'reading', headline: 'Read by this board.', installed: true, hasData: true, confidence: 'verified', steps: ['Install the CLI', 'Sign in', 'Use it'], where: '~/.copilot/session-state/', fields: 'tokens per model, premium requests', docs: 'https://docs.github.com' },
            { id: 'devin', name: 'Devin CLI', state: 'reading', headline: 'Read by this board.', installed: true, hasData: true, confidence: 'verified', steps: ['Install: curl -fsSL https://devin.ai/install.sh | sh', 'Sign in: devin login', 'Run a session'], where: '~/.local/share/devin/', fields: 'credits and ACU per session', docs: 'https://docs.devin.ai' },
            { id: 'gemini-cli', name: 'Gemini CLI', state: 'needs-setup', headline: 'Installed. One step on this machine turns its numbers on.', installed: true, hasData: false, confidence: 'documented', steps: ['Open ~/.gemini/settings.json', 'Add telemetry block', 'Run gemini once'], where: '~/.gemini/telemetry.log', fields: 'token counts per API call', docs: 'https://github.com/google-gemini/gemini-cli' },
            { id: 'cline', name: 'Cline', state: 'needs-setup', headline: 'Installed. Per-task tokens tracked by default.', installed: true, hasData: false, confidence: 'documented', steps: [], where: 'VS Code global storage', fields: 'tokensIn, tokensOut, cost', docs: null },
            { id: 'cursor', name: 'Cursor', state: 'api-only', headline: 'Installed here, but it keeps no usage on this machine.', installed: true, hasData: false, confidence: 'documented', steps: [], where: 'API only', fields: 'per-request tokens with team key', docs: null },
            { id: 'windsurf', name: 'Windsurf', state: 'api-only', headline: 'Installed here, but it keeps no usage on this machine.', installed: true, hasData: false, confidence: 'documented', steps: [], where: 'API only', fields: 'credits with team key', docs: null },
          ],
          integrationSummary: { known: 26, reading: 4, ready: 0, needsSetup: 2, apiOnly: 8, installed: 10 },
          governance: { mcp: { servers: 5 }, toolCalls: { allowed: 34 }, permissions: { auto: 12 }, extensions: { count: 19 } },
          codex: { available: true },
          projects: Array.from({ length: 21 }, (_, i) => ({ name: `project-${i + 1}` })),
          daemon: { running: true, pid: 1234, uptime: 432000 },
          prompts: [],
        },
      },
    ],
    endings: [
      { host: 'studio-mbp', pid: 90210, args: 'agent · explore', started: new Date(Date.now() - 9000e3).toISOString(), ended: new Date(Date.now() - 1800e3).toISOString(), noticed_at: NOW, duration: 7200 },
    ],
    store: { snapshots: 4200 },
    machines: [],
  }
}

/* Stubs the self-host API so the board renders with data */
async function stubApi(page) {
  await page.route('**/api/v1/overview', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockOverview()) })
  )
  await page.route('**/api/v1/stream', route =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
  )
  await page.route('**/api/v1/stream-token', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'mock' }) })
  )
  await page.route('**/api/v1/portal-key', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'mock-key' }) })
  )
  /* Block the GitHub release check */
  await page.route('**/api.github.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.2.6' }) })
  )
}

async function capture() {
  const browser = await chromium.launch()
  const { copyFileSync } = await import('fs')

  /* ── 1. Self-host board screenshot (1440x900) ── */
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const page = await ctx.newPage()
  await stubApi(page)

  await page.goto(BASE, { waitUntil: 'networkidle' })
  /* Open the portal — CTA click */
  await page.locator('.hero__actions .btn--primary').click()
  await page.waitForTimeout(500)
  /* If we see the sign-in overlay, click "use a local server instead" */
  const selfHostBtn = page.locator('button:text-is("use a local server instead")')
  if (await selfHostBtn.count()) {
    console.log('Found self-host link, clicking...')
    await selfHostBtn.click()
  }
  /* Wait for the SelfHost admin shell to fully render with data */
  console.log('Waiting for admin shell to appear...')
  await page.locator('.adm-root').waitFor({ timeout: 15000 }).catch(async () => {
    console.log('Admin shell timeout. DOM classes:', await page.evaluate(() =>
      [...document.querySelectorAll('[class]')].slice(0, 30).map(e => e.className).join(' | ')
    ))
  })
  await page.waitForTimeout(2000)

  /* Check if we actually got the admin shell */
  const hasAdmin = await page.locator('.adm-root').count()
  if (hasAdmin > 0) {
    await page.screenshot({ path: join(root, 'public/board.png'), type: 'png' })
    console.log('Captured: public/board.png (admin shell)')
    copyFileSync(join(root, 'public/board.png'), join(root, '..', 'docs/board.png'))
    console.log('Copied:   docs/board.png')
  } else {
    console.log('Admin shell not visible, taking fallback screenshot')
    await page.screenshot({ path: join(root, 'public/board.png'), type: 'png' })
    copyFileSync(join(root, 'public/board.png'), join(root, '..', 'docs/board.png'))
  }

  /* ── 2. OG image (1200x630) ── */
  const ogCtx = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const ogPage = await ogCtx.newPage()
  await stubApi(ogPage)
  await ogPage.goto(BASE, { waitUntil: 'networkidle' })
  const ogCta = ogPage.locator('.hero__actions .btn--primary')
  await ogCta.click()
  await ogPage.waitForTimeout(500)
  const ogSelfHost = ogPage.locator('text=use a local server instead')
  const ogHasSH = await ogSelfHost.count()
  if (ogHasSH) {
    await ogSelfHost.click()
    await ogPage.locator('.adm-root').waitFor({ timeout: 8000 }).catch(() => {})
  }
  await ogPage.waitForTimeout(2500)
  await ogPage.screenshot({ path: join(root, 'public/og-board.png'), type: 'png' })
  console.log('Captured: public/og-board.png (1200x630)')

  await browser.close()
  console.log('Done.')
}

capture().catch(e => { console.error(e); process.exit(1) })

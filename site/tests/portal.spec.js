import { expect, test } from '@playwright/test'

/* The portal overlay, signed out.
 *
 * These tests run without a deployed backend. A checkout that has never
 * deployed has no amplify_outputs.json, so the portal explains itself with
 * the "Portal not deployed" card; a checkout with a sandbox deployed shows
 * the sign-in form. Both are the signed-out portal — the assertions accept
 * either, and the form-specific ones skip when there is no backend. */

const CARD = '.dashboard-card'

async function openPortal(page) {
  await page.click('.nav__cta')
  await expect(page.locator(CARD)).toBeVisible()
}

async function hasAuthForm(page) {
  return (await page.locator(`${CARD} input[aria-label="Email"]`).count()) > 0
}

test.describe('Portal, signed out', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('the nav button opens the portal card', async ({ page }) => {
    await expect(page.locator('.nav__cta')).toHaveText(/Sign in|Open your board/)
    await openPortal(page)
    await expect(page.locator(`${CARD} h2`)).toHaveText(/Sign in|Portal not deployed/)
  })

  test('the hero and CTA-strip buttons open the same card', async ({ page }) => {
    await page.click('.hero__actions .btn--primary')
    await expect(page.locator(CARD)).toBeVisible()
    await page.click('.dashboard-close')
    await expect(page.locator(CARD)).toHaveCount(0)

    await page.locator('.cta-strip .btn--primary').scrollIntoViewIfNeeded()
    await page.click('.cta-strip .btn--primary')
    await expect(page.locator(CARD)).toBeVisible()
  })

  test('Escape and the close button dismiss the overlay', async ({ page }) => {
    await openPortal(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('.dashboard-overlay')).toHaveCount(0)

    await openPortal(page)
    await page.click('.dashboard-close')
    await expect(page.locator('.dashboard-overlay')).toHaveCount(0)
  })

  test('clicking the backdrop dismisses the overlay', async ({ page }) => {
    await openPortal(page)
    await page.locator('.dashboard-overlay').click({ position: { x: 8, y: 8 } })
    await expect(page.locator('.dashboard-overlay')).toHaveCount(0)
  })

  test('sign-in submit stays disabled until both fields are filled', async ({ page }) => {
    await openPortal(page)
    if (!(await hasAuthForm(page))) test.skip(true, 'no backend deployed for this checkout')

    const submit = page.locator(`${CARD} button[type="submit"]`)
    await expect(submit).toBeDisabled()
    await page.fill(`${CARD} input[aria-label="Email"]`, 'someone@example.com')
    await expect(submit).toBeDisabled()
    await page.fill(`${CARD} input[aria-label="Password"]`, 'hunter2hunter2')
    await expect(submit).toBeEnabled()
  })

  test('the sign-up and reset screens are reachable and lead back', async ({ page }) => {
    await openPortal(page)
    if (!(await hasAuthForm(page))) test.skip(true, 'no backend deployed for this checkout')

    await page.getByRole('button', { name: 'Create an account' }).click()
    await expect(page.locator(`${CARD} h2`)).toHaveText('Create your account')
    await page.getByRole('button', { name: 'Sign in' }).last().click()
    await expect(page.locator(`${CARD} h2`)).toHaveText('Sign in')

    await page.getByRole('button', { name: 'Forgot password' }).click()
    await expect(page.locator(`${CARD} h2`)).toHaveText('Reset your password')
    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await expect(page.locator(`${CARD} h2`)).toHaveText('Sign in')
  })

  test('the browser derives the same pairing code as the server and the Lambda', async ({ page }) => {
    /* The third of three implementations. A person is asked to compare the
       code their terminal printed against the code this page shows — so if
       these drift, the portal tells them to refuse a machine that is fine.
       The same vectors are pinned in server/tests/pairing.rs and
       amplify/functions/ingest/protocol.test.mjs; they came from the Rust one. */
    const vectors = [
      ['', 'FRM-2XH'],
      ['a', 'CY4-X6K'],
      ['tokenhud', 'K63-CWT'],
      ['DdI0kK2mBcCLpCoOtdgKrHRVJnUCLZbXDDvKfdG-P9k', 'C3D-3TH'],
      ['x'.repeat(43), 'DMA-8SQ'],
    ]
    const got = await page.evaluate(async (tokens) => {
      const { pairingCode } = await import('/src/lib/enrollment.js')
      return Promise.all(tokens.map(t => pairingCode(t)))
    }, vectors.map(([t]) => t))
    expect(got).toEqual(vectors.map(([, code]) => code))
  })

  test('the minted token has the shape the agent and the Lambda both accept', async ({ page }) => {
    const tokens = await page.evaluate(async () => {
      const { newToken } = await import('/src/lib/enrollment.js')
      return [newToken(), newToken()]
    })
    for (const t of tokens) {
      /* 43 base64url chars: inside the claim endpoint's 20..100 bound, and
         safe after the '#' the agent splits the enrollment link on. */
      expect(t).toHaveLength(43)
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    expect(tokens[0]).not.toEqual(tokens[1])
  })

  test('no credentials survive in localStorage', async ({ page }) => {
    /* The old overlay parked a server URL and API key in localStorage.
       The portal must not: Cognito tokens are Amplify's business, and the
       retired keys should never reappear. */
    await openPortal(page)
    const stale = await page.evaluate(() =>
      ['tokenhud_api_key', 'tokenhud_server_url'].map(k => localStorage.getItem(k)))
    expect(stale).toEqual([null, null])
  })
})

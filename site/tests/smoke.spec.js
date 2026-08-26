import { expect, test } from '@playwright/test'

const BASE = 'http://localhost:5174'

test.describe('Marketing site smoke test', () => {
  test('page loads with no console errors', async ({ page }) => {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))

    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    expect(errors).toEqual([])
  })

  test('all major sections render', async ({ page }) => {
    await page.goto(BASE)

    // hero
    await expect(page.locator('.hero__display')).toContainText('Know what your')
    await expect(page.locator('.hero__sub')).toBeVisible()

    // stats
    await expect(page.locator('.stat__value').first()).toBeVisible()

    // board
    await expect(page.locator('#board')).toBeVisible()
    await expect(page.locator('#board img')).toBeVisible()

    // manifest
    await expect(page.locator('#manifest')).toBeVisible()

    // boundary
    await expect(page.locator('#boundary')).toBeVisible()

    // integrations
    await expect(page.locator('#integrations')).toBeVisible()

    // compare
    await expect(page.locator('#compare')).toBeVisible()
    await expect(page.locator('table.compare')).toBeVisible()

    // pricing
    await expect(page.locator('#pricing')).toBeVisible()

    // faq
    await expect(page.locator('#faq')).toBeVisible()

    // footer
    await expect(page.locator('footer')).toBeVisible()
    await expect(page.locator('footer')).toContainText('Content never does.')
  })

  test('nav links scroll to sections', async ({ page }) => {
    await page.goto(BASE)

    await page.click('.nav__links a[href="#board"]')
    await page.waitForTimeout(500)
    await expect(page.locator('#board')).toBeInViewport()
  })

  test('nav pill contracts on scroll', async ({ page }) => {
    await page.goto(BASE)
    await expect(page.locator('.nav')).not.toHaveClass(/is-scrolled/)

    await page.evaluate(() => window.scrollTo(0, 200))
    await page.waitForTimeout(200)
    await expect(page.locator('.nav')).toHaveClass(/is-scrolled/)
  })

  test('FAQ details expand on click', async ({ page }) => {
    await page.goto(BASE)
    const first = page.locator('.faq-item').first()
    await first.scrollIntoViewIfNeeded()

    // should be collapsed
    await expect(first.locator('.faq-body')).not.toBeVisible()

    // click to expand
    await first.locator('summary').click()
    await expect(first.locator('.faq-body')).toBeVisible()
  })
})

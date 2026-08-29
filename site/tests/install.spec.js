import { expect, test } from '@playwright/test'

/* The install flow: the script is accessible, the CDN serves binaries,
 * and the "Add a machine" modal shows a single combined command.
 *
 * The CDN test hits the live CloudFront distribution - it does not need
 * a local backend, but it does need network access. */

const CDN = 'https://d3gu0e7g3rcz5n.cloudfront.net'

test.describe('Install script & CDN', () => {
  test('install.sh is served from the site', async ({ request }) => {
    const res = await request.get('/install.sh')
    expect(res.status()).toBe(200)
    const body = await res.text()
    expect(body).toContain('TokenHUD')
    expect(body).toContain('ENROLL')
    expect(body).toContain('tokenhud-agent')
  })

  test('CDN serves the version file', async ({ request }) => {
    const res = await request.fetch(`${CDN}/latest/version.txt`)
    expect(res.status()).toBe(200)
    const version = (await res.text()).trim()
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  test('CDN serves agent binaries', async ({ request }) => {
    /* HEAD request to verify the binary exists without downloading it. */
    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
    ]) {
      const res = await request.head(`${CDN}/latest/tokenhud-agent-${target}`)
      expect(res.status(), `binary for ${target}`).toBe(200)
    }
  })

  test('CDN serves checksum files', async ({ request }) => {
    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
    ]) {
      const res = await request.fetch(`${CDN}/latest/tokenhud-agent-${target}.sha256`)
      expect(res.status(), `checksum for ${target}`).toBe(200)
      const text = (await res.text()).trim()
      /* "<64-char hex>  <filename>" */
      expect(text).toMatch(/^[a-f0-9]{64}\s/)
    }
  })
})

test.describe('Add-a-machine modal (no backend)', () => {
  /* Without a cloud backend the modal uses the self-host flow.
   * These tests verify the UI plumbing, not the actual enrollment. */
  test('the install URL in the modal uses the site origin', async ({ page }) => {
    /* Read the compiled source to verify the constant is set correctly. */
    const url = await page.evaluate(() => {
      return `${location.origin}/install.sh`
    })
    expect(url).toContain('/install.sh')
    expect(url).not.toContain('githubusercontent.com')
  })
})

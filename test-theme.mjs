/**
 * Theme toggle tests
 *
 * A. Theme toggle button exists
 * B. Clicking toggle switches between light and dark
 * C. Background colour changes (CSS variable --bg updates)
 * D. Layout is not broken after toggle (key elements still visible)
 * E. Theme persists after page reload (localStorage)
 */

import { makeAssert, runTest, BASE } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–E — Theme toggle', async (page) => {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })

  // A — toggle button (home page: .icon-btn[title*="Switch to"], inside PDFApp: .pdfapp-sb-icon-btn[title*="Switch to"])
  const toggleBtn = await page.$('button[title*="Switch to light"], button[title*="Switch to dark"]')
    || await page.$('button.icon-btn, .pdfapp-theme-toggle, .pdfapp-sb-icon-btn')
  check(!!toggleBtn, 'theme toggle button present')
  if (!toggleBtn) return

  // B — get initial background colour
  const getBg = () => page.evaluate(() => {
    const el = document.documentElement
    return window.getComputedStyle(el).getPropertyValue('--bg').trim()
      || window.getComputedStyle(document.body).backgroundColor
  })

  const bgBefore = await getBg()
  ok(`initial background: "${bgBefore}"`)

  await toggleBtn.click()
  await page.waitForTimeout(300)

  // C — background changed
  const bgAfter = await getBg()
  check(bgBefore !== bgAfter, `background changed on toggle: "${bgBefore}" → "${bgAfter}"`)

  // D — key layout elements still present after toggle (on home/calendar page)
  const layoutOk = await page.evaluate(() => {
    const checks = [
      document.querySelector('button'),
      document.querySelector('.topbar, .app, .cal-sb, h1, main'),
    ]
    return checks.every(Boolean)
  })
  check(layoutOk, 'layout intact after theme toggle')

  // E — toggle back and reload — check it persists
  const bgToggled = bgAfter
  await page.reload({ waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(300)

  const bgAfterReload = await getBg()
  // Theme should persist (stored in localStorage)
  check(bgAfterReload === bgToggled || bgAfterReload !== bgBefore,
    `theme persisted after reload: "${bgAfterReload}"`)
})

process.exit(summary())

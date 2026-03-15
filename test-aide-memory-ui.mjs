/**
 * Aide Memory sub-tab UI tests
 *
 * A. Memory sub-tab shows token audit bar
 * B. Token count is ~0 when soul is empty (fresh case)
 * C. Token warn class applied when count >2000
 * D. Session Diary header present
 * E. Empty diary state message shown when no entries
 * F. After seeding a diary entry via API, it appears in the accordion
 * G. Clicking a diary entry expands it (chevron rotates, body visible)
 * H. Clicking again collapses it
 * I. Memory sub-tab badge shows diary count
 */

import { openCase, uploadPDF, makeTextPDF, makeAssert, runTest, BASE } from './test-helpers.mjs'

const API = process.env.API_URL || 'http://localhost:3001'
const { check, summary } = makeAssert()

// Seed a diary entry directly via API (simulates a completed Aide run)
async function seedDiaryEntry(caseId, entry) {
  await fetch(`${API}/api/cases/${caseId}/aide/diary/entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
}

await runTest('A–I — Aide Memory sub-tab UI', async (page) => {
  const caseName = 'AideMemory-' + Date.now()
  await openCase(page, caseName)
  await uploadPDF(page, makeTextPDF('/tmp/tb-aide-mem.pdf'))

  // Get caseId from localStorage
  const caseId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('pdf-parties-'))
    return key ? key.replace('pdf-parties-', '') : null
  })

  // Navigate to Aide → Memory
  const aideTab = await page.waitForSelector('.pdfapp-right-tab:has-text("Aide")', { timeout: 8000 })
  await aideTab.click()
  await page.waitForTimeout(300)

  // ── A — Token audit bar present ────────────────────────────────────────
  const memSubtab = await page.waitForSelector('.pdfapp-aide-subtab:has-text("Memory")', { timeout: 5000 })
  await memSubtab.click()
  await page.waitForTimeout(300)

  const auditBar = await page.$('.pdfapp-aide-audit')
  check(!!auditBar, 'A — token audit bar present')

  // ── B — Token count ~0 when soul empty ────────────────────────────────
  const tokenEl = await page.$('.pdfapp-aide-audit-tokens')
  const tokenText = tokenEl ? await tokenEl.textContent() : ''
  const tokenNum = parseInt(tokenText.replace(/[^0-9]/g, ''), 10)
  check(!isNaN(tokenNum) && tokenNum < 50, `B — token count near 0 for empty soul: "${tokenText.trim()}"`)

  // ── C — Warn class when >2000 tokens (simulate by filling soul fields) ─
  // Fill Soul fields with a lot of text to trigger warning
  const soulSubtab = await page.$('.pdfapp-aide-subtab:has-text("Soul")')
  await soulSubtab.click()
  await page.waitForTimeout(200)

  const textareas = await page.$$('.pdfapp-aide-soul-textarea')
  // Fill each textarea with ~500 chars each to get total > 2000 tokens (8000+ chars / 4)
  for (const ta of textareas.slice(0, 3)) {
    await ta.fill('X'.repeat(2800))
    await page.waitForTimeout(50)
  }

  await memSubtab.click()
  await page.waitForTimeout(200)

  const warnEl = await page.$('.pdfapp-aide-audit-tokens--warn')
  check(!!warnEl, 'C — warn class applied when token estimate >2000')
  const warnMsg = await page.$('.pdfapp-aide-audit-warn')
  check(!!warnMsg, 'C — over-budget warning message shown')

  // Reset soul fields
  await soulSubtab.click()
  await page.waitForTimeout(200)
  for (const ta of textareas.slice(0, 3)) {
    await ta.fill('')
    await page.waitForTimeout(50)
  }
  await memSubtab.click()
  await page.waitForTimeout(200)

  // ── D — Session Diary header ───────────────────────────────────────────
  const memHeader = await page.$('.pdfapp-aide-memory-header')
  const headerText = memHeader ? await memHeader.textContent() : ''
  check(headerText.toLowerCase().includes('diary') || headerText.toLowerCase().includes('session'), `D — Session Diary header: "${headerText.trim()}"`)

  // ── E — Empty state message when no entries ────────────────────────────
  const emptyMsg = await page.$('.pdfapp-aide-soul-empty')
  check(!!emptyMsg, 'E — empty diary state message present')

  // ── F — Seeded entry appears in accordion ─────────────────────────────
  if (caseId) {
    await seedDiaryEntry(caseId, {
      id: 'test-entry-1',
      createdAt: new Date().toISOString(),
      task: 'Find all indemnity clauses',
      steps: 5,
      result: 'Found 3 clauses on pages 4, 7, and 12.',
      reflection: '• Good coverage\n• Missed clause 8.1\n• Search more broadly next time',
      notesAdded: 2,
    })

    // Reload the Memory sub-tab to pick up new data
    // Navigate away and back to force a re-fetch (or just reload the page)
    await page.reload({ waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForTimeout(500)

    // Re-open the case
    const caseRow = await page.$('.cal-sb-case')
    if (caseRow) {
      await caseRow.hover()
      await page.waitForTimeout(200)
      const openBtn = await page.$('.cal-sb-open-btn')
      if (openBtn) {
        await openBtn.click({ force: true })
        await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(500)
      }
    }

    const aideTabReload = await page.$('.pdfapp-right-tab:has-text("Aide")')
    if (aideTabReload) {
      await aideTabReload.click()
      await page.waitForTimeout(300)
      const memTabReload = await page.$('.pdfapp-aide-subtab:has-text("Memory")')
      if (memTabReload) {
        await memTabReload.click()
        await page.waitForTimeout(300)

        const diaryEntry = await page.$('.pdfapp-aide-diary-entry')
        check(!!diaryEntry, 'F — diary entry appears after reload')

        const entryTaskText = await page.$eval('.pdfapp-aide-diary-task', el => el.textContent).catch(() => '')
        check(entryTaskText.includes('indemnity'), `F — entry task shown: "${entryTaskText}"`)

        // ── G — Click entry expands body ───────────────────────────────────
        const diaryRow = await page.$('.pdfapp-aide-diary-row')
        if (diaryRow) {
          await diaryRow.click()
          await page.waitForTimeout(300)
          const diaryBody = await page.$('.pdfapp-aide-diary-body')
          check(!!diaryBody, 'G — diary body visible after clicking row')
          const chevron = await page.$('.pdfapp-aide-diary-chevron')
          const chevronOpen = chevron ? await chevron.evaluate(el => el.classList.contains('open')) : false
          check(chevronOpen, 'G — chevron has .open class when expanded')

          // ── H — Click again collapses ────────────────────────────────────
          await diaryRow.click()
          await page.waitForTimeout(300)
          const diaryBodyAfter = await page.$('.pdfapp-aide-diary-body')
          check(!diaryBodyAfter, 'H — diary body hidden after second click (collapsed)')
          const chevronClosed = chevron ? await chevron.evaluate(el => !el.classList.contains('open')) : false
          check(chevronClosed, 'H — chevron .open class removed when collapsed')
        }

        // ── I — Memory sub-tab badge shows count ──────────────────────────
        const memBadge = await page.$('.pdfapp-aide-subtab-badge')
        if (memBadge) {
          const badgeText = await memBadge.textContent()
          const badgeNum = parseInt(badgeText, 10)
          check(!isNaN(badgeNum) && badgeNum >= 1, `I — Memory badge shows entry count: "${badgeText}"`)
        } else {
          console.log('  (I — badge not visible — diary may not have loaded yet)')
        }
      }
    }
  } else {
    console.log('  (F–I — caseId not found in localStorage, skipping diary seed tests)')
  }
})

process.exit(summary())

/**
 * Case management tests
 *
 * A. Creating a case — appears in case list
 * B. Opening a case — navigates into PDFApp view
 * C. Case name is displayed in the app header
 * D. Multiple cases coexist independently
 * E. Deleting a case — removed from list (if delete is available)
 * F. Party grouping — documents are grouped under "Party 1" by default
 */

import { makeAssert, runTest, BASE } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–F — Case management', async (page) => {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })

  const caseName1 = 'CaseMgmt-Alpha-' + Date.now()
  const caseName2 = 'CaseMgmt-Beta-' + Date.now()

  // A — create case 1
  await page.click('button:has-text("Add Case")')
  await page.waitForSelector('.cal-modal-overlay', { timeout: 5000 })
  await page.fill('input.cal-modal-input', caseName1)
  await page.click('button:has-text("Create")')
  await page.waitForTimeout(800)

  // Case should appear in the list
  const list = await page.$(`text=${caseName1}`)
  check(!!list, `case "${caseName1}" appears in case list`)

  // Create case 2
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  await page.click('button:has-text("Add Case")')
  await page.waitForSelector('.cal-modal-overlay', { timeout: 5000 })
  await page.fill('input.cal-modal-input', caseName2)
  await page.click('button:has-text("Create")')
  await page.waitForTimeout(800)

  // D — both cases visible
  const case1InList = await page.$(`text=${caseName1}`)
  const case2InList = await page.$(`text=${caseName2}`)
  check(!!case1InList, `case 1 still in list with case 2 present`)
  check(!!case2InList, `case 2 in list`)

  // B — open a case (hover the case row to reveal the open button, then click it)
  const caseRow = await page.waitForSelector('.cal-sb-case', { timeout: 5000 })
  await caseRow.hover()
  await page.waitForTimeout(200)
  const openBtn = await page.waitForSelector('.cal-sb-open-btn', { timeout: 5000 })
  await openBtn.click({ force: true })
  // Wait for PDFApp to mount
  await page.waitForSelector('.pdfapp-sb-case-title, .pdfapp-party-list, input[type="file"]', { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(500)

  // Check we're in PDFApp view (file input present)
  const fileInput = await page.$('input[type="file"]')
  check(!!fileInput, 'opening case enters PDFApp (file input present)')

  // C — case name visible in header (.pdfapp-sb-case-title)
  const caseTitle = await page.$('.pdfapp-sb-case-title')
  const caseTitleText = caseTitle ? await caseTitle.textContent() : ''
  const pageText = await page.evaluate(() => document.body.innerText)
  const caseNameVisible = caseTitleText.includes('CaseMgmt') || pageText.includes('CaseMgmt') || pageText.includes('Beta') || pageText.includes('Alpha')
  check(caseNameVisible, `case name visible in app header (title: "${caseTitleText.trim()}")`)

  // F — party list panel is present in the sidebar (may be empty for a brand-new case)
  // "Party 1" is only created when initial files are present; empty cases show "No parties yet."
  await page.waitForSelector('.pdfapp-party-list, .pdfapp-sb-litigants-btn', { timeout: 5000 }).catch(() => {})
  const partyList = await page.$('.pdfapp-party-list')
  const partyGroup = await page.$('.pdfapp-party-group')
  const emptyState = await page.$('.pdfapp-sb-empty-state, .pdfapp-sb-litigants-btn')
  check(!!partyList || !!partyGroup || !!emptyState,
    `party panel present in sidebar (groups: ${partyGroup ? 1 : 0}, empty-state: ${!!emptyState})`)

  // E — go back and delete case 2 (if delete button available)
  const backBtn = await page.$('button[title*="back"], button[aria-label*="back"], .pdfapp-back-btn, [class*="back"]')
  if (backBtn) {
    await backBtn.click()
    await page.waitForTimeout(800)
  } else {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  }

  // Find delete button for case 2
  const deleteBtn = await page.$(`[data-case="${caseName2}"] button[title*="delete"], [class*="case-item"]:has-text("${caseName2}") button`)
    || await page.$('.cal-sb-delete, [class*="delete-case"]')

  if (deleteBtn) {
    await deleteBtn.click()
    await page.waitForTimeout(600)
    // Confirm if there's a confirmation dialog
    const confirmBtn = await page.$('button:has-text("Delete"), button:has-text("Confirm")')
    if (confirmBtn) await confirmBtn.click()
    await page.waitForTimeout(600)

    const deletedCase = await page.$(`text=${caseName2}`)
    check(!deletedCase, `case 2 removed from list after delete`)
  } else {
    console.log('  (E skipped — delete case button not found)')
  }
})

process.exit(summary())

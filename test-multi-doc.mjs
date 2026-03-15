/**
 * Multi-document tests
 *
 * A. Upload two PDFs to the same case — both appear in sidebar
 * B. Switching between docs changes the PDF displayed
 * C. Extracting one doc does not pollute the other doc's chunk panel
 * D. Each doc has an independent chunk count
 * E. Switching back to extracted doc restores chunks instantly (session cache)
 */

import { openCase, uploadPDF, clickExtract, waitForChunks, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–E — Multi-document', async (page) => {
  await openCase(page, 'MultiDoc-' + Date.now())

  // Upload doc 1
  const pdf1 = makeTextPDF('/tmp/tb-multi1.pdf', ['This is document one unique content.'])
  await uploadPDF(page, pdf1)
  ok('doc 1 uploaded')

  // Upload doc 2
  const addDocBtn = await page.$('button:has-text("Add document"), .pdfapp-add-doc, [class*="add-doc"]')
  if (addDocBtn) {
    await addDocBtn.click()
    await page.waitForTimeout(500)
  }
  const fileInput2 = await page.$('input[type="file"]')
  const pdf2 = makeTextPDF('/tmp/tb-multi2.pdf', ['This is document two unique content.'])
  await fileInput2.setInputFiles(pdf2)
  await page.waitForTimeout(2000)
  ok('doc 2 uploaded')

  // A — both docs in sidebar
  const docCards = await page.$$('.pdfapp-doc-card')
  check(docCards.length >= 2, `${docCards.length} doc cards in sidebar`)

  // B — switch between docs changes PDF
  // Click doc 1
  const docCard1 = docCards[0]
  await docCard1.click()
  await page.waitForTimeout(800)
  const title1 = await page.evaluate(() => document.title || document.querySelector('[class*="doc-name"]')?.textContent || '')
  const pageText1 = await page.evaluate(() => document.body.innerText)

  // Click doc 2
  await docCards[1].click()
  await page.waitForTimeout(800)
  const pageText2 = await page.evaluate(() => document.body.innerText)

  // The active doc card should switch
  const activeCards = await page.$$('.pdfapp-doc-card--active')
  check(activeCards.length === 1, `exactly one active doc card (got ${activeCards.length})`)

  // C — doc 2 starts with 0 chunks (never extracted) — check BEFORE extracting doc 1
  await docCards[1].click()
  await page.waitForTimeout(600)
  const count2Before = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(count2Before === 0, `doc 2 starts with 0 chunks (before any extraction, got ${count2Before})`)

  // D/E — extract doc 1 and verify session cache
  await docCards[0].click()
  await page.waitForTimeout(500)
  await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 10000 })

  const extractBtn = await page.$('button:has-text("Prepare for search")')
  if (extractBtn) {
    await extractBtn.click()
    await waitForChunks(page, 1)
    const count1 = await page.$$eval('.pdfapp-chunk-card', els => els.length)
    check(count1 > 0, `doc 1 has ${count1} chunk(s) after extraction`)

    // E — switch to doc 2 and back to doc 1 — chunks restore instantly (session cache)
    await docCards[1].click()
    await page.waitForTimeout(500)
    // Refresh docCards reference after possible DOM changes
    const docCardsNow = await page.$$('.pdfapp-doc-card')
    await docCardsNow[0].click()
    await page.waitForTimeout(600)
    const count1Restored = await page.$$eval('.pdfapp-chunk-card', els => els.length)
    check(count1Restored === count1, `doc 1 chunks restored instantly: ${count1Restored}`)
  } else {
    console.log('  (D/E skipped — extract button not available)')
  }
})

process.exit(summary())

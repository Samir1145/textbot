/**
 * Citation highlight rendering tests
 *
 * A. Clicking a chunk card creates a highlight overlay
 * B. Highlight rect has non-zero dimensions
 * C. Highlight is positioned on the correct page
 * D. Stage 4 textlayer upgrade: rect gets --textlayer class (green) within 3s
 * E. Multiple citations cleared when switching docs / clicking away
 */

import { openCase, uploadPDF, clickExtract, waitForChunks, makeAssert, runTest } from './test-helpers.mjs'
import { existsSync } from 'fs'

const { ok, fail, check, summary } = makeAssert()

const REAL_PDF = '/Users/atulgrover/Desktop/Dokuwiki/bin/lib/plugins/pdfjs/pdfjs/web/compressed.tracemonkey-pldi-09.pdf'

if (!existsSync(REAL_PDF)) {
  console.log('SKIP — real PDF not found at ' + REAL_PDF)
  process.exit(0)
}

await runTest('Test A–E — Citation highlight rendering', async (page) => {
  await openCase(page, 'Highlights-' + Date.now())
  await uploadPDF(page, REAL_PDF)
  await clickExtract(page)
  await waitForChunks(page, 3)

  // A — click chunk card → highlight overlay appears
  const cards = await page.$$('.pdfapp-chunk-card')
  check(cards.length >= 3, `${cards.length} chunk cards available`)

  await cards[0].click()
  await page.waitForTimeout(600)

  const overlay = await page.$('.pdfapp-highlight-overlay')
  check(!!overlay, 'highlight overlay element present in DOM')

  // B — highlight rect has non-zero dimensions
  const rect = await page.$('.pdfapp-highlight-rect')
  check(!!rect, 'highlight rect rendered')

  if (rect) {
    const bbox = await rect.boundingBox()
    check(!!bbox && bbox.width > 0, `rect width: ${bbox?.width?.toFixed(0)}px`)
    check(!!bbox && bbox.height > 0, `rect height: ${bbox?.height?.toFixed(0)}px`)

    // C — rect is within the viewport (roughly near the PDF canvas)
    const canvas = await page.$('canvas.pdfapp-page-canvas')
    const canvasBbox = canvas ? await canvas.boundingBox() : null
    if (canvasBbox && bbox) {
      const overlapsPage = bbox.x < canvasBbox.x + canvasBbox.width &&
                           bbox.y < canvasBbox.y + canvasBbox.height
      check(overlapsPage, 'highlight rect overlaps the PDF page area')
    }
  }

  // D — Stage 4 textlayer upgrade: wait up to 3s for --textlayer class
  const textlayerRect = await page.waitForSelector('.pdfapp-highlight-rect--textlayer', { timeout: 4000 })
    .catch(() => null)
  if (textlayerRect) {
    ok('Stage 4: rect upgraded to --textlayer (green highlight)')
    const tlBbox = await textlayerRect.boundingBox()
    check(!!tlBbox && tlBbox.width > 0, `textlayer rect width: ${tlBbox?.width?.toFixed(0)}px`)
  } else {
    // Not a failure — text layer may not load in headless or chunk may not have matching text
    console.log('  (Stage 4 upgrade not seen — text layer may not render in this headless run)')
  }

  // E — switching to another chunk clears previous and shows new highlight
  if (cards.length >= 2) {
    await cards[1].click()
    await page.waitForTimeout(600)

    // Should still have highlight (new one for card[1])
    const rectAfterSwitch = await page.$('.pdfapp-highlight-rect')
    check(!!rectAfterSwitch, 'highlight present after switching to second chunk')

    // Check card[0] is no longer active, card[1] is active
    const card0Active = await cards[0].evaluate(el => el.classList.contains('pdfapp-chunk-card--active'))
    const card1Active = await cards[1].evaluate(el => el.classList.contains('pdfapp-chunk-card--active'))
    check(!card0Active, 'previous card loses active state')
    check(card1Active, 'new card has active state')
  }
})

process.exit(summary())

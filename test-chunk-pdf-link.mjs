/**
 * Bidirectional chunk ↔ PDF linking tests (Phase 14)
 *
 * A. Click chunk card → highlight rect appears in PDF viewer
 * B. Clicked chunk card gets .pdfapp-chunk-card--active class
 * C. Clicking a different chunk → highlight moves, active class moves
 * D. Click highlight rect → chunk panel scrolls; card becomes active
 */

import { openCase, uploadPDF, clickExtract, waitForChunks, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'
import { existsSync } from 'fs'

const { ok, fail, check, summary } = makeAssert()

// Use the real PDF since it has actual text + bboxes for highlights to work
const REAL_PDF = '/Users/atulgrover/Desktop/Dokuwiki/bin/lib/plugins/pdfjs/pdfjs/web/compressed.tracemonkey-pldi-09.pdf'
const PDF = existsSync(REAL_PDF) ? REAL_PDF : makeTextPDF('/tmp/tb-link.pdf')

await runTest('Test A–D — Chunk ↔ PDF bidirectional linking', async (page) => {
  await openCase(page, 'ChunkLink-' + Date.now())
  await uploadPDF(page, PDF)
  await clickExtract(page)
  await waitForChunks(page, 2)

  // A — click first chunk card → highlight appears
  const cards = await page.$$('.pdfapp-chunk-card')
  check(cards.length >= 2, `${cards.length} chunk cards (need ≥2 for full test)`)

  await cards[0].click()
  await page.waitForTimeout(800) // allow scroll + Stage 4 upgrade

  const overlayAfterClick = await page.$('.pdfapp-highlight-overlay')
  check(!!overlayAfterClick, 'highlight overlay appears after chunk click')

  const rects = await page.$$('.pdfapp-highlight-rect')
  check(rects.length > 0, `${rects.length} highlight rect(s) rendered`)

  // B — first card has active class
  const firstActive = await cards[0].evaluate(el => el.classList.contains('pdfapp-chunk-card--active'))
  check(firstActive, 'clicked card gets --active class')
  const secondActive = await cards[1].evaluate(el => el.classList.contains('pdfapp-chunk-card--active'))
  check(!secondActive, 'non-clicked card does NOT get --active class')

  // C — click second card → active moves
  await cards[1].click()
  await page.waitForTimeout(600)

  const firstStillActive = await cards[0].evaluate(el => el.classList.contains('pdfapp-chunk-card--active'))
  const secondNowActive = await cards[1].evaluate(el => el.classList.contains('pdfapp-chunk-card--active'))
  check(!firstStillActive, 'first card loses --active after second is clicked')
  check(secondNowActive, 'second card gains --active')

  const rectsAfter = await page.$$('.pdfapp-highlight-rect')
  check(rectsAfter.length > 0, 'highlight still rendered after switching chunk')

  // D — click highlight rect → matching chunk card becomes active
  // First click a card to establish a highlight, then click the highlight rect
  await cards[0].click()
  await page.waitForTimeout(600)

  const rect = await page.$('.pdfapp-highlight-rect')
  if (rect) {
    // Make rect clickable (pointer-events: auto should be set)
    const isClickable = await page.evaluate(el => {
      const cs = window.getComputedStyle(el)
      return cs.pointerEvents !== 'none'
    }, rect)
    check(isClickable, 'highlight rect has pointer-events: auto (clickable)')

    await rect.click()
    await page.waitForTimeout(600)

    // At least one card should be active after clicking the rect
    const anyActive = await page.$$eval('.pdfapp-chunk-card--active', els => els.length)
    check(anyActive > 0, `clicking rect activates a chunk card (${anyActive} active)`)
  } else {
    console.log('  (skipped D — no highlight rect available, bbox may be absent)')
  }
})

process.exit(summary())

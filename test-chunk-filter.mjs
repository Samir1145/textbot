/**
 * Chunk text-filter tests
 *
 * A. Typing in search input filters chunk cards client-side
 * B. Matching text is wrapped in <mark class="pdfapp-chunk-match">
 * C. Clearing search restores all chunks
 * D. No-match state shows empty message with "Enter for semantic" hint
 */

import { openCase, uploadPDF, clickExtract, waitForChunks, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–D — Chunk text filter', async (page) => {
  await openCase(page, 'ChunkFilter-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-filter.pdf'))
  await clickExtract(page)
  await waitForChunks(page, 1)

  const totalCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(totalCards > 0, `baseline: ${totalCards} chunk(s)`)

  const searchInput = await page.$('.pdfapp-chunk-search-input')
  check(!!searchInput, 'search input present')

  // A — filter by a word that exists
  await searchInput.fill('Party')
  await page.waitForTimeout(300)

  const filteredCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(filteredCards <= totalCards, `filter reduces cards: ${filteredCards} ≤ ${totalCards}`)
  check(filteredCards > 0, `at least one match for "Party"`)

  // B — match highlight <mark> present inside visible cards
  const markCount = await page.$$eval('.pdfapp-chunk-match', els => els.length)
  check(markCount > 0, `${markCount} <mark> highlight(s) in filtered results`)

  // Also verify the mark text is the search term (case-insensitive)
  const markText = await page.$eval('.pdfapp-chunk-match', el => el.textContent.toLowerCase()).catch(() => '')
  check(markText === 'party', `mark text is "party", got "${markText}"`)

  // C — clear restores all cards
  await searchInput.fill('')
  await page.waitForTimeout(300)
  const restoredCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(restoredCards === totalCards, `clearing restores all ${totalCards} chunk(s), got ${restoredCards}`)
  const marksAfterClear = await page.$$eval('.pdfapp-chunk-match', els => els.length)
  check(marksAfterClear === 0, 'marks gone after clearing')

  // D — no-match shows empty state with hint
  await searchInput.fill('xyzzy_no_match_ever_12345')
  await page.waitForTimeout(300)
  const noMatchCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(noMatchCards === 0, 'no cards for nonsense query')
  const placeholder = await page.$('.pdfapp-extracted-placeholder')
  check(!!placeholder, 'empty-state placeholder shown')
  const placeholderText = await placeholder.textContent()
  check(placeholderText.toLowerCase().includes('enter') || placeholderText.toLowerCase().includes('filter'),
    `placeholder mentions Enter/filter: "${placeholderText.slice(0, 60)}"`)

  // ✕ button clears
  const clearBtn = await page.$('.pdfapp-chunk-search-clear')
  check(!!clearBtn, '✕ clear button appears when query is set')
  await clearBtn.click()
  await page.waitForTimeout(200)
  const afterClearBtnCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(afterClearBtnCards === totalCards, `✕ button restores all ${totalCards} chunk(s)`)
})

process.exit(summary())

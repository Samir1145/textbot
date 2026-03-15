/**
 * Chunk semantic search tests
 *
 * Requires: RAG embed server + Ollama running (nomic-embed-text loaded).
 * Skipped automatically if the embed server is unreachable.
 *
 * A. Enter key triggers semantic search (spinner → results)
 * B. Results show % score badges
 * C. Results are limited to k results
 * D. No-results message when query matches nothing
 * E. Clearing query restores full chunk list
 */

import { openCase, uploadPDF, extractAndIndex, waitForChunks, makeTextPDF, makeAssert, runTest, BASE } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

// ── Check embed server is reachable ───────────────────────────────────────────
async function embedAvailable() {
  try {
    const res = await fetch('http://localhost:3001/api/health', { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (res?.ok) return true
    // Try ollama directly
    const ol = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) }).catch(() => null)
    return !!ol?.ok
  } catch { return false }
}

if (!(await embedAvailable())) {
  console.log('SKIP — embed server / Ollama not reachable. Start the dev server and Ollama first.')
  process.exit(0)
}

await runTest('Test A–E — Chunk semantic search', async (page) => {
  await openCase(page, 'ChunkSemantic-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-semantic.pdf'))
  await extractAndIndex(page, 1)

  // Wait for indexing to settle
  await page.waitForTimeout(1000)

  const totalCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(totalCards > 0, `baseline: ${totalCards} chunk(s)`)

  const searchInput = await page.$('.pdfapp-chunk-search-input')

  // A — press Enter → semantic search fires
  await searchInput.fill('consulting services agreement')
  await page.waitForTimeout(200)

  // Capture spinner appearance (it's brief so we just check results appear)
  await searchInput.press('Enter')

  // Wait for results (spinner appears then disappears, results load)
  await page.waitForFunction(
    () => {
      const score = document.querySelector('.pdfapp-chunk-tag--score')
      const loading = document.querySelector('.pdfapp-chunk-search-bar .pdfapp-spinner--small')
      return score || (!loading && document.querySelectorAll('.pdfapp-chunk-card').length > 0)
    },
    { timeout: 15000 }
  )

  const scoreBadges = await page.$$('.pdfapp-chunk-tag--score')
  check(scoreBadges.length > 0, `${scoreBadges.length} score badge(s) shown in semantic results`)

  // B — badges show a percentage
  if (scoreBadges.length > 0) {
    const badgeText = await scoreBadges[0].textContent()
    check(badgeText.includes('%'), `score badge shows "%": "${badgeText}"`)
  }

  // C — results ≤ k (default k=10)
  const resultCount = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(resultCount <= 10, `result count (${resultCount}) ≤ k=10`)
  check(resultCount > 0, `at least 1 result for relevant query`)

  // D — no-results message for garbage query
  await searchInput.fill('zzzzznomatch99999xyz')
  await searchInput.press('Enter')
  await page.waitForFunction(
    () => {
      const loading = document.querySelector('.pdfapp-chunk-search-bar .pdfapp-spinner--small')
      return !loading
    },
    { timeout: 15000 }
  )
  await page.waitForTimeout(500)

  const noMatchPlaceholder = await page.$('.pdfapp-extracted-placeholder')
  const noMatchCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  // Either 0 cards or a no-match message
  check(noMatchCards === 0 || !!noMatchPlaceholder, `no-results state for garbage query (cards=${noMatchCards})`)

  // E — clear restores full list
  const clearBtn = await page.$('.pdfapp-chunk-search-clear')
  if (clearBtn) await clearBtn.click()
  else await searchInput.fill('')
  await page.waitForTimeout(300)

  const restoredCards = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  check(restoredCards === totalCards, `clearing restores all ${totalCards} chunk(s), got ${restoredCards}`)
  const scoresAfterClear = await page.$$eval('.pdfapp-chunk-tag--score', els => els.length)
  check(scoresAfterClear === 0, 'score badges gone after clearing')
})

process.exit(summary())

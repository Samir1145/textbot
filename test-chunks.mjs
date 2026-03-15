/**
 * Chunk panel tests — Phase 15 (Option C: search + note-from-chunk)
 *
 * Tests:
 *  A. Native text PDF → chunks appear after extraction, search bar present
 *  B. Real multi-page PDF (tracemonkey) → multiple chunks
 *  C. Reload persistence — chunks load from saved extraction
 *  D. Layout — search bar + body heights are sane
 *
 * Usage:  node test-chunks.mjs [--base http://localhost:5173]
 */

import { chromium } from 'playwright'
import { writeFileSync, existsSync } from 'fs'

const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i !== -1 ? process.argv[i + 1] : 'http://localhost:5173'
})()

const REAL_PDF = '/Users/atulgrover/Desktop/Dokuwiki/bin/lib/plugins/pdfjs/pdfjs/web/compressed.tracemonkey-pldi-09.pdf'

// ── Minimal contract PDF ─────────────────────────────────────────────────────
function makeTextPDF(path = '/tmp/test-chunks-text.pdf') {
  const lines = [
    'Contract between Party A and Party B dated January 2024.',
    'This agreement governs the terms and conditions of service.',
    'Party A agrees to provide consulting services as described herein.',
    'Party B shall pay the agreed fee within thirty days of invoice.',
    'Both parties agree to maintain confidentiality of all shared information.',
    'This contract shall remain in force for a period of twelve months.',
  ]
  const content = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td (${l}) Tj ET`).join('\n')
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length ${content.length}>>
stream
${content}
endstream
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000274 00000 n
0000000352 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
800
%%EOF`
  writeFileSync(path, pdf)
  return path
}

// ── Shared helpers ───────────────────────────────────────────────────────────
async function newBrowser() {
  return chromium.launch({ headless: true })
}

async function openCase(page, name) {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  await page.click('button:has-text("Add Case")')
  await page.waitForSelector('.cal-modal-overlay', { timeout: 5000 })
  await page.fill('input.cal-modal-input', name)
  await page.click('button:has-text("Create")')
  await page.waitForTimeout(800)
  await page.waitForSelector('.cal-sb-open-btn', { timeout: 5000 })
  await page.click('.cal-sb-open-btn')
  await page.waitForTimeout(1000)
}

async function uploadPDF(page, pdfPath) {
  const fi = await page.$('input[type="file"]')
  if (!fi) throw new Error('file input not found')
  await fi.setInputFiles(pdfPath)
  await page.waitForTimeout(2000)
  await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 20000 })
}

async function clickExtract(page) {
  // Button text varies depending on RAG/extraction state
  await page.waitForSelector(
    'button:has-text("Prepare for search"), button:has-text("Re-scan pages")',
    { timeout: 8000 }
  )
  await page.click('button:has-text("Prepare for search"), button:has-text("Re-scan pages")')
}

async function waitForChunks(page, minCount = 1, timeout = 30000) {
  await page.waitForFunction(
    n => document.querySelectorAll('.pdfapp-chunk-card').length >= n,
    minCount,
    { timeout }
  )
}

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0

function ok(msg)   { console.log(`  ✓ ${msg}`); passed++ }
function fail(msg, detail = '') { console.error(`  ✗ ${msg}${detail ? ' — ' + detail : ''}`); failed++ }

async function runTest(label, fn) {
  console.log(`\n${label}`)
  const browser = await newBrowser()
  try {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const jsErrors = []
    page.on('pageerror', e => jsErrors.push(e.message))
    await fn(page)
    const realErrors = jsErrors.filter(e => !e.includes('indexing failed') && !e.includes('ERR_FILE_NOT_FOUND'))
    if (realErrors.length) console.warn('  JS errors:', realErrors)
  } catch (err) {
    fail('test threw', err.message)
  } finally {
    await browser.close()
  }
}

// ── A: Native text PDF ────────────────────────────────────────────────────
await runTest('Test A — Native text PDF, fresh extraction', async (page) => {
  await openCase(page, 'ChunksA-' + Date.now())
  await uploadPDF(page, makeTextPDF())
  await clickExtract(page)
  await waitForChunks(page, 1)

  const count = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  const hasSearchBar = await page.$('.pdfapp-chunk-search-bar') !== null
  const headerText = await page.$eval('.pdfapp-chunk-count', el => el.textContent).catch(() => '')

  count > 0 ? ok(`${count} chunk card(s) rendered`) : fail('no chunk cards')
  hasSearchBar ? ok('search bar present') : fail('search bar missing')
  headerText.includes('chunks') ? ok(`header: "${headerText}"`) : fail('chunk count header missing')
})

// ── B: Real multi-page PDF ────────────────────────────────────────────────
if (existsSync(REAL_PDF)) {
  await runTest('Test B — Real multi-page PDF (tracemonkey)', async (page) => {
    await openCase(page, 'ChunksB-' + Date.now())
    await uploadPDF(page, REAL_PDF)
    await clickExtract(page)
    await waitForChunks(page, 5, 35000)

    const count = await page.$$eval('.pdfapp-chunk-card', els => els.length)
    count >= 5 ? ok(`${count} chunks rendered`) : fail(`only ${count} (expected ≥5)`)

    const rect = await page.$eval('.pdfapp-chunk-card', el => {
      const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }
    }).catch(() => null)
    rect && rect.h > 0 ? ok(`first card h=${rect.h.toFixed(0)}px`) : fail('first card not visible')
  })
} else {
  console.log('\nTest B — skipped (tracemonkey PDF not found at ' + REAL_PDF + ')')
}

// ── C: Reload persistence ─────────────────────────────────────────────────
await runTest('Test C — Chunk persistence after page reload', async (page) => {
  await openCase(page, 'ChunksC-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/test-chunks-c.pdf'))
  await clickExtract(page)
  await waitForChunks(page, 1)
  const before = await page.$$eval('.pdfapp-chunk-card', els => els.length)

  // Reload and reopen the same case
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(500)
  const reopenBtn = await page.$('.cal-sb-open-btn')
  if (reopenBtn) { await reopenBtn.click(); await page.waitForTimeout(2000) }

  const after = await page.$$eval('.pdfapp-chunk-card', els => els.length)
  after >= before
    ? ok(`${after} chunks after reload (was ${before})`)
    : fail(`chunks dropped: ${before} → ${after}`)
})

// ── D: Layout dimensions ──────────────────────────────────────────────────
await runTest('Test D — Layout: panel, search bar, body heights', async (page) => {
  await openCase(page, 'ChunksD-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/test-chunks-d.pdf'))
  await clickExtract(page)
  await waitForChunks(page, 1)

  const dims = await page.evaluate(() => {
    const get = sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { h: Math.round(r.height), w: Math.round(r.width) }
    }
    return {
      panel:     get('.pdfapp-extracted-panel'),
      header:    get('.pdfapp-extracted-header'),
      searchBar: get('.pdfapp-chunk-search-bar'),
      body:      get('.pdfapp-chunks-body'),
      card:      get('.pdfapp-chunk-card'),
    }
  })

  dims.panel     ? ok(`panel     ${dims.panel.h}px`)     : fail('extracted-panel not found')
  dims.searchBar ? ok(`searchBar ${dims.searchBar.h}px`) : fail('search bar missing')
  dims.body && dims.body.h >= 40
    ? ok(`body      ${dims.body.h}px`)
    : fail(`body too small: ${dims.body?.h}px`)
  dims.card && dims.card.h > 0
    ? ok(`card      ${dims.card.h}px`)
    : fail('chunk card not visible')

  // Search bar + header + drag should leave room for body
  if (dims.panel && dims.searchBar && dims.header) {
    const remaining = dims.panel.h - dims.header.h - dims.searchBar.h - 6 /* drag */
    remaining >= 40
      ? ok(`remaining body space: ${remaining}px`)
      : fail(`too little body space: ${remaining}px`)
  }
})

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`)
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

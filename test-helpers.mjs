/**
 * Shared test helpers for TextBot Playwright tests.
 * Import from any test file:  import { openCase, uploadPDF, ... } from './test-helpers.mjs'
 */

import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

export const BASE = process.env.BASE_URL || 'http://localhost:5173'
export const REAL_PDF = '/Users/atulgrover/Desktop/Dokuwiki/bin/lib/plugins/pdfjs/pdfjs/web/compressed.tracemonkey-pldi-09.pdf'

// ── PDF generators ────────────────────────────────────────────────────────────

export function makeTextPDF(path = '/tmp/tb-text.pdf', extraLines = []) {
  const lines = [
    'Contract between Party A and Party B dated January 2024.',
    'This agreement governs the terms and conditions of service.',
    'Party A agrees to provide consulting services as described herein.',
    'Party B shall pay the agreed fee within thirty days of invoice.',
    'Both parties agree to maintain confidentiality of all shared information.',
    'This contract shall remain in force for a period of twelve months.',
    ...extraLines,
  ]
  const cmds = lines.map((l, i) => `BT /F1 11 Tf 50 ${750 - i * 18} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')
  _writePDF(path, cmds)
  return path
}

export function makeMultiPagePDF(path = '/tmp/tb-multi.pdf', numPages = 3) {
  // Build a PDF with numPages pages, each with distinct text
  const pageObjs = []
  for (let i = 1; i <= numPages; i++) {
    pageObjs.push(`Page ${i}: This is the content of page number ${i} in the document.`)
  }
  // Simple single-page approach — encode all "pages" as paragraphs on one page
  const cmds = pageObjs.map((t, i) => `BT /F1 11 Tf 50 ${750 - i * 30} Td (${t}) Tj ET`).join('\n')
  _writePDF(path, cmds)
  return path
}

function _writePDF(path, streamContent) {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length ${streamContent.length}>>
stream
${streamContent}
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
}

// ── Browser / page helpers ────────────────────────────────────────────────────

export async function newPage(opts = {}) {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  if (opts.logConsoleErrors !== false) {
    page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })
  }
  page._tb_browser = browser
  page._tb_errors = errors
  return page
}

export async function closePage(page) {
  await page._tb_browser.close()
}

export function jsErrors(page, { ignorePatterns = ['indexing failed', 'ERR_FILE_NOT_FOUND', 'embed'] } = {}) {
  return (page._tb_errors || []).filter(e => !ignorePatterns.some(p => e.includes(p)))
}

// ── App navigation ────────────────────────────────────────────────────────────

export async function openCase(page, name) {
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

export async function uploadPDF(page, pdfPath) {
  const fi = await page.$('input[type="file"]')
  if (!fi) throw new Error('file input not found — are you inside a case?')
  await fi.setInputFiles(pdfPath)
  await page.waitForTimeout(2000)
  await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 20000 })
}

export async function clickExtract(page) {
  const btn = await page.waitForSelector(
    'button:has-text("Prepare for search"), button:has-text("Re-scan pages")',
    { timeout: 8000 }
  )
  await btn.click()
}

export async function waitForChunks(page, minCount = 1, timeout = 30000) {
  await page.waitForFunction(
    n => document.querySelectorAll('.pdfapp-chunk-card').length >= n,
    minCount,
    { timeout }
  )
}

export async function extractAndIndex(page, minChunks = 1) {
  await clickExtract(page)
  await waitForChunks(page, minChunks)
  // Also wait for indexing to complete (Index button disappears or ragStatus changes)
  await page.waitForFunction(
    () => !document.querySelector('button:has-text("Index for search")'),
    { timeout: 30000 }
  ).catch(() => {}) // ok if indexing was already done / not triggered
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

export function makeAssert() {
  let passed = 0, failed = 0
  function ok(msg)         { console.log(`  ✓ ${msg}`); passed++ }
  function fail(msg, det)  { console.error(`  ✗ ${msg}${det ? ' — ' + det : ''}`); failed++ }
  function check(cond, msg, det) { cond ? ok(msg) : fail(msg, det) }
  function summary() {
    console.log(`\n${'─'.repeat(40)}`)
    console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`)
    return failed
  }
  return { ok, fail, check, summary, get passed() { return passed }, get failed() { return failed } }
}

export async function runTest(label, fn) {
  console.log(`\n${label}`)
  const page = await newPage()
  let threw = false
  try {
    await fn(page)
  } catch (err) {
    console.error(`  ✗ test threw: ${err.message}`)
    threw = true
  } finally {
    const errs = jsErrors(page)
    if (errs.length) console.warn('  JS errors:', errs)
    await closePage(page)
  }
  return !threw
}

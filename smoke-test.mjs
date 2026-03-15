/**
 * Playwright smoke test — creates a case, uploads a PDF, verifies canvas renders.
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://localhost:5173'

function createMinimalPDF() {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>
stream
BT /F1 24 Tf 100 700 Td (Hello World) Tj ET
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
446
%%EOF`
  const path = '/tmp/test-smoke.pdf'
  writeFileSync(path, pdf)
  return path
}

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const jsErrors = []
  page.on('pageerror', e => jsErrors.push(e.message))

  console.log('► Opening app…')
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })

  // ── Step 1: Open "New Case" modal ──
  console.log('► Clicking + Add Case…')
  await page.click('button:has-text("Add Case")')
  await page.waitForSelector('.cal-modal-overlay', { timeout: 5000 })

  // Fill case name inside modal
  await page.fill('input.cal-modal-input', 'Smoke Test Case')

  // Click Create
  await page.click('button:has-text("Create")')
  await page.waitForTimeout(800)
  await page.screenshot({ path: '/tmp/smoke-01-case-created.png' })
  console.log('  screenshot: /tmp/smoke-01-case-created.png')

  // ── Step 2: Click → (cal-sb-open-btn) to open the case ──
  console.log('► Opening case…')
  await page.waitForSelector('.cal-sb-open-btn', { timeout: 5000 })
  await page.click('.cal-sb-open-btn')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: '/tmp/smoke-02-case-opened.png' })
  console.log('  screenshot: /tmp/smoke-02-case-opened.png')

  await page.screenshot({ path: '/tmp/smoke-03-pdf-app.png' })
  console.log('  screenshot: /tmp/smoke-03-pdf-app.png')

  // ── Step 3: Upload PDF ──
  const fileInput = await page.$('input[type="file"]')
  if (!fileInput) {
    console.error('  ✗ No file input — not in PDFApp')
    await browser.close()
    process.exit(1)
  }

  const pdfPath = createMinimalPDF()
  console.log('► Uploading PDF…')
  await fileInput.setInputFiles(pdfPath)
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/smoke-04-uploaded.png' })
  console.log('  screenshot: /tmp/smoke-04-uploaded.png')

  // ── Step 4: Check canvas appears ──
  console.log('► Waiting for canvas (pageCount > 0)…')
  try {
    await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 20000 })
    console.log('  ✓ canvas.pdfapp-page-canvas in DOM')
  } catch {
    console.error('  ✗ canvas never appeared — pageCount stayed null')
    await page.screenshot({ path: '/tmp/smoke-fail.png' })
    console.log('  screenshot: /tmp/smoke-fail.png')

    // Extra diagnostics
    const pdfLoading = await page.$('.pdfapp-center-placeholder--inline')
    const pdfError   = await page.$('.pdfapp-center-placeholder:not(.pdfapp-center-placeholder--inline)')
    if (pdfLoading) console.log('  pdfLoading spinner still visible')
    if (pdfError)   console.log(`  pdfError: "${await pdfError.textContent()}"`)
    await browser.close()
    process.exit(1)
  }

  // ── Step 5: Check canvas is painted ──
  console.log('► Waiting for canvas to be painted by render worker…')
  try {
    await page.waitForFunction(
      () => document.querySelector('canvas.pdfapp-page-canvas')?.dataset.rendered === 'true',
      { timeout: 20000 }
    )
    console.log('  ✓ Canvas painted (dataset.rendered=true)')
  } catch {
    const rendered = await page.$eval('canvas.pdfapp-page-canvas', c => c.dataset.rendered).catch(() => 'N/A')
    console.error(`  ✗ Canvas not painted — dataset.rendered="${rendered}"`)
    await page.screenshot({ path: '/tmp/smoke-fail-paint.png' })
    console.log('  screenshot: /tmp/smoke-fail-paint.png')
  }

  await page.screenshot({ path: '/tmp/smoke-final.png' })
  console.log('  Final screenshot: /tmp/smoke-final.png')

  if (jsErrors.length) {
    console.warn(`  ⚠ JS errors:\n${jsErrors.map(e => '    ' + e).join('\n')}`)
  } else {
    console.log('  ✓ No JS errors')
  }

  await browser.close()
  console.log('► Done.')
}

run().catch(err => { console.error(err); process.exit(1) })

/**
 * Test: chunk guide modal opens when ··· is clicked
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
  const path = '/tmp/test-modal.pdf'
  writeFileSync(path, pdf)
  return path
}

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', e => console.error('  JS error:', e.message))

  console.log('► Opening app…')
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })

  // Create case
  console.log('► Creating case…')
  await page.click('button:has-text("Add Case")')
  await page.waitForSelector('.cal-modal-overlay', { timeout: 5000 })
  await page.fill('input.cal-modal-input', 'Modal Test Case')
  await page.click('button:has-text("Create")')
  await page.waitForTimeout(800)

  // Open case
  await page.waitForSelector('.cal-sb-open-btn', { timeout: 5000 })
  await page.click('.cal-sb-open-btn')
  await page.waitForTimeout(1000)

  // Upload PDF
  const fileInput = await page.$('input[type="file"]')
  await fileInput.setInputFiles(createMinimalPDF())
  await page.waitForTimeout(2000)

  // Wait for canvas
  await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 20000 })
  console.log('  ✓ PDF loaded')

  // Look for the ··· button
  console.log('► Looking for ··· button…')
  await page.screenshot({ path: '/tmp/modal-test-01-before.png' })
  console.log('  screenshot: /tmp/modal-test-01-before.png')

  const menuBtn = await page.$('button.pdfapp-action-btn--menu')
  if (!menuBtn) {
    console.error('  ✗ ··· button not found in DOM')
    await browser.close()
    process.exit(1)
  }
  console.log('  ✓ ··· button found')

  // Click it
  console.log('► Clicking ··· button…')
  await menuBtn.click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/modal-test-02-after-click.png' })
  console.log('  screenshot: /tmp/modal-test-02-after-click.png')

  // Check overlay rendered
  const overlay = await page.$('.pdfapp-guide-overlay')
  if (!overlay) {
    console.error('  ✗ .pdfapp-guide-overlay not found — modal did not open')
    await browser.close()
    process.exit(1)
  }
  console.log('  ✓ .pdfapp-guide-overlay present')

  const modal = await page.$('.pdfapp-guide-modal')
  if (!modal) {
    console.error('  ✗ .pdfapp-guide-modal not found')
    await browser.close()
    process.exit(1)
  }
  console.log('  ✓ .pdfapp-guide-modal present')

  // Check it's actually visible (not clipped)
  const box = await modal.boundingBox()
  console.log(`  Modal bounding box: ${JSON.stringify(box)}`)
  if (!box || box.width === 0 || box.height === 0) {
    console.error('  ✗ Modal has zero size — likely clipped/hidden')
    await browser.close()
    process.exit(1)
  }
  console.log('  ✓ Modal is visible with size', `${box.width}x${box.height}`)

  // Check title text
  const title = await page.textContent('.pdfapp-guide-title')
  console.log(`  Modal title: "${title}"`)

  // Check close button works
  console.log('► Clicking close button…')
  await page.click('.pdfapp-guide-close')
  await page.waitForTimeout(300)
  const gone = await page.$('.pdfapp-guide-overlay')
  if (gone) {
    console.error('  ✗ Modal still visible after close')
  } else {
    console.log('  ✓ Modal closed successfully')
  }

  await page.screenshot({ path: '/tmp/modal-test-03-closed.png' })
  console.log('  screenshot: /tmp/modal-test-03-closed.png')

  await browser.close()
  console.log('► Done.')
}

run().catch(err => { console.error(err); process.exit(1) })

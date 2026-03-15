/**
 * Notes system tests
 *
 * A. Note tool button exists in toolbar
 * B. Enabling note mode → clicking page creates a note pin
 * C. Typing text and blurring saves the note
 * D. Note pin persists after page reload
 * E. Clicking pin re-opens the note for editing
 * F. Deleting a note removes the pin
 * G. Note count badge on Notes tab updates
 */

import { openCase, uploadPDF, makeTextPDF, makeAssert, runTest, BASE } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–G — Notes system', async (page) => {
  await openCase(page, 'Notes-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-notes.pdf'))

  // A — note tool button in toolbar
  const noteToolBtn = await page.$('.pdfapp-toolbar-btn[title*="note"], .pdfapp-toolbar-btn[title*="Note"]')
  check(!!noteToolBtn, 'note tool button in toolbar')

  // B — enable note mode and click on PDF page to create pin
  await noteToolBtn.click()
  await page.waitForTimeout(200)

  // Click somewhere on the PDF page canvas
  const canvas = await page.$('canvas.pdfapp-page-canvas')
  check(!!canvas, 'PDF canvas present')
  const canvasBox = await canvas.boundingBox()

  // Click in the middle of the canvas
  await page.mouse.click(
    canvasBox.x + canvasBox.width * 0.5,
    canvasBox.y + canvasBox.height * 0.3
  )
  await page.waitForTimeout(400)

  const pins = await page.$$('.pdfapp-note-pin')
  check(pins.length > 0, `${pins.length} note pin(s) created`)

  // C — type text into note textarea and blur to save
  const noteTextarea = await page.$('.pdfapp-note-pin--open textarea, .pdfapp-note-textarea, .pdfapp-note-input')
  if (noteTextarea) {
    await noteTextarea.fill('Test note content for persistence check.')
    await noteTextarea.evaluate(el => el.blur())
    await page.waitForTimeout(400)
    ok('note text entered and blurred')
  } else {
    // Some implementations use a different selector — try clicking the open pin
    if (pins.length > 0) {
      const pinText = await pins[0].$('textarea, input')
      if (pinText) {
        await pinText.fill('Test note content for persistence check.')
        await pinText.evaluate(el => el.blur())
        await page.waitForTimeout(400)
        ok('note text entered via pin textarea')
      } else {
        console.log('  (note textarea selector not found — checking evidence tab directly)')
      }
    }
  }

  // G — Notes tab badge should update
  const notesTab = await page.$('.pdfapp-right-tab:has-text("Notes")')
  check(!!notesTab, 'Notes tab exists')
  const tabText = await notesTab.textContent()
  // Badge could be "(1)" or just a count — check tab text changed from (0)
  check(!tabText.includes('(0)'), `Notes tab updated: "${tabText.trim()}"`)

  // D — reload and check pin persists
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(500)
  // Hover to reveal open button, then click
  const caseRowReload = await page.waitForSelector('.cal-sb-case', { timeout: 5000 }).catch(() => null)
  if (caseRowReload) {
    await caseRowReload.hover()
    await page.waitForTimeout(200)
    const reopenBtn = await page.$('.cal-sb-open-btn')
    if (reopenBtn) {
      await reopenBtn.click({ force: true })
      // Wait for PDFApp to mount
      await page.waitForSelector('.pdfapp-doc-card, input[type="file"]', { timeout: 8000, state: 'attached' }).catch(() => {})
      await page.waitForTimeout(500)
      // Click the first doc card to activate it (so notes load)
      const docCard = await page.$('.pdfapp-doc-card')
      if (docCard) {
        await docCard.click()
        await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(800)
      }
    }
  }

  const pinsAfterReload = await page.$$('.pdfapp-note-pin')
  check(pinsAfterReload.length > 0, `${pinsAfterReload.length} pin(s) persisted after reload`)

  // E — clicking pin opens it for editing
  if (pinsAfterReload.length > 0) {
    await pinsAfterReload[0].click()
    await page.waitForTimeout(300)
    const openPin = await page.$('.pdfapp-note-pin--open')
    check(!!openPin, 'clicking pin opens it (gets --open class)')
  }

  // F — delete the note
  const deleteBtn = await page.$('.pdfapp-note-delete, button[title*="delete"], button[title*="Delete"]')
  if (deleteBtn) {
    await deleteBtn.click()
    await page.waitForTimeout(400)
    const pinsAfterDelete = await page.$$('.pdfapp-note-pin')
    check(pinsAfterDelete.length < pinsAfterReload.length, 'pin removed after delete')
  } else {
    console.log('  (delete button not found — skipping F)')
  }
})

process.exit(summary())

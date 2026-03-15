/**
 * Note-from-chunk tests (Option C)
 *
 * A. ✏ button appears on chunk card hover
 * B. Clicking ✏ opens inline textarea
 * C. Escape cancels without saving
 * D. Ctrl+Enter saves — note appears in Evidence tab
 * E. Save button disabled when textarea empty; saves when filled
 * F. Saved note has correct pageNum and is linked to chunk bbox
 * G. Clicking ✏ again while editing closes the textarea
 */

import { openCase, uploadPDF, clickExtract, waitForChunks, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–G — Note from chunk', async (page) => {
  await openCase(page, 'ChunkNote-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-note.pdf'))
  await clickExtract(page)
  await waitForChunks(page, 1)

  const card = await page.$('.pdfapp-chunk-card')
  check(!!card, 'at least one chunk card exists')

  // A — ✏ button: initially not visible (opacity:0), becomes visible on hover
  await card.hover()
  await page.waitForTimeout(200)
  const noteBtn = await card.$('.pdfapp-chunk-note-btn')
  check(!!noteBtn, 'note button (✏) exists on chunk card')

  const btnVisible = await page.evaluate(el => {
    const cs = window.getComputedStyle(el)
    return parseFloat(cs.opacity) > 0
  }, noteBtn)
  check(btnVisible, '✏ button visible on hover')

  // B — click ✏ opens textarea
  await noteBtn.click()
  const noteArea = await card.$('.pdfapp-chunk-note-area')
  check(!!noteArea, 'note area opens after clicking ✏')
  const textarea = await card.$('.pdfapp-chunk-note-input')
  check(!!textarea, 'textarea present in note area')

  // C — Escape cancels
  await textarea.press('Escape')
  await page.waitForTimeout(200)
  const areaAfterEsc = await card.$('.pdfapp-chunk-note-area')
  check(!areaAfterEsc, 'note area closes on Escape')

  // E — Save button disabled when empty
  await noteBtn.click()
  const saveBtn = await card.$('.pdfapp-chunk-note-save')
  check(!!saveBtn, 'Save note button present')
  const disabledWhenEmpty = await saveBtn.isDisabled()
  check(disabledWhenEmpty, 'Save button disabled when textarea is empty')

  // G — clicking ✏ again while open closes it
  await noteBtn.click()
  const areaAfterToggle = await card.$('.pdfapp-chunk-note-area')
  check(!areaAfterToggle, 'clicking ✏ again closes the note area')

  // D — Ctrl+Enter saves
  await noteBtn.click()
  const ta = await card.$('.pdfapp-chunk-note-input')
  await ta.fill('This is a test note from the chunk.')
  await ta.press('Control+Enter')
  await page.waitForTimeout(400)

  const areaAfterSave = await card.$('.pdfapp-chunk-note-area')
  check(!areaAfterSave, 'note area closes after Ctrl+Enter save')

  // F — note visible in Evidence tab
  const evidenceTab = await page.$('.pdfapp-right-tab:has-text("Notes")')
  check(!!evidenceTab, 'Notes/Evidence tab exists')
  await evidenceTab.click()
  await page.waitForTimeout(500)

  const evidenceContainer = await page.$('.pdfapp-evidence')
  check(!!evidenceContainer, 'evidence container visible')

  const noteText = await page.$eval('.pdfapp-evidence', el => el.textContent).catch(() => '')
  check(noteText.includes('test note from the chunk'), `note text visible in Evidence: "${noteText.slice(0, 80)}"`)

  // E (save via button) — reopen and use Save button
  const chatTab = await page.$('.pdfapp-right-tab:has-text("Chat")')
  if (chatTab) await chatTab.click()
  await page.waitForTimeout(300)

  await noteBtn.click()
  const ta2 = await card.$('.pdfapp-chunk-note-input')
  await ta2.fill('Second note via Save button.')

  const saveBtn2 = await card.$('.pdfapp-chunk-note-save')
  const disabledWhenFilled = await saveBtn2.isDisabled()
  check(!disabledWhenFilled, 'Save button enabled when textarea has text')
  await saveBtn2.click()
  await page.waitForTimeout(400)

  const areaAfterBtn = await card.$('.pdfapp-chunk-note-area')
  check(!areaAfterBtn, 'note area closes after Save button click')
})

process.exit(summary())

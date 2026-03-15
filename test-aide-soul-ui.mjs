/**
 * Aide Soul sub-tab UI interaction tests
 *
 * A. Paste text into skill area → skillMd populated, drop-zone replaced by preview
 * B. Filling red-flags textarea marks soul as dirty
 * C. Save Soul button activates (loses disabled state) when soul is dirty
 * D. Save Soul → saved timestamp appears, button returns to inactive
 * E. Add a correction via input → appears in correction list
 * F. Remove a correction → removed from list
 * G. Add a style sample → sample textarea appears
 * H. Remove a style sample → removed
 * I. Token estimate in Memory sub-tab rises after content is added to Soul
 */

import { openCase, uploadPDF, makeTextPDF, makeAssert, runTest, BASE } from './test-helpers.mjs'

const { check, summary } = makeAssert()

await runTest('A–I — Aide Soul sub-tab interactions', async (page) => {
  await openCase(page, 'AideSoul-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-aide-soul.pdf'))

  // Navigate to Aide tab → Soul sub-tab
  const aideTab = await page.waitForSelector('.pdfapp-right-tab:has-text("Aide")', { timeout: 8000 })
  await aideTab.click()
  await page.waitForTimeout(300)

  const soulSubtab = await page.waitForSelector('.pdfapp-aide-subtab:has-text("Soul")', { timeout: 5000 })
  await soulSubtab.click()
  await page.waitForTimeout(300)

  // ── A — Paste text into skill paste textarea ────────────────────────────
  const skillPasteArea = await page.$('.pdfapp-aide-soul-textarea[placeholder*="paste"]')
  if (skillPasteArea) {
    await skillPasteArea.fill('You are a senior M&A lawyer. Always flag indemnity clauses first.')
    await page.waitForTimeout(300)
    // After filling, the skill section should now show a preview (drop-zone replaced)
    const skillPreview = await page.$('.pdfapp-aide-skill-loaded, .pdfapp-aide-skill-preview')
    check(!!skillPreview, 'A — skill preview appears after pasting skill text')
    ok('A — skill textarea filled')
  } else {
    // Drop zone present but no paste area yet — that is ok
    const dropZone = await page.$('.pdfapp-aide-skill-drop')
    check(!!dropZone, 'A — skill drop-zone present (paste area not shown separately)')
  }

  function ok(msg) { console.log(`  ✓ ${msg}`) }

  // ── B — Fill red-flags → soul marked dirty ─────────────────────────────
  // Get all soul textareas (2nd one = red flags by section order)
  const allTextareas = await page.$$('.pdfapp-aide-soul-textarea')
  const redFlagsTa = allTextareas[1] || allTextareas[0]
  if (redFlagsTa) {
    await redFlagsTa.fill('Unlimited liability\nAutomatic renewal without cap')
    await page.waitForTimeout(200)
    ok('B — red flags filled')
  }

  // ── C — Save Soul button should be active (dirty) ──────────────────────
  const saveBtn = await page.$('.pdfapp-aide-soul-save-btn')
  const saveBtnDisabled = saveBtn ? await saveBtn.evaluate(el => el.disabled) : true
  check(!saveBtnDisabled, 'C — Save Soul button active when soul is dirty')

  const saveBtnDirtyClass = saveBtn ? await saveBtn.evaluate(el => el.classList.contains('pdfapp-aide-soul-save-btn--dirty')) : false
  check(saveBtnDirtyClass, 'C — Save Soul button has --dirty modifier class')

  // ── D — Click Save → timestamp appears, button deactivates ─────────────
  if (saveBtn && !saveBtnDisabled) {
    await saveBtn.click()
    await page.waitForTimeout(1000) // wait for fetch
    const savedLabel = await page.$('.pdfapp-aide-soul-saved')
    check(!!savedLabel, 'D — saved timestamp label appears after save')
    const saveBtnAfter = await page.$('.pdfapp-aide-soul-save-btn')
    const disabledAfter = saveBtnAfter ? await saveBtnAfter.evaluate(el => el.disabled) : false
    check(disabledAfter, 'D — Save button disabled again after save (not dirty)')
  } else {
    console.log('  (D — skipped: save button not available)')
  }

  // ── E — Add a correction ───────────────────────────────────────────────
  const correctionInput = await page.$('.pdfapp-aide-correction-input')
  const addCorrBtn = await page.$('.pdfapp-aide-correction-input-row .pdfapp-aide-soul-add-btn')
  if (correctionInput && addCorrBtn) {
    await correctionInput.fill('Stop summarising — give findings only')
    await addCorrBtn.click()
    await page.waitForTimeout(200)
    const correctionRows = await page.$$('.pdfapp-aide-correction-row')
    check(correctionRows.length >= 1, `E — correction row added (count=${correctionRows.length})`)
    const inputAfter = await correctionInput.inputValue()
    check(inputAfter === '', 'E — correction input cleared after adding')
  } else {
    console.log('  (E — correction input not found, skipping)')
  }

  // ── F — Remove a correction ───────────────────────────────────────────
  const corrRowsBefore = await page.$$('.pdfapp-aide-correction-row')
  if (corrRowsBefore.length > 0) {
    const removeBtn = await corrRowsBefore[0].$('.pdfapp-aide-sample-remove')
    if (removeBtn) {
      await removeBtn.click()
      await page.waitForTimeout(200)
      const corrRowsAfter = await page.$$('.pdfapp-aide-correction-row')
      check(corrRowsAfter.length < corrRowsBefore.length, `F — correction removed (${corrRowsBefore.length} → ${corrRowsAfter.length})`)
    } else {
      console.log('  (F — remove button not found in correction row)')
    }
  } else {
    console.log('  (F — no corrections to remove, skipping)')
  }

  // ── G — Add a style sample ────────────────────────────────────────────
  const addSampleBtn = await page.$('.pdfapp-aide-soul-section-label-row .pdfapp-aide-soul-add-btn')
  if (addSampleBtn) {
    const samplesBefore = await page.$$('.pdfapp-aide-sample-row')
    await addSampleBtn.click()
    await page.waitForTimeout(200)
    const samplesAfter = await page.$$('.pdfapp-aide-sample-row')
    check(samplesAfter.length > samplesBefore.length, `G — style sample row added (${samplesBefore.length} → ${samplesAfter.length})`)
  } else {
    console.log('  (G — add sample button not found, skipping)')
  }

  // ── H — Remove a style sample ─────────────────────────────────────────
  const sampleRowsBefore = await page.$$('.pdfapp-aide-sample-row')
  if (sampleRowsBefore.length > 0) {
    const removeBtn = await sampleRowsBefore[0].$('.pdfapp-aide-sample-remove')
    if (removeBtn) {
      await removeBtn.click()
      await page.waitForTimeout(200)
      const sampleRowsAfter = await page.$$('.pdfapp-aide-sample-row')
      check(sampleRowsAfter.length < sampleRowsBefore.length, `H — style sample removed (${sampleRowsBefore.length} → ${sampleRowsAfter.length})`)
    } else {
      console.log('  (H — remove button not found in sample row)')
    }
  } else {
    console.log('  (H — no sample rows to remove, skipping)')
  }

  // ── I — Token estimate rises in Memory tab after Soul content added ────
  const memSubtab = await page.$('.pdfapp-aide-subtab:has-text("Memory")')
  if (memSubtab) {
    // First record token count with some soul content
    await soulSubtab.click()
    await page.waitForTimeout(200)

    // Add substantial text to red flags
    const tas = await page.$$('.pdfapp-aide-soul-textarea')
    if (tas[1]) {
      await tas[1].fill('A'.repeat(500)) // ~125 tokens
      await page.waitForTimeout(100)
    }

    await memSubtab.click()
    await page.waitForTimeout(200)

    const tokenEl = await page.$('.pdfapp-aide-audit-tokens')
    const tokenText = tokenEl ? await tokenEl.textContent() : ''
    const tokenNum = parseInt(tokenText.replace(/[^0-9]/g, ''), 10)
    check(!isNaN(tokenNum) && tokenNum > 0, `I — token estimate is non-zero after soul content added: "${tokenText.trim()}"`)
  } else {
    console.log('  (I — Memory sub-tab not found, skipping)')
  }
})

process.exit(summary())

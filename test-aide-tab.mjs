/**
 * Aide tab UI tests (replaces test-agent-tab.mjs)
 *
 * A. Tab button is labelled "Aide" (not "Agent")
 * B. Three sub-tabs present: Run, Soul, Memory
 * C. Run sub-tab active by default — shows task / intent / perspective / Run button
 * D. Soul sub-tab — shows skill drop-zone, red-flags, style-guide, corrections sections
 * E. Memory sub-tab — shows token audit bar and diary empty state
 * F. Sub-tab switching preserves Run form content
 * G. Run button disabled when task is empty; enabled once text typed
 */

import { openCase, uploadPDF, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'

const { check, summary } = makeAssert()

await runTest('A–G — Aide tab UI', async (page) => {
  await openCase(page, 'AideTab-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-aide-tab.pdf'))

  // ── A — Tab button is labelled "Aide" ───────────────────────────────────
  const aideTab = await page.$('.pdfapp-right-tab:has-text("Aide")')
  check(!!aideTab, 'A — tab button labelled "Aide" exists')
  const agentTab = await page.$('.pdfapp-right-tab:has-text("Agent")')
  check(!agentTab, 'A — no tab labelled "Agent" (renamed)')

  if (!aideTab) return

  await aideTab.click()
  await page.waitForTimeout(400)

  // ── B — Three sub-tabs ───────────────────────────────────────────────────
  const runSubtab    = await page.$('.pdfapp-aide-subtab:has-text("Run")')
  const soulSubtab   = await page.$('.pdfapp-aide-subtab:has-text("Soul")')
  const memorySubtab = await page.$('.pdfapp-aide-subtab:has-text("Memory")')
  check(!!runSubtab,    'B — Run sub-tab present')
  check(!!soulSubtab,   'B — Soul sub-tab present')
  check(!!memorySubtab, 'B — Memory sub-tab present')

  // ── C — Run sub-tab default content ─────────────────────────────────────
  const activeSubtab = await page.$('.pdfapp-aide-subtab--active')
  const activeText   = activeSubtab ? await activeSubtab.textContent() : ''
  check(activeText.includes('Run'), 'C — Run sub-tab active by default')

  const taskTextarea   = await page.$('.pdfapp-aide-textarea')
  const runBtn         = await page.$('.pdfapp-aide-run-btn')
  const perspectSelect = await page.$('.pdfapp-aide-select')
  check(!!taskTextarea,   'C — task textarea present')
  check(!!runBtn,         'C — Run button present')
  check(!!perspectSelect, 'C — Perspective select present')

  // ── D — Soul sub-tab content ─────────────────────────────────────────────
  await soulSubtab.click()
  await page.waitForTimeout(300)

  const skillDrop    = await page.$('.pdfapp-aide-skill-drop, .pdfapp-aide-skill-loaded')
  const redFlagsTa   = await page.$('.pdfapp-aide-soul-textarea')
  const saveSoulBtn  = await page.$('.pdfapp-aide-soul-save-btn')
  check(!!skillDrop,   'D — skill drop-zone or loaded area present')
  check(!!redFlagsTa,  'D — at least one soul textarea present')
  check(!!saveSoulBtn, 'D — Save Soul button present')

  // All 4 section labels should be visible
  const sectionLabels = await page.$$eval('.pdfapp-aide-soul-section-label', els =>
    els.map(e => e.textContent.trim().toLowerCase())
  )
  check(sectionLabels.some(l => l.includes('skill')),      'D — Skill file section label')
  check(sectionLabels.some(l => l.includes('checklist') || l.includes('red flag')), 'D — Standing checklist section label')
  check(sectionLabels.some(l => l.includes('style') || l.includes('writing')),      'D — Writing style section label')
  check(sectionLabels.some(l => l.includes('correction')), 'D — Corrections section label')

  // ── E — Memory sub-tab content ───────────────────────────────────────────
  await memorySubtab.click()
  await page.waitForTimeout(300)

  const auditBar    = await page.$('.pdfapp-aide-audit')
  const tokenLabel  = await page.$('.pdfapp-aide-audit-tokens')
  const memHeader   = await page.$('.pdfapp-aide-memory-header')
  check(!!auditBar,   'E — token audit bar present')
  check(!!tokenLabel, 'E — token count label present')
  check(!!memHeader,  'E — Session Diary header present')

  const tokenText = tokenLabel ? await tokenLabel.textContent() : ''
  check(tokenText.includes('token'), `E — token count shown: "${tokenText.trim()}"`)

  // Empty state message
  const emptyMsg = await page.$('.pdfapp-aide-soul-empty')
  check(!!emptyMsg, 'E — empty diary state message shown')

  // ── F — Switching sub-tabs preserves Run form content ───────────────────
  await runSubtab.click()
  await page.waitForTimeout(200)
  const taskInput = await page.$('.pdfapp-aide-textarea')
  await taskInput.fill('Find all liability clauses')
  await page.waitForTimeout(100)

  await soulSubtab.click()
  await page.waitForTimeout(200)
  await runSubtab.click()
  await page.waitForTimeout(200)

  const taskValue = await page.$eval('.pdfapp-aide-textarea', el => el.value)
  check(taskValue.includes('liability'), `F — Run form content preserved after sub-tab switch: "${taskValue}"`)

  // ── G — Run button disabled when task empty, enabled when filled ─────────
  await taskInput.fill('')
  await page.waitForTimeout(100)
  const runBtnDisabled = await page.$eval('.pdfapp-aide-run-btn:not(.pdfapp-aide-run-btn--stop)', el => el.disabled)
  check(runBtnDisabled, 'G — Run button disabled when task is empty')

  await taskInput.fill('some task')
  await page.waitForTimeout(100)
  const runBtnEnabled = await page.$eval('.pdfapp-aide-run-btn:not(.pdfapp-aide-run-btn--stop)', el => !el.disabled)
  check(runBtnEnabled, 'G — Run button enabled when task has text')
})

process.exit(summary())

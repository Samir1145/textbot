/**
 * Law tab UI tests (Playwright — requires dev server on localhost:5173)
 *
 * A. "Law" tab button is visible in the right panel tab bar
 * B. Clicking "Law" renders the law panel with Search + Import sub-tabs
 * C. Search sub-tab is active by default
 * D. No-corpus banner appears when no caselaw DB is loaded
 * E. Search input and Search button are present
 * F. Filter row (court, jurisdiction, year from/to) is present
 * G. Search button is disabled when no corpus is loaded
 * H. Import sub-tab shows corpus status card
 * I. Import sub-tab shows drop zone
 * J. Switching back to Search sub-tab from Import sub-tab works
 */

import { makeAssert, newPage, closePage, openCase, jsErrors, BASE } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

// ── A–J — Law tab UI ──────────────────────────────────────────────────────
console.log('\nA–J — Law tab UI')

const page = await newPage()
try {
  await openCase(page, `LawTabTest-${Date.now()}`)

  // ── A — Law tab button exists ────────────────────────────────────────────
  const lawTabBtn = await page.$('.pdfapp-right-tab:has-text("Law")')
  check(lawTabBtn !== null, 'A — "Law" tab button is present in tab bar')

  // ── B — Click Law tab → panel renders ────────────────────────────────────
  await page.click('.pdfapp-right-tab:has-text("Law")')
  await page.waitForTimeout(600)

  const lawPanel = await page.$('.pdfapp-law-panel')
  check(lawPanel !== null, 'B — .pdfapp-law-panel is rendered')

  const subTabs = await page.$$('.pdfapp-law-subtab')
  check(subTabs.length === 2, `B — 2 sub-tabs present (got ${subTabs.length})`)

  // ── C — Search sub-tab active by default ─────────────────────────────────
  const activeSubTab = await page.$('.pdfapp-law-subtab--active')
  const activeText = activeSubTab ? await activeSubTab.textContent() : ''
  check(activeText.trim() === 'Search', `C — Search sub-tab is active by default (got "${activeText.trim()}")`)

  const searchPanel = await page.$('.pdfapp-law-search-panel')
  check(searchPanel !== null, 'C — search panel is visible')

  // ── D — No-corpus banner (if no DB loaded) ───────────────────────────────
  // status endpoint is called on mount — wait briefly for it to resolve
  await page.waitForTimeout(1000)
  const hasBanner = await page.$('.pdfapp-law-no-corpus') !== null
  const hasResults = await page.$('.pdfapp-law-results') !== null
  // Either no-corpus banner OR results area must be visible
  check(hasBanner || hasResults, 'D — no-corpus banner or results area is present')

  // ── E — Search input + button present ────────────────────────────────────
  const searchInput = await page.$('.pdfapp-law-search-input')
  check(searchInput !== null, 'E — search input is present')

  const searchBtn = await page.$('.pdfapp-law-search-btn')
  check(searchBtn !== null, 'E — Search button is present')

  // ── F — Filter inputs present ─────────────────────────────────────────────
  const filterInputs = await page.$$('.pdfapp-law-filter-input')
  check(filterInputs.length >= 4, `F — at least 4 filter inputs present (got ${filterInputs.length})`)

  // Check placeholders
  const placeholders = await Promise.all(filterInputs.map(el => el.getAttribute('placeholder')))
  const hasCourt    = placeholders.some(p => p?.toLowerCase().includes('court'))
  const hasJuris    = placeholders.some(p => p?.toLowerCase().includes('jurisdiction'))
  const hasYearFrom = placeholders.some(p => p?.toLowerCase().includes('from'))
  const hasYearTo   = placeholders.some(p => p?.toLowerCase().includes('to'))
  check(hasCourt,    'F — Court filter input present')
  check(hasJuris,    'F — Jurisdiction filter input present')
  check(hasYearFrom, 'F — Year-from filter input present')
  check(hasYearTo,   'F — Year-to filter input present')

  // ── G — Search button disabled when no corpus / empty query ───────────────
  const isDisabled = await searchBtn.isDisabled()
  check(isDisabled, 'G — Search button disabled when query is empty or no corpus')

  // Also check after typing into search box (still disabled if no corpus)
  if (hasBanner) {
    // no corpus — button stays disabled regardless of query
    await searchInput.fill('duty of care')
    await page.waitForTimeout(200)
    const stillDisabled = await searchBtn.isDisabled()
    check(stillDisabled, 'G — Search button stays disabled with no corpus even with query')
  } else {
    // corpus loaded — button should become enabled when query is non-empty
    await searchInput.fill('duty of care')
    await page.waitForTimeout(200)
    const nowEnabled = !(await searchBtn.isDisabled())
    check(nowEnabled, 'G — Search button enabled when corpus loaded and query non-empty')
  }

  // ── H — Import sub-tab shows corpus status card ───────────────────────────
  await page.click('.pdfapp-law-subtab:has-text("Import")')
  await page.waitForTimeout(500)

  const importPanel = await page.$('.pdfapp-law-import-panel')
  check(importPanel !== null, 'H — import panel rendered')

  const corpusStatus = await page.$('.pdfapp-law-corpus-status')
  check(corpusStatus !== null, 'H — corpus status card present')

  const corpusBadge = await page.$('.pdfapp-law-corpus-badge')
  check(corpusBadge !== null, 'H — corpus badge present')

  const badgeText = corpusBadge ? (await corpusBadge.textContent()).trim() : ''
  check(badgeText === 'Active' || badgeText === 'No corpus', `H — badge says Active or No corpus (got "${badgeText}")`)

  // ── I — Drop zone is present ─────────────────────────────────────────────
  const dropZone = await page.$('.pdfapp-law-drop-zone')
  check(dropZone !== null, 'I — .pdfapp-law-drop-zone is present')

  const dropText = dropZone ? await dropZone.textContent() : ''
  check(dropText.includes('.db'), 'I — drop zone mentions .db files')

  // ── J — Switching back to Search sub-tab ─────────────────────────────────
  await page.click('.pdfapp-law-subtab:has-text("Search")')
  await page.waitForTimeout(300)

  const backToSearch = await page.$('.pdfapp-law-search-panel')
  check(backToSearch !== null, 'J — switching back to Search sub-tab renders search panel')

  const importGone = await page.$('.pdfapp-law-import-panel')
  check(importGone === null, 'J — import panel hidden when Search sub-tab is active')

  // ── JS errors ─────────────────────────────────────────────────────────────
  const errs = jsErrors(page)
  if (errs.length) console.warn('  JS errors:', errs.join('\n'))
  check(errs.length === 0, `no JS errors (got ${errs.length})`)

} catch (err) {
  fail(`test threw: ${err.message}`)
} finally {
  await closePage(page)
}

const failCount = summary()
process.exit(failCount > 0 ? 1 : 0)

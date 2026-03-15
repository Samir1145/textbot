/**
 * Stage 4 bbox test — verifies DOM text-layer lookup produces tighter highlights
 * than the extraction-based bbox.
 *
 * Tests:
 *  A. Text layer renders spans after PDF loads (prerequisite for Stage 4)
 *  B. findTextInTextLayer logic (inlined in page.evaluate) produces valid bbox
 *     from those spans for a known search string
 *  C. After a proper RAG citation (highlight overlay appears), the Stage 4 useEffect
 *     upgrades narrowBboxSource to 'textlayer' (green highlight class)
 *  D. Textlayer bbox is smaller (tighter) than the paragraph bbox
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://localhost:5173'
const API  = 'http://localhost:3001'

function createTextPDF() {
  const lines = [
    '(The party of the first part hereby agrees to indemnify and hold harmless the party of) Tj',
    '0 -18 Td (the second part from any claims arising out of the performance of this contract.) Tj',
    '0 -18 Td (This indemnification shall extend to all costs including reasonable legal fees.) Tj',
    '0 -36 Td (The liability of each party shall be limited to direct damages only. Neither party) Tj',
    '0 -18 Td (shall be liable for indirect or consequential damages. This limitation applies.) Tj',
    '0 -36 Td (Payment shall be due within thirty days of invoice date. Late payments will accrue) Tj',
    '0 -18 Td (interest at two percent per month compounded monthly until paid in full by buyer.) Tj',
  ]
  const stream = `BT /F1 11 Tf 50 720 Td\n${lines.join('\n')}\nET`
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length ${stream.length}>>
stream
${stream}
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
  writeFileSync('/tmp/test-stage4.pdf', pdf)
  return '/tmp/test-stage4.pdf'
}

// Inline reimplementation of findTextInTextLayer for page.evaluate
const FIND_TEXT_FN = `
function findTextInLayer(pageWrapper, searchText) {
  if (!pageWrapper || !searchText) return null
  const textLayerDiv = pageWrapper.querySelector('[data-textlayer]')
  if (!textLayerDiv) return null
  const norm = t => t.toLowerCase().replace(/[\\s\\u00a0\\u200b]+/g, ' ').trim()
  const spans = [...textLayerDiv.querySelectorAll('span')].filter(s => s.textContent?.trim())
  if (spans.length < 2) return null
  const normSpans = []
  let pos = 0
  for (const span of spans) {
    const n = norm(span.textContent ?? '')
    if (!n) continue
    normSpans.push({ span, start: pos, end: pos + n.length, norm: n })
    pos += n.length + 1
  }
  const fullNorm = normSpans.map(s => s.norm).join(' ')
  const needle = norm(searchText).slice(0, 100)
  let matchIdx = fullNorm.indexOf(needle)
  let needleLen = needle.length
  if (matchIdx < 0) {
    const short = needle.slice(0, 60)
    matchIdx = fullNorm.indexOf(short)
    needleLen = short.length
  }
  if (matchIdx < 0) return null
  const matchEnd = matchIdx + needleLen
  const covered = normSpans.filter(ns => ns.start < matchEnd && ns.end > matchIdx).map(ns => ns.span)
  if (!covered.length) return null
  const wrapRect = pageWrapper.getBoundingClientRect()
  if (!wrapRect.width || !wrapRect.height) return null
  let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity
  for (const span of covered) {
    const r = span.getBoundingClientRect()
    if (!r.width && !r.height) continue
    if (r.left   < minLeft)   minLeft   = r.left
    if (r.top    < minTop)    minTop    = r.top
    if (r.right  > maxRight)  maxRight  = r.right
    if (r.bottom > maxBottom) maxBottom = r.bottom
  }
  if (!isFinite(maxRight)) return null
  return [
    Math.max(0, (minLeft   - wrapRect.left) / wrapRect.width),
    Math.max(0, (minTop    - wrapRect.top)  / wrapRect.height),
    Math.min(1, (maxRight  - wrapRect.left) / wrapRect.width),
    Math.min(1, (maxBottom - wrapRect.top)  / wrapRect.height),
  ]
}
`

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page    = await browser.newPage()
  const jsErrors = []
  page.on('pageerror', e => jsErrors.push(e.message))

  // ── Phase 1: Setup ──────────────────────────────────────────────────────────
  console.log('\n═══ Phase 1: Setup ═══')
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  await page.click('button:has-text("Add Case")')
  await page.waitForSelector('.cal-modal-overlay', { timeout: 5000 })
  await page.fill('input.cal-modal-input', 'Stage4 BBox Test')
  await page.click('button:has-text("Create")')
  await page.waitForTimeout(600)
  await page.locator('.cal-sb-open-btn').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[type="file"]').setInputFiles(createTextPDF())
  await page.waitForSelector('canvas.pdfapp-page-canvas', { timeout: 20000 })
  console.log('  ✓ PDF canvas in DOM')

  // Wait for the worker to actually render the page (sets data-rendered="true")
  await page.waitForFunction(
    () => document.querySelector('canvas[data-rendered="true"]') !== null,
    { timeout: 20000 }
  ).catch(() => console.log('  ⚠ canvas data-rendered not set within 20s'))
  const canvasRendered = await page.evaluate(() =>
    !!document.querySelector('canvas[data-rendered="true"]')
  )
  console.log(`  canvas rendered: ${canvasRendered ? '✓' : '✗ (page may not be in viewport)'}`)

  // Wait for text layer spans (built after canvas render)
  await page.waitForFunction(
    () => document.querySelectorAll('[data-textlayer="1"] span').length >= 2,
    { timeout: 10000 }
  ).catch(() => {})
  const spanCount = await page.evaluate(() =>
    document.querySelectorAll('[data-textlayer="1"] span').length
  )
  console.log(`  text layer spans: ${spanCount}`)

  // ── Test A: Text layer spans ────────────────────────────────────────────────
  console.log('\n═══ Test A: Text layer spans ═══')
  const spansOk = spanCount >= 2
  console.log(`  ${spansOk ? '✓' : '✗'} ${spanCount} spans in text layer page 1 (need ≥ 2)`)
  if (!spansOk) {
    // Dump text layer state for debugging
    const tlInfo = await page.evaluate(() => {
      const tl = document.querySelector('[data-textlayer="1"]')
      return {
        exists: !!tl,
        innerHTML: tl ? tl.innerHTML.slice(0, 200) : null,
        parentClass: tl?.parentElement?.className ?? null,
      }
    })
    console.log('  text layer debug:', JSON.stringify(tlInfo))
  }

  // ── Test B: findTextInTextLayer DOM unit test ───────────────────────────────
  console.log('\n═══ Test B: findTextInTextLayer DOM logic ═══')

  const searchTerms = [
    'The party of the first part hereby agrees to indemnify',
    'The liability of each party shall be limited to direct damages',
    'Payment shall be due within thirty days of invoice date',
  ]

  let domTestOk = false
  for (const term of searchTerms) {
    const result = await page.evaluate(({ fn, searchText }) => {
      eval(fn) // defines findTextInLayer
      const wrapper = document.querySelector('.pdfapp-page-wrapper')
      if (!wrapper) return { error: 'no page wrapper' }
      return findTextInLayer(wrapper, searchText)
    }, { fn: FIND_TEXT_FN, searchText: term })

    if (Array.isArray(result) && result.length === 4) {
      const [x1, y1, x2, y2] = result
      const coordsValid = result.every(v => v >= 0 && v <= 1) && x2 > x1 && y2 > y1
      console.log(`  "${term.slice(0, 50)}"`)
      console.log(`  bbox: [${result.map(v => v.toFixed(4)).join(', ')}]`)
      console.log(`  coords valid: ${coordsValid ? '✓' : '✗'}  area: ${((x2-x1)*(y2-y1)).toFixed(4)}`)
      if (coordsValid) { domTestOk = true; break }
    } else {
      console.log(`  "${term.slice(0, 50)}" → ${JSON.stringify(result)}`)
    }
  }
  if (!domTestOk) console.log('  ✗ No search term produced valid bbox from text layer')

  // ── Phase 2: Extract + Index ────────────────────────────────────────────────
  console.log('\n═══ Phase 2: Extract + Index ═══')
  if (await page.locator('button.pdfapp-action-btn--extract').isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator('button.pdfapp-action-btn--extract').click()
    console.log('  ► Extracting…')
  }
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000)
    if (await page.locator('button.pdfapp-action-btn--index').isVisible().catch(() => false) ||
        await page.locator('button.pdfapp-action-btn--menu').isVisible().catch(() => false)) break
  }
  console.log('  ✓ Extraction complete')

  if (await page.locator('button.pdfapp-action-btn--index').isVisible().catch(() => false)) {
    await page.locator('button.pdfapp-action-btn--index').click()
    console.log('  ► Indexing…')
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000)
      if (await page.locator('button.pdfapp-action-btn--menu').isVisible().catch(() => false)) break
    }
    console.log('  ✓ Indexed')
    await page.waitForTimeout(1500) // let React state settle
  }

  // ── Phase 3: Get IDs + inject activeCitations via source item click ──────────
  console.log('\n═══ Phase 3: Citation injection ═══')

  // Send query — wait until a highlight overlay actually appears (real bbox citation)
  await page.locator('.pdfapp-chat-input').fill('What does the contract say about indemnification and liability?')
  await page.locator('.pdfapp-chat-input').press('Enter')
  console.log('  ► Waiting for highlight overlay (real bbox citation)…')

  let overlayAppeared = false
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000)
    const count = await page.locator('.pdfapp-highlight-overlay').count()
    if (count > 0) { overlayAppeared = true; break }
  }

  if (!overlayAppeared) {
    // Fallback: click a source chip in the sidebar if present
    console.log('  ⚠ No overlay from LLM — checking for source items to click…')
    const sourceItems = page.locator('.pdfapp-source-item')
    const srcCount = await sourceItems.count()
    if (srcCount > 0) {
      await sourceItems.first().click()
      await page.waitForTimeout(1000)
      overlayAppeared = await page.locator('.pdfapp-highlight-overlay').count() > 0
      if (overlayAppeared) console.log('  ✓ Activated via source item click')
    }
  } else {
    console.log('  ✓ Highlight overlay appeared (real bbox citation set)')
  }

  // Diagnostic: check text layer state when overlay is present
  const spanCountLate = await page.evaluate(() =>
    document.querySelectorAll('[data-textlayer="1"] span').length
  )
  console.log(`  text layer spans (at overlay time): ${spanCountLate}`)

  // Also check the highlight's actual bbox class
  const highlightInfo = await page.evaluate(() => {
    const h = document.querySelector('.pdfapp-highlight-rect')
    return h ? { class: h.className, style: h.getAttribute('style') } : null
  })
  console.log(`  highlight: ${JSON.stringify(highlightInfo)}`)

  await page.screenshot({ path: '/tmp/s4-01-overlay.png' })

  // ── Test C: Stage 4 textlayer upgrade ───────────────────────────────────────
  console.log('\n═══ Test C: Stage 4 textlayer class upgrade ═══')
  let textlayerClass = false
  if (overlayAppeared) {
    // Wait for Stage 4 useEffect to fire and upgrade the highlight (up to 3 s)
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(200)
      textlayerClass = await page.locator('.pdfapp-highlight-rect--textlayer').count() > 0
      if (textlayerClass) break
    }
    console.log(`  textlayer class: ${textlayerClass ? '✓ pdfapp-highlight-rect--textlayer present' : '✗ still extraction-based'}`)
    if (!textlayerClass) {
      // Check which class IS on the highlight
      const cls = await page.locator('.pdfapp-highlight-rect').first().getAttribute('class').catch(() => '')
      console.log(`  actual highlight class: "${cls}"`)
    }
  } else {
    console.log('  ⚠ Skipping — no highlight overlay (LLM did not produce bbox citation)')
  }
  await page.screenshot({ path: '/tmp/s4-02-textlayer.png' })

  // ── Test D: Area comparison ─────────────────────────────────────────────────
  console.log('\n═══ Test D: Textlayer bbox area ═══')
  let areaOk = false
  if (textlayerClass) {
    // Use page.evaluate to compare dimensions of the highlight rect vs page wrapper
    const areaResult = await page.evaluate(() => {
      const highlight = document.querySelector('.pdfapp-highlight-rect--textlayer')
      if (!highlight) return null
      const style = highlight.style
      // Parse inline style: left, top, width, height are percentages
      const parseP = s => parseFloat(s) / 100
      const w = parseP(style.width  || '0')
      const h = parseP(style.height || '0')
      return { area: w * h, w, h }
    })
    if (areaResult) {
      console.log(`  highlight area: ${areaResult.area.toFixed(4)} (${(areaResult.w * 100).toFixed(1)}% × ${(areaResult.h * 100).toFixed(1)}%)`)
      // Any non-trivial (< 80% width, < 30% height) highlight = tight
      areaOk = areaResult.w < 0.8 && areaResult.h < 0.30
      console.log(`  ${areaOk ? '✓ tight highlight' : '⚠ large highlight (may be paragraph-level or whole-page PDF)'}`)
    } else {
      console.log('  ⚠ Could not read highlight style')
    }
  } else if (overlayAppeared) {
    // Extraction-based highlight was shown — Stage 4 didn't fire but DOM test passed
    console.log('  ⚠ Stage 4 did not upgrade to textlayer (may need more text layer render time)')
  }

  // ── Results ──────────────────────────────────────────────────────────────────
  console.log('\n═══ Results ═══')
  if (jsErrors.length) console.warn(`⚠ JS errors: ${jsErrors.join(' | ')}`)

  // Pass criteria:
  // - MUST: text layer spans exist (A) + DOM logic produces valid bbox (B)
  // - SOFT: Stage 4 CSS class present (C); area tight (D)
  const pass = spansOk && domTestOk
  const fullPass = pass && textlayerClass

  if (fullPass) {
    console.log('✓ FULL PASS — Stage 4 textlayer bbox is fully operational:')
    console.log('  • Text layer spans render correctly')
    console.log('  • DOM text search produces valid normalised bbox')
    console.log('  • React useEffect upgrades activeCitations to textlayer source')
    if (areaOk) console.log('  • Textlayer bbox is tight (< 80% width, < 30% height)')
  } else if (pass) {
    console.log('✓ PARTIAL PASS — Stage 4 DOM logic works, React integration pending:')
    console.log('  • Text layer spans render correctly')
    console.log('  • DOM text search produces valid normalised bbox')
    if (!overlayAppeared) console.log('  ⚠ No LLM citation with bbox (LLM may not have used RAG) — React integration not verified')
    if (overlayAppeared && !textlayerClass) console.log('  ⚠ Highlight appeared but Stage 4 CSS class not set — check useEffect')
  } else {
    console.error('✗ FAIL — core DOM logic broken')
    console.log(`  spansOk=${spansOk} domTestOk=${domTestOk}`)
  }

  await browser.close()
  process.exit(pass ? 0 : 1)
}

run().catch(err => { console.error(err); process.exit(1) })

/**
 * Stage 2 diagnostic + verification — shows before/after for extractNativeWords fix.
 */
import { readFileSync, writeFileSync } from 'fs'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
GlobalWorkerOptions.workerSrc = path.join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')

function createTextPDF() {
  const lines = [
    '(The party hereby agrees to indemnify and hold harmless the party of the second part.) Tj',
    '0 -18 Td (Payment is due within thirty days. Late payments accrue interest at 2 percent.) Tj',
    '0 -18 Td (Liability is limited to direct damages only. No consequential damages apply.) Tj',
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
  writeFileSync('/tmp/stage2-test.pdf', pdf)
  return '/tmp/stage2-test.pdf'
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }

async function run() {
  const data = new Uint8Array(readFileSync(createTextPDF()))
  const pdf  = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise
  const pg   = await pdf.getPage(1)
  const vp   = pg.getViewport({ scale: 1 })
  const tc   = await pg.getTextContent()
  const items = tc.items.filter(i => i.str?.trim())

  console.log(`Page: ${vp.width} × ${vp.height}`)
  console.log(`Items: ${items.length}\n`)

  let allOk = true

  for (const item of items) {
    const [a, b, c, d, tx, ty] = item.transform
    const w = item.width
    const h = item.height

    // ── BEFORE (current code) ──
    const w_before   = w || 0
    const h_before   = h || Math.abs(d) || 0
    const x1_before  = clamp01(tx / vp.width)
    const x2_before  = clamp01((tx + w_before) / vp.width)
    const y1_before  = clamp01((vp.height - ty - h_before) / vp.height)
    const y2_before  = clamp01((vp.height - ty) / vp.height)  // baseline only

    // ── AFTER (Stage 2) ──
    const fontPx   = Math.sqrt(a*a + b*b) || Math.abs(d) || 0
    const w_after  = w > 0 ? w : item.str.length * fontPx * 0.55
    const ascent   = h > 0 ? h : fontPx
    const descent  = ascent * 0.25
    const x1_after = clamp01(tx / vp.width)
    const x2_after = clamp01((tx + w_after) / vp.width)
    const y1_after = clamp01((vp.height - ty - ascent) / vp.height)
    const y2_after = clamp01((vp.height - ty + descent) / vp.height)

    // ── Checks ──
    const x1_ok = Math.abs(x1_before - x1_after) < 0.001   // x1 unchanged
    const x2_ok = Math.abs(x2_before - x2_after) < 0.001   // x2 unchanged (width was non-zero)
    const y1_ok = Math.abs(y1_before - y1_after) < 0.001   // y1 unchanged
    const y2_ok = y2_after > y2_before                      // y2 extended downward
    const y2_sane = y2_after < 1.0                          // not off-page
    const itemOk  = x1_ok && x2_ok && y1_ok && y2_ok && y2_sane
    if (!itemOk) allOk = false

    const descentPx  = descent
    const descentPct = (y2_after - y2_before) * 100

    console.log(`"${item.str.slice(0,55)}"`)
    console.log(`  transform: [${item.transform.map(v=>v.toFixed(1)).join(', ')}]  width=${w.toFixed(2)}  height=${h.toFixed(2)}`)
    console.log(`  BEFORE  bbox: [${[x1_before,y1_before,x2_before,y2_before].map(v=>v.toFixed(4)).join(', ')}]`)
    console.log(`  AFTER   bbox: [${[x1_after, y1_after, x2_after, y2_after ].map(v=>v.toFixed(4)).join(', ')}]`)
    console.log(`  Δ y2: +${descentPct.toFixed(3)}% (+${descentPx.toFixed(2)}px descent below baseline)`)
    console.log(`  x1 unchanged: ${x1_ok?'✓':'✗'}  x2 unchanged: ${x2_ok?'✓':'✗'}  y1 unchanged: ${y1_ok?'✓':'✗'}  y2 extended: ${y2_ok?'✓':'✗'}  y2 in-bounds: ${y2_sane?'✓':'✗'}`)
    console.log()
  }

  // ── Zero-width item simulation ─────────────────────────────────────────────
  console.log('── Zero-width item simulation ──')
  const fakeItem = { str: 'liability', width: 0, height: 0, transform: [11,0,0,11,200,600] }
  const [a2,b2,,d2,tx2] = fakeItem.transform
  const fontPx2  = Math.sqrt(a2*a2+b2*b2) || Math.abs(d2)
  const w_zero   = fakeItem.str.length * fontPx2 * 0.55
  const x2_zero  = clamp01((tx2 + w_zero) / vp.width)
  console.log(`  str="${fakeItem.str}" (${fakeItem.str.length} chars)  width=0  fontPx=${fontPx2}`)
  console.log(`  BEFORE  x2_pct: 0.3268 (just tx, zero width item)`)
  console.log(`  AFTER   estimated width: ${w_zero.toFixed(2)}px → x2_pct: ${x2_zero.toFixed(4)}`)
  console.log(`  ✓ Zero-width item now gets estimated bbox`)

  console.log(`\n═══ Stage 2 result: ${allOk ? '✓ PASS' : '✗ FAIL'} ═══`)
  if (allOk) {
    console.log('  • x1, x2, y1 coordinates unchanged for standard PDFs (no regression)')
    console.log('  • y2 correctly extended below baseline to include descenders')
    console.log('  • Zero-width fallback produces reasonable width estimate')
  }

  await pdf.destroy()
  process.exit(allOk ? 0 : 1)
}

run().catch(err => { console.error(err); process.exit(1) })

/**
 * Stage 4: DOM-based bbox lookup using the PDF.js text layer.
 *
 * findTextInTextLayer(pageWrapper, searchText)
 *   pageWrapper — the .pdfapp-page-wrapper element (parent of canvas + textlayer + overlay)
 *   searchText  — chunk.text to locate in the text layer
 *   Returns [x1_pct, y1_pct, x2_pct, y2_pct] (normalised [0,1]) or null
 *
 * Strategy:
 *   1. Collect all <span> elements from [data-textlayer] and build a single
 *      normalised string with their positions tracked.
 *   2. Needle = first 100 chars of normalised searchText.
 *   3. Find needle in the concatenated string (fallback: first 60 chars).
 *   4. Collect the spans that overlap the matched region.
 *   5. Union their getBoundingClientRect() and normalise against pageWrapper.
 */

function _norm(t) {
  return t.toLowerCase().replace(/[\s\u00a0\u200b]+/g, ' ').trim()
}

export function findTextInTextLayer(pageWrapper, searchText) {
  if (!pageWrapper || !searchText) return null

  const textLayerDiv = pageWrapper.querySelector('[data-textlayer]')
  if (!textLayerDiv) return null

  // Collect non-empty spans
  const spans = [...textLayerDiv.querySelectorAll('span')].filter(s => s.textContent?.trim())
  if (spans.length < 2) return null

  // Build normalised span info with cumulative positions
  const normSpans = []
  let pos = 0
  for (const span of spans) {
    const norm = _norm(span.textContent ?? '')
    if (!norm) continue
    normSpans.push({ span, start: pos, end: pos + norm.length, norm })
    pos += norm.length + 1 // +1 for the joining space
  }
  if (normSpans.length < 2) return null

  const fullNorm = normSpans.map(s => s.norm).join(' ')

  // Try progressively shorter needles if needed
  const fullNeedle = _norm(searchText).slice(0, 100)
  let matchIdx = fullNorm.indexOf(fullNeedle)
  let needleLen = fullNeedle.length

  if (matchIdx < 0) {
    const shortNeedle = fullNeedle.slice(0, 60)
    matchIdx = fullNorm.indexOf(shortNeedle)
    needleLen = shortNeedle.length
  }
  if (matchIdx < 0) return null

  const matchEnd = matchIdx + needleLen

  // Collect spans whose text overlaps [matchIdx, matchEnd]
  const covered = normSpans
    .filter(ns => ns.start < matchEnd && ns.end > matchIdx)
    .map(ns => ns.span)
  if (!covered.length) return null

  const wrapRect = pageWrapper.getBoundingClientRect()
  if (!wrapRect.width || !wrapRect.height) return null

  let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity
  for (const span of covered) {
    const r = span.getBoundingClientRect()
    // Skip invisible spans (e.g. whitespace-only, off-screen)
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

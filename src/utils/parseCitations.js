/**
 * ATG citation utilities.
 *
 * chunkMap  — Map<n, chunk>  where n is the 1-based citation number
 * citations — subset of chunkMap for only the [n] markers that appear in text
 */

/**
 * Build a numbered evidence block for the LLM prompt.
 * Returns { ragContext: string, chunkMap: Map<number, chunk> }
 *
 * When chunks carry a `doc_id` field (case-wide search), the label includes
 * a provenance prefix so the LLM can cite which document each passage is from.
 * `docLabels` is an optional Map<doc_id, string> for human-readable names.
 */
export function buildEvidenceBlock(chunks, { docLabels } = {}) {
  const chunkMap = new Map()
  if (!chunks.length) return { ragContext: '', chunkMap }

  chunks.forEach((chunk, i) => chunkMap.set(i + 1, chunk))

  const lines = chunks.map((c, i) => {
    const provenance = c.doc_id && docLabels?.get(c.doc_id)
      ? `[${docLabels.get(c.doc_id)}] `
      : c.doc_id
        ? `[${c.doc_id}] `
        : ''
    // windowText: sentence-window expansion (±N neighbors). Falls back to raw chunk text.
    return `[${i + 1}] ${provenance}Page ${c.page_num}:\n${c.windowText ?? c.text}`
  })

  const ragContext =
    '\n\nEvidence — cite inline as [1], [2], etc. when drawing on these sections:\n' +
    lines.join('\n\n')

  return { ragContext, chunkMap }
}

/**
 * Parse which [n] markers appear in the LLM response.
 * Returns Map<number, chunk> for only the cited chunks.
 */
export function parseCitations(text, chunkMap) {
  const cited = new Map()
  for (const [, n] of text.matchAll(/\[(\d+)\]/g)) {
    const num = parseInt(n)
    if (chunkMap.has(num) && !cited.has(num)) {
      cited.set(num, chunkMap.get(num))
    }
  }
  return cited
}

// ── Sentence-level bbox narrowing ──────────────────────────────────────────

function _tokenSet(text) {
  return new Set(text.toLowerCase().split(/\W+/).filter(t => t.length > 2))
}

function _jaccard(a, b) {
  let hits = 0
  for (const t of a) if (b.has(t)) hits++
  return hits / (a.size + b.size - hits || 1)
}

/**
 * Given the full LLM response text and a citation number, extract ~200 chars
 * of context immediately before the [n] marker.
 */
function _contextAround(responseText, n) {
  const match = [...responseText.matchAll(/\[(\d+)\]/g)].find(m => parseInt(m[1]) === n)
  if (!match) return ''
  const before = responseText.slice(Math.max(0, match.index - 250), match.index)
  const after  = responseText.slice(match.index + match[0].length, match.index + match[0].length + 100)
  return before + ' ' + after
}

/**
 * Stage 1 fix: when sourceWords were stripped at persist time, rebuild a
 * usable word list from the page's rawWords by filtering to tokens that
 * appear in the chunk text.  rawWords is always persisted.
 */
function _rebuildSourceWords(chunk, page) {
  if (!page?.rawWords?.length) return null
  const chunkTokens = _tokenSet(chunk.text)
  if (chunkTokens.size === 0) return null
  // A rawWord item may be a single word (ideal) or an entire line (PDF.js Tj operator).
  // Match if ANY token within the item's text appears in the chunk token set.
  const words = page.rawWords.filter(w => {
    for (const t of _tokenSet(w.text)) if (chunkTokens.has(t)) return true
    return false
  })
  return words.length >= 1 ? words : null
}

/**
 * Try to narrow a paragraph-level bbox to the sentence most relevant to the
 * LLM's usage context.
 * Returns { bbox: [x1,y1,x2,y2], source: string } or null if not possible.
 *
 * source values:
 *   'sourcewords' — exact word list from the extraction chunk (best)
 *   'rawwords'    — rebuilt from page rawWords via token matching (Stage 1)
 */
function _computeNarrowBbox(chunk, contextText, extractionPages) {
  if (!chunk.bbox || !extractionPages) return null
  const page = extractionPages.find(p => p.pageNum === chunk.page_num)
  if (!page) return null

  // Match chunk in extraction cache by index, fall back to text prefix
  const ec = page.chunks[chunk.chunk_idx]
    ?? page.chunks.find(c => c.text.slice(0, 60) === chunk.text.slice(0, 60))

  // Prefer persisted sourceWords; fall back to rawWords rebuild (fixes reload bug)
  // >= 2 handles both word-level items (real PDFs) and line-level items (some PDFs/OCR)
  const sourceWords = ec?.sourceWords?.length >= 2
    ? ec.sourceWords
    : _rebuildSourceWords(chunk, page)
  if (!sourceWords) return null

  const source = ec?.sourceWords?.length >= 2 ? 'sourcewords' : 'rawwords'
  const chunkText = ec?.text ?? chunk.text

  // Split into sentences (punctuation-based)
  const sentences = chunkText.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10)
  if (sentences.length <= 1) return null

  const ctxTokens = _tokenSet(contextText)
  if (ctxTokens.size === 0) return null

  let bestIdx = -1, bestScore = 0
  for (let i = 0; i < sentences.length; i++) {
    const score = _jaccard(ctxTokens, _tokenSet(sentences[i]))
    if (score > bestScore) { bestScore = score; bestIdx = i }
  }
  if (bestIdx < 0 || bestScore < 0.04) return null

  const sentTokens = _tokenSet(sentences[bestIdx])
  const matching = sourceWords.filter(w => sentTokens.has(w.text.toLowerCase().replace(/\W/g, '')))
  if (matching.length < 2) return null

  return {
    bbox: [
      Math.min(...matching.map(w => w.x1_pct)),
      Math.min(...matching.map(w => w.y1_pct)),
      Math.max(...matching.map(w => w.x2_pct)),
      Math.max(...matching.map(w => w.y2_pct)),
    ],
    source,
  }
}

/**
 * Enrich a citations Map with narrowBbox where sentence-level matching succeeds.
 * extractionPages comes from lastExtractionPagesRef.current.pages.
 * Returns a new Map<n, chunk> with narrowBbox + narrowBboxSource added where possible.
 */
export function narrowCitations(citations, responseText, extractionPages) {
  if (!extractionPages || !citations.size) return citations
  const out = new Map()
  for (const [n, chunk] of citations) {
    const context = _contextAround(responseText, n)
    const result = _computeNarrowBbox(chunk, context, extractionPages)
    out.set(n, result ? { ...chunk, narrowBbox: result.bbox, narrowBboxSource: result.source } : chunk)
  }
  return out
}

/**
 * Convert a vector distance to a 0–100 confidence score.
 * For normalized embeddings: cosine_sim ≈ 1 − dist²/2
 * Clamp to [0, 100] and return as integer.
 */
export function distanceToScore(distance) {
  return Math.round(Math.max(0, Math.min(1, 1 - (distance * distance) / 2)) * 100)
}

/**
 * Split a message string into segments: plain strings and citation markers.
 * e.g. "hello [1] world [2]" → ["hello ", 1, " world ", 2]
 */
export function tokeniseMessage(text) {
  const parts = []
  let last = 0
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(parseInt(match[1]))
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

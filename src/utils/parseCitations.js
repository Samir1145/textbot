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
    return `[${i + 1}] ${provenance}Page ${c.page_num}:\n${c.text}`
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
 * Try to narrow a paragraph-level bbox to the sentence most relevant to the
 * LLM's usage context.  Requires sourceWords on the matched extraction chunk.
 * Returns a tight [x1,y1,x2,y2] or null if narrowing isn't possible.
 */
function _computeNarrowBbox(chunk, contextText, extractionPages) {
  if (!chunk.bbox || !extractionPages) return null
  const page = extractionPages.find(p => p.pageNum === chunk.page_num)
  if (!page) return null

  // Match by chunk_idx first, fall back to text prefix
  const ec = page.chunks[chunk.chunk_idx]
    ?? page.chunks.find(c => c.text.slice(0, 60) === chunk.text.slice(0, 60))
  if (!ec?.sourceWords?.length || ec.sourceWords.length < 4) return null

  // Split into sentences (punctuation-based)
  const sentences = ec.text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10)
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
  const matching = ec.sourceWords.filter(w => sentTokens.has(w.text.toLowerCase().replace(/\W/g, '')))
  if (matching.length < 2) return null

  return [
    Math.min(...matching.map(w => w.x1_pct)),
    Math.min(...matching.map(w => w.y1_pct)),
    Math.max(...matching.map(w => w.x2_pct)),
    Math.max(...matching.map(w => w.y2_pct)),
  ]
}

/**
 * Enrich a citations Map with narrowBbox where sentence-level matching succeeds.
 * extractionPages comes from lastExtractionPagesRef.current.pages.
 * Returns a new Map<n, chunk> with narrowBbox added where possible.
 */
export function narrowCitations(citations, responseText, extractionPages) {
  if (!extractionPages || !citations.size) return citations
  const out = new Map()
  for (const [n, chunk] of citations) {
    const context = _contextAround(responseText, n)
    const narrowBbox = _computeNarrowBbox(chunk, context, extractionPages)
    out.set(n, narrowBbox ? { ...chunk, narrowBbox } : chunk)
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

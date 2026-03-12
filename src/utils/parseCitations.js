/**
 * ATG citation utilities.
 *
 * chunkMap  — Map<n, chunk>  where n is the 1-based citation number
 * citations — subset of chunkMap for only the [n] markers that appear in text
 */

/**
 * Build a numbered evidence block for the LLM prompt.
 * Returns { ragContext: string, chunkMap: Map<number, chunk> }
 */
export function buildEvidenceBlock(chunks) {
  const chunkMap = new Map()
  if (!chunks.length) return { ragContext: '', chunkMap }

  chunks.forEach((chunk, i) => chunkMap.set(i + 1, chunk))

  const lines = chunks.map((c, i) =>
    `[${i + 1}] Page ${c.page_num}:\n${c.text}`
  )

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

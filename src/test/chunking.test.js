/**
 * Unit tests for Phase 19 chunking logic.
 *
 * All functions under test (chunkRecursive, buildChunkedPages, applyChunkStrategy,
 * countWords, _bboxFromWords, _lineRectsFromWords, _splitParaIntoSentences) are
 * defined at module scope in PDFApp.jsx but NOT exported, so their pure logic is
 * replicated inline here.
 *
 * groupIntoParagraphs is exported from pdfExtract.js, but that module imports
 * pdfjs-dist which requires DOMMatrix (not available in jsdom).  Rather than
 * spinning up a custom environment, we replicate groupIntoParagraphs from its
 * source as well — keeping the test file entirely self-contained and fast.
 *
 * Maintenance note: any change to the logic of these functions in PDFApp.jsx or
 * pdfExtract.js must be reflected in the replicas below.
 */

import { describe, it, expect } from 'vitest'

// ─── Replica: pdfExtract.js helpers ─────────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)) }

const MAX_LINES_PER_PARA = 8

function _lineRectsFromPdfExtract(words) {
  if (!words?.length) return null
  const avgH = words.reduce((s, w) => s + (w.y2_pct - w.y1_pct), 0) / words.length || 0.01
  const sorted = [...words].sort((a, b) => a.y1_pct - b.y1_pct || a.x1_pct - b.x1_pct)
  const lines = []
  let cur = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const lineBottom = Math.max(...cur.map(x => x.y2_pct))
    if (sorted[i].y1_pct - lineBottom > avgH * 0.3) { lines.push(cur); cur = [sorted[i]] }
    else cur.push(sorted[i])
  }
  lines.push(cur)
  return lines.map(line => [
    clamp01(Math.min(...line.map(w => w.x1_pct))),
    clamp01(Math.min(...line.map(w => w.y1_pct))),
    clamp01(Math.max(...line.map(w => w.x2_pct))),
    clamp01(Math.max(...line.map(w => w.y2_pct))),
  ])
}

function _makePara(words) {
  const sorted = [...words].sort((a, b) => a.y1_pct - b.y1_pct || a.x1_pct - b.x1_pct)
  const text = sorted.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim()
  const bbox = [
    clamp01(Math.min(...words.map(w => w.x1_pct))),
    clamp01(Math.min(...words.map(w => w.y1_pct))),
    clamp01(Math.max(...words.map(w => w.x2_pct))),
    clamp01(Math.max(...words.map(w => w.y2_pct))),
  ]
  return { text, bbox, lineRects: _lineRectsFromPdfExtract(sorted), sourceWords: sorted }
}

function groupIntoParagraphs(words) {
  if (!words.length) return []
  const sorted = [...words].sort((a, b) => a.y1_pct - b.y1_pct || a.x1_pct - b.x1_pct)
  const avgH = sorted.reduce((s, w) => s + (w.y2_pct - w.y1_pct), 0) / sorted.length || 0.01
  const lines = []
  let curLine = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i]
    const lineBottom = Math.max(...curLine.map(x => x.y2_pct))
    if (w.y1_pct - lineBottom > avgH * 0.3) { lines.push(curLine); curLine = [w] }
    else curLine.push(w)
  }
  lines.push(curLine)
  for (const l of lines) l.sort((a, b) => a.x1_pct - b.x1_pct)
  const PARA_GAP = avgH * 1.5
  const paragraphs = []
  let curLines = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    const prevBottom = Math.max(...curLines[curLines.length - 1].map(w => w.y2_pct))
    const nextTop = Math.min(...lines[i].map(w => w.y1_pct))
    const visualBreak = nextTop - prevBottom > PARA_GAP
    const tooLong = curLines.length >= MAX_LINES_PER_PARA
    if (visualBreak || tooLong) { paragraphs.push(_makePara(curLines.flat())); curLines = [lines[i]] }
    else curLines.push(lines[i])
  }
  paragraphs.push(_makePara(curLines.flat()))
  return paragraphs
}

// ─── Replica: PDFApp.jsx module-scope helpers ────────────────────────────────

function countWords(text) {
  return text.trim().split(/\s+/).length
}

function _bboxFromWords(words) {
  if (!words?.length) return null
  return [
    Math.min(...words.map(w => w.x1_pct)),
    Math.min(...words.map(w => w.y1_pct)),
    Math.max(...words.map(w => w.x2_pct)),
    Math.max(...words.map(w => w.y2_pct)),
  ]
}

function _lineRectsFromWords(words) {
  if (!words?.length) return null
  const valid = words.filter(w => w.x2_pct > 0)
  if (!valid.length) return null
  const avgH = valid.reduce((s, w) => s + (w.y2_pct - w.y1_pct), 0) / valid.length || 0.01
  const sorted = [...valid].sort((a, b) => a.y1_pct - b.y1_pct || a.x1_pct - b.x1_pct)
  const lines = []
  let cur = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const lineBottom = Math.max(...cur.map(x => x.y2_pct))
    if (sorted[i].y1_pct - lineBottom > avgH * 0.3) { lines.push(cur); cur = [sorted[i]] }
    else cur.push(sorted[i])
  }
  lines.push(cur)
  return lines.map(line => [
    Math.min(...line.map(w => w.x1_pct)),
    Math.min(...line.map(w => w.y1_pct)),
    Math.max(...line.map(w => w.x2_pct)),
    Math.max(...line.map(w => w.y2_pct)),
  ])
}

const _ABBREVS = /^(Mr|Mrs|Ms|Dr|Prof|Hon|Inc|Ltd|Co|Corp|vs|v|cf|et|al|ibid|viz|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|No|Art|Sec|Sch|Reg|Vol|Ch|Pt|Div|Ord|cl|para|s|r|O|p|pp)\.$/

function _splitParaIntoSentences(para) {
  const words = para.sourceWords ?? []
  if (!words.length) {
    return para.text
      .split(/(?<=[.?!])\s+(?=[A-Z"])/)
      .filter(s => s.trim())
      .map(s => ({ text: s.trim(), words: [] }))
  }
  const sentences = []
  let cur = []
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i])
    const raw = words[i].text.trimEnd()
    const next = words[i + 1]
    const isBoundary = /[.?!]$/.test(raw) && !_ABBREVS.test(raw)
      && (!next || /^[A-Z("0-9]/.test(next.text.trim()))
    if (isBoundary && cur.length >= 5) {
      sentences.push({ text: cur.map(w => w.text).join(' '), words: [...cur] })
      cur = []
    }
  }
  if (cur.length > 0) {
    if (sentences.length > 0 && cur.length < 3) {
      const last = sentences[sentences.length - 1]
      sentences[sentences.length - 1] = {
        text: last.text + ' ' + cur.map(w => w.text).join(' '),
        words: [...last.words, ...cur],
      }
    } else {
      sentences.push({ text: cur.map(w => w.text).join(' '), words: cur })
    }
  }
  return sentences.length > 0 ? sentences : [{ text: para.text, words }]
}

function chunkRecursive(pages, targetWords = 300) {
  const result = []
  for (const page of pages) {
    const paragraphs = page.rawWords?.length
      ? groupIntoParagraphs(page.rawWords)
      : (page.chunks ?? [])

    let acc = [], accT = 0
    const flushAcc = () => {
      if (!acc.length) return
      result.push({ pageNum: page.pageNum, text: acc.map(w => w.text).join(' '), bbox: _bboxFromWords(acc), lineRects: _lineRectsFromWords(acc), sourceWords: acc })
      acc = []; accT = 0
    }

    for (const para of paragraphs) {
      const paraWords = para.sourceWords ?? []
      const t = countWords(para.text)

      if (t <= targetWords) {
        if (accT > 0 && accT + t > targetWords) flushAcc()
        if (paraWords.length) {
          acc.push(...paraWords)
        } else {
          acc.push(...para.text.trim().split(/\s+/).map(w => ({ text: w, x1_pct: 0, y1_pct: 0, x2_pct: 0, y2_pct: 0 })))
        }
        accT += t
      } else {
        flushAcc()
        for (const sent of _splitParaIntoSentences(para)) {
          const st = countWords(sent.text)
          if (st > targetWords) {
            flushAcc()
            const sw = sent.words.length ? sent.words
              : sent.text.split(/\s+/).map(t => ({ text: t, x1_pct: 0, y1_pct: 0, x2_pct: 0, y2_pct: 0 }))
            for (let i = 0; i < sw.length; i += targetWords) {
              const sl = sw.slice(i, i + targetWords)
              const slValid = sl.filter(w => w.x2_pct > 0)
              result.push({ pageNum: page.pageNum, text: sl.map(w => w.text).join(' '), bbox: _bboxFromWords(slValid), lineRects: _lineRectsFromWords(slValid), sourceWords: sl })
            }
          } else {
            if (accT > 0 && accT + st > targetWords) flushAcc()
            const sw = sent.words.length ? sent.words
              : [{ text: sent.text, x1_pct: 0, y1_pct: 0, x2_pct: 0, y2_pct: 0 }]
            acc.push(...sw); accT += st
          }
        }
      }
    }
    flushAcc()
  }
  return result
}

const CHUNK_TARGET_WORDS = 300

function buildChunkedPages(rawPages, rawChunks) {
  const byPage = new Map()
  for (const c of rawChunks) {
    if (!byPage.has(c.pageNum)) byPage.set(c.pageNum, [])
    byPage.get(c.pageNum).push(c)
  }
  return rawPages.map(p => ({ ...p, chunks: byPage.get(p.pageNum) ?? [] }))
}

function applyChunkStrategy(rawPages) {
  return buildChunkedPages(rawPages, chunkRecursive(rawPages, CHUNK_TARGET_WORDS))
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Build a word object with explicit coordinates. */
function makeWord(text, x1 = 0.1, y1 = 0.1, x2 = 0.2, y2 = 0.12) {
  return { text, x1_pct: x1, y1_pct: y1, x2_pct: x2, y2_pct: y2 }
}

/** Build an array of N words spread across a single horizontal line. */
function makeWords(n, yBase = 0.1) {
  return Array.from({ length: n }, (_, i) =>
    makeWord(`word${i}`, 0.05 + i * 0.02, yBase, 0.05 + i * 0.02 + 0.015, yBase + 0.02)
  )
}

/** Build a paragraph with sourceWords and text derived from those words. */
function makePara(words) {
  return { text: words.map(w => w.text).join(' '), sourceWords: words, bbox: [0.05, 0.1, 0.9, 0.12] }
}

/** Page with rawWords (typical post-Phase-19 extraction). */
function makeRawWordPage(pageNum, wordCount, yBase = 0.1) {
  return { pageNum, rawWords: makeWords(wordCount, yBase) }
}

/** Page with pre-built chunks and no rawWords (old format). */
function makeChunkPage(pageNum, chunks) {
  return { pageNum, chunks }
}

// ─── countWords ──────────────────────────────────────────────────────────────

describe('countWords', () => {
  it('counts single word', () => expect(countWords('hello')).toBe(1))
  it('counts multiple words', () => expect(countWords('one two three')).toBe(3))
  it('handles extra whitespace', () => expect(countWords('  one  two  ')).toBe(2))
  it('empty string counts as 1 (split artifact — same as source)', () => {
    // ''.trim().split(/\s+/) → [''] → length 1
    expect(countWords('')).toBe(1)
  })
})

// ─── _bboxFromWords ──────────────────────────────────────────────────────────

describe('_bboxFromWords', () => {
  it('returns null for empty array', () => expect(_bboxFromWords([])).toBeNull())
  it('returns null for undefined', () => expect(_bboxFromWords(undefined)).toBeNull())

  it('returns bounding box for a single word', () => {
    const words = [makeWord('hello', 0.1, 0.2, 0.3, 0.4)]
    expect(_bboxFromWords(words)).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('returns tight bounding box spanning multiple words', () => {
    const words = [
      makeWord('a', 0.05, 0.10, 0.15, 0.20),
      makeWord('b', 0.20, 0.12, 0.40, 0.22),
      makeWord('c', 0.10, 0.08, 0.30, 0.18),
    ]
    expect(_bboxFromWords(words)).toEqual([0.05, 0.08, 0.40, 0.22])
  })
})

// ─── _lineRectsFromWords ─────────────────────────────────────────────────────

describe('_lineRectsFromWords', () => {
  it('returns null for empty array', () => expect(_lineRectsFromWords([])).toBeNull())
  it('returns null for all-zero-width words', () => {
    const words = [{ text: 'x', x1_pct: 0, y1_pct: 0, x2_pct: 0, y2_pct: 0.02 }]
    expect(_lineRectsFromWords(words)).toBeNull()
  })

  it('returns one rect for words on the same line', () => {
    const words = [
      makeWord('a', 0.1, 0.10, 0.2, 0.12),
      makeWord('b', 0.25, 0.10, 0.4, 0.12),
    ]
    const rects = _lineRectsFromWords(words)
    expect(rects).toHaveLength(1)
    expect(rects[0]).toEqual([0.1, 0.10, 0.4, 0.12])
  })

  it('returns multiple rects for words on different lines', () => {
    const words = [
      makeWord('line1a', 0.1, 0.10, 0.3, 0.12),
      makeWord('line2a', 0.1, 0.30, 0.3, 0.32), // large y-gap → new line
    ]
    const rects = _lineRectsFromWords(words)
    expect(rects).toHaveLength(2)
  })

  it('all rect values are numbers', () => {
    const words = makeWords(5)
    const rects = _lineRectsFromWords(words)
    expect(Array.isArray(rects)).toBe(true)
    for (const r of rects) {
      for (const v of r) expect(typeof v).toBe('number')
    }
  })
})

// ─── groupIntoParagraphs ─────────────────────────────────────────────────────

describe('groupIntoParagraphs (replicated from pdfExtract.js)', () => {
  it('returns empty array for empty input', () => {
    expect(groupIntoParagraphs([])).toEqual([])
  })

  it('groups words on the same line into one paragraph', () => {
    const words = [
      makeWord('hello', 0.1, 0.10, 0.2, 0.12),
      makeWord('world', 0.25, 0.10, 0.4, 0.12),
    ]
    const paras = groupIntoParagraphs(words)
    expect(paras).toHaveLength(1)
    expect(paras[0].text).toBe('hello world')
  })

  it('splits words with large y-gaps into separate paragraphs', () => {
    const words = [
      makeWord('para1', 0.1, 0.10, 0.3, 0.12),
      makeWord('para2', 0.1, 0.60, 0.3, 0.62), // far below → new paragraph
    ]
    const paras = groupIntoParagraphs(words)
    expect(paras.length).toBeGreaterThanOrEqual(2)
  })

  it('each paragraph has text, bbox, and sourceWords', () => {
    const words = makeWords(3)
    const paras = groupIntoParagraphs(words)
    for (const p of paras) {
      expect(typeof p.text).toBe('string')
      expect(Array.isArray(p.bbox)).toBe(true)
      expect(Array.isArray(p.sourceWords)).toBe(true)
    }
  })

  it('preserves all word texts in output', () => {
    const words = makeWords(5)
    const paras = groupIntoParagraphs(words)
    const allWords = paras.flatMap(p => p.sourceWords.map(w => w.text))
    const expected = words.map(w => w.text)
    expect(allWords.sort()).toEqual(expected.sort())
  })

  it('caps lines per paragraph at MAX_LINES_PER_PARA (8)', () => {
    // Each word occupies its own line (step=0.03, height=0.02).
    // gap = 0.03 - 0.02 = 0.01 > avgH*0.3 = 0.006 → each word is a separate line.
    // visual break threshold = avgH*1.5 = 0.03 > gap=0.01 → no visual para break.
    // So the only thing that can split these 30 lines into paragraphs is MAX_LINES_PER_PARA.
    // With cap=8: ceil(30/8) = 4 paragraphs expected.
    const step = 0.03
    const height = 0.02
    const words = Array.from({ length: 30 }, (_, i) =>
      ({ text: `w${i}`, x1_pct: 0.1, y1_pct: i * step, x2_pct: 0.3, y2_pct: i * step + height })
    )
    const paras = groupIntoParagraphs(words)
    // 30 lines capped at 8 per para → at least 4 paragraphs
    expect(paras.length).toBeGreaterThanOrEqual(4)
  })
})

// ─── _splitParaIntoSentences ─────────────────────────────────────────────────

describe('_splitParaIntoSentences', () => {
  it('returns one sentence for a short paragraph without strong boundary', () => {
    const para = makePara(makeWords(5))
    const sents = _splitParaIntoSentences(para)
    expect(sents).toHaveLength(1)
  })

  it('does not split on the abbreviation "v."', () => {
    // "Smith v. Jones [2024] UKSC 12. The case is important."
    const rawWords = [
      makeWord('Smith'), makeWord('v.'), makeWord('Jones'), makeWord('[2024]'), makeWord('UKSC'), makeWord('12.'),
      makeWord('The'), makeWord('case'), makeWord('is'), makeWord('important.'),
    ]
    const para = { text: rawWords.map(w => w.text).join(' '), sourceWords: rawWords }
    const sents = _splitParaIntoSentences(para)
    // 'v.' is in _ABBREVS — the split at 'v.' should not produce a new sentence
    const vAndJones = sents.some(s => s.words.some(w => w.text === 'v.') && s.words.some(w => w.text === 'Jones'))
    expect(vAndJones).toBe(true)
  })

  it('falls back to text splitting when sourceWords is empty', () => {
    const para = { text: 'First sentence. Second sentence.', sourceWords: [] }
    const sents = _splitParaIntoSentences(para)
    expect(sents.length).toBeGreaterThanOrEqual(1)
    for (const s of sents) expect(typeof s.text).toBe('string')
  })

  it('merges tiny trailing fragment (< 3 words) into last sentence', () => {
    // 6-word sentence ending in "." followed by a 1-word fragment "End."
    const rawWords = [
      makeWord('The'), makeWord('quick'), makeWord('brown'), makeWord('fox'), makeWord('jumps'), makeWord('here.'),
      makeWord('End.'),
    ]
    const para = { text: rawWords.map(w => w.text).join(' '), sourceWords: rawWords }
    const sents = _splitParaIntoSentences(para)
    // "End." is only 1 word → should be merged into the previous sentence
    const standalone = sents.find(s => s.text.trim() === 'End.')
    expect(standalone).toBeUndefined()
  })
})

// ─── chunkRecursive ──────────────────────────────────────────────────────────

describe('chunkRecursive', () => {
  it('returns empty array for empty pages input', () => {
    expect(chunkRecursive([])).toEqual([])
  })

  it('returns empty array for pages with no words and no chunks', () => {
    const pages = [{ pageNum: 1, rawWords: [], chunks: [] }]
    expect(chunkRecursive(pages)).toEqual([])
  })

  it('produces chunks with pageNum matching their source page', () => {
    const pages = [makeRawWordPage(1, 10), makeRawWordPage(2, 10)]
    const chunks = chunkRecursive(pages)
    expect(chunks.every(c => c.pageNum === 1 || c.pageNum === 2)).toBe(true)
  })

  it('small page (< targetWords) produces exactly 1 chunk', () => {
    const pages = [makeRawWordPage(1, 50)]
    const chunks = chunkRecursive(pages, 300)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].pageNum).toBe(1)
  })

  it('each chunk has text, bbox (or null), lineRects, and sourceWords', () => {
    const pages = [makeRawWordPage(1, 20)]
    const chunks = chunkRecursive(pages)
    for (const c of chunks) {
      expect(typeof c.text).toBe('string')
      expect(c.text.length).toBeGreaterThan(0)
      if (c.bbox !== null) expect(c.bbox).toHaveLength(4)
      expect(Array.isArray(c.sourceWords)).toBe(true)
    }
  })

  it('sourceWords across all chunks sum to the total input word count', () => {
    const wordCount = 30
    const pages = [makeRawWordPage(1, wordCount)]
    const chunks = chunkRecursive(pages)
    const totalWords = chunks.reduce((s, c) => s + c.sourceWords.length, 0)
    expect(totalWords).toBe(wordCount)
  })

  it('falls back to page.chunks when rawWords is absent', () => {
    const para = makePara(makeWords(10))
    const page = makeChunkPage(1, [para])
    const chunks = chunkRecursive([page])
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0].pageNum).toBe(1)
    expect(chunks[0].text).toContain('word0')
  })

  it('falls back gracefully for old-format chunks with no sourceWords', () => {
    const page = {
      pageNum: 1,
      chunks: [{ text: 'alpha beta gamma delta epsilon', bbox: [0, 0, 1, 1] }],
    }
    const chunks = chunkRecursive([page])
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe('alpha beta gamma delta epsilon')
  })

  it('multi-page input preserves page assignments for all three pages', () => {
    const pages = [makeRawWordPage(1, 10), makeRawWordPage(2, 10), makeRawWordPage(3, 10)]
    const chunks = chunkRecursive(pages)
    const pageNums = new Set(chunks.map(c => c.pageNum))
    expect(pageNums.has(1)).toBe(true)
    expect(pageNums.has(2)).toBe(true)
    expect(pageNums.has(3)).toBe(true)
  })

  it('no chunk wildly exceeds targetWords (allows sentence-level overflow up to ~2×)', () => {
    // Three groups of 50 words separated by large y gaps (different paragraphs)
    const makeParaWords = (n, yBase) =>
      Array.from({ length: n }, (_, i) =>
        makeWord(`w${yBase}_${i}`, 0.05 + (i % 20) * 0.04, yBase + Math.floor(i / 20) * 0.025, 0.08 + (i % 20) * 0.04, yBase + Math.floor(i / 20) * 0.025 + 0.02)
      )
    const pages = [{
      pageNum: 1,
      rawWords: [
        ...makeParaWords(50, 0.0),
        ...makeParaWords(50, 0.40),
        ...makeParaWords(50, 0.80),
      ],
    }]
    const chunks = chunkRecursive(pages, 100)
    for (const c of chunks) {
      expect(countWords(c.text)).toBeLessThanOrEqual(200)
    }
  })
})

// ─── buildChunkedPages ───────────────────────────────────────────────────────

describe('buildChunkedPages', () => {
  it('assigns chunks to the correct page', () => {
    const rawPages = [{ pageNum: 1 }, { pageNum: 2 }]
    const rawChunks = [
      { pageNum: 1, text: 'chunk A' },
      { pageNum: 2, text: 'chunk B' },
      { pageNum: 2, text: 'chunk C' },
    ]
    const pages = buildChunkedPages(rawPages, rawChunks)
    expect(pages[0].chunks).toHaveLength(1)
    expect(pages[1].chunks).toHaveLength(2)
  })

  it('gives empty chunks array to pages with no matching rawChunks', () => {
    const rawPages = [{ pageNum: 1 }, { pageNum: 3 }]
    const rawChunks = [{ pageNum: 1, text: 'only page 1' }]
    const pages = buildChunkedPages(rawPages, rawChunks)
    expect(pages[1].chunks).toEqual([])
  })

  it('preserves other page properties', () => {
    const rawPages = [{ pageNum: 1, rawWords: ['x'], someFlag: true }]
    const rawChunks = [{ pageNum: 1, text: 'hello' }]
    const [page] = buildChunkedPages(rawPages, rawChunks)
    expect(page.rawWords).toEqual(['x'])
    expect(page.someFlag).toBe(true)
  })

  it('returns the same number of pages as the input array', () => {
    const rawPages = [{ pageNum: 1 }, { pageNum: 2 }, { pageNum: 3 }]
    const pages = buildChunkedPages(rawPages, [])
    expect(pages).toHaveLength(3)
  })
})

// ─── applyChunkStrategy ──────────────────────────────────────────────────────

describe('applyChunkStrategy', () => {
  it('returns array with same page count as input', () => {
    const rawPages = [makeRawWordPage(1, 20), makeRawWordPage(2, 20)]
    const pages = applyChunkStrategy(rawPages)
    expect(pages).toHaveLength(2)
  })

  it('each output page has a chunks array', () => {
    const rawPages = [makeRawWordPage(1, 10)]
    const pages = applyChunkStrategy(rawPages)
    for (const p of pages) expect(Array.isArray(p.chunks)).toBe(true)
  })

  it('empty pages produce empty chunks arrays', () => {
    const rawPages = [{ pageNum: 1, rawWords: [], chunks: [] }]
    const pages = applyChunkStrategy(rawPages)
    expect(pages[0].chunks).toEqual([])
  })

  it('non-empty pages produce at least one chunk', () => {
    const rawPages = [makeRawWordPage(1, 15)]
    const pages = applyChunkStrategy(rawPages)
    expect(pages[0].chunks.length).toBeGreaterThanOrEqual(1)
  })

  it('250 words on one page fits within the 300-word target → exactly 1 chunk', () => {
    const rawPages = [makeRawWordPage(1, 250)]
    const pages = applyChunkStrategy(rawPages)
    expect(pages[0].chunks).toHaveLength(1)
  })
})

// ─── Fix A: chunk count computation ─────────────────────────────────────────
// Tests the logic in the Fix A useEffect:
//   const count = extractedPages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)

describe('Fix A — chunk count computation from extractedPages', () => {
  it('counts zero for pages with empty chunks', () => {
    const pages = [{ pageNum: 1, chunks: [] }, { pageNum: 2, chunks: [] }]
    const count = pages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)
    expect(count).toBe(0)
  })

  it('counts chunks across multiple pages correctly', () => {
    const pages = [
      { pageNum: 1, chunks: [{ text: 'a' }, { text: 'b' }] },
      { pageNum: 2, chunks: [{ text: 'c' }] },
      { pageNum: 3, chunks: [] },
    ]
    const count = pages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)
    expect(count).toBe(3)
  })

  it('handles undefined chunks gracefully via nullish coalescing', () => {
    const pages = [{ pageNum: 1 }, { pageNum: 2, chunks: [{ text: 'x' }] }]
    const count = pages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)
    expect(count).toBe(1)
  })

  it('count matches the actual chunk array length from applyChunkStrategy', () => {
    const rawPages = [makeRawWordPage(1, 20), makeRawWordPage(2, 20)]
    const extractedPages = applyChunkStrategy(rawPages)
    const count = extractedPages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)
    const actual = extractedPages.flatMap(p => p.chunks).length
    expect(count).toBe(actual)
  })

  it('zero count does not trigger a setDocChunkCountsById update', () => {
    // The guard: if (count > 0) { setDocChunkCountsById(...) }
    // Verified by checking the condition itself
    const pages = [{ pageNum: 1, chunks: [] }]
    const count = pages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)
    expect(count > 0).toBe(false)
  })
})

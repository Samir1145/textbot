import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker } from 'tesseract.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc

// PDFs with fewer than this many average chars/page are treated as scanned
const SCANNED_THRESHOLD = 50

// ── Coordinate helpers ─────────────────────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)) }

/**
 * Group word objects { text, x1_pct, y1_pct, x2_pct, y2_pct } into paragraph
 * chunks. Returns [{ text, bbox: [x1,y1,x2,y2], sourceWords }].
 * Coords are normalized fractions [0,1] with top-left origin.
 */
export function groupIntoParagraphs(words) {
  if (!words.length) return []

  const sorted = [...words].sort((a, b) => a.y1_pct - b.y1_pct || a.x1_pct - b.x1_pct)
  const avgH = sorted.reduce((s, w) => s + (w.y2_pct - w.y1_pct), 0) / sorted.length || 0.01

  // Pass 1: group words into lines (close y values = same line)
  const lines = []
  let curLine = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i]
    const lineBottom = Math.max(...curLine.map(x => x.y2_pct))
    if (w.y1_pct - lineBottom > avgH * 0.3) {
      lines.push(curLine)
      curLine = [w]
    } else {
      curLine.push(w)
    }
  }
  lines.push(curLine)
  for (const l of lines) l.sort((a, b) => a.x1_pct - b.x1_pct)

  // Pass 2: group lines into paragraphs (larger gap = new paragraph)
  const PARA_GAP = avgH * 1.5
  const paragraphs = []
  let curLines = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    const prevBottom = Math.max(...curLines[curLines.length - 1].map(w => w.y2_pct))
    const nextTop = Math.min(...lines[i].map(w => w.y1_pct))
    if (nextTop - prevBottom > PARA_GAP) {
      paragraphs.push(_makePara(curLines.flat()))
      curLines = [lines[i]]
    } else {
      curLines.push(lines[i])
    }
  }
  paragraphs.push(_makePara(curLines.flat()))
  return paragraphs
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
  return { text, bbox, sourceWords: sorted }
}

/** Extract word bboxes from PDF.js getTextContent() items + viewport. */
function extractNativeWords(items, viewport) {
  return items
    .filter(item => item.str?.trim())
    .map(item => {
      const tx = item.transform[4]
      const ty = item.transform[5]
      const w = item.width || 0
      const h = item.height || Math.abs(item.transform[3]) || 0
      return {
        text: item.str,
        x1_pct: clamp01(tx / viewport.width),
        y1_pct: clamp01((viewport.height - ty - h) / viewport.height),
        x2_pct: clamp01((tx + w) / viewport.width),
        y2_pct: clamp01((viewport.height - ty) / viewport.height),
      }
    })
}

/**
 * Extract paragraph chunks with bboxes from an already-loaded PDF.
 * Native text only (no OCR). Returns [{ pageNum, chunks }] or null if aborted.
 */
export async function extractPageChunksFromPDF(pdf, { onStatus, signal } = {}) {
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    if (signal?.aborted) return null
    onStatus?.(`Extracting page ${i} / ${pdf.numPages}…`)
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const words = extractNativeWords(tc.items, viewport)
    const chunks = words.length ? groupIntoParagraphs(words) : []
    pages.push({ pageNum: i, chunks })
  }
  return pages
}

// ── Load a previously saved extraction from the server ───────────────────
// Returns { text, isOcr, createdAt } or null
export async function loadExtraction(docId, { caseId } = {}) {
  try {
    const url = caseId
      ? `/api/cases/${encodeURIComponent(caseId)}/extractions/${docId}`
      : `/api/extractions/${docId}`
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ── Extract text + bbox data from a PDF File and persist ─────────────────
// Returns { text, isOcr, pages: [{pageNum, chunks: [{text, bbox, sourceWords}]}] }
// or null if aborted
export async function extractAndSaveText(docId, file, { onStatus, signal, caseId, onPartialResult, visiblePages = 5 } = {}) {
  const url = URL.createObjectURL(file)
  let pdf

  try {
    onStatus?.('Loading PDF…')
    const task = pdfjsLib.getDocument({ url, standardFontDataUrl: '/standard_fonts/', cMapUrl: '/cmaps/', cMapPacked: true })
    if (signal) signal.addEventListener('abort', () => task.destroy(), { once: true })
    pdf = await task.promise
  } finally {
    URL.revokeObjectURL(url)
  }

  if (signal?.aborted) { pdf.destroy(); return null }

  const numPages = pdf.numPages

  // ── Step 1: extract native text + bboxes for all pages (also used for scanned detection) ──
  onStatus?.('Detecting PDF type…')
  let totalChars = 0
  const nativePages = []

  for (let i = 1; i <= numPages; i++) {
    if (signal?.aborted) { pdf.destroy(); return null }
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const words = extractNativeWords(tc.items, viewport)
    const text = words.map(w => w.text).join(' ').trim()
    nativePages.push({ pageNum: i, text, words })
    totalChars += text.length
  }

  const isScanned = (totalChars / numPages) < SCANNED_THRESHOLD

  let fullText
  let isOcr
  let pages // [{ pageNum, chunks: [{ text, bbox, sourceWords }] }]

  if (!isScanned) {
    // ── Native text PDF ────────────────────────────────────────────────────
    isOcr = false
    onStatus?.('Extracting text…')
    pages = nativePages.map(p => ({
      pageNum:  p.pageNum,
      chunks:   p.words.length ? groupIntoParagraphs(p.words) : [],
      rawWords: p.words,   // kept so re-chunking with a different word size is free
    }))
    fullText = nativePages
      .filter(p => p.text)
      .map(p => `--- Page ${p.pageNum} ---\n${p.text}`)
      .join('\n\n')

    // Emit first visiblePages early so LexChat can answer before full save completes
    if (onPartialResult && pages.length > visiblePages) {
      const partial = pages.slice(0, visiblePages)
      const partialText = nativePages.slice(0, visiblePages).filter(p => p.text)
        .map(p => `--- Page ${p.pageNum} ---\n${p.text}`).join('\n\n')
      if (partialText.trim()) onPartialResult({ text: partialText, pages: partial })
    }

  } else {
    // ── Scanned PDF — render each page and OCR it ──────────────────────────
    isOcr = true
    onStatus?.(`Scanned PDF detected — starting OCR (${numPages} page${numPages > 1 ? 's' : ''})…`)

    const worker = await createWorker('eng')
    const ocrResults = []

    for (let i = 1; i <= numPages; i++) {
      if (signal?.aborted) { await worker.terminate(); pdf.destroy(); return null }
      onStatus?.(`OCR — page ${i} of ${numPages}…`)

      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 2.0 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise

      const { data } = await worker.recognize(canvas)
      const words = (data.words || [])
        .filter(w => w.text?.trim() && w.confidence > 20)
        .map(w => ({
          text: w.text,
          x1_pct: clamp01(w.bbox.x0 / canvas.width),
          y1_pct: clamp01(w.bbox.y0 / canvas.height),
          x2_pct: clamp01(w.bbox.x1 / canvas.width),
          y2_pct: clamp01(w.bbox.y1 / canvas.height),
        }))
      const chunks = words.length ? groupIntoParagraphs(words) : []
      ocrResults.push({ pageNum: i, text: data.text.trim(), chunks, rawWords: words })

      // Emit partial results progressively so LexChat can answer as OCR completes
      if (onPartialResult) {
        const partialPgs = ocrResults.map(p => ({ pageNum: p.pageNum, chunks: p.chunks }))
        const partialTxt = ocrResults.map(p => `--- Page ${p.pageNum} ---\n${p.text}`).join('\n\n')
        onPartialResult({ text: partialTxt, pages: partialPgs })
      }
    }

    await worker.terminate()
    pages = ocrResults.map(p => ({ pageNum: p.pageNum, chunks: p.chunks, rawWords: p.rawWords || [] }))
    fullText = ocrResults
      .map(p => `--- Page ${p.pageNum} ---\n${p.text}`)
      .join('\n\n')
  }

  pdf.destroy()

  if (!fullText?.trim()) {
    throw new Error('No text could be extracted from this PDF.')
  }

  // Persist text + bbox pages (sourceWords stripped to reduce payload size)
  const saveUrl = caseId
    ? `/api/cases/${encodeURIComponent(caseId)}/extractions/${docId}`
    : `/api/extractions/${docId}`
  const pagesForCache = pages.map(p => ({
    pageNum:  p.pageNum,
    chunks:   p.chunks.map(({ text, bbox }) => ({ text, bbox })),
    rawWords: p.rawWords || [],   // persisted so re-chunking never requires re-OCR/re-extraction
  }))
  await fetch(saveUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fullText, isOcr, pages: pagesForCache, createdAt: new Date().toISOString() }),
  })

  return { text: fullText, isOcr, pages }
}

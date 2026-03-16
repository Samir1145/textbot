import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { flushSync, createPortal } from 'react-dom'
import { useTheme } from '../useTheme.js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { uploadCaseBlob, loadCaseBlob, deleteCaseBlob, loadChatHistory, saveChatHistory, loadNotes, saveNotes, loadAllNotes, deleteNotes, deleteSummary } from '../db.js'
import { FORMAT_CATEGORIES } from '../skills/formatsIndex.js'
import { getDocRagStatus, indexDocPages, pruneDocChunks, clearDocChunks, searchDocChunks, searchCaseChunks, initFormatCategories } from '../rag.js'
import { extractAndSaveText, loadExtraction, extractPageChunksFromPDF, groupIntoParagraphs } from '../utils/pdfExtract.js'
import { getCachedThumb, setCachedThumb } from '../utils/thumbnailCache.js'
import { buildEvidenceBlock, parseCitations, tokeniseMessage, narrowCitations, distanceToScore } from '../utils/parseCitations.js'
import { findTextInTextLayer } from '../utils/textLayerSearch.js'
import { streamOllamaChat, callOllama, checkLlmHealth, LLM_BACKEND_NAME, LLM_MODEL_NAME } from '../utils/ollamaStream.js'
import './PDFApp.css'

// ── Follow-up suggestion generator ─────────────────────────────────────────
async function _fetchSuggestions(question, answer) {
  const content = await callOllama({
    messages: [
      { role: 'system', content: 'Generate exactly 3 concise follow-up questions based on this Q&A exchange. Return ONLY a valid JSON array of 3 short question strings, nothing else.' },
      { role: 'user', content: `Q: ${question}\nA: ${answer.slice(0, 600)}` },
    ],
  })
  if (!content) return []
  const match = content.match(/\[[\s\S]*?\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    return Array.isArray(parsed) ? parsed.slice(0, 3).map(String) : []
  } catch { return [] }
}

// ── Word-count-based chunk merging ──────────────────────────────────────────
// Merges paragraph chunks so each resulting chunk is ≤ targetWords words.
function estimateTokens(text) {
  return text.trim().split(/\s+/).length
}

// Bbox from a list of sourceWords (tight, word-level).
function _bboxFromWords(words) {
  if (!words?.length) return null
  return [
    Math.min(...words.map(w => w.x1_pct)),
    Math.min(...words.map(w => w.y1_pct)),
    Math.max(...words.map(w => w.x2_pct)),
    Math.max(...words.map(w => w.y2_pct)),
  ]
}

// Per-line bboxes from a list of sourceWords.
// Groups words into lines by y-band, returns [[x1,y1,x2,y2], ...] — one rect per line.
// This produces multi-stripe highlights that hug each text row without covering
// whitespace between lines or column gutters.
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

// Split a single chunk that exceeds targetTokens into smaller pieces.
// Uses sourceWords for word-level splits with precise per-piece bboxes.
// Falls back to sentence-level splits with the paragraph bbox when sourceWords absent.
function splitChunk(chunk, targetTokens) {
  const t = estimateTokens(chunk.text)
  if (t <= targetTokens) return [chunk]

  const words = chunk.sourceWords
  if (words?.length >= 2) {
    // Word-level split — each piece gets a tight bbox from its own words
    const pieces = []
    let wBuf = []
    for (const word of words) {
      if (wBuf.length >= targetTokens) {
        pieces.push({ text: wBuf.map(w => w.text).join(' '), bbox: _bboxFromWords(wBuf), sourceWords: wBuf })
        wBuf = []
      }
      wBuf.push(word)
    }
    if (wBuf.length) pieces.push({ text: wBuf.map(w => w.text).join(' '), bbox: _bboxFromWords(wBuf), sourceWords: wBuf })
    return pieces
  }

  // Fallback: sentence split — pieces share the paragraph bbox (no sourceWords)
  const sentences = chunk.text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 5)
  if (sentences.length <= 1) return [chunk]
  const pieces = []
  let sBuf = []
  let sBufTokens = 0
  for (const sent of sentences) {
    const st = estimateTokens(sent)
    if (sBuf.length > 0 && sBufTokens + st > targetTokens) {
      pieces.push({ text: sBuf.join(' '), bbox: chunk.bbox })
      sBuf = []
      sBufTokens = 0
    }
    sBuf.push(sent)
    sBufTokens += st
  }
  if (sBuf.length) pieces.push({ text: sBuf.join(' '), bbox: chunk.bbox })
  return pieces.length ? pieces : [chunk]
}

function mergeChunksByTokens(pages, targetTokens) {
  const merged = []
  for (const page of pages) {
    let buf = []         // accumulates chunk pieces to merge
    let bufWords = []    // sourceWords from all pieces in buf (for tight bbox)
    let bufTokens = 0
    const flush = () => {
      if (!buf.length) return
      const text = buf.map(c => c.text).join(' ')
      // Prefer tight word-level bbox; fall back to envelope union of paragraph bboxes
      const bbox = bufWords.length >= 2
        ? _bboxFromWords(bufWords)
        : buf.every(c => c.bbox)
          ? [
              Math.min(...buf.map(c => c.bbox[0])),
              Math.min(...buf.map(c => c.bbox[1])),
              Math.max(...buf.map(c => c.bbox[2])),
              Math.max(...buf.map(c => c.bbox[3])),
            ]
          : null
      merged.push({ pageNum: page.pageNum, text, bbox })
      buf = []
      bufWords = []
      bufTokens = 0
    }
    for (const rawChunk of page.chunks) {
      if (!rawChunk.text?.trim() || rawChunk.text.length < 15) continue
      // Split oversized chunks before merging — this is what makes precision actually work
      const pieces = splitChunk(rawChunk, targetTokens)
      for (const chunk of pieces) {
        if (!chunk.text?.trim()) continue
        const t = estimateTokens(chunk.text)
        if (buf.length > 0 && bufTokens + t > targetTokens) flush()
        buf.push(chunk)
        if (chunk.sourceWords?.length) bufWords.push(...chunk.sourceWords)
        bufTokens += t
      }
    }
    flush()
  }
  return merged
}

// ── Shared abbreviation guard (prevents splitting on "Dr.", "Inc.", etc.) ──
const _ABBREVS = /^(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Co|Corp|vs|cf|et|al|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|No|Art|Sec|cl|para)\.$/

// Split a paragraph (with sourceWords) into sentence objects [{text, words}].
// Shared by all three chunkers below.
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
      && (!next || /^[A-Z("]/.test(next.text.trim()))
    if (isBoundary && cur.length >= 5) {
      sentences.push({ text: cur.map(w => w.text).join(' '), words: [...cur] })
      cur = []
    }
  }
  if (cur.length >= 3) sentences.push({ text: cur.map(w => w.text).join(' '), words: cur })
  return sentences.length > 0 ? sentences : [{ text: para.text, words }]
}

// ── Strategy 1: Clause ───────────────────────────────────────────────────
// Splits at sentence boundaries, semicolons (legal enumeration), and
// legal section markers (ARTICLE, Section, (a), numbered items).
// Best for precise citation lookup and clause-level highlights.
function chunkByClauses(pages) {
  const MIN_WORDS = 6
  const MAX_WORDS = 100
  const SECTION_RE = /^(ARTICLE|Section|CLAUSE|SCHEDULE|WHEREAS|NOW|WITNESSETH)\b/i
  const LEGAL_ITEM_RE = /^(\([a-z]\)|\([ivxIVX]+\)|\d+\.\s)/
  const result = []

  for (const page of pages) {
    const words = page.rawWords?.length
      ? page.rawWords
      : (page.chunks ?? []).flatMap(c => c.sourceWords ?? [])

    if (!words.length) {
      for (const c of (page.chunks ?? []))
        if (c.text?.trim()) result.push({ pageNum: page.pageNum, text: c.text, bbox: c.bbox, lineRects: _lineRectsFromWords(c.sourceWords), sourceWords: c.sourceWords })
      continue
    }

    let buf = []
    const flush = () => {
      if (buf.length < MIN_WORDS) return
      if (buf.length > MAX_WORDS) {
        for (let i = 0; i < buf.length; i += MAX_WORDS) {
          const s = buf.slice(i, i + MAX_WORDS)
          result.push({ pageNum: page.pageNum, text: s.map(w => w.text).join(' '), bbox: _bboxFromWords(s), lineRects: _lineRectsFromWords(s), sourceWords: s })
        }
      } else {
        result.push({ pageNum: page.pageNum, text: buf.map(w => w.text).join(' '), bbox: _bboxFromWords(buf), lineRects: _lineRectsFromWords(buf), sourceWords: buf })
      }
      buf = []
    }

    for (let i = 0; i < words.length; i++) {
      buf.push(words[i])
      const raw = words[i].text.trimEnd()
      const next = words[i + 1]
      const isSentenceEnd = /[.?!]$/.test(raw) && !_ABBREVS.test(raw) && (!next || /^[A-Z("]/.test(next.text.trim()))
      const isSemicolon   = raw.endsWith(';')
      const nextIsMarker  = next && (SECTION_RE.test(next.text) || LEGAL_ITEM_RE.test(next.text))
      if ((isSentenceEnd || isSemicolon || nextIsMarker) && buf.length >= MIN_WORDS) flush()
    }
    flush()
  }
  return result
}

// ── Strategy 2: Sentence ────────────────────────────────────────────────
// Splits at sentence boundaries only. Each sentence is one chunk.
// The LLM receives ±windowSize surrounding sentences at query time for context.
// Best for precise search + full-context answers.
function chunkBySentences(pages) {
  const MIN_WORDS = 5
  const MAX_WORDS = 80
  const result = []

  for (const page of pages) {
    const words = page.rawWords?.length
      ? page.rawWords
      : (page.chunks ?? []).flatMap(c => c.sourceWords ?? [])

    if (!words.length) {
      for (const c of (page.chunks ?? []))
        if (c.text?.trim()) result.push({ pageNum: page.pageNum, text: c.text, bbox: c.bbox, lineRects: _lineRectsFromWords(c.sourceWords), sourceWords: c.sourceWords })
      continue
    }

    let buf = []
    const flush = () => {
      if (buf.length < MIN_WORDS) return
      if (buf.length > MAX_WORDS) {
        for (let i = 0; i < buf.length; i += MAX_WORDS) {
          const s = buf.slice(i, i + MAX_WORDS)
          result.push({ pageNum: page.pageNum, text: s.map(w => w.text).join(' '), bbox: _bboxFromWords(s), lineRects: _lineRectsFromWords(s), sourceWords: s })
        }
      } else {
        result.push({ pageNum: page.pageNum, text: buf.map(w => w.text).join(' '), bbox: _bboxFromWords(buf), lineRects: _lineRectsFromWords(buf), sourceWords: buf })
      }
      buf = []
    }

    for (let i = 0; i < words.length; i++) {
      buf.push(words[i])
      const raw = words[i].text.trimEnd()
      const next = words[i + 1]
      const isSentenceEnd = /[.?!]$/.test(raw) && !_ABBREVS.test(raw) && (!next || /^[A-Z("]/.test(next.text.trim()))
      if (isSentenceEnd && buf.length >= MIN_WORDS) flush()
    }
    flush()
  }
  return result
}

// ── Strategy 3: Recursive ───────────────────────────────────────────────
// Accumulates paragraphs up to targetWords. If a paragraph exceeds the
// target it's split into sentences; sentences that still exceed are split
// by words. Merges adjacent small units to avoid orphan fragments.
// Best for general Q&A with balanced precision and context.
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
      const t = estimateTokens(para.text)

      if (t <= targetWords) {
        if (accT > 0 && accT + t > targetWords) flushAcc()
        acc.push(...paraWords); accT += t
      } else {
        flushAcc()
        for (const sent of _splitParaIntoSentences(para)) {
          const st = estimateTokens(sent.text)
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

// Configure pdfjs worker for bundlers like Vite
// IMPORTANT: Do NOT set workerPort to a shared Worker instance.
// When a loadingTask is destroyed (cleanup on doc switch), it terminates
// the shared worker, killing all subsequent PDF loads and crashing the app.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc

const SIDEBAR_EXPANDED_PCT = 20   // % of total viewport
const COLLAPSED_WIDTH_PX = 40
const CENTER_DEFAULT_PCT = 50   // % of non-sidebar space
const MIN_SPLIT_PCT = 20   // minimum for center OR right, of non-sidebar space
const MAX_SPLIT_PCT = 80

export default function PDFApp({ folder, caseId, caseName, onBack, onAddFiles }) {
  const { theme, toggleTheme } = useTheme()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // centerSplit: % of the non-sidebar space that center takes (20–80)
  const [centerSplit, setCenterSplit] = useState(CENTER_DEFAULT_PCT)

  // ── Parties — groups of documents ─────────────────────────────────────────
  const [parties, setParties] = useState(() => {
    // If scoped to a case, load parties from localStorage
    if (caseId) {
      try {
        const saved = JSON.parse(localStorage.getItem(`pdf-parties-${caseId}`) || 'null')
        if (Array.isArray(saved) && saved.length > 0) return saved
      } catch { /* ignore */ }
      return []
    }
    const initialDocs = (folder?.children || [])
      .filter(c => c.type === 'file')
      .map(c => ({ id: String(c.id), name: c.name, file: c.file }))
    if (initialDocs.length === 0) return []
    return [{ id: crypto.randomUUID(), name: 'Folder 1', documents: initialDocs }]
  })
  const [activePartyId, setActivePartyId] = useState(null)
  const [collapsedParties, setCollapsedParties] = useState({})
  const [docStatuses, setDocStatuses] = useState(() => {
    if (!caseId) return {}
    try { return JSON.parse(localStorage.getItem(`pdf-statuses-${caseId}`) || '{}') } catch { return {} }
  })
  const [renamingPartyId, setRenamingPartyId] = useState(null)
  const pendingAddPartyRef = useRef(null) // partyId to assign the next file upload to

  // ── RAG query result cache — avoids re-hitting sqlite-vec for repeated questions ──
  const ragQueryCacheRef = useRef(new Map()) // key → rawChunks[]

  // Flat document list derived from parties — used by all existing pdf/extraction/chat logic
  const documents = useMemo(() => parties.flatMap(p => p.documents), [parties])

  const [activeDocumentId, setActiveDocumentId] = useState(() => {
    const first = (folder?.children || []).find(c => c.type === 'file')
    return first ? String(first.id) : null
  })
  const activeDoc = useMemo(() => documents.find(d => d.id === activeDocumentId), [documents, activeDocumentId])
  const [activeDocUrl, setActiveDocUrl] = useState(null)
  const [pageCount, setPageCount] = useState(null)
  const [pageCountsById, setPageCountsById] = useState(() => {
    if (!caseId) return {}
    try { return JSON.parse(localStorage.getItem(`pdf-pagecounts-${caseId}`) || '{}') } catch { return {} }
  })
  const [docChunkCountsById, setDocChunkCountsById] = useState(() => {
    if (!caseId) return {}
    try { return JSON.parse(localStorage.getItem(`pdf-chunkcounts-${caseId}`) || '{}') } catch { return {} }
  })
  const [pageDims, setPageDims] = useState({})   // pageNum → {w,h} — drives skeleton sizing
  const [renderScale, setRenderScale] = useState(1.0)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState(null)
  const [pdfMainThreadReady, setPdfMainThreadReady] = useState(false)
  const [thumbsOpen, setThumbsOpen] = useState(false)
const fileInputRef = useRef(null)
  const pagesContainerRef = useRef(null)

  // Scroll a page canvas into view within the pages container only,
  // avoiding scrollIntoView which propagates to overflow:hidden ancestors (Chrome bug).
  const scrollPageIntoView = useCallback((pageNum, block = 'start') => {
    const container = pagesContainerRef.current
    if (!container) return
    const el = container.querySelector(`[data-page="${pageNum}"]`)
    if (!el) return
    const elRect = el.getBoundingClientRect()
    const cRect = container.getBoundingClientRect()
    let top
    if (block === 'center') {
      top = container.scrollTop + elRect.top - cRect.top - cRect.height / 2 + elRect.height / 2
    } else {
      top = container.scrollTop + elRect.top - cRect.top
    }
    addLogRef.current(`[SCROLL] → page ${pageNum} (${block}) scrollTop: ${Math.round(top)}`, 'info')
    container.scrollTo({ top, behavior: 'instant' })
  }, [])

  // Scroll so the bbox (or lineRects) midpoint is centered in the container viewport.
  // bbox / lineRects coords are normalized [0,1] fractions of the page height.
  const scrollBboxIntoView = useCallback((pageNum, bboxOrRects) => {
    const container = pagesContainerRef.current
    if (!container || !bboxOrRects) return scrollPageIntoView(pageNum, 'center')
    const el = container.querySelector(`[data-page="${pageNum}"]`)
    if (!el) return scrollPageIntoView(pageNum, 'center')
    // Determine the vertical centre of the highlighted region as a [0,1] fraction.
    let yCenterFrac
    if (Array.isArray(bboxOrRects[0])) {
      // lineRects — array of [x1,y1,x2,y2]; span from first top to last bottom
      yCenterFrac = (bboxOrRects[0][1] + bboxOrRects[bboxOrRects.length - 1][3]) / 2
    } else {
      // single bbox [x1,y1,x2,y2]
      yCenterFrac = (bboxOrRects[1] + bboxOrRects[3]) / 2
    }
    const elRect = el.getBoundingClientRect()
    const cRect  = container.getBoundingClientRect()
    // Absolute offset of the bbox centre from the top of the container's scroll area
    const bboxCenterAbs = container.scrollTop + elRect.top - cRect.top + yCenterFrac * elRect.height
    const top = bboxCenterAbs - cRect.height / 2
    addLogRef.current(`[SCROLL] → page ${pageNum} bbox-center yCtr=${yCenterFrac.toFixed(3)} scrollTop: ${Math.round(top)}`, 'info')
    container.scrollTo({ top, behavior: 'smooth' })
  }, [scrollPageIntoView])
  // ── Auto-fit: scale PDF to fill container width ────────────────────────
  const recalcScale = useCallback(() => {
    const container = pagesContainerRef.current
    const naturalW = pageDimsRef.current[1]?.w / renderScaleRef.current
    if (!container || !naturalW) {
      addLogRef.current(`[SCALE] skip — container=${!!container} naturalW=${naturalW}`, 'info')
      return
    }
    const available = container.clientWidth - 32 // subtract 16px padding each side
    const newScale = Math.max(0.4, +(available / naturalW).toFixed(2))
    const willUpdate = Math.abs(newScale - renderScaleRef.current) > 0.03
    addLogRef.current(
      `[SCALE] clientW=${container.clientWidth} naturalW=${Math.round(naturalW)} cur=${renderScaleRef.current.toFixed(2)} → new=${newScale.toFixed(2)} ${willUpdate ? '✦ UPDATING' : '(no change)'}`,
      willUpdate ? 'ok' : 'info'
    )
    if (willUpdate) setRenderScale(newScale)
  }, [])

  // Re-fit when panel split or sidebar changes (divider drag / sidebar toggle).
  // rAF defers until after the browser has applied the new flex layout so
  // container.clientWidth reflects the settled width.
  useEffect(() => {
    addLogRef.current(`[EFFECT] centerSplit/sidebarOpen changed → recalcScale (split=${centerSplit.toFixed(1)} sidebar=${sidebarOpen})`, 'info')
    const id = requestAnimationFrame(recalcScale)
    return () => cancelAnimationFrame(id)
  }, [centerSplit, sidebarOpen, recalcScale])

  // Re-fit when first page dims arrive (new doc loaded).
  useEffect(() => {
    if (!pageDims[1]) return
    addLogRef.current(`[EFFECT] pageDims[1].w changed (${pageDims[1]?.w}) → recalcScale`, 'info')
    const id = requestAnimationFrame(recalcScale)
    return () => cancelAnimationFrame(id)
  }, [pageDims[1]?.w, recalcScale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit on window resize (browser window resize / DevTools open-close).
  useEffect(() => {
    const onResize = () => {
      addLogRef.current('[EFFECT] window resize → recalcScale', 'info')
      requestAnimationFrame(recalcScale)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [recalcScale])

  // ── Persist doc statuses + page counts to localStorage ──────────────────
  // Placed here — after docStatuses AND pageCountsById are both declared —
  // to avoid a temporal dead zone reference in the dep arrays.
  useEffect(() => {
    if (caseId) localStorage.setItem(`pdf-statuses-${caseId}`, JSON.stringify(docStatuses))
  }, [docStatuses, caseId])
  useEffect(() => {
    if (caseId) localStorage.setItem(`pdf-pagecounts-${caseId}`, JSON.stringify(pageCountsById))
  }, [pageCountsById, caseId])
  // NOTE: chunking persistence useEffect is placed AFTER chunkingStrategy declaration (below)
  // to avoid TDZ — dep arrays are evaluated immediately when useEffect() is called.

  // ── PDF Notes ──
  const [notes, setNotes] = useState([])          // [{id, pageNum, x, y, text, createdAt}]
  const [noteMode, setNoteMode] = useState(false)        // true = click-to-place mode
  const [openNoteId, setOpenNoteId] = useState(null)

  const thumbsContainerRef = useRef(null)
  const pdfDocRef = useRef(null)         // main-thread pdf instance for text extraction
  const pageDimsRef = useRef({})         // mirror of pageDims state, readable inside callbacks
  const renderWorkerRef = useRef(null)
  const thumbWorkerRef = useRef(null)
  const observerRef = useRef(null)
  const thumbObserverRef = useRef(null)
  const renderScaleRef = useRef(1.0)
  // DEV: ref so pre-addLog callbacks can log into the activity panel
  const addLogRef = useRef(() => {})
  // Cross-doc navigation: set before switching activeDocumentId; consumed when new PDF is ready
  const pendingNavRef = useRef(null) // { pageNum, chunkText, bbox, narrowBbox, chunkIdx? }
  const pdfBufferRef = useRef(null)      // cached PDF bytes for zoom re-renders
  const prevActiveDocUrlRef = useRef(null)
  const prevActiveDocIdRef = useRef(null)

  const containerRef = useRef(null)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartSplit = useRef(CENTER_DEFAULT_PCT)

  const handleFilesSelected = (event) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return

    const pdfFiles = files.filter(
      f =>
        f.type === 'application/pdf' ||
        f.type === 'application/x-pdf' ||
        f.name.toLowerCase().endsWith('.pdf'),
    )

    if (!pdfFiles.length) {
      event.target.value = ''
      return
    }

    if (caseId) {
      // Case mode: add files directly to parties without going through the parent
      const newDocs = pdfFiles.map(f => ({
        id: crypto.randomUUID(),
        name: f.name,
        file: f,
      }))
      const targetId = pendingAddPartyRef.current
      pendingAddPartyRef.current = null
      setParties(prev => {
        if (!targetId || !prev.some(p => p.id === targetId)) {
          if (prev.length === 0) return [{ id: crypto.randomUUID(), name: 'Folder 1', documents: newDocs }]
          return [{ ...prev[0], documents: [...prev[0].documents, ...newDocs] }, ...prev.slice(1)]
        }
        return prev.map(p => p.id === targetId ? { ...p, documents: [...p.documents, ...newDocs] } : p)
      })
      if (newDocs.length > 0) setActiveDocumentId(newDocs[0].id)
      // Upload blobs to server so they persist across sessions
      newDocs.forEach(doc => uploadCaseBlob(caseId, doc.id, doc.name, doc.file))
    } else if (onAddFiles) {
      onAddFiles(pdfFiles)
    }

    // Allow selecting the same file again
    event.target.value = ''
  }

  const handleRemoveDocument = (docId) => {
    const doc = parties.flatMap(p => p.documents).find(d => d.id === docId)
    const docName = doc?.name || 'this document'
    const noteCount = (allCaseNotes[docId] || []).length
    const isIndexed = docChunkCountsById[docId] > 0
    setDeleteDocConfirm({ docId, docName, noteCount, isIndexed })
  }

  const confirmRemoveDocument = () => {
    if (!deleteDocConfirm) return
    const { docId } = deleteDocConfirm
    setDeleteDocConfirm(null)

    // Abort any in-flight extraction or indexing for this doc
    if (activeDocumentId === docId) {
      if (extractionAbortRef.current) { extractionAbortRef.current.abort(); extractionAbortRef.current = null }
      isIndexingRef.current = false
    }

    // 1. Remove from UI state immediately
    setParties(prev => prev.map(p => ({ ...p, documents: p.documents.filter(d => d.id !== docId) })))
    if (activeDocumentId === docId) setActiveDocumentId(null)

    // 2. Remove from badge count
    setAllCaseNotes(prev => { const next = { ...prev }; delete next[docId]; return next })

    // 3. Clear per-doc cached state
    setDocStatuses(prev => { const next = { ...prev }; delete next[docId]; return next })
    setPageCountsById(prev => { const next = { ...prev }; delete next[docId]; return next })
    setDocChunkCountsById(prev => { const next = { ...prev }; delete next[docId]; return next })

    // 4. Delete all server-side data (fire-and-forget — non-blocking)
    if (caseId) {
      const onDeleteError = (label) => (err) => addLog(`Delete failed (${label}): ${err?.message || err}`, 'error')
      deleteCaseBlob(caseId, docId).catch(onDeleteError('blob'))
      deleteNotes(docId, { caseId }).catch(onDeleteError('notes'))
      deleteSummary(docId, { caseId }).catch(onDeleteError('summary'))
      fetch(`/api/cases/${encodeURIComponent(caseId)}/extractions/${docId}`, { method: 'DELETE' }).catch(onDeleteError('extractions'))
      fetch(`/api/cases/${encodeURIComponent(caseId)}/chat/${docId}`, { method: 'DELETE' }).catch(onDeleteError('chat'))
      fetch(`/api/cases/${encodeURIComponent(caseId)}/highlights/${encodeURIComponent(docId)}`, { method: 'DELETE' }).catch(onDeleteError('highlights'))
      fetch(`/api/cases/${encodeURIComponent(caseId)}/skill-results/${encodeURIComponent(docId)}`, { method: 'DELETE' }).catch(onDeleteError('skill-results'))
      clearDocChunks(docId, { caseId }).catch(onDeleteError('chunks'))
    }
  }

  const handleAddParty = () => {
    const newId = crypto.randomUUID()
    setParties(prev => [...prev, { id: newId, name: `Folder ${prev.length + 1}`, documents: [] }])
    setActivePartyId(newId)
  }

  const handleAddDocToParty = (partyId) => {
    setActivePartyId(partyId)
    pendingAddPartyRef.current = partyId
    fileInputRef.current?.click()
  }

  const handleRenameParty = (partyId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setParties(prev => prev.map(p => p.id === partyId ? { ...p, name: trimmed } : p))
  }

  const handleRemoveParty = (partyId) => {
    const party = parties.find(p => p.id === partyId)
    if (party?.documents.some(d => d.id === activeDocumentId)) setActiveDocumentId(null)
    setParties(prev => prev.filter(p => p.id !== partyId))
    if (activePartyId === partyId) setActivePartyId(null)
  }

  // Rehydrate PDF blobs from server for case mode (files lost on page reload)
  useEffect(() => {
    if (!caseId) return
    setParties(prev => {
      const docsNeedingFiles = prev.flatMap(p =>
        p.documents.filter(d => !d.file).map(d => ({ partyId: p.id, doc: d }))
      )
      if (docsNeedingFiles.length === 0) return prev
      docsNeedingFiles.forEach(({ partyId, doc }) => {
        loadCaseBlob(caseId, doc.id, doc.name).then(file => {
          if (!file) return
          setParties(prev2 => prev2.map(p =>
            p.id !== partyId ? p : {
              ...p,
              documents: p.documents.map(d => d.id === doc.id ? { ...d, file } : d),
            }
          ))
        })
      })
      return prev
    })
  }, [caseId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist parties structure (without File objects) to localStorage when case-scoped
  useEffect(() => {
    if (!caseId) return
    const serializable = parties.map(p => ({
      id: p.id,
      name: p.name,
      documents: p.documents.map(d => ({ id: d.id, name: d.name })),
    }))
    localStorage.setItem(`pdf-parties-${caseId}`, JSON.stringify(serializable))
  }, [caseId, parties])

  // Assign files newly appeared in folder.children to the pending party
  useEffect(() => {
    setParties(prev => {
      const knownIds = new Set(prev.flatMap(p => p.documents.map(d => d.id)))
      const newDocs = (folder?.children || [])
        .filter(c => c.type === 'file' && !knownIds.has(String(c.id)))
        .map(c => ({ id: String(c.id), name: c.name, file: c.file }))
      if (!newDocs.length) return prev

      const targetId = pendingAddPartyRef.current
      pendingAddPartyRef.current = null

      if (!targetId || !prev.some(p => p.id === targetId)) {
        if (prev.length === 0) return [{ id: crypto.randomUUID(), name: 'Folder 1', documents: newDocs }]
        return [{ ...prev[0], documents: [...prev[0].documents, ...newDocs] }, ...prev.slice(1)]
      }
      return prev.map(p => p.id === targetId ? { ...p, documents: [...p.documents, ...newDocs] } : p)
    })
  }, [folder?.children]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure we always have an active doc if none selected
  useEffect(() => {
    if (activeDocumentId != null) {
      // Check if the current active document still exists
      if (documents.some(d => d.id === activeDocumentId)) return
    }
    if (documents.length === 0) {
      setActiveDocumentId(null)
    } else {
      setActiveDocumentId(documents[0].id)
    }
  }, [documents, activeDocumentId])

  // Create / cleanup object URL for the active document's file
  useEffect(() => {
    const activeDoc = documents.find(d => d.id === activeDocumentId)
    if (!activeDoc || !activeDoc.file) {
      setActiveDocUrl(null)
      return
    }
    const url = URL.createObjectURL(activeDoc.file)
    setActiveDocUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [activeDocumentId, documents])

  // Load PDF — rendering off main thread via OffscreenCanvas worker.
  // Handles both doc changes (full reset) and zoom changes (re-render only).
  useEffect(() => {
    renderScaleRef.current = renderScale
    const isDocChange = activeDocUrl !== prevActiveDocUrlRef.current
                     || activeDocumentId !== prevActiveDocIdRef.current
    prevActiveDocUrlRef.current = activeDocUrl
    prevActiveDocIdRef.current  = activeDocumentId

    // Reset scroll to top on doc change so new document starts from page 1
    if (isDocChange && pagesContainerRef.current) {
      pagesContainerRef.current.scrollTop = 0
    }

    // Always terminate the previous render worker and observer
    if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null }
    if (renderWorkerRef.current) { renderWorkerRef.current.terminate(); renderWorkerRef.current = null }

    if (isDocChange) {
      // Full reset — clear extraction + rendering state
      setPageCount(null)
      setPageDims({})
      pageDimsRef.current = {}
      setExtractedText(null)
      extractedTextRef.current = null
      setExtractedPages(extractionByDocRef.current[activeDocumentId] ?? null)
      setExtractionSource(null)
      setExtractionError(null)
      setExtractionStatus('')
      setExtractingText(false)
      if (extractionAbortRef.current) { extractionAbortRef.current.abort(); extractionAbortRef.current = null }
      if (pdfDocRef.current) { pdfDocRef.current.destroy(); pdfDocRef.current = null }
      pdfBufferRef.current = null
      setPdfMainThreadReady(false)
    }
    // (Zoom-only: extraction state kept; canvases remount via renderScale in key)

    if (!activeDocUrl) {
      if (isDocChange) { setPdfLoading(false); setPdfError(null) }
      return
    }

    let cancelled = false

    if (isDocChange) {
      setPdfLoading(true)
      setPdfError(null)
      // Restore cached dims from localStorage for instant skeleton sizing
      try {
        const saved = JSON.parse(localStorage.getItem(`pdf-dims-${activeDocumentId}`) || 'null')
        if (saved) { pageDimsRef.current = saved; setPageDims(saved) }
      } catch { /* ignore */ }
    }

    // ── Render worker (OffscreenCanvas — off main thread) ─────────────────
    const worker = new Worker(
      new URL('../workers/pdfRenderer.worker.js', import.meta.url),
      { type: 'module' }
    )
    renderWorkerRef.current = worker

    function setupObserver() {
      if (cancelled) return
      addLogRef.current(`[OBSERVER] setupObserver called — watching ${pagesContainerRef.current?.querySelectorAll('.pdfapp-page-canvas').length ?? 0} canvases`, 'info')
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const canvas  = entry.target
          const pageNum = parseInt(canvas.dataset.page, 10)
          if (!entry.isIntersecting) {
            // Cancel queued render if page leaves pre-render window before it starts
            if (!canvas.dataset.rendered) {
              renderWorkerRef.current?.postMessage({ type: 'cancel', pageNum })
            }
            return
          }
          if (canvas.dataset.rendered) {
            addLogRef.current(`[INTERSECT] page ${pageNum} in view — already rendered (skip)`, 'info')
            return
          }
          if (!canvas.isConnected) {
            addLogRef.current(`[INTERSECT] page ${pageNum} in view — not connected (skip)`, 'error')
            return
          }
          addLogRef.current(`[INTERSECT] page ${pageNum} in view → requesting render`, 'ok')
          renderWorkerRef.current?.postMessage({
            type: 'render', pageNum, dpr: window.devicePixelRatio || 1,
          })
        })
      }, { root: pagesContainerRef.current, rootMargin: '300px 0px 300px 0px' })

      observerRef.current = observer
      pagesContainerRef.current
        ?.querySelectorAll('.pdfapp-page-canvas')
        ?.forEach(canvas => observer.observe(canvas))
    }

    worker.onerror = (err) => {
      if (!cancelled) { setPdfError(err.message || 'Render worker error'); if (isDocChange) setPdfLoading(false) }
    }

    worker.onmessage = ({ data: msg }) => {
      if (cancelled) return
      if (msg.type === 'ready') {
        const { numPages, dims } = msg
        addLogRef.current(`[WORKER] ready — ${numPages} pages, dims[1]=${dims[1]?.w}×${dims[1]?.h}`, 'ok')
        pageDimsRef.current = dims
        // flushSync forces React to commit dim/size state to DOM before the
        // observer fires — prevents the canvas from displaying at raw physical-
        // pixel dimensions (2× on retina) before CSS sizes are applied.
        flushSync(() => {
          setPageDims(dims)
          // Always set pageCount + loading — safe no-op on zoom (same value).
          // Also fixes React StrictMode double-invoke: second run has isDocChange=false
          // because prevActiveDocUrlRef was already updated in the first run, so
          // guarding on isDocChange would leave pageCount=null permanently.
          setPageCount(numPages)
          setPageCountsById(prev => ({ ...prev, [activeDocumentId]: numPages }))
          setPdfLoading(false)
        })
        // DOM is already updated — single rAF to let the browser paint before observing
        requestAnimationFrame(() => {
          setupObserver()
          // Consume any pending cross-doc navigation (set before switching activeDocumentId)
          if (pendingNavRef.current) {
            const { pageNum, chunkText, bbox, narrowBbox, lineRects, chunkIdx } = pendingNavRef.current
            pendingNavRef.current = null
            setActiveCitations(new Map([[1, { text: chunkText, page_num: pageNum, bbox, narrowBbox, lineRects }]]))
            if (chunkIdx != null) {
              setActiveChunkKey(`${pageNum}-${chunkIdx}`)
              setExtractedTextOpen(true)
            }
          }
        })
      } else if (msg.type === 'dims-update') {
        // Some pages have different dimensions from page 1 — patch them
        const updated = { ...pageDimsRef.current, ...msg.dims }
        addLogRef.current(`[WORKER] dims-update for pages: ${Object.keys(msg.dims).join(', ')}`, 'info')
        pageDimsRef.current = updated
        setPageDims(updated)
      } else if (msg.type === 'rendered') {
        const { pageNum, bitmap } = msg
        addLogRef.current(`[WORKER] rendered page ${pageNum}`, 'info')

        // Draw bitmap onto the main-thread canvas — main thread keeps full control
        const canvas = pagesContainerRef.current?.querySelector(`[data-page="${pageNum}"]`)
        if (canvas && bitmap) {
          canvas.width  = bitmap.width
          canvas.height = bitmap.height
          canvas.getContext('2d').drawImage(bitmap, 0, 0)
          bitmap.close()
          canvas.dataset.rendered = 'true'
          canvas.style.backgroundColor = 'transparent'
        } else {
          bitmap?.close()
        }

        // Build text layer after the page is drawn.
        // pdfDocRef may still be loading (main-thread load is async; worker can finish first).
        // Retry up to 15 × 200ms while waiting for pdfDocRef to become available.
        ;(function buildTextLayer(attempt) {
          if (cancelled) return
          if (!pdfDocRef.current) {
            if (attempt < 15) setTimeout(() => buildTextLayer(attempt + 1), 200)
            return
          }
          const scale = renderScaleRef.current
          pdfDocRef.current.getPage(pageNum).then(page => {
            if (cancelled) return
            const vp = page.getViewport({ scale })
            return page.getTextContent().then(tc => {
              if (cancelled) return
              const container = pagesContainerRef.current?.querySelector(`[data-textlayer="${pageNum}"]`)
              if (!container) return
              container.innerHTML = ''
              new pdfjsLib.TextLayer({ textContentSource: tc, container, viewport: vp }).render()
            })
          }).catch(() => {})
        })(0)
      } else if (msg.type === 'error') {
        if (!cancelled) { setPdfError(msg.error || 'PDF render error'); if (isDocChange) setPdfLoading(false) }
      }
    }

    // Init worker — reuse cached buffer on zoom, fetch fresh on doc change
    if (!isDocChange && pdfBufferRef.current) {
      // Zoom: re-init with cached buffer (zero new network requests)
      const renderBuffer = pdfBufferRef.current.slice(0)
      worker.postMessage({ type: 'init', pdfData: renderBuffer, scale: renderScale }, [renderBuffer])
      // Rebuild main pdfDoc from cached buffer if it was destroyed (e.g. React strict mode
      // double-invoke: Effect 1 sets pdfDocRef then cleanup destroys it; Effect 2 lands here)
      if (!pdfDocRef.current) {
        pdfjsLib.getDocument({
          data: pdfBufferRef.current.slice(0),
          standardFontDataUrl: '/standard_fonts/',
          cMapUrl: '/cmaps/',
          cMapPacked: true,
        }).promise.then(pdf => {
          if (cancelled) { pdf.destroy(); return }
          pdfDocRef.current = pdf
          setPdfMainThreadReady(true)
        }).catch(() => {})
      }
    } else {
      // Doc change: fetch once, split into two copies
      fetch(activeDocUrl)
        .then(r => {
          if (!r.ok) throw new Error(`Failed to fetch PDF (${r.status})`)
          return r.arrayBuffer()
        })
        .then(async (buffer) => {
          if (cancelled) return
          pdfBufferRef.current  = buffer.slice(0)  // save for zoom re-renders
          const renderBuffer    = buffer             // transferred (zero-copy) to worker
          const mainBuffer      = buffer.slice(0)   // clone for main-thread pdf.js

          worker.postMessage({ type: 'init', pdfData: renderBuffer, scale: renderScale }, [renderBuffer])

          // Main-thread pdf.js for extraction / summarise / RAG indexing
          const task = pdfjsLib.getDocument({
            data: mainBuffer,
            standardFontDataUrl: '/standard_fonts/',
            cMapUrl: '/cmaps/',
            cMapPacked: true,
          })
          const pdf  = await task.promise
          if (cancelled) { pdf.destroy(); return }
          pdfDocRef.current = pdf
          setPdfMainThreadReady(true)
        })
        .catch(err => {
          if (!cancelled) { setPdfError(err?.message || 'Failed to load PDF'); if (isDocChange) setPdfLoading(false) }
        })
    }

    return () => {
      cancelled = true
      if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null }
      if (renderWorkerRef.current) { renderWorkerRef.current.terminate(); renderWorkerRef.current = null }
      // Destroy main pdf only on doc change (kept alive across zoom changes for extraction)
      if (isDocChange && pdfDocRef.current) { pdfDocRef.current.destroy(); pdfDocRef.current = null }
    }
  }, [activeDocUrl, activeDocumentId, renderScale])

  // Thumbnail worker — spun up when the thumbnail panel opens
  useEffect(() => {
    if (!thumbsOpen || !pdfBufferRef.current || !pageCount) {
      if (thumbWorkerRef.current) { thumbWorkerRef.current.terminate(); thumbWorkerRef.current = null }
      if (thumbObserverRef.current) { thumbObserverRef.current.disconnect(); thumbObserverRef.current = null }
      return
    }

    let cancelled = false
    const worker = new Worker(
      new URL('../workers/pdfRenderer.worker.js', import.meta.url),
      { type: 'module' }
    )
    thumbWorkerRef.current = worker

    worker.onmessage = ({ data: msg }) => {
      if (cancelled) return

      // Worker sends back an ImageBitmap — draw onto the thumbnail canvas and cache.
      if (msg.type === 'rendered' && msg.bitmap) {
        const canvas = thumbsContainerRef.current?.querySelector(`.pdfapp-thumb-canvas[data-page="${msg.pageNum}"]`)
        if (canvas?.isConnected) {
          const ctx = canvas.getContext('2d')
          canvas.width  = msg.bitmap.width
          canvas.height = msg.bitmap.height
          ctx?.drawImage(msg.bitmap, 0, 0)
          // Cache as JPEG blob for next session
          if (activeDocumentId) {
            const tmp = new OffscreenCanvas(msg.bitmap.width, msg.bitmap.height)
            tmp.getContext('2d').drawImage(msg.bitmap, 0, 0)
            tmp.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
              .then(blob => setCachedThumb(activeDocumentId, msg.pageNum, blob))
              .catch(() => {})
          }
        }
        msg.bitmap.close()
      }

      if (msg.type !== 'ready') return
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled || !thumbsContainerRef.current) return
        const observer = new IntersectionObserver((entries) => {
          entries.forEach(async entry => {
            if (!entry.isIntersecting) return
            const canvas = entry.target
            if (canvas.dataset.rendered || !canvas.isConnected) return
            canvas.dataset.rendered = 'true' // claim immediately to prevent double-processing

            const pageNum = parseInt(canvas.dataset.page, 10)

            // Check IDB cache — draw directly without involving the worker
            const cached = await getCachedThumb(activeDocumentId, pageNum)
            if (cached && canvas.isConnected) {
              try {
                const bmp = await createImageBitmap(cached)
                const ctx = canvas.getContext('2d')
                canvas.width  = bmp.width
                canvas.height = bmp.height
                ctx?.drawImage(bmp, 0, 0)
                bmp.close()
                return
              } catch { /* fall through to worker if IDB blob is corrupt */ }
            }

            // Not cached — request render from worker (ImageBitmap protocol)
            if (!canvas.isConnected) return
            thumbWorkerRef.current?.postMessage({ type: 'render', pageNum, dpr: 1 })
          })
        }, { root: thumbsContainerRef.current, rootMargin: '600px' })
        thumbObserverRef.current = observer
        thumbsContainerRef.current
          ?.querySelectorAll('.pdfapp-thumb-canvas')
          ?.forEach(c => observer.observe(c))
      }))
    }

    const buf = pdfBufferRef.current.slice(0)
    worker.postMessage({ type: 'init', pdfData: buf, scale: 0.15 }, [buf])

    return () => {
      cancelled = true
      worker.terminate()
      thumbWorkerRef.current = null
      if (thumbObserverRef.current) { thumbObserverRef.current.disconnect(); thumbObserverRef.current = null }
    }
  }, [thumbsOpen, pageCount])

  // ── Summarize (OCR + Text LLM) ────────────────

  // Stores bbox-rich pages from the most recent extraction for this doc (avoids re-OCR when indexing)
  const lastExtractionPagesRef = useRef({ docId: null, pages: null })
  const extractedTextRef = useRef(null)

  // ── RAG state ──
  const [ragStatus, setRagStatus] = useState(null)   // null | 'indexing' | 'indexed' | 'failed'
  const [ragProgress, setRagProgress] = useState('')

  // ── Chunking strategy (Option D — case-level setting) ──────────────────
  const CHUNKING_STRATEGIES = {
    clause:    { label: 'Clause',    windowSize: 0 },
    sentence:  { label: 'Sentence',  windowSize: 2 },
    recursive: { label: 'Recursive', windowSize: 0, targetWords: 300 },
  }
  const [chunkingStrategy, setChunkingStrategy] = useState(() => {
    const saved = caseId && localStorage.getItem(`chunking-${caseId}`)
    return (saved && CHUNKING_STRATEGIES[saved]) ? saved : 'recursive'
  })
  const [chunkGuideOpen, setChunkGuideOpen] = useState(false)
  const [deleteDocConfirm, setDeleteDocConfirm] = useState(null) // { docId, docName, noteCount, isIndexed }
  // ── Connectivity warnings ──────────────────────────────────────────────
  const [connectivity, setConnectivity] = useState({ llm: null, embed: null }) // null=checking, {ok,error}=result
  // ── Connectivity check — runs once on mount, can be re-triggered ──────────
  const checkConnectivity = useCallback(async () => {
    setConnectivityDismissed(false)
    const [llmRes, embedRes] = await Promise.allSettled([
      checkLlmHealth(),
      fetch('/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
    ])
    setConnectivity({
      llm:   llmRes.status   === 'fulfilled' ? llmRes.value   : { ok: false, error: 'unreachable' },
      embed: embedRes.status === 'fulfilled' ? embedRes.value.embed : { ok: false, error: 'unreachable' },
    })
  }, [])

  useEffect(() => {
    // Initial check + one automatic retry after 4 s (covers slow Ollama startup)
    checkConnectivity()
    const retryId = setTimeout(checkConnectivity, 4000)
    return () => clearTimeout(retryId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persistence effects for chunking + chunk counts — must be after their declarations (TDZ)
  useEffect(() => {
    if (caseId) localStorage.setItem(`chunking-${caseId}`, chunkingStrategy)
  }, [chunkingStrategy, caseId])
  useEffect(() => {
    if (caseId) localStorage.setItem(`pdf-chunkcounts-${caseId}`, JSON.stringify(docChunkCountsById))
  }, [docChunkCountsById, caseId])

  // ── Evidence (starred sources + notes → report) ──
  const [starredSources, setStarredSources] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`starred-${caseId || 'solo'}`) || '[]') } catch { return [] }
  })
  const [allCaseNotes, setAllCaseNotes] = useState({}) // { [docId]: NoteObject[] }
  const [rightTab, setRightTab] = useState('chat') // 'chat' | 'notes' | 'aide' | 'law'
  const [notesCollapsed, setNotesCollapsed] = useState({}) // { 'section:starred'|'party:id'|'doc:id'|'note-exp:id': bool }
  const [editingNoteId, setEditingNoteId] = useState(null)
  const [editingNoteDraft, setEditingNoteDraft] = useState('')
  // ── Aide state ──
  const [aideTask,   setAideTask]   = useState('')
  const [aideIntent, setAideIntent] = useState('')
  const [aideRole,   setAideRole]   = useState('')
  const [aideJobId,  setAideJobId]  = useState(null)
  const [aideSteps,  setAideSteps]  = useState([])
  const [aideStatus, setAideStatus] = useState('idle') // 'idle'|'running'|'done'|'error'|'cancelled'
  const [aideResult, setAideResult] = useState(null)
  const aideEsRef = useRef(null)

  // ── Aide Soul / Memory ────────────────────────────────────────────────────
  const [aideSoulTab,    setAideSoulTab]    = useState('run') // 'run' | 'soul' | 'memory'
  const [aideSoul,       setAideSoul]       = useState({ skillMd: '', redFlags: '', styleGuide: '', corrections: [], styleSamples: [] })
  const [aideDiary,      setAideDiary]      = useState([])
  const [aideSoulDirty,  setAideSoulDirty]  = useState(false)
  const [aideSoulSaving, setAideSoulSaving] = useState(false)
  const [aideSoulSavedAt,setAideSoulSavedAt]= useState(null)
  const [aideNewCorrection, setAideNewCorrection] = useState('')
  const [aideDiaryOpen,  setAideDiaryOpen]  = useState(new Set())
  const [aideSkillFileName, setAideSkillFileName] = useState('')
  const isIndexingRef = useRef(false)   // ref guard — prevents concurrent / loop-triggered indexing

  // ── Law tab state ─────────────────────────────────────────────────────────
  const [lawSubTab,      setLawSubTab]      = useState('search') // 'search' | 'import'
  const [lawQuery,       setLawQuery]       = useState('')
  const [lawResults,     setLawResults]     = useState([])
  const [lawSearching,   setLawSearching]   = useState(false)
  const [lawFilters,     setLawFilters]     = useState({ court: '', jurisdiction: '', yearFrom: '', yearTo: '' })
  const [lawStatus,      setLawStatus]      = useState(null)   // corpus status from /api/caselaw/status
  const [lawUploadFile,  setLawUploadFile]  = useState(null)   // staged .db file for import
  const [lawUploading,   setLawUploading]   = useState(false)
  const [lawVersions,    setLawVersions]    = useState([])
  const [lawImportMsg,   setLawImportMsg]   = useState(null)   // { type: 'ok'|'err', text }
  const [lawDragOver,    setLawDragOver]    = useState(false)
  const lawFileInputRef = useRef(null)

  // ── Activity log ──
  const [logs, setLogs] = useState([])
  const [logOpen, setLogOpen] = useState(true)
  const logEntriesRef = useRef(null)

  const addLog = useCallback((msg, level = 'info') => {
    if (!msg?.trim()) return
    setLogs(prev => [
      ...prev.slice(-299),
      { id: crypto.randomUUID(), time: new Date(), msg: msg.trim(), level },
    ])
  }, [])
  // DEV: wire ref so pre-addLog callbacks can reach the activity log
  addLogRef.current = addLog

  // DEV: log whenever renderScale state actually changes
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    addLog(`[RENDERSCALE] changed → ${renderScale.toFixed(3)}`, 'ok')
  }, [renderScale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll log to bottom when new entries arrive
  useEffect(() => {
    if (logOpen && logEntriesRef.current) {
      logEntriesRef.current.scrollTop = logEntriesRef.current.scrollHeight
    }
  }, [logs, logOpen])

  // ── LexChat ──
  const [caseSearchActive, setCaseSearchActive] = useState(!!caseId) // default ON in case mode
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [activeCitations, setActiveCitations] = useState(new Map()) // n → chunk

  // Stable display citations — falls back to last LLM response's citations when activeCitations
  // is empty (covers: doc-switch clear, race between indexing state churn and citation set)
  const displayCitations = useMemo(() => {
    if (activeCitations.size > 0) return activeCitations
    const lastCited = [...chatMessages].reverse().find(m => m.role === 'assistant' && m.citations?.size)
    return lastCited?.citations ?? new Map()
  }, [activeCitations, chatMessages])

  // Scroll to the first cited page whenever activeCitations changes
  useEffect(() => {
    if (!activeCitations.size) return
    const firstChunk = activeCitations.values().next().value
    const bbox = firstChunk.bbox
    const narrowBbox = firstChunk.narrowBbox
    const bboxStr = bbox ? `[${bbox.map(v => v.toFixed(3)).join(', ')}]` : 'none'
    const bboxArea = bbox ? ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])).toFixed(3) : 'n/a'
    const isLarge = bbox && (bbox[2] - bbox[0]) > 0.8 && (bbox[3] - bbox[1]) > 0.5
    const lineRects = firstChunk.lineRects
    addLog(
      `[CITATION] page=${firstChunk.page_num} bbox=${bboxStr} area=${bboxArea}${isLarge ? ' ⚠ LARGE BBOX (covers most of page)' : ''} ${lineRects ? `lineRects=${lineRects.length}` : narrowBbox ? `narrowBbox=[${narrowBbox.map(v => v.toFixed(3)).join(', ')}] source=${firstChunk.narrowBboxSource ?? 'unknown'}` : 'narrowBbox=none'}`,
      isLarge ? 'error' : 'ok'
    )
    // Center the bbox itself in the viewport, not just the page
    const target = firstChunk.lineRects ?? firstChunk.narrowBbox ?? firstChunk.bbox
    scrollBboxIntoView(firstChunk.page_num, target)
  }, [activeCitations]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stage 4: upgrade active citations with DOM-based bbox after text layer renders.
  // Retries up to 10 × 200ms while waiting for PDF.js to populate the text layer spans.
  useEffect(() => {
    if (!activeCitations.size || !pagesContainerRef.current) return

    const toUpgrade = [...activeCitations.entries()].filter(
      ([, chunk]) => chunk.bbox && chunk.narrowBboxSource !== 'textlayer'
    )
    if (!toUpgrade.length) return

    let cancelled = false
    let attempts = 0

    function tryUpgrade() {
      if (cancelled) return
      attempts++
      const upgrades = []

      for (const [n, chunk] of toUpgrade) {
        const textLayerDiv = pagesContainerRef.current?.querySelector(`[data-textlayer="${chunk.page_num}"]`)
        if (!textLayerDiv) continue
        if (!textLayerDiv.querySelectorAll('span').length) continue // not yet rendered

        const pageWrapper = textLayerDiv.parentElement
        const domBbox = findTextInTextLayer(pageWrapper, chunk.text)
        if (domBbox) upgrades.push([n, { ...chunk, narrowBbox: domBbox, narrowBboxSource: 'textlayer' }])
      }

      if (upgrades.length) {
        if (!cancelled) {
          setActiveCitations(prev => {
            const next = new Map(prev)
            for (const [n, upgraded] of upgrades) next.set(n, upgraded)
            return next
          })
        }
      } else if (attempts < 10) {
        setTimeout(tryUpgrade, 200)
      }
    }

    const t = setTimeout(tryUpgrade, 150)
    return () => { cancelled = true; clearTimeout(t) }
  }, [activeCitations]) // eslint-disable-line react-hooks/exhaustive-deps

  const chatAbortRef = useRef(null)
  const chatMessagesRef = useRef(null)
  const chunksPanelRef = useRef(null)
  const [activeChunkKey, setActiveChunkKey] = useState(null)
  const [chunkQuery, setChunkQuery] = useState('')
  const [chunkSearchMode, setChunkSearchMode] = useState('idle') // 'idle' | 'filter' | 'semantic'
  const [chunkSemanticResults, setChunkSemanticResults] = useState(null) // null | array of {page_num, chunk_idx}
  const [chunkSemanticLoading, setChunkSemanticLoading] = useState(false)
  const [editingNoteChunkKey, setEditingNoteChunkKey] = useState(null)
  const [noteChunkDraft, setNoteChunkDraft] = useState('')
  // Session-level per-doc caches — state restores instantly on doc switch (no async blank flash)
  const chatByDocRef           = useRef({}) // docId → Message[]
  const extractionByDocRef     = useRef({}) // docId → extractedPages
  const ragStatusByDocRef      = useRef({}) // docId → 'indexed' | 'failed'
  const prevCachedExtDocIdRef  = useRef(null) // tracks which docId extractedPages was last written for

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight
    }
  }, [chatMessages])

  // Scroll chunk panel to the active card when activeChunkKey changes
  useEffect(() => {
    if (!activeChunkKey || !chunksPanelRef.current) return
    const card = chunksPanelRef.current.querySelector(`[data-chunk-key="${activeChunkKey}"]`)
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeChunkKey])

  // Reset chat + RAG state when document changes; load persisted chat history
  useEffect(() => {
    // Restore immediately from in-session cache — no async round-trip, no blank flash
    const sessionMsgs = chatByDocRef.current[activeDocumentId] || []
    const sessionLastCited = [...sessionMsgs].reverse().find(m => m.role === 'assistant' && m.citations?.size)
    setChatMessages(sessionMsgs)
    setActiveCitations(sessionLastCited?.citations ?? new Map())
    setActiveChunkKey(null)
    setChunkQuery('')
    setChunkSearchMode('idle')
    setChunkSemanticResults(null)
    setEditingNoteChunkKey(null)
    setNoteChunkDraft('')
    setChatInput('')
    setRagStatus(ragStatusByDocRef.current[activeDocumentId] ?? null)
    setRagProgress('')
    ragQueryCacheRef.current.clear() // invalidate cached search results for previous doc

    if (!activeDocumentId) return

    // Load from server only on first visit this session (cross-session persistence)
    if (caseId && !sessionMsgs.length) {
      loadChatHistory(activeDocumentId, { caseId }).then(msgs => {
        if (msgs.length) {
          chatByDocRef.current[activeDocumentId] = msgs
          setChatMessages(msgs)
          const lastCited = [...msgs].reverse().find(m => m.role === 'assistant' && m.citations?.size)
          if (lastCited) setActiveCitations(lastCited.citations)
        }
      }).catch(() => {})
    }

    getDocRagStatus(activeDocumentId, { caseId }).then(({ indexed, chunks }) => {
      if (indexed) {
        ragStatusByDocRef.current[activeDocumentId] = 'indexed'
        setRagStatus('indexed')
        setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'indexed' }))
        if (chunks) setDocChunkCountsById(prev => ({ ...prev, [activeDocumentId]: chunks }))
      }
    }).catch(() => {})
  }, [activeDocumentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load notes when active doc changes — also sync allCaseNotes so the badge is always fresh
  useEffect(() => {
    if (!activeDocumentId || !caseId) { setNotes([]); return }
    loadNotes(activeDocumentId, { caseId }).then(loaded => {
      setNotes(loaded)
      setAllCaseNotes(prev => ({ ...prev, [activeDocumentId]: loaded }))
    }).catch(() => setNotes([]))
    setOpenNoteId(null)
  }, [activeDocumentId, caseId]) // eslint-disable-line react-hooks/exhaustive-deps

  const persistNotes = useCallback((next, docId) => {
    // A: optimistic update — evidence tab reflects changes instantly
    if (caseId) {
      setAllCaseNotes(prev => ({ ...prev, [docId]: next }))
    }
    saveNotes(docId, next, { caseId }).catch(() => {})
  }, [caseId])

  const deleteNoteFromTab = useCallback((docId, noteId) => {
    const current = allCaseNotes[docId] || []
    const next = current.filter(n => n.id !== noteId)
    if (docId === activeDocumentId) setNotes(next)
    persistNotes(next, docId)
  }, [allCaseNotes, activeDocumentId, persistNotes])

  const saveNoteEditFromTab = useCallback((docId, noteId, text) => {
    const trimmed = text.trim()
    if (!trimmed) { deleteNoteFromTab(docId, noteId); return }
    const current = allCaseNotes[docId] || []
    const next = current.map(n => n.id === noteId ? { ...n, text: trimmed } : n)
    if (docId === activeDocumentId) setNotes(next)
    persistNotes(next, docId)
  }, [allCaseNotes, activeDocumentId, deleteNoteFromTab, persistNotes])

  // Load all notes for the whole case whenever the case changes
  useEffect(() => {
    if (!caseId) return
    loadAllNotes(caseId).then(setAllCaseNotes).catch(() => {})
  }, [caseId])

  // ── Chunk search handlers ──
  const handleChunkQueryChange = useCallback((val) => {
    setChunkQuery(val)
    if (val.trim()) {
      setChunkSearchMode('filter')
      setChunkSemanticResults(null)
    } else {
      setChunkSearchMode('idle')
      setChunkSemanticResults(null)
    }
  }, [])

  const handleChunkSemanticSearch = useCallback(async () => {
    const q = chunkQuery.trim()
    if (!q || !activeDocumentId) return
    setChunkSemanticLoading(true)
    setChunkSemanticResults(null)
    try {
      const results = await searchDocChunks(activeDocumentId, q, 10, { caseId })
      setChunkSemanticResults(results)
      setChunkSearchMode('semantic')
    } catch {
      setChunkSemanticResults([])
    } finally {
      setChunkSemanticLoading(false)
    }
  }, [chunkQuery, activeDocumentId, caseId])

  const saveNoteFromChunk = useCallback((chunk, pageNum, chunkIdx) => {
    const text = noteChunkDraft.trim()
    if (!text || !activeDocumentId) return
    const bbox = chunk.bbox ?? null
    // Derive x/y from bbox center (normalised 0–1) or fall back to (0.5, 0.5)
    const x = bbox ? (bbox[0] + bbox[2]) / 2 : 0.5
    const y = bbox ? (bbox[1] + bbox[3]) / 2 : 0.5
    const note = {
      id: crypto.randomUUID(),
      pageNum,
      x,
      y,
      text,
      createdAt: new Date().toISOString(),
      chunkText: chunk.text,
      chunkBbox: bbox,
      chunkLineRects: chunk.lineRects ?? null,
      chunkIdx,
    }
    const next = [...notes, note]
    setNotes(next)
    persistNotes(next, activeDocumentId)
    setEditingNoteChunkKey(null)
    setNoteChunkDraft('')
  }, [noteChunkDraft, activeDocumentId, notes, persistNotes])

  // ── Starred source handlers ──
  const _starKey = (chunk) => `${chunk.page_num}::${chunk.text.slice(0, 60)}`

  const handleToggleStar = useCallback((chunk, question = '') => {
    setStarredSources(prev => {
      const k = _starKey(chunk)
      const exists = prev.findIndex(s => s.key === k)
      const ownerParty = parties.find(p => (p.documents || []).some(d => d.id === activeDocumentId))
      const ownerDoc   = ownerParty?.documents?.find(d => d.id === activeDocumentId)
      const next = exists >= 0
        ? prev.filter((_, i) => i !== exists)
        : [...prev, {
            id: crypto.randomUUID(),
            key: k,
            docId: activeDocumentId,
            docName:   ownerDoc?.name   || null,
            partyName: ownerParty?.name || null,
            chunkText: chunk.text,
            pageNum: chunk.page_num,
            bbox: chunk.bbox || null,
            narrowBbox: chunk.narrowBbox || null,
            score: chunk.distance != null ? distanceToScore(chunk.distance) : null,
            question: question.slice(0, 120),
            starredAt: new Date().toISOString(),
          }]
      localStorage.setItem(`starred-${caseId || 'solo'}`, JSON.stringify(next))
      return next
    })
  }, [activeDocumentId, caseId, parties])

  const handleRemoveStar = useCallback((id) => {
    setStarredSources(prev => {
      const next = prev.filter(s => s.id !== id)
      localStorage.setItem(`starred-${caseId || 'solo'}`, JSON.stringify(next))
      return next
    })
  }, [caseId])

  const handleAideStart = useCallback(async () => {
    if (!aideTask.trim() || !caseId) return
    // Close any existing SSE stream
    aideEsRef.current?.close()
    setAideSteps([])
    setAideResult(null)
    setAideStatus('running')

    const res = await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: aideTask, intent: aideIntent, role: aideRole, caseId }),
    })
    const { jobId, error } = await res.json()
    if (error) { setAideStatus('error'); return }
    setAideJobId(jobId)

    const es = new EventSource(`/api/agent/${jobId}/stream`)
    aideEsRef.current = es

    es.onmessage = (e) => {
      const step = JSON.parse(e.data)
      if (step.type === 'status') {
        setAideStatus(step.status)
        if (step.result) setAideResult(step.result)
        if (step.status !== 'running') { es.close(); aideEsRef.current = null }
        return
      }
      if (step.type === 'diary_entry') {
        setAideDiary(prev => [step.entry, ...prev])
        return
      }
      setAideSteps(prev => [...prev, step])
      if (step.type === 'tool_result' && step.tool === 'add_note' && step.result?.ok) {
        loadAllNotes(caseId).then(setAllCaseNotes).catch(() => {})
      }
    }
    es.onerror = () => { setAideStatus('error'); es.close(); aideEsRef.current = null }
  }, [aideTask, aideIntent, aideRole, caseId, setAllCaseNotes])

  const handleAideStop = useCallback(async () => {
    aideEsRef.current?.close()
    aideEsRef.current = null
    if (aideJobId) {
      await fetch(`/api/agent/${aideJobId}`, { method: 'DELETE' }).catch(() => {})
    }
    setAideStatus('cancelled')
  }, [aideJobId])

  // Load soul + diary whenever the case changes
  useEffect(() => {
    if (!caseId) return
    fetch(`/api/cases/${caseId}/aide/soul`).then(r => r.json()).then(d => {
      setAideSoul(d.soul || { skillMd: '', redFlags: '', styleGuide: '', corrections: [], styleSamples: [] })
      setAideSoulDirty(false)
      setAideSoulSavedAt(d.savedAt || null)
    }).catch(() => {})
    fetch(`/api/cases/${caseId}/aide/diary`).then(r => r.json()).then(d => {
      setAideDiary(Array.isArray(d) ? d : [])
    }).catch(() => {})
  }, [caseId])

  const handleAideSoulSave = useCallback(async () => {
    if (!caseId || aideSoulSaving) return
    setAideSoulSaving(true)
    try {
      const res = await fetch(`/api/cases/${caseId}/aide/soul`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soul: aideSoul }),
      })
      const data = await res.json()
      setAideSoulSavedAt(data.savedAt || new Date().toISOString())
      setAideSoulDirty(false)
    } finally {
      setAideSoulSaving(false)
    }
  }, [caseId, aideSoul, aideSoulSaving])

  const patchSoul = useCallback((key, value) => {
    setAideSoul(prev => ({ ...prev, [key]: value }))
    setAideSoulDirty(true)
  }, [])

  const addCorrection = useCallback(() => {
    const text = aideNewCorrection.trim()
    if (!text) return
    setAideSoul(prev => ({ ...prev, corrections: [...(prev.corrections || []), { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }] }))
    setAideSoulDirty(true)
    setAideNewCorrection('')
  }, [aideNewCorrection])

  const removeCorrection = useCallback((id) => {
    setAideSoul(prev => ({ ...prev, corrections: (prev.corrections || []).filter(c => c.id !== id) }))
    setAideSoulDirty(true)
  }, [])

  const addStyleSample = useCallback(() => {
    setAideSoul(prev => ({ ...prev, styleSamples: [...(prev.styleSamples || []), { id: crypto.randomUUID(), text: '', createdAt: new Date().toISOString() }] }))
    setAideSoulDirty(true)
  }, [])

  const updateStyleSample = useCallback((id, text) => {
    setAideSoul(prev => ({ ...prev, styleSamples: (prev.styleSamples || []).map(s => s.id === id ? { ...s, text } : s) }))
    setAideSoulDirty(true)
  }, [])

  const removeStyleSample = useCallback((id) => {
    setAideSoul(prev => ({ ...prev, styleSamples: (prev.styleSamples || []).filter(s => s.id !== id) }))
    setAideSoulDirty(true)
  }, [])

  const aideSoulTokenEstimate = useMemo(() => {
    const s = aideSoul
    const texts = [s.skillMd, s.redFlags, s.styleGuide, ...(s.corrections || []).map(c => c.text), ...(s.styleSamples || []).map(x => x.text)]
    return Math.round(texts.reduce((sum, t) => sum + (t?.length || 0), 0) / 4)
  }, [aideSoul])

  // ── Law tab handlers ───────────────────────────────────────────────────────

  // Load caselaw status + versions when Law tab is first opened
  const _refreshLawStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/caselaw/status').then(r => r.json())
      setLawStatus(d)
      // Build ordered version list: active first, then backups
      const versions = []
      if (d.activeFile) versions.push(d.activeFile)
      if (Array.isArray(d.backups)) versions.push(...d.backups)
      setLawVersions(versions)
    } catch {
      setLawStatus({ available: false, message: 'Server unreachable' })
    }
  }, [])

  useEffect(() => {
    if (rightTab !== 'law') return
    _refreshLawStatus()
  }, [rightTab, _refreshLawStatus])

  const handleLawSearch = useCallback(async () => {
    if (!lawQuery.trim() || lawSearching) return
    setLawSearching(true)
    setLawResults([])
    try {
      const body = { query: lawQuery, k: 8, filters: {} }
      if (lawFilters.court)        body.filters.court        = lawFilters.court
      if (lawFilters.jurisdiction) body.filters.jurisdiction = lawFilters.jurisdiction
      if (lawFilters.yearFrom)     body.filters.yearFrom     = Number(lawFilters.yearFrom)
      if (lawFilters.yearTo)       body.filters.yearTo       = Number(lawFilters.yearTo)
      const r = await fetch('/api/caselaw/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Search failed')
      setLawResults(d.results || [])
    } catch (err) {
      setLawResults([])
      setLawImportMsg({ type: 'err', text: err.message })
    } finally {
      setLawSearching(false)
    }
  }, [lawQuery, lawSearching, lawFilters])

  const handleLawDbDrop = useCallback((e) => {
    e.preventDefault()
    setLawDragOver(false)
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.db')) {
      setLawImportMsg({ type: 'err', text: 'Only .db files are accepted' })
      return
    }
    setLawUploadFile(file)
    setLawImportMsg(null)
  }, [])

  const handleLawSwap = useCallback(async () => {
    if (!lawUploadFile || lawUploading) return
    setLawUploading(true)
    setLawImportMsg(null)
    try {
      // Send as raw binary; server reads req.body via express.raw
      const safeName = lawUploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const arrayBuf = await lawUploadFile.arrayBuffer()
      const r = await fetch(`/api/admin/caselaw/upload?filename=${encodeURIComponent(safeName)}&autoSwap=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: arrayBuf,
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Upload failed')
      const swapResult = d.swap || d
      if (swapResult.ok === false) throw new Error(swapResult.message || 'Swap failed')
      setLawImportMsg({ type: 'ok', text: swapResult.message || `Activated ${safeName}` })
      setLawUploadFile(null)
      await _refreshLawStatus()
    } catch (err) {
      setLawImportMsg({ type: 'err', text: err.message })
    } finally {
      setLawUploading(false)
    }
  }, [lawUploadFile, lawUploading, _refreshLawStatus])

  const handlePageClick = useCallback((e, pageNum) => {
    if (!noteMode) return
    const wrapper = e.currentTarget
    const rect = wrapper.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top)  / rect.height
    const note = { id: crypto.randomUUID(), pageNum, x, y, text: '', createdAt: new Date().toISOString() }
    const next = [...notes, note]
    setNotes(next)
    persistNotes(next, activeDocumentId)
    setOpenNoteId(note.id)
    setNoteMode(false)
  }, [noteMode, notes, activeDocumentId, persistNotes])

  const handleNoteTextSave = useCallback((id, text) => {
    const next = notes.map(n => n.id === id ? { ...n, text } : n)
    setNotes(next)
    persistNotes(next, activeDocumentId)
  }, [notes, activeDocumentId, persistNotes])

  const handleNoteDelete = useCallback((id) => {
    const next = notes.filter(n => n.id !== id)
    setNotes(next)
    persistNotes(next, activeDocumentId)
    setOpenNoteId(null)
  }, [notes, activeDocumentId, persistNotes])

  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return

    const userMsg = { role: 'user', id: crypto.randomUUID(), content: text }
    // Track finalMessages locally so we can persist after streaming completes
    let finalMessages = [...chatMessages, userMsg]
    setChatMessages(finalMessages)
    setChatInput('')
    setChatLoading(true)
    addLog(`LexChat query: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`, 'info')
    setActiveCitations(new Map()) // clear previous highlights

    if (chatAbortRef.current) chatAbortRef.current.abort()
    const controller = new AbortController()
    chatAbortRef.current = controller

    // RAG: retrieve relevant chunks and build numbered evidence block
    // Results are cached per (doc/case + query text) to avoid redundant vector searches.
    let ragContext = ''
    let chunkMap = new Map()
    // For case-wide search, allow even if active doc isn't indexed (other docs in case may be)
    if ((ragStatus === 'indexed' || (caseSearchActive && caseId)) && activeDocumentId) {
      const cacheKey = `${caseSearchActive ? `case:${caseId}` : `doc:${activeDocumentId}`}::${text}`
      let rawChunks = ragQueryCacheRef.current.get(cacheKey)
      if (!rawChunks) {
        rawChunks = caseSearchActive && caseId
          ? await searchCaseChunks(caseId, text, 5)
          : await searchDocChunks(activeDocumentId, text, 3, { caseId, windowSize: CHUNKING_STRATEGIES[chunkingStrategy]?.windowSize ?? 0 })
        if (rawChunks?.length) ragQueryCacheRef.current.set(cacheKey, rawChunks)
      }
      // Build doc-name labels so the LLM prompt shows human-readable provenance
      const docLabels = caseSearchActive && caseId
        ? new Map(parties.flatMap(party =>
            (party.documents || []).map(doc => [doc.id, `${party.name} / ${doc.name}`])
          ))
        : undefined
      ;({ ragContext, chunkMap } = buildEvidenceBlock(rawChunks, { docLabels }))
    }

    // Fallback: when not indexed, include full extracted text (truncated) so the model has document context
    const _extractedText = extractedTextRef.current
    const docContext = ragContext
      ? ragContext
      : _extractedText
        ? `\n\nDocument text:\n${_extractedText.slice(0, 12000)}${_extractedText.length > 12000 ? '\n[…document continues…]' : ''}`
        : ''

    // Build message history for Ollama
    const systemPrompt = `You are LexChat, an expert legal AI assistant. You help legal professionals analyze documents, answer legal questions, and provide guidance on legal matters.${docContext}

Important: You assist with legal workflows but do not provide legal advice. Always recommend qualified legal professionals for final decisions.`

    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...chatMessages,
      userMsg,
    ]

    const assistantId = crypto.randomUUID()
    finalMessages = [...finalMessages, { id: assistantId, role: 'assistant', content: '' }]
    setChatMessages(finalMessages)

    try {
      const accumulated = await streamOllamaChat({
        messages: ollamaMessages,
        signal: controller.signal,
        onChunk: text => setChatMessages(prev => [...prev.slice(0, -1), { id: assistantId, role: 'assistant', content: text }]),
      })
      let accumulated_final = accumulated

      // ATG: parse which [n] citations the LLM actually used
      let msgCitations = parseCitations(accumulated_final, chunkMap)
      // Narrow paragraph-level bboxes to sentence-level using extraction cache
      if (msgCitations.size) {
        const cachedPages = lastExtractionPagesRef.current?.docId === activeDocumentId
          ? lastExtractionPagesRef.current.pages
          : null
        msgCitations = narrowCitations(msgCitations, accumulated_final, cachedPages)
      }
      const assistantMsg = msgCitations.size
        ? { id: assistantId, role: 'assistant', content: accumulated_final, citations: msgCitations }
        : { id: assistantId, role: 'assistant', content: accumulated_final }

      finalMessages = [...finalMessages.slice(0, -1), assistantMsg]
      setChatMessages(prev => [...prev.slice(0, -1), assistantMsg])
      if (msgCitations.size) setActiveCitations(msgCitations)

      // Persist chat history (case mode only)
      if (caseId) saveChatHistory(activeDocumentId, finalMessages, { caseId }).catch(() => {})

      addLog('LexChat response received', 'ok')

      // Fire follow-up suggestions async — non-blocking
      _fetchSuggestions(text, accumulated_final).then(suggestions => {
        if (!suggestions?.length) return
        setChatMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, suggestions } : m
        ))
      }).catch(() => {})
    } catch (err) {
      if (err.name === 'AbortError') return
      addLog(`LexChat error: ${err.message}`, 'error')
      const errMsg = { role: 'assistant', content: `Error: ${err.message}` }
      finalMessages = [...finalMessages, errMsg]
      setChatMessages(prev => [...prev, errMsg])
      if (caseId) saveChatHistory(activeDocumentId, finalMessages, { caseId }).catch(() => {})
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatLoading, chatMessages, ragStatus, activeDocumentId, caseSearchActive, caseId, parties, addLog])
  const handleIndexDocument = useCallback(async ({ forceClear = false } = {}) => {
    if (isIndexingRef.current) return   // ref guard: prevents concurrent/loop starts
    const cached = lastExtractionPagesRef.current
    const hasCachedPages = cached.docId === activeDocumentId && cached.pages
    // Need the main-thread pdf only if we have no cached pages to fall back on
    if (!hasCachedPages && !pdfDocRef.current) return

    isIndexingRef.current = true
    setRagStatus('indexing')
    setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'indexing' }))
    try {
      // Step 1 — optionally clear existing chunks (re-index with new strategy)
      if (forceClear) {
        setRagProgress('Clearing previous chunks…')
        await clearDocChunks(activeDocumentId, { caseId })
      }

      // Step 2 — index format categories (non-fatal — skips if embed model not ready yet)
      try {
        setRagProgress('Setting up categories (first time only)…')
        await initFormatCategories(FORMAT_CATEGORIES)
      } catch (err) {
        addLog(`Format categories skipped (will retry next index): ${err.message}`, 'warn')
      }

      // Step 3 — get bbox-aware paragraph chunks
      // Prefer cached pages from extraction (has OCR bboxes too); fallback to native re-extract
      let pages
      if (hasCachedPages) {
        pages = cached.pages
      } else {
        const pdf = pdfDocRef.current
        setRagProgress('Extracting text with coordinates…')
        pages = await extractPageChunksFromPDF(pdf, { onStatus: setRagProgress })
      }

      // Step 4 — chunk using selected strategy (works from rawWords for free re-chunking)
      let rawChunks
      if (chunkingStrategy === 'clause') {
        rawChunks = chunkByClauses(pages)
      } else if (chunkingStrategy === 'sentence') {
        rawChunks = chunkBySentences(pages)
      } else {
        // 'recursive' (default) — paragraph → sentence → word hierarchy
        rawChunks = chunkRecursive(pages, CHUNKING_STRATEGIES[chunkingStrategy]?.targetWords ?? 300)
      }
      const allChunks = rawChunks.map((c, idx) => ({
        pageNum: c.pageNum,
        chunkIdx: idx,
        text: c.text,
        bbox: c.bbox,
      }))

      // Update the chunk panel to reflect the new strategy chunks
      const newChunksByPage = new Map()
      for (const c of rawChunks) {
        if (!newChunksByPage.has(c.pageNum)) newChunksByPage.set(c.pageNum, [])
        newChunksByPage.get(c.pageNum).push(c)
      }
      setExtractedPages(prev =>
        (prev ?? pages)?.map(p => ({ ...p, chunks: newChunksByPage.get(p.pageNum) ?? [] })) ?? null
      )
      // Keep lastExtractionPagesRef in sync so future re-chunks use the same page words
      if (lastExtractionPagesRef.current?.pages) {
        lastExtractionPagesRef.current = {
          ...lastExtractionPagesRef.current,
          pages: lastExtractionPagesRef.current.pages.map(p => ({
            ...p,
            chunks: newChunksByPage.get(p.pageNum) ?? [],
          })),
        }
      }

      // Step 5 — embed + store in batches (server skips unchanged hashes)
      const BATCH = 10
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH)
        setRagProgress(`Embedding chunks ${i + 1}–${Math.min(i + BATCH, allChunks.length)} / ${allChunks.length}…`)
        await indexDocPages(activeDocumentId, batch, { caseId })
      }

      // Prune stale chunks (from previous versions with different chunk count/layout)
      if (!forceClear) {
        setRagProgress('Pruning stale chunks…')
        await pruneDocChunks(activeDocumentId, allChunks.map(c => ({ pageNum: c.pageNum, chunkIdx: c.chunkIdx })), { caseId })
      }

      setRagStatus('indexed')
      setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'indexed' }))
      setDocChunkCountsById(prev => ({ ...prev, [activeDocumentId]: allChunks.length }))
      // Embedding succeeded — clear any stale "embed unavailable" banner
      setConnectivity(prev => prev.embed?.ok === false ? { ...prev, embed: { ...prev.embed, ok: true } } : prev)

    } catch (err) {
      console.error('[RAG] indexing failed:', err)
      addLog(`Chunking failed: ${err.message}`, 'error')
      setRagStatus('failed')
      setDocStatuses(prev => {
        const cur = prev[activeDocumentId]
        return { ...prev, [activeDocumentId]: cur === 'indexing' ? 'extracted' : cur }
      })
    } finally {
      isIndexingRef.current = false
      setRagProgress('')
    }
  }, [activeDocumentId, caseId, chunkingStrategy, addLog])

  // Lightweight chunk reload — display-only, never re-embeds.
  // Used by: recovery effect + manual "Reload chunks" button.
  // Path 1: try server extraction cache → apply strategy → set extractedPages.
  // Path 2: if cache missing, re-extract from the main-thread pdfDoc → apply strategy.
  // Embeddings are NOT touched (they already exist in SQLite).
  const reloadChunksOnly = useCallback(async () => {
    if (!activeDocumentId) return
    const applyStrategy = (rawPages) => {
      let rawChunks
      if (chunkingStrategy === 'clause') rawChunks = chunkByClauses(rawPages)
      else if (chunkingStrategy === 'sentence') rawChunks = chunkBySentences(rawPages)
      else rawChunks = chunkRecursive(rawPages, CHUNKING_STRATEGIES[chunkingStrategy]?.targetWords ?? 300)
      const byPage = new Map()
      for (const c of rawChunks) {
        if (!byPage.has(c.pageNum)) byPage.set(c.pageNum, [])
        byPage.get(c.pageNum).push(c)
      }
      return rawPages.map(p => ({ ...p, chunks: byPage.get(p.pageNum) ?? [] }))
    }

    // Path 1 — server cache
    try {
      const saved = await loadExtraction(activeDocumentId, { caseId })
      const totalCached = saved?.pages?.reduce((s, p) => s + (p.chunks?.length ?? 0), 0) ?? 0
      if (saved?.pages?.length && totalCached > 0) {
        const pages = applyStrategy(saved.pages)
        setExtractedPages(pages)
        lastExtractionPagesRef.current = { docId: activeDocumentId, pages }
        return
      }
    } catch { /* fall through to path 2 */ }

    // Path 2 — re-extract from loaded PDF (no embedding)
    if (!pdfDocRef.current) return
    setExtractionStatus('Re-extracting text…')
    setExtractingText(true)
    try {
      const rawPages = await extractPageChunksFromPDF(pdfDocRef.current, { onStatus: setExtractionStatus })
      if (!rawPages) return
      const pages = applyStrategy(rawPages)
      setExtractedPages(pages)
      lastExtractionPagesRef.current = { docId: activeDocumentId, pages }
    } finally {
      setExtractingText(false)
      setExtractionStatus('')
    }
  }, [activeDocumentId, caseId, chunkingStrategy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Extracted text panel ──────────────────────
  const [extractedText, setExtractedText] = useState(null)
  const [extractedPages, setExtractedPages] = useState(null) // [{pageNum, chunks: [{text, bbox}]}]
  const [extractedTextOpen, setExtractedTextOpen] = useState(true)
  const [extractedTextHeight, setExtractedTextHeight] = useState(200)
  const [extractingText, setExtractingText] = useState(false)
  const [extractionStatus, setExtractionStatus] = useState('')
  const [extractionError, setExtractionError] = useState(null)
  const [extractionSource, setExtractionSource] = useState(null) // 'text' | 'ocr' | null
  const extractionAbortRef = useRef(null)

  // Keep session caches in sync so doc-switch restores are instant
  // NOTE: placed here — after extractedPages declaration — to avoid TDZ in dep array
  useEffect(() => {
    if (activeDocumentId && chatMessages.length) chatByDocRef.current[activeDocumentId] = chatMessages
  }, [chatMessages, activeDocumentId])
  useEffect(() => {
    // Guard: only write cache when activeDocumentId is stable (same as previous effect run).
    // Without this, switching A→B causes a transient render where activeDocumentId=B but
    // extractedPages still holds A's data, poisoning B's cache slot with A's chunks.
    if (activeDocumentId && extractedPages && prevCachedExtDocIdRef.current === activeDocumentId) {
      extractionByDocRef.current[activeDocumentId] = extractedPages
    }
    prevCachedExtDocIdRef.current = activeDocumentId
  }, [extractedPages, activeDocumentId])
  useEffect(() => {
    if (activeDocumentId && ragStatus && ragStatus !== 'indexing') ragStatusByDocRef.current[activeDocumentId] = ragStatus
  }, [ragStatus, activeDocumentId])

  // Watch key status strings and mirror them into the log automatically
  useEffect(() => { if (extractionStatus) addLog(extractionStatus) }, [extractionStatus, addLog])
  useEffect(() => { if (ragProgress)      addLog(ragProgress)      }, [ragProgress, addLog])
  useEffect(() => {
    if (ragStatus === 'indexed')  addLog('Chunking complete — semantic search active', 'ok')
    if (ragStatus === 'indexing') addLog('Chunking text…', 'info')
  }, [ragStatus, addLog])
  useEffect(() => {
    if (pdfLoading) addLog('Loading PDF…')
    else if (!pdfLoading && pageCount) addLog(`PDF loaded — ${pageCount} pages`, 'ok')
  }, [pdfLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Core extraction runner — called both automatically on doc load and from the retry button
  const runExtraction = useCallback(async (docId, file) => {
    if (!file) return
    if (extractionAbortRef.current) extractionAbortRef.current.abort()
    const controller = new AbortController()
    extractionAbortRef.current = controller
    setExtractingText(true)
    setExtractionError(null)
    setExtractionSource(null)
    setExtractionStatus('Detecting PDF type…')
    setDocStatuses(prev => ({ ...prev, [docId]: 'extracting' }))
    try {
      const result = await extractAndSaveText(docId, file, {
        onStatus: setExtractionStatus,
        signal: controller.signal,
        caseId,
        // Emit partial pages early so LexChat can answer before full extraction finishes
        onPartialResult: ({ text, pages: partialPages }) => {
          extractedTextRef.current = text
          setExtractedText(text)
          setExtractedPages(partialPages)
          lastExtractionPagesRef.current = { docId, pages: partialPages }
        },
      })
      if (result) {
        setExtractedText(result.text)
        extractedTextRef.current = result.text
        setExtractedPages(result.pages ?? null)
        setExtractionSource(result.isOcr ? 'ocr' : 'text')
        setDocStatuses(prev => ({ ...prev, [docId]: 'extracted' }))
        lastExtractionPagesRef.current = { docId, pages: result.pages }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setExtractionError(err.message === 'No text could be extracted from this PDF.'
          ? err.message
          : 'OCR failed — could not extract text')
        setDocStatuses(prev => ({ ...prev, [docId]: 'error' }))
      }
    } finally {
      setExtractingText(false)
      setExtractionStatus('')
    }
  }, []) // all used setters and extractAndSaveText are stable references

  // Re-extract fresh from the PDF, then immediately clear the old index and rebuild it.
  // Atomic "fix everything" action: handles garbled text, scanned→text upgrades, and
  // algorithm changes. forceClear ensures stale bboxes are fully replaced, not just pruned.
  const handleReextractAndReindex = useCallback(async (docId, file) => {
    await runExtraction(docId, file)
    // runExtraction updates lastExtractionPagesRef.current which handleIndexDocument reads.
    await handleIndexDocument({ forceClear: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On document change: load from cache if available (user manually starts extraction otherwise)
  useEffect(() => {
    if (!activeDocumentId) return
    let cancelled = false
    loadExtraction(activeDocumentId, { caseId }).then(saved => {
      if (cancelled) return
      const totalCachedChunks = saved?.pages?.reduce((s, p) => s + (p.chunks?.length ?? 0), 0) ?? 0
      if (saved?.text && totalCachedChunks > 0) {
        setExtractedText(saved.text)
        extractedTextRef.current = saved.text
        setExtractionSource(saved.isOcr ? 'ocr' : 'text')
        setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'extracted' }))
        if (saved.pages) {
          // If getDocRagStatus already resolved (doc confirmed indexed), apply strategy chunks
          // immediately for display — otherwise auto-index will apply them after embedding.
          let pages = saved.pages
          if (ragStatusByDocRef.current[activeDocumentId]) {
            let rawChunks
            if (chunkingStrategy === 'clause') rawChunks = chunkByClauses(saved.pages)
            else if (chunkingStrategy === 'sentence') rawChunks = chunkBySentences(saved.pages)
            else rawChunks = chunkRecursive(saved.pages, CHUNKING_STRATEGIES[chunkingStrategy]?.targetWords ?? 300)
            const byPage = new Map()
            for (const c of rawChunks) {
              if (!byPage.has(c.pageNum)) byPage.set(c.pageNum, [])
              byPage.get(c.pageNum).push(c)
            }
            pages = saved.pages.map(p => ({ ...p, chunks: byPage.get(p.pageNum) ?? [] }))
          }
          setExtractedPages(pages)
          lastExtractionPagesRef.current = { docId: activeDocumentId, pages }
        }
      } else if (saved) {
        // Stale cache (0 chunks) — delete it so next manual run starts fresh
        const url = caseId
          ? `/api/cases/${encodeURIComponent(caseId)}/extractions/${activeDocumentId}`
          : `/api/extractions/${activeDocumentId}`
        fetch(url, { method: 'DELETE' }).catch(() => {})
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [activeDocumentId, caseId])

  // Auto-index for RAG after extraction completes.
  // Fires only when ragStatus===null (new doc or first extraction this session).
  // Returning to an already-indexed doc sets ragStatus from ragStatusByDocRef, so this won't re-trigger.
  useEffect(() => {
    const cached = lastExtractionPagesRef.current
    const hasCachedPages = cached?.docId === activeDocumentId && cached?.pages
    if (extractedPages && (ragStatus === null) && activeDocumentId && (hasCachedPages || pdfDocRef.current)) {
      handleIndexDocument()
    }
  }, [extractedPages, ragStatus, activeDocumentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Recovery: doc is confirmed indexed in SQLite but extraction cache is missing (extractedPages
  // still null after loadExtraction returned nothing). Re-extract from the loaded PDF so the Text
  // Chunks panel shows content. Uses pdfMainThreadReady (state) so the effect reliably re-fires
  // once the main-thread pdfDoc is available — pageCount alone isn't enough because the render
  // worker sends 'ready' before the main-thread pdfjsLib.getDocument() promise resolves.
  // forceClear:false keeps existing embeddings; server re-upserts unchanged chunks harmlessly.
  useEffect(() => {
    if (ragStatus !== 'indexed' || extractedPages || !activeDocumentId || !pdfMainThreadReady) return
    reloadChunksOnly()
  }, [ragStatus, extractedPages, activeDocumentId, pdfMainThreadReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const textPanelDragging = useRef(false)
  const textPanelDragStartY = useRef(0)
  const textPanelDragStartH = useRef(0)

  const onTextPanelHandleDown = useCallback((e) => {
    e.preventDefault()
    textPanelDragging.current = true
    textPanelDragStartY.current = e.clientY
    textPanelDragStartH.current = extractedTextHeight
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [extractedTextHeight])

  useEffect(() => {
    const onMove = (e) => {
      if (!textPanelDragging.current) return
      const delta = textPanelDragStartY.current - e.clientY
      const next = Math.max(80, Math.min(600, textPanelDragStartH.current + delta))
      setExtractedTextHeight(next)
    }
    const onUp = () => {
      if (!textPanelDragging.current) return
      textPanelDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ── Divider drag ──────────────────────────────
  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault()
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartSplit.current = centerSplit
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [centerSplit])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!isDragging.current) return
      const container = containerRef.current
      if (!container) return

      const totalW = container.offsetWidth
      const sidebarW = sidebarOpen ? totalW * (SIDEBAR_EXPANDED_PCT / 100) : COLLAPSED_WIDTH_PX
      const availW = totalW - sidebarW

      const deltaX = e.clientX - dragStartX.current
      const deltaPct = (deltaX / availW) * 100
      const next = Math.min(MAX_SPLIT_PCT, Math.max(MIN_SPLIT_PCT, dragStartSplit.current + deltaPct))
      setCenterSplit(next)
    }

    const onMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [sidebarOpen])

  // ── Widths ────────────────────────────────────
  // All three panels are direct flex children — exactly 3, no extras.
  // Sidebar: fixed px or % depending on state.
  // Center + Right split the remaining space via flex values derived from centerSplit.

  const sidebarStyle = sidebarOpen
    ? { width: `${SIDEBAR_EXPANDED_PCT}%` }
    : { width: `${COLLAPSED_WIDTH_PX}px` }

  // Center and right use flex to share the remaining space.
  // We express their shares as a ratio: centerSplit : (100 - centerSplit)
  const centerFlex = centerSplit
  const rightFlex = 100 - centerSplit

  // Render chat bubble content — replaces [n] markers with clickable citation chips
  function renderMessageContent(msg, isLast) {
    const tokens = msg.citations?.size ? tokeniseMessage(msg.content) : [msg.content]
    const cursor = chatLoading && isLast && msg.role === 'assistant'
      ? <span className="pdfapp-cursor">▌</span> : null

    if (tokens.length === 1 && typeof tokens[0] === 'string') {
      return <>{tokens[0]}{cursor}</>
    }
    return (
      <>
        {tokens.map((token, i) => {
          if (typeof token === 'number') {
            const chunk = msg.citations.get(token)
            if (!chunk) return `[${token}]`
            return (
              <button
                key={i}
                className={`pdfapp-citation-chip${displayCitations.has(token) ? ' pdfapp-citation-chip--active' : ''}`}
                title={`Page ${chunk.page_num} — ${chunk.text.slice(0, 120)}${chunk.text.length > 120 ? '…' : ''}`}
                onClick={() => {
                  addLog(`[CLICK] citation chip [${token}] → page ${chunk.page_num}`, 'info')
                  setActiveCitations(new Map([[token, chunk]]))
                }}
              >
                {token}
              </button>
            )
          }
          return token
        })}
        {cursor}
      </>
    )
  }

  return (
    <div className="pdfapp" ref={containerRef}>

      {/* ── Panel 1: Left Sidebar ── */}
      <div className="pdfapp-sidebar" style={sidebarStyle}>
        {sidebarOpen ? (
          <div className="pdfapp-sb-content">

            {/* Header */}
            <div className="pdfapp-sb-header">
              <div className="pdfapp-sb-header-row">
                <div className="pdfapp-sb-header-left">
                  {onBack && (
                    <button type="button" className="pdfapp-sb-icon-btn" onClick={onBack} title="Back to calendar">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    className="pdfapp-sb-icon-btn"
                    onClick={toggleTheme}
                    title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                  >
                    {theme === 'dark' ? (
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="5" />
                        <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                        <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    )}
                  </button>
                </div>

                <span className="pdfapp-sb-case-title" title={caseName || folder?.name}>
                  {caseName || folder?.name || 'Documents'}
                </span>

                <button type="button" className="pdfapp-sb-litigants-btn" onClick={handleAddParty}>
                  + Folder
                </button>
                <button
                  type="button"
                  className="pdfapp-sb-collapse-btn"
                  onClick={() => setSidebarOpen(false)}
                  title="Collapse sidebar"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              </div>
              <div className="pdfapp-sb-separator" />
            </div>

            {/* Party groups */}
            <div className="pdfapp-party-list">
              {parties.length === 0 ? (
                <div className="pdfapp-sb-empty-state">
                  <p>No folders yet.</p>
                  <button type="button" className="pdfapp-sb-litigants-btn" onClick={handleAddParty}>
                    + Add Folder
                  </button>
                </div>
              ) : (
                parties.map(party => {
                  const isCollapsed = !!collapsedParties[party.id]
                  const isRenaming = renamingPartyId === party.id
                  return (
                    <div key={party.id} className="pdfapp-party-group">
                      {/* Folder header row — click anywhere to expand/collapse */}
                      <div
                        className={`pdfapp-party-header${activePartyId === party.id ? ' pdfapp-party-header--active' : ''}`}
                        onClick={() => {
                          setCollapsedParties(prev => ({ ...prev, [party.id]: !isCollapsed }))
                          setActivePartyId(party.id)
                        }}
                      >
                        {/* Chevron — visual only, not a button */}
                        <span className="pdfapp-party-chevron">
                          <svg
                            viewBox="0 0 24 24" width="11" height="11"
                            fill="none" stroke="currentColor" strokeWidth="2.5"
                            style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </span>

                        {isRenaming ? (
                          <input
                            className="pdfapp-party-rename-input"
                            defaultValue={party.name}
                            autoFocus
                            onClick={e => e.stopPropagation()}
                            onBlur={e => { handleRenameParty(party.id, e.target.value); setRenamingPartyId(null) }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { handleRenameParty(party.id, e.target.value); setRenamingPartyId(null) }
                              if (e.key === 'Escape') setRenamingPartyId(null)
                            }}
                          />
                        ) : (
                          <span className="pdfapp-party-name" title={party.name}>
                            {party.name}
                          </span>
                        )}

                        {/* D: doc-count + status badge when collapsed */}
                        {isCollapsed && party.documents.length > 0 && (() => {
                          const allIndexed = party.documents.every(d => docStatuses[d.id] === 'indexed')
                          const anyProcessing = party.documents.some(d => ['extracting', 'indexing'].includes(docStatuses[d.id]))
                          return (
                            <span className="pdfapp-party-count">
                              {party.documents.length}{allIndexed ? ' ✓' : anyProcessing ? ' ⟳' : ''}
                            </span>
                          )
                        })()}

                        {/* Hover actions */}
                        <div className="pdfapp-party-actions">
                          <button
                            type="button"
                            className="pdfapp-party-action-btn"
                            title="Rename folder"
                            onClick={e => { e.stopPropagation(); setRenamingPartyId(party.id) }}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="pdfapp-party-action-btn"
                            title="Add document"
                            onClick={e => { e.stopPropagation(); handleAddDocToParty(party.id) }}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                              <line x1="12" y1="11" x2="12" y2="17" />
                              <line x1="9" y1="14" x2="15" y2="14" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="pdfapp-party-action-btn pdfapp-party-action-btn--danger"
                            title="Delete folder"
                            onClick={e => { e.stopPropagation(); handleRemoveParty(party.id) }}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* Document cards nested under party */}
                      {!isCollapsed && (
                        <div className="pdfapp-party-docs">
                          {party.documents.length === 0 ? (
                            <button
                              type="button"
                              className="pdfapp-doc-add-btn"
                              onClick={() => handleAddDocToParty(party.id)}
                            >
                              + Add document
                            </button>
                          ) : (
                            <>
                              {party.documents.map(doc => {
                                const status = docStatuses[doc.id]
                                const isActive = activeDocumentId === doc.id
                                return (
                                  <div
                                    key={doc.id}
                                    className={`pdfapp-doc-card${isActive ? ' pdfapp-doc-card--active' : ''}`}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => { setActiveDocumentId(doc.id); setActivePartyId(party.id) }}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        setActiveDocumentId(doc.id)
                                        setActivePartyId(party.id)
                                      }
                                    }}
                                  >
                                    <div className="pdfapp-doc-card-icon">
                                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                        <polyline points="14 2 14 8 20 8" />
                                      </svg>
                                    </div>
                                    <div className="pdfapp-doc-card-info">
                                      <span className="pdfapp-doc-card-name" title={doc.name}>{doc.name}</span>
                                      {(pageCountsById[doc.id] != null || docChunkCountsById[doc.id] != null) && (
                                        <span className="pdfapp-doc-card-pages">
                                          {pageCountsById[doc.id] != null ? `${pageCountsById[doc.id]} page${pageCountsById[doc.id] === 1 ? '' : 's'}` : ''}
                                          {pageCountsById[doc.id] != null && docChunkCountsById[doc.id] != null ? ' · ' : ''}
                                          {docChunkCountsById[doc.id] != null ? `${docChunkCountsById[doc.id]} chunks` : ''}
                                        </span>
                                      )}
                                    </div>
                                    <div className="pdfapp-doc-card-right">
                                      {(() => {
                                        const st = docStatuses[doc.id]
                                        const cc = docChunkCountsById[doc.id]
                                        if (!st) return null
                                        // icon-only status indicators
                                        if (st === 'extracting' || st === 'indexing') {
                                          return (
                                            <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--loading" title={st === 'extracting' ? 'Reading…' : 'Chunking…'}>
                                              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                                                <circle cx="8" cy="8" r="6" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round"/>
                                              </svg>
                                            </span>
                                          )
                                        }
                                        if (st === 'indexed') {
                                          return (
                                            <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--indexed" title={cc ? `Chunked — ${cc} chunks` : 'Chunked'}>
                                              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                                                <circle cx="8" cy="8" r="6"/>
                                                <path d="M5 8 L7 10.5 L11 6" strokeLinecap="round" strokeLinejoin="round"/>
                                              </svg>
                                            </span>
                                          )
                                        }
                                        if (st === 'error') {
                                          return (
                                            <span className="pdfapp-doc-card-retry">
                                              <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--error" title="Processing failed">
                                                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                                                  <circle cx="8" cy="8" r="6"/>
                                                  <path d="M8 5 L8 9" strokeLinecap="round"/>
                                                  <circle cx="8" cy="11.5" r="0.8" fill="currentColor"/>
                                                </svg>
                                              </span>
                                              <button
                                                type="button"
                                                className="pdfapp-doc-retry-btn"
                                                title="Retry — re-read and re-index this document"
                                                onClick={e => { e.stopPropagation(); handleReextractAndReindex(doc.id, doc.file) }}
                                              >Retry</button>
                                            </span>
                                          )
                                        }
                                        if (st === 'extracted') {
                                          return (
                                            <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--ready" title="Text extracted">
                                              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                                                <rect x="3" y="2" width="10" height="12" rx="1.5"/>
                                                <line x1="5" y1="6" x2="11" y2="6" strokeLinecap="round"/>
                                                <line x1="5" y1="9" x2="11" y2="9" strokeLinecap="round"/>
                                                <line x1="5" y1="12" x2="8" y2="12" strokeLinecap="round"/>
                                              </svg>
                                            </span>
                                          )
                                        }
                                        return null
                                      })()}
                                      <button
                                        type="button"
                                        className="pdfapp-doc-remove"
                                        onClick={e => { e.stopPropagation(); handleRemoveDocument(doc.id) }}
                                        aria-label={`Remove ${doc.name}`}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </div>
                                )
                              })}
                              <button
                                type="button"
                                className="pdfapp-doc-add-btn"
                                onClick={() => handleAddDocToParty(party.id)}
                              >
                                + Add document
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>


            {/* ── Activity Log ── */}
            <div className="pdfapp-log-panel">
              <button
                type="button"
                className="pdfapp-log-header"
                onClick={() => setLogOpen(o => !o)}
              >
                <span>Activity Log</span>
                <span className="pdfapp-log-chevron">{logOpen ? '▾' : '▸'}</span>
              </button>
              {logOpen && (
                <div className="pdfapp-log-entries" ref={logEntriesRef}>
                  {logs.length === 0 && (
                    <div className="pdfapp-log-empty">No activity yet</div>
                  )}
                  {logs.map(entry => (
                    <div key={entry.id} className={`pdfapp-log-entry pdfapp-log-entry--${entry.level}`}>
                      <span className="pdfapp-log-time">
                        {entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="pdfapp-log-msg">{entry.msg}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>


            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              style={{ display: 'none' }}
              onChange={handleFilesSelected}
            />
          </div>
        ) : (
          <div className="pdfapp-sidebar-icons">
            <button
              className="pdfapp-sb-collapse-btn"
              type="button"
              title="Expand sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* ── Thumbnails strip (between sidebar and center) ── */}
      {thumbsOpen && pageCount && (
        <div className="pdfapp-thumbs" ref={thumbsContainerRef}>
          {Array.from({ length: pageCount }, (_, i) => {
            const n = i + 1
            const dim = pageDims[n] || pageDims[1]
            const thumbW = 72
            const thumbH = dim ? Math.round(thumbW * dim.h / dim.w) : Math.round(thumbW * 1.414)
            return (
              <div
                key={`thumb-${activeDocumentId}-${n}`}
                className="pdfapp-thumb-item"
                onClick={() => {
                  scrollPageIntoView(n, 'start')
                }}
              >
                <canvas
                  data-page={n}
                  className="pdfapp-thumb-canvas"
                  style={{ width: thumbW, height: thumbH }}
                />
                <span className="pdfapp-thumb-num">{n}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Panel 2: Center (PDF viewer) ── */}
      <div className="pdfapp-center" style={{ flex: centerFlex }}>
        {(() => {
          const activeDoc = documents.find(d => d.id === activeDocumentId)
          if (!activeDoc) {
            return (
              <div className="pdfapp-center-placeholder">
                Select a document from the sidebar
              </div>
            )
          }
          return (
            <div className="pdfapp-center-content">
              <div className="pdfapp-center-header">
                <div className="pdfapp-toolbar-left">
                  {/* Thumbnail toggle */}
                  <button
                    className={`pdfapp-toolbar-btn pdfapp-toolbar-btn--thumb${thumbsOpen ? ' pdfapp-toolbar-btn--active' : ''}`}
                    onClick={() => setThumbsOpen(o => !o)}
                    title={thumbsOpen ? 'Hide thumbnails' : 'Show page thumbnails'}
                    disabled={!pageCount}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                    </svg>
                  </button>
                </div>
                <span className="pdfapp-center-filename" title={activeDoc.name}>
                  {activeDoc.name.length > 50 ? activeDoc.name.slice(0, 50) + '…' : activeDoc.name}
                </span>
                <div className="pdfapp-toolbar-right">
                </div>
              </div>
              <div className="pdfapp-center-body" ref={pagesContainerRef}>
                {pdfError && (
                  <div className="pdfapp-center-placeholder">
                    {pdfError}
                  </div>
                )}
                {!pdfError && (
                  <div className="pdfapp-center-pages">
                    {pdfLoading && (
                      <div className="pdfapp-center-placeholder pdfapp-center-placeholder--inline">
                        Loading PDF…
                      </div>
                    )}
                    {pageCount != null && Array.from({ length: pageCount }, (_, index) => {
                      const pageNum = index + 1
                      const dim = pageDims[pageNum]
                      const pageHighlights = [...displayCitations.values()].filter(c => c.page_num === pageNum && c.bbox)
                      const pageNotes = notes.filter(n => n.pageNum === pageNum)
                      return (
                        <div
                          key={`${activeDocumentId}-${pageNum}-${renderScale}`}
                          className={`pdfapp-page-wrapper${noteMode ? ' pdfapp-page-wrapper--note-mode' : ''}`}
                          onClick={noteMode ? (e) => handlePageClick(e, pageNum) : undefined}
                        >
                          <canvas
                            data-page={pageNum}
                            className="pdfapp-page-canvas"
                            style={dim
                              ? { width: `${dim.w}px`, height: `${dim.h}px`, backgroundColor: '#1f2937' }
                              : { backgroundColor: '#1f2937' }
                            }
                          />
                          {/* Selectable text layer — built imperatively after render */}
                          <div className="pdfapp-text-layer" data-textlayer={pageNum} />
                          {/* Citation highlights */}
                          {pageHighlights.length > 0 && (
                            <div className="pdfapp-highlight-overlay">
                              {pageHighlights.map((chunk, i) => {
                                const handleHighlightClick = () => {
                                  if (!extractedPages) return
                                  const pg = extractedPages.find(p => p.pageNum === chunk.page_num)
                                  if (!pg) return
                                  const idx = chunk.chunk_idx ?? pg.chunks.findIndex(c =>
                                    c.bbox && chunk.bbox &&
                                    Math.abs(c.bbox[0] - chunk.bbox[0]) < 0.005 &&
                                    Math.abs(c.bbox[1] - chunk.bbox[1]) < 0.005
                                  )
                                  if (idx >= 0) setActiveChunkKey(`${chunk.page_num}-${idx}`)
                                }
                                // Per-line highlight: one stripe per text row — no whitespace gaps,
                                // no column spillover. Falls back to single-rect for LLM citations
                                // that only carry a bbox (no sourceWords in search results).
                                if (chunk.lineRects?.length) {
                                  return chunk.lineRects.map((r, li) => (
                                    <div
                                      key={`${i}-${li}`}
                                      className="pdfapp-highlight-rect pdfapp-highlight-rect--line"
                                      style={{
                                        left:          `${r[0] * 100}%`,
                                        top:           `${r[1] * 100}%`,
                                        width:         `${(r[2] - r[0]) * 100}%`,
                                        height:        `${(r[3] - r[1]) * 100}%`,
                                        pointerEvents: 'auto',
                                        cursor:        'pointer',
                                      }}
                                      onClick={handleHighlightClick}
                                    />
                                  ))
                                }
                                // Fallback: single rect from bbox/narrowBbox (LLM citations)
                                const b = chunk.narrowBbox || chunk.bbox
                                return (
                                  <div
                                    key={i}
                                    className={`pdfapp-highlight-rect${chunk.narrowBbox ? ` pdfapp-highlight-rect--narrow pdfapp-highlight-rect--${chunk.narrowBboxSource ?? 'unknown'}` : ''}`}
                                    style={{
                                      left:          `${b[0] * 100}%`,
                                      top:           `${b[1] * 100}%`,
                                      width:         `${(b[2] - b[0]) * 100}%`,
                                      height:        `${(b[3] - b[1]) * 100}%`,
                                      pointerEvents: 'auto',
                                      cursor:        'pointer',
                                    }}
                                    onClick={handleHighlightClick}
                                  />
                                )
                              })}
                            </div>
                          )}
                          {/* Note pins */}
                          {pageNotes.map(note => (
                            <div
                              key={note.id}
                              className={`pdfapp-note-pin${openNoteId === note.id ? ' pdfapp-note-pin--open' : ''}`}
                              style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
                              onClick={e => { e.stopPropagation(); setOpenNoteId(id => id === note.id ? null : note.id) }}
                            >
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke="white" strokeWidth="1.5" fill="none"/>
                              </svg>
                              {/* D: styled hover preview (replaces browser tooltip) */}
                              {openNoteId !== note.id && note.text && (
                                <div className="pdfapp-note-preview">{note.text}</div>
                              )}
                              {openNoteId === note.id && (
                                <div className="pdfapp-note-popover" onClick={e => e.stopPropagation()}>
                                  <textarea
                                    className="pdfapp-note-textarea"
                                    defaultValue={note.text}
                                    placeholder="Type your note…"
                                    autoFocus
                                    onBlur={e => {
                                      const text = e.target.value.trim()
                                      if (!text) {
                                        // B: discard empty notes instead of saving blanks
                                        handleNoteDelete(note.id)
                                      } else {
                                        handleNoteTextSave(note.id, e.target.value)
                                      }
                                    }}
                                  />
                                  <div className="pdfapp-note-popover-footer">
                                    <span className="pdfapp-note-date">
                                      {new Date(note.createdAt).toLocaleDateString()}
                                    </span>
                                    <button
                                      className="pdfapp-note-delete-btn"
                                      onClick={() => handleNoteDelete(note.id)}
                                      title="Delete note"
                                    >Delete</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* ── Extracted Text Panel ── */}
              <div
                className="pdfapp-extracted-panel"
                style={{ height: extractedTextOpen ? extractedTextHeight : 32 }}
              >
                {extractedTextOpen && (
                  <div
                    className="pdfapp-extracted-drag"
                    onMouseDown={onTextPanelHandleDown}
                  />
                )}
                {/* ── Header row: title + badges + controls ── */}
                <div className="pdfapp-extracted-header">
                  <div
                    className="pdfapp-extracted-header-left"
                    onClick={() => setExtractedTextOpen(o => !o)}
                    style={{ cursor: 'pointer', flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>Text Chunks</span>
                    {extractionSource && (
                      <span className={`pdfapp-extraction-badge pdfapp-extraction-badge--${extractionSource}`}>
                        {extractionSource === 'ocr' ? 'OCR' : 'Text'}
                      </span>
                    )}
                    {extractedPages && (
                      <span className="pdfapp-chunk-count">
                        {extractedPages.reduce((s, p) => s + p.chunks.length, 0)} chunks
                      </span>
                    )}
                    {extractingText && (
                      <div className="pdfapp-spinner pdfapp-spinner--small" style={{ marginLeft: 4 }} />
                    )}
                  </div>

                  {/* ── Controls: cancel in-progress ops + settings menu ── */}
                  <div className="pdfapp-extract-controls" onClick={e => e.stopPropagation()}>
                    {extractingText && (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--stop"
                        onClick={() => { extractionAbortRef.current?.abort(); setExtractingText(false); setExtractionStatus('') }}
                      >■ Cancel</button>
                    )}
                    {ragStatus === 'indexing' && (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--stop"
                        onClick={() => { setRagStatus('failed'); setRagProgress('') }}
                      >■ Cancel</button>
                    )}
                    {/* Service status dots — only shown when a service is confirmed down */}
                    {connectivity.embed && !connectivity.embed.ok && (() => {
                      const embedIsLlamafile = (connectivity.embed?.backend ?? 'ollama') === 'llamafile'
                      const embedModel = connectivity.embed?.model ?? import.meta.env.VITE_OLLAMA_EMBED_MODEL ?? 'nomic-embed-text:latest'
                      const tip = embedIsLlamafile
                        ? `Embedding offline — start: ./llamafile/llamafiler -m ./llamafile/nomic-embed-text-v1.5.Q8_0.gguf --embedding`
                        : `Embedding offline — run: ollama serve  then: ollama pull ${embedModel}`
                      return (
                        <span className="pdfapp-svc-dot pdfapp-svc-dot--down" title={tip}
                          onClick={checkConnectivity}>
                          <span className="pdfapp-svc-dot-label">embed</span>
                        </span>
                      )
                    })()}
                    {connectivity.llm && !connectivity.llm.ok && (() => {
                      const isLlamafile = LLM_BACKEND_NAME === 'llamafile'
                      const tip = isLlamafile
                        ? `LLM offline — start: ./llamafile/llamafiler -m ./llamafile/${LLM_MODEL_NAME} -l 0.0.0.0:8081`
                        : `LLM offline — run: ollama serve  then: ollama pull ${LLM_MODEL_NAME}`
                      return (
                        <span className="pdfapp-svc-dot pdfapp-svc-dot--down" title={tip}
                          onClick={checkConnectivity}>
                          <span className="pdfapp-svc-dot-label">llm</span>
                        </span>
                      )
                    })()}
                    <button
                      className="pdfapp-action-btn pdfapp-action-btn--menu"
                      title="Text processing guide & settings"
                      onClick={() => setChunkGuideOpen(true)}
                    >···</button>
                  </div>

                  <span
                    className="pdfapp-extracted-arrow"
                    onClick={() => setExtractedTextOpen(o => !o)}
                    style={{ cursor: 'pointer' }}
                  >
                    {extractedTextOpen ? '▲' : '▼'}
                  </span>
                </div>

                {extractedTextOpen && (
                  extractedPages ? (
                    <>
                    {/* ── Chunk search bar ── */}
                    <div className="pdfapp-chunk-search-bar">
                      <input
                        className="pdfapp-chunk-search-input"
                        type="text"
                        placeholder="Filter chunks… (Enter for semantic search)"
                        value={chunkQuery}
                        onChange={e => handleChunkQueryChange(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); handleChunkSemanticSearch() }
                          if (e.key === 'Escape') { handleChunkQueryChange(''); e.target.blur() }
                        }}
                      />
                      {chunkQuery && (
                        <button className="pdfapp-chunk-search-clear" onClick={() => handleChunkQueryChange('')} title="Clear">✕</button>
                      )}
                      {chunkSemanticLoading && <div className="pdfapp-spinner pdfapp-spinner--small" style={{ flexShrink: 0 }} />}
                    </div>
                    <div className="pdfapp-chunks-body" ref={chunksPanelRef}>
                      {(() => {
                        // Build display list based on search mode
                        let displayChunks // [{page, chunk, idx, matchHighlight}]
                        const queryNorm = chunkQuery.trim().toLowerCase()

                        if (chunkSearchMode === 'semantic' && chunkSemanticResults) {
                          // Show semantic results in ranked order
                          displayChunks = chunkSemanticResults.map(r => {
                            const page = extractedPages.find(p => p.pageNum === r.page_num)
                            const chunk = page?.chunks[r.chunk_idx]
                            if (!page || !chunk) return null
                            return { page, chunk, idx: r.chunk_idx, score: r.distance != null ? distanceToScore(r.distance) : null }
                          }).filter(Boolean)
                        } else if (chunkSearchMode === 'filter' && queryNorm) {
                          // Text filter across all chunks
                          displayChunks = []
                          for (const page of extractedPages) {
                            page.chunks.forEach((chunk, idx) => {
                              if (chunk.text?.toLowerCase().includes(queryNorm)) {
                                displayChunks.push({ page, chunk, idx })
                              }
                            })
                          }
                        } else {
                          // All chunks
                          displayChunks = []
                          for (const page of extractedPages) {
                            page.chunks.forEach((chunk, idx) => {
                              displayChunks.push({ page, chunk, idx })
                            })
                          }
                        }

                        if (displayChunks.length === 0) {
                          return (
                            <div className="pdfapp-extracted-prompt">
                              <span className="pdfapp-extracted-placeholder">
                                {chunkQuery.trim()
                                  ? chunkSearchMode === 'semantic'
                                    ? 'No matching chunks found.'
                                    : <>No chunks match. Press <kbd>Enter</kbd> for semantic search.</>
                                  : 'No text chunks extracted. Try re-running extraction.'}
                              </span>
                            </div>
                          )
                        }

                        return displayChunks.map(({ page, chunk, idx, score }) => {
                          const chunkKey = `${page.pageNum}-${idx}`
                          const isEditing = editingNoteChunkKey === chunkKey
                          const chunkNotes = notes.filter(n => n.chunkIdx === idx && n.pageNum === page.pageNum)

                          // Highlight matching text in filter mode
                          let textContent
                          if (chunkSearchMode === 'filter' && queryNorm && chunk.text) {
                            const parts = []
                            let remaining = chunk.text
                            let searchFrom = 0
                            const lower = chunk.text.toLowerCase()
                            let found
                            while ((found = lower.indexOf(queryNorm, searchFrom)) !== -1) {
                              if (found > searchFrom) parts.push(<span key={`b${found}`}>{chunk.text.slice(searchFrom, found)}</span>)
                              parts.push(<mark key={`m${found}`} className="pdfapp-chunk-match">{chunk.text.slice(found, found + queryNorm.length)}</mark>)
                              searchFrom = found + queryNorm.length
                            }
                            if (searchFrom < chunk.text.length) parts.push(<span key="tail">{chunk.text.slice(searchFrom)}</span>)
                            textContent = parts
                          } else {
                            textContent = chunk.text
                          }

                          return (
                            <div
                              key={chunkKey}
                              data-chunk-key={chunkKey}
                              className={`pdfapp-chunk-card${activeChunkKey === chunkKey ? ' pdfapp-chunk-card--active' : ''}`}
                              onClick={e => {
                                // Don't trigger PDF scroll when clicking note button/textarea
                                if (e.target.closest('.pdfapp-chunk-note-btn') || e.target.closest('.pdfapp-chunk-note-area')) return
                                setActiveChunkKey(chunkKey)
                                // lineRects gives per-line stripes directly from sourceWords —
                                // single render, no async textlayer upgrade needed for chunk clicks.
                                setActiveCitations(new Map([[1, {
                                  text: chunk.text,
                                  page_num: page.pageNum,
                                  bbox: chunk.bbox,
                                  lineRects: chunk.lineRects ?? null,
                                  chunk_idx: idx,
                                }]]))
                              }}
                            >
                              <div className="pdfapp-chunk-meta">
                                <span className="pdfapp-chunk-tag pdfapp-chunk-tag--page">P{page.pageNum}</span>
                                <span className="pdfapp-chunk-tag pdfapp-chunk-tag--idx">#{idx}</span>
                                {score != null && (
                                  <span className="pdfapp-chunk-tag pdfapp-chunk-tag--score">{Math.round(score * 100)}%</span>
                                )}
                                {chunk.bbox && !score && (
                                  <span className="pdfapp-chunk-bbox">
                                    [{chunk.bbox.map(v => (v * 100).toFixed(1) + '%').join(', ')}]
                                  </span>
                                )}
                                <button
                                  className={`pdfapp-chunk-note-btn${chunkNotes.length > 0 ? ' pdfapp-chunk-note-btn--has-notes' : ''}`}
                                  title={chunkNotes.length > 0 ? `${chunkNotes.length} note${chunkNotes.length > 1 ? 's' : ''} — click to add another` : 'Add note from this chunk'}
                                  onClick={e => {
                                    e.stopPropagation()
                                    if (isEditing) {
                                      setEditingNoteChunkKey(null)
                                      setNoteChunkDraft('')
                                    } else {
                                      setEditingNoteChunkKey(chunkKey)
                                      setNoteChunkDraft('')
                                    }
                                  }}
                                >✏{chunkNotes.length > 0 && <span className="pdfapp-chunk-note-count">{chunkNotes.length}</span>}</button>
                              </div>
                              <p className="pdfapp-chunk-text">{textContent}</p>
                              {isEditing && (
                                <div className="pdfapp-chunk-note-area" onClick={e => e.stopPropagation()}>
                                  {chunkNotes.length > 0 && (
                                    <div className="pdfapp-chunk-note-existing">
                                      {chunkNotes.map(n => (
                                        <div key={n.id} className="pdfapp-chunk-note-existing-item">
                                          <span className="pdfapp-chunk-note-existing-date">{new Date(n.createdAt).toLocaleDateString()}</span>
                                          <p className="pdfapp-chunk-note-existing-text">{n.text}</p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  <textarea
                                    className="pdfapp-chunk-note-input"
                                    placeholder="Add a note… (Ctrl+Enter to save, Esc to cancel)"
                                    value={noteChunkDraft}
                                    autoFocus
                                    onChange={e => setNoteChunkDraft(e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                        e.preventDefault()
                                        saveNoteFromChunk(chunk, page.pageNum, idx)
                                      }
                                      if (e.key === 'Escape') {
                                        setEditingNoteChunkKey(null)
                                        setNoteChunkDraft('')
                                      }
                                    }}
                                  />
                                  <div className="pdfapp-chunk-note-actions">
                                    <button
                                      className="pdfapp-chunk-note-save"
                                      disabled={!noteChunkDraft.trim()}
                                      onClick={() => saveNoteFromChunk(chunk, page.pageNum, idx)}
                                    >Save note</button>
                                    <button
                                      className="pdfapp-chunk-note-cancel"
                                      onClick={() => { setEditingNoteChunkKey(null); setNoteChunkDraft('') }}
                                    >Cancel</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })
                      })()}
                      {extractingText && (
                        <div className="pdfapp-extracted-prompt" style={{ paddingTop: 8 }}>
                          <div className="pdfapp-spinner pdfapp-spinner--small" />
                          <span className="pdfapp-extracted-status">{extractionStatus}</span>
                        </div>
                      )}
                    </div>
                    </>
                  ) : extractingText ? (
                    <div className="pdfapp-extracted-prompt">
                      <span className="pdfapp-extracted-status">{extractionStatus || 'Extracting…'}</span>
                    </div>
                  ) : extractionError ? (
                    <div className="pdfapp-extracted-prompt">
                      <span className="pdfapp-extracted-error">{extractionError}</span>
                    </div>
                  ) : (
                    <div className="pdfapp-extracted-prompt">
                      <span className="pdfapp-extracted-placeholder">
                        {activeDoc?.file
                          ? ragStatus === 'indexed'
                            ? <>Chunks not loaded. <button className="pdfapp-reload-chunks-btn" onClick={reloadChunksOnly}>Reload chunks</button></>
                            : <>Press <strong>Prepare for search</strong> above to start extraction.</>
                          : 'No file loaded — upload a PDF to get started.'}
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>
          )
        })()}

        {/* ── Activity status bar ── */}
        {(() => {
          const msg =
            pdfLoading      ? (ragProgress || 'Loading PDF…') :
            extractingText  ? (extractionStatus || 'Extracting text…') :
            ragStatus === 'indexing' ? (ragProgress || 'Chunking document…') :
            null
          if (!msg) return null
          return (
            <div className="pdfapp-status-bar">
              <div className="pdfapp-spinner pdfapp-spinner--small pdfapp-status-bar__spinner" />
              <span className="pdfapp-status-bar__text">{msg}</span>
            </div>
          )
        })()}

        {/* Divider — absolutely overlaid on right edge, NOT a flex sibling */}
        <div
          className="pdfapp-divider"
          onMouseDown={onDividerMouseDown}
        >
          <span className="pdfapp-divider-handle">⠿</span>
        </div>
      </div>

      {/* ── Panel 3: Right Workspace ── */}
      <div className="pdfapp-right" style={{ flex: rightFlex }}>
        {/* Tab bar */}
        <div className="pdfapp-right-tabs">
          <button className={`pdfapp-right-tab${rightTab === 'chat' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('chat')}>Chat</button>
          <button className={`pdfapp-right-tab${rightTab === 'notes' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('notes')}>
            {(() => {
              const merged = { ...allCaseNotes, ...(activeDocumentId ? { [activeDocumentId]: notes } : {}) }
              const t = Object.values(merged).flat().filter(n => n.text?.trim()).length
              return `Notes (${t})`
            })()}
          </button>
          <button className={`pdfapp-right-tab${rightTab === 'aide' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('aide')}>
            Aide{aideStatus === 'running' ? ' ⟳' : aideStatus === 'done' ? ' ✓' : ''}
          </button>
          <button className={`pdfapp-right-tab${rightTab === 'law' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('law')}>
            Law{lawStatus?.available ? ' ✓' : ''}
          </button>
        </div>

        {/* ── Chat tab ── */}
        {rightTab === 'chat' && <div className="pdfapp-chat">
          <div className="pdfapp-chat-messages" ref={chatMessagesRef}>
              {chatMessages.length === 0 && (
                <div className="pdfapp-chat-empty">
                  <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#4b5563" strokeWidth="1.2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <p>Ask LexChat anything about this document</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`pdfapp-chat-msg pdfapp-chat-msg--${msg.role}`}>
                  {msg.role === 'assistant' && (
                    <div className="pdfapp-chat-avatar">L</div>
                  )}
                  <div className="pdfapp-chat-msg-body">
                    <div className="pdfapp-chat-bubble">
                      {renderMessageContent(msg, i === chatMessages.length - 1)}
                    </div>
                    {msg.role === 'assistant' && msg.citations?.size > 0 && (
                      <div className="pdfapp-sources">
                        <span className="pdfapp-sources-label">Sources</span>
                        {[...msg.citations.entries()].map(([n, chunk]) => {
                          const score = chunk.distance != null ? distanceToScore(chunk.distance) : null
                          const hasNarrow = !!chunk.narrowBbox
                          const isStarred = starredSources.some(s => s.key === `${chunk.page_num}::${chunk.text.slice(0, 60)}`)
                          const questionCtx = chatMessages[i - 1]?.content || ''
                          return (
                            <div key={n} className="pdfapp-source-row">
                              <button
                                className={`pdfapp-source-item${displayCitations.has(n) ? ' pdfapp-source-item--active' : ''}`}
                                onClick={() => {
                                  addLog(`[CLICK] source [${n}] → page ${chunk.page_num}`, 'info')
                                  setActiveCitations(new Map([[n, chunk]]))
                                }}
                                title={hasNarrow ? 'Sentence-level highlight available' : 'Paragraph highlight'}
                              >
                                <span className="pdfapp-source-num">[{n}]</span>
                                <span className="pdfapp-source-page">p.{chunk.page_num}</span>
                                {score != null && (
                                  <span className={`pdfapp-source-score pdfapp-source-score--${score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low'}`}>
                                    {score}%
                                  </span>
                                )}
                                {hasNarrow && <span className="pdfapp-source-narrow" title="Sentence-level">◈</span>}
                                <span className="pdfapp-source-excerpt">
                                  {chunk.text.slice(0, 100)}{chunk.text.length > 100 ? '…' : ''}
                                </span>
                              </button>
                              <button
                                className={`pdfapp-source-star${isStarred ? ' pdfapp-source-star--active' : ''}`}
                                title={isStarred ? 'Remove from evidence' : 'Add to evidence'}
                                onClick={() => handleToggleStar(chunk, questionCtx)}
                              >★</button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {msg.role === 'assistant' && msg.suggestions?.length > 0 && (
                      <div className="pdfapp-suggestions">
                        {msg.suggestions.map((q, si) => (
                          <button
                            key={si}
                            className="pdfapp-suggestion-chip"
                            onClick={() => setChatInput(q)}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {caseId && (
              <div className="pdfapp-chat-scope-row">
                <button
                  className={`pdfapp-chat-scope-btn${caseSearchActive ? ' pdfapp-chat-scope-btn--active' : ''}`}
                  onClick={() => setCaseSearchActive(v => !v)}
                  title={caseSearchActive ? 'Searching entire case — click to limit to active document' : 'Click to search all documents in this case'}
                >
                  {caseSearchActive ? 'Searching: entire case' : 'Searching: active doc'}
                </button>
              </div>
            )}
            <div className="pdfapp-chat-input-row">
              <textarea
                className="pdfapp-chat-input"
                placeholder="Ask a legal question…"
                value={chatInput}
                rows={1}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend() }
                }}
                disabled={chatLoading || !activeDocumentId}
              />
              <button
                className={`pdfapp-chat-send${chatLoading ? ' pdfapp-chat-send--stop' : ''}`}
                onClick={chatLoading ? () => chatAbortRef.current?.abort() : handleChatSend}
                disabled={!chatLoading && (!chatInput.trim() || !activeDocumentId)}
                title={chatLoading ? 'Stop generation' : 'Send'}
              >
                {chatLoading
                  ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                }
              </button>
            </div>
          </div>}

        {/* ── Notes tab ── */}
        {rightTab === 'notes' && (() => {
          const resolveDoc = (docId) => {
            const p = parties.find(pt => (pt.documents || []).some(d => d.id === docId))
            const d = p?.documents?.find(d => d.id === docId)
            return { partyName: p?.name || null, docName: d?.name || null }
          }

          const starGroups = parties.map(party => ({
            party,
            sources: starredSources
              .filter(s => (party.documents || []).some(d => d.id === s.docId))
              .map(s => ({ ...s, docName: s.docName || resolveDoc(s.docId).docName, partyName: s.partyName || party.name })),
          })).filter(g => g.sources.length > 0)
          const assignedIds = new Set(starGroups.flatMap(g => g.sources.map(s => s.id)))
          const unassigned = starredSources.filter(s => !assignedIds.has(s.id))

          const noteGroups = parties.map(party => ({
            party,
            docNotes: (party.documents || [])
              .map(doc => ({ doc, notes: (allCaseNotes[doc.id] || []).filter(n => n.text?.trim()) }))
              .filter(dn => dn.notes.length > 0),
          })).filter(g => g.docNotes.length > 0)

          const totalNotes = Object.values(allCaseNotes).flat().filter(n => n.text?.trim()).length
          const isEmpty = starredSources.length === 0 && totalNotes === 0

          const toggle = (key) => setNotesCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
          const isCol = (key) => !!notesCollapsed[key]

          const goToSource = (s) => {
            if (s.docId !== activeDocumentId) {
              pendingNavRef.current = { pageNum: s.pageNum, chunkText: s.chunkText, bbox: s.bbox, narrowBbox: s.narrowBbox }
              setActiveDocumentId(s.docId)
            } else {
              scrollPageIntoView(s.pageNum, 'center')
              setActiveCitations(new Map([[1, { text: s.chunkText, page_num: s.pageNum, bbox: s.bbox, narrowBbox: s.narrowBbox }]]))
            }
          }
          const goToNote = (docId, pageNum) => {
            if (docId !== activeDocumentId) {
              pendingNavRef.current = { pageNum, chunkText: '', bbox: null, narrowBbox: null }
              setActiveDocumentId(docId)
            } else {
              scrollPageIntoView(pageNum, 'center')
            }
          }
          const goToChunk = (docId, n) => {
            // Prefer live chunk data (up-to-date after re-chunking); fall back to frozen snapshot on note
            const livePage = docId === activeDocumentId
              ? extractedPages?.find(p => p.pageNum === n.pageNum)
              : null
            const liveChunk = livePage?.chunks?.[n.chunkIdx] ?? null
            const bbox      = liveChunk?.bbox      ?? n.chunkBbox      ?? null
            const lineRects = liveChunk?.lineRects ?? n.chunkLineRects ?? null
            const chunkText = liveChunk?.text      ?? n.chunkText      ?? ''
            const nav = { pageNum: n.pageNum, chunkText, bbox, narrowBbox: null, lineRects, chunkIdx: n.chunkIdx }
            if (docId !== activeDocumentId) {
              pendingNavRef.current = nav
              setActiveDocumentId(docId)
            } else {
              scrollBboxIntoView(n.pageNum, lineRects ?? bbox)
              setActiveCitations(new Map([[1, { text: chunkText, page_num: n.pageNum, bbox, narrowBbox: null, lineRects }]]))
              setActiveChunkKey(`${n.pageNum}-${n.chunkIdx}`)
              setExtractedTextOpen(true)
            }
          }

          // ── Note row renderer ──
          const renderNoteRow = (n, doc) => {
            const isEditing = editingNoteId === n.id
            const dateStr = n.createdAt ? new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
            const navigate = () => n.chunkIdx != null ? goToChunk(doc.id, n) : goToNote(doc.id, n.pageNum)
            return (
              <div key={n.id} className={`nt-note-row${doc.id !== activeDocumentId ? ' nt-note-row--other' : ''}`}>
                <div className="nt-note-meta">
                  <span className="nt-page-badge">page {n.pageNum}</span>
                  {n.chunkIdx != null && <span className="nt-chunk-badge">chunk {n.chunkIdx}</span>}
                  {dateStr && <span className="nt-date">{dateStr}</span>}
                  <div className="nt-row-actions">
                    <button className="nt-action-btn" title="Navigate" onClick={navigate}>→</button>
                    <button className="nt-action-btn" title="Edit note" onClick={e => { e.stopPropagation(); setEditingNoteId(n.id); setEditingNoteDraft(n.text) }}>✏</button>
                    <button className="nt-action-btn nt-action-btn--danger" title="Delete note" onClick={e => { e.stopPropagation(); deleteNoteFromTab(doc.id, n.id) }}>✕</button>
                  </div>
                </div>
                {isEditing ? (
                  <textarea
                    className="nt-note-edit-input"
                    value={editingNoteDraft}
                    autoFocus
                    onChange={e => setEditingNoteDraft(e.target.value)}
                    onBlur={() => { saveNoteEditFromTab(doc.id, n.id, editingNoteDraft); setEditingNoteId(null) }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { saveNoteEditFromTab(doc.id, n.id, editingNoteDraft); setEditingNoteId(null) }
                      if (e.key === 'Escape') setEditingNoteId(null)
                    }}
                  />
                ) : (
                  <>
                    {n.chunkText && (
                      <div className="nt-chunk-quote">{n.chunkText}</div>
                    )}
                    <div className="nt-note-text">{n.text}</div>
                  </>
                )}
              </div>
            )
          }

          const ChevronSvg = ({ collapsed }) => (
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease', flexShrink: 0 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )

          return (
            <div className="nt-root">
              {isEmpty && (
                <div className="pdfapp-evidence-empty">
                  Star sources (★) from chat responses, or add notes from text chunks (✏), to build your evidence collection.
                </div>
              )}

              {/* ── Starred Sources ── */}
              {(starGroups.length > 0 || unassigned.length > 0) && (
                <div className="nt-section">
                  <div className="nt-section-row" onClick={() => toggle('section:starred')}>
                    <ChevronSvg collapsed={isCol('section:starred')} />
                    <span className="nt-section-title">⭐ Starred</span>
                    <span className="nt-count">{starredSources.length}</span>
                  </div>
                  {!isCol('section:starred') && (
                    <div className="nt-children">
                      {starGroups.map(({ party, sources }) => {
                        const pk = `star-party:${party.id}`
                        return (
                          <div key={party.id}>
                            <div className="nt-party-row" onClick={() => toggle(pk)}>
                              <ChevronSvg collapsed={isCol(pk)} />
                              <span className="nt-row-name">{party.name}</span>
                              {isCol(pk) && <span className="nt-count">{sources.length}</span>}
                            </div>
                            {!isCol(pk) && (
                              <div className="nt-children">
                                {sources.map(s => (
                                  <div key={s.id} className="nt-star-row">
                                    <div className="nt-note-meta">
                                      <span className="nt-row-name nt-doc-label" title={s.docName}>{s.docName}</span>
                                      <span className="nt-page-badge">p.{s.pageNum}</span>
                                      {s.score != null && <span className="nt-score">{s.score}%</span>}
                                      <div className="nt-row-actions">
                                        <button className="nt-action-btn" title="Go to source" onClick={() => goToSource(s)}>→</button>
                                        <button className="nt-action-btn nt-action-btn--danger" title="Unstar" onClick={() => handleRemoveStar(s.id)}>✕</button>
                                      </div>
                                    </div>
                                    <div className="nt-star-text">{s.chunkText.slice(0, 120)}{s.chunkText.length > 120 ? '…' : ''}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {unassigned.length > 0 && (
                        <div className="nt-children">
                          {unassigned.map(s => (
                            <div key={s.id} className="nt-star-row">
                              <div className="nt-note-meta">
                                <span className="nt-page-badge">p.{s.pageNum}</span>
                                {s.score != null && <span className="nt-score">{s.score}%</span>}
                                <div className="nt-row-actions">
                                  <button className="nt-action-btn" onClick={() => goToSource(s)}>→</button>
                                  <button className="nt-action-btn nt-action-btn--danger" onClick={() => handleRemoveStar(s.id)}>✕</button>
                                </div>
                              </div>
                              <div className="nt-star-text">{s.chunkText.slice(0, 120)}{s.chunkText.length > 120 ? '…' : ''}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Notes ── */}
              {noteGroups.length > 0 && (
                <div className="nt-section">
                  <div className="nt-section-row" onClick={() => toggle('section:notes')}>
                    <ChevronSvg collapsed={isCol('section:notes')} />
                    <span className="nt-section-title">📝 Notes</span>
                    <span className="nt-count">{totalNotes}</span>
                  </div>
                  {!isCol('section:notes') && (
                    <div className="nt-children">
                      {noteGroups.map(({ party, docNotes }) => {
                        const pk = `note-party:${party.id}`
                        const partyCount = docNotes.reduce((s, dn) => s + dn.notes.length, 0)
                        return (
                          <div key={party.id}>
                            <div className="nt-party-row" onClick={() => toggle(pk)}>
                              <ChevronSvg collapsed={isCol(pk)} />
                              <span className="nt-row-name">{party.name}</span>
                              {isCol(pk) && <span className="nt-count">{partyCount}</span>}
                            </div>
                            {!isCol(pk) && (
                              <div className="nt-children">
                                {docNotes.map(({ doc, notes: docNoteList }) => {
                                  const dk = `doc:${doc.id}`
                                  const chunkLinked = docNoteList.filter(n => n.chunkIdx != null)
                                  const pageOnly = docNoteList.filter(n => n.chunkIdx == null)
                                  const chunkGroups = []
                                  const seenChunks = new Map()
                                  for (const n of chunkLinked) {
                                    const key = `${n.pageNum}-${n.chunkIdx}`
                                    if (!seenChunks.has(key)) {
                                      seenChunks.set(key, { key, pageNum: n.pageNum, chunkText: n.chunkText || '', notes: [] })
                                      chunkGroups.push(seenChunks.get(key))
                                    }
                                    seenChunks.get(key).notes.push(n)
                                  }
                                  return (
                                    <div key={doc.id}>
                                      <div className="nt-doc-row" onClick={() => toggle(dk)}>
                                        <ChevronSvg collapsed={isCol(dk)} />
                                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ flexShrink: 0, color: 'var(--text-dim)' }}>
                                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                        </svg>
                                        <span className="nt-row-name" title={doc.name}>{doc.name}</span>
                                        <span className="nt-count">{docNoteList.length}</span>
                                      </div>
                                      {!isCol(dk) && (
                                        <div className="nt-children">
                                          {chunkGroups.flatMap(group => group.notes.map(n => renderNoteRow(n, doc)))}
                                          {pageOnly.map(n => renderNoteRow(n, doc))}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}

        {/* ── Aide tab ── */}
        {rightTab === 'aide' && (
          <div className="pdfapp-aide-panel">

            {/* Sub-tab bar */}
            <div className="pdfapp-aide-subtabs">
              <button className={`pdfapp-aide-subtab${aideSoulTab === 'run' ? ' pdfapp-aide-subtab--active' : ''}`} onClick={() => setAideSoulTab('run')}>Run</button>
              <button className={`pdfapp-aide-subtab${aideSoulTab === 'soul' ? ' pdfapp-aide-subtab--active' : ''}`} onClick={() => setAideSoulTab('soul')}>Soul</button>
              <button className={`pdfapp-aide-subtab${aideSoulTab === 'memory' ? ' pdfapp-aide-subtab--active' : ''}`} onClick={() => setAideSoulTab('memory')}>
                Memory
                {aideDiary.length > 0 && <span className="pdfapp-aide-subtab-badge">{aideDiary.length}</span>}
              </button>
            </div>

            {/* ── Run sub-tab ── */}
            {aideSoulTab === 'run' && (<>
              <div className="pdfapp-aide-form">
                <div className="pdfapp-aide-form-field">
                  <label className="pdfapp-aide-label">Task</label>
                  <textarea
                    className="pdfapp-aide-textarea"
                    placeholder="What should the agent do? e.g. 'Find all liability clauses across all contracts and flag any conflicts'"
                    value={aideTask}
                    rows={2}
                    onChange={e => setAideTask(e.target.value)}
                    disabled={aideStatus === 'running'}
                  />
                </div>
                <div className="pdfapp-aide-form-field">
                  <label className="pdfapp-aide-label">Your goal <span className="pdfapp-aide-label-hint">(helps your Aide focus)</span></label>
                  <textarea
                    className="pdfapp-aide-textarea"
                    placeholder="e.g. 'Acting for the buyer. Flag anything that exposes the client to unlimited liability.'"
                    value={aideIntent}
                    rows={2}
                    onChange={e => setAideIntent(e.target.value)}
                    disabled={aideStatus === 'running'}
                  />
                </div>
                <div className="pdfapp-aide-form-row">
                  <select
                    className="pdfapp-aide-select"
                    value={aideRole}
                    onChange={e => setAideRole(e.target.value)}
                    disabled={aideStatus === 'running'}
                  >
                    <option value="">— Perspective —</option>
                    <option value="Acting for buyer">Acting for buyer</option>
                    <option value="Acting for seller">Acting for seller</option>
                    <option value="Acting for contractor">Acting for contractor</option>
                    <option value="Acting for client">Acting for client</option>
                    <option value="Neutral due diligence">Neutral due diligence</option>
                    <option value="Litigation — claimant">Litigation — claimant</option>
                    <option value="Litigation — defendant">Litigation — defendant</option>
                  </select>
                  {aideStatus === 'running'
                    ? <button className="pdfapp-aide-run-btn pdfapp-aide-run-btn--stop" onClick={handleAideStop}>■ Stop</button>
                    : <button
                        className="pdfapp-aide-run-btn"
                        onClick={handleAideStart}
                        disabled={!aideTask.trim() || !caseId}
                      >
                        {aideStatus === 'idle' ? 'Run Aide →' : 'Run Again →'}
                      </button>
                  }
                </div>
                {!caseId && <div className="pdfapp-aide-no-case">Open a case to use your Aide.</div>}
              </div>

              {aideSteps.length === 0 && aideStatus === 'idle' && (
                <div className="pdfapp-evidence-empty">
                  Describe your task and goal above, then run your Aide. It will search your documents step-by-step and save findings to Notes.
                </div>
              )}

              {(aideSteps.length > 0 || aideStatus === 'running') && (
                <div className="pdfapp-aide-trail">
                  {aideStatus === 'running' && (
                    <div className="pdfapp-aide-thinking">
                      <span className="pdfapp-aide-thinking-dot" />
                      <span className="pdfapp-aide-thinking-dot" />
                      <span className="pdfapp-aide-thinking-dot" />
                      <span className="pdfapp-aide-thinking-label">Thinking…</span>
                    </div>
                  )}
                  {aideSteps.map((step, i) => (
                    <div key={i} className={`pdfapp-aide-step pdfapp-aide-step--${step.type}`}>
                      {step.type === 'tool_call' && (
                        <>
                          <span className="pdfapp-aide-step-icon">⚙</span>
                          <div className="pdfapp-aide-step-body">
                            <span className="pdfapp-aide-step-tool">{step.tool}</span>
                            {step.tool === 'search_case' && <span className="pdfapp-aide-step-args">"{step.args?.query}"</span>}
                            {step.tool === 'search_doc'  && <span className="pdfapp-aide-step-args">"{step.args?.query}" in {step.args?.docId?.slice(0,8)}…</span>}
                            {step.tool === 'add_note'    && <span className="pdfapp-aide-step-args">saving note…</span>}
                          </div>
                        </>
                      )}
                      {step.type === 'tool_result' && (
                        <>
                          <span className="pdfapp-aide-step-icon">↩</span>
                          <div className="pdfapp-aide-step-body">
                            {step.tool === 'add_note' && step.result?.ok
                              ? <span className="pdfapp-aide-step-note-saved">Note saved to Notes tab</span>
                              : Array.isArray(step.result)
                                ? <span className="pdfapp-aide-step-result-count">{step.result.length} result{step.result.length !== 1 ? 's' : ''} found</span>
                                : <span className="pdfapp-aide-step-result-count">{step.result?.error || 'done'}</span>
                            }
                          </div>
                        </>
                      )}
                      {step.type === 'error' && (
                        <>
                          <span className="pdfapp-aide-step-icon">✕</span>
                          <div className="pdfapp-aide-step-body pdfapp-aide-step-body--error">{step.content}</div>
                        </>
                      )}
                    </div>
                  ))}
                  {aideResult && (
                    <div className="pdfapp-aide-answer">
                      <div className="pdfapp-aide-answer-header">
                        <span>Aide finding</span>
                        <button className="pdfapp-aide-answer-copy" onClick={() => navigator.clipboard.writeText(aideResult).catch(() => {})}>Copy</button>
                      </div>
                      <div className="pdfapp-aide-answer-body">{aideResult}</div>
                    </div>
                  )}
                  {aideStatus === 'cancelled' && (
                    <div className="pdfapp-aide-step pdfapp-aide-step--cancelled">
                      <span className="pdfapp-aide-step-icon">⏹</span>
                      <div className="pdfapp-aide-step-body">Stopped by user</div>
                    </div>
                  )}
                </div>
              )}
            </>)}

            {/* ── Soul sub-tab ── */}
            {aideSoulTab === 'soul' && (
              <div className="pdfapp-aide-soul-panel">
                <div className="pdfapp-aide-soul-header">
                  <span className="pdfapp-aide-soul-title">Your Aide's Identity</span>
                  <div className="pdfapp-aide-soul-actions">
                    {aideSoulSavedAt && !aideSoulDirty && (
                      <span className="pdfapp-aide-soul-saved">Saved {new Date(aideSoulSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                    <button
                      className={`pdfapp-aide-soul-save-btn${aideSoulDirty ? ' pdfapp-aide-soul-save-btn--dirty' : ''}`}
                      onClick={handleAideSoulSave}
                      disabled={!aideSoulDirty || aideSoulSaving || !caseId}
                    >
                      {aideSoulSaving ? 'Saving…' : 'Save Soul'}
                    </button>
                  </div>
                </div>

                {/* Skill.md upload */}
                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Skill file <span className="pdfapp-aide-soul-hint">(defines who your Aide is)</span></div>
                  {aideSoul.skillMd ? (
                    <div className="pdfapp-aide-skill-loaded">
                      <span className="pdfapp-aide-skill-filename">{aideSkillFileName || 'skill.md'}</span>
                      <span className="pdfapp-aide-skill-preview">{aideSoul.skillMd.slice(0, 120)}{aideSoul.skillMd.length > 120 ? '…' : ''}</span>
                      <button className="pdfapp-aide-skill-remove" onClick={() => { patchSoul('skillMd', ''); setAideSkillFileName('') }}>× Remove</button>
                    </div>
                  ) : (
                    <label className="pdfapp-aide-skill-drop">
                      <input type="file" accept=".md,.txt" style={{ display: 'none' }} onChange={e => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const reader = new FileReader()
                        reader.onload = ev => { patchSoul('skillMd', ev.target.result); setAideSkillFileName(file.name) }
                        reader.readAsText(file)
                        e.target.value = ''
                      }} />
                      <span className="pdfapp-aide-skill-drop-icon">↑</span>
                      <span>Drop a .md file or click to upload</span>
                    </label>
                  )}
                  {!aideSoul.skillMd && (
                    <textarea
                      className="pdfapp-aide-soul-textarea"
                      placeholder="Or paste your skill / persona here…"
                      rows={4}
                      value=""
                      onChange={e => { if (e.target.value) patchSoul('skillMd', e.target.value) }}
                    />
                  )}
                </div>

                {/* Red flags checklist */}
                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Standing checklist <span className="pdfapp-aide-soul-hint">(red flags to always look for)</span></div>
                  <textarea
                    className="pdfapp-aide-soul-textarea"
                    placeholder="e.g. Unlimited liability clauses&#10;Automatic renewal terms&#10;Jurisdiction outside home country"
                    rows={4}
                    value={aideSoul.redFlags || ''}
                    onChange={e => patchSoul('redFlags', e.target.value)}
                  />
                </div>

                {/* Style guide */}
                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Writing style <span className="pdfapp-aide-soul-hint">(how your Aide should sound)</span></div>
                  <textarea
                    className="pdfapp-aide-soul-textarea"
                    placeholder="e.g. Concise bullet points. Plain language. Avoid legal jargon. Always cite page numbers."
                    rows={3}
                    value={aideSoul.styleGuide || ''}
                    onChange={e => patchSoul('styleGuide', e.target.value)}
                  />
                </div>

                {/* Style samples */}
                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label-row">
                    <span className="pdfapp-aide-soul-section-label">Example outputs <span className="pdfapp-aide-soul-hint">(show your Aide what good looks like)</span></span>
                    <button className="pdfapp-aide-soul-add-btn" onClick={addStyleSample}>+ Add</button>
                  </div>
                  {(aideSoul.styleSamples || []).map(s => (
                    <div key={s.id} className="pdfapp-aide-sample-row">
                      <textarea
                        className="pdfapp-aide-soul-textarea pdfapp-aide-sample-textarea"
                        placeholder="Paste an example of ideal output…"
                        rows={3}
                        value={s.text}
                        onChange={e => updateStyleSample(s.id, e.target.value)}
                      />
                      <button className="pdfapp-aide-sample-remove" onClick={() => removeStyleSample(s.id)}>×</button>
                    </div>
                  ))}
                  {(aideSoul.styleSamples || []).length === 0 && (
                    <div className="pdfapp-aide-soul-empty">No examples yet. Add one to show your Aide your preferred output format.</div>
                  )}
                </div>

                {/* Corrections */}
                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Corrections <span className="pdfapp-aide-soul-hint">(things you've told your Aide to stop doing)</span></div>
                  <div className="pdfapp-aide-correction-input-row">
                    <input
                      className="pdfapp-aide-correction-input"
                      placeholder="e.g. Stop summarising — give me findings only"
                      value={aideNewCorrection}
                      onChange={e => setAideNewCorrection(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCorrection() } }}
                    />
                    <button className="pdfapp-aide-soul-add-btn" onClick={addCorrection}>Add</button>
                  </div>
                  {(aideSoul.corrections || []).map(c => (
                    <div key={c.id} className="pdfapp-aide-correction-row">
                      <span className="pdfapp-aide-correction-text">{c.text}</span>
                      <button className="pdfapp-aide-sample-remove" onClick={() => removeCorrection(c.id)}>×</button>
                    </div>
                  ))}
                  {(aideSoul.corrections || []).length === 0 && (
                    <div className="pdfapp-aide-soul-empty">No corrections yet. These are added automatically when you correct your Aide mid-run.</div>
                  )}
                </div>
              </div>
            )}

            {/* ── Memory sub-tab ── */}
            {aideSoulTab === 'memory' && (
              <div className="pdfapp-aide-memory-panel">
                {/* Token audit */}
                <div className="pdfapp-aide-audit">
                  <span className="pdfapp-aide-audit-label">Soul context</span>
                  <span className={`pdfapp-aide-audit-tokens${aideSoulTokenEstimate > 2000 ? ' pdfapp-aide-audit-tokens--warn' : ''}`}>
                    ~{aideSoulTokenEstimate.toLocaleString()} tokens
                  </span>
                  {aideSoulTokenEstimate > 2000 && <span className="pdfapp-aide-audit-warn">⚠ Over budget — trim Soul content</span>}
                </div>

                {/* Session diary */}
                <div className="pdfapp-aide-memory-header">Session Diary</div>
                {aideDiary.length === 0 && (
                  <div className="pdfapp-aide-soul-empty" style={{ margin: '8px 12px' }}>
                    No sessions yet. Run your Aide and it will write a diary entry summarising what it learned.
                  </div>
                )}
                {aideDiary.map((entry, i) => {
                  const key = entry.id || i
                  const open = aideDiaryOpen.has(key)
                  return (
                    <div key={key} className="pdfapp-aide-diary-entry">
                      <button
                        className="pdfapp-aide-diary-row"
                        onClick={() => setAideDiaryOpen(prev => {
                          const next = new Set(prev)
                          open ? next.delete(key) : next.add(key)
                          return next
                        })}
                      >
                        <span className={`pdfapp-aide-diary-chevron${open ? ' open' : ''}`}>›</span>
                        <span className="pdfapp-aide-diary-task">{entry.task || 'Session'}</span>
                        <span className="pdfapp-aide-diary-date">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</span>
                      </button>
                      {open && (
                        <div className="pdfapp-aide-diary-body">
                          {entry.reflection && <div className="pdfapp-aide-diary-reflection">{entry.reflection}</div>}
                          {entry.findings && <div className="pdfapp-aide-diary-section"><span className="pdfapp-aide-diary-section-label">Findings</span><div>{entry.findings}</div></div>}
                          {entry.gaps && <div className="pdfapp-aide-diary-section"><span className="pdfapp-aide-diary-section-label">Gaps</span><div>{entry.gaps}</div></div>}
                          {entry.suggestions && <div className="pdfapp-aide-diary-section"><span className="pdfapp-aide-diary-section-label">For next time</span><div>{entry.suggestions}</div></div>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

          </div>
        )}

        {/* ── Law tab ── */}
        {rightTab === 'law' && (
          <div className="pdfapp-law-panel">

            {/* Sub-tab bar */}
            <div className="pdfapp-law-subtabs">
              <button className={`pdfapp-law-subtab${lawSubTab === 'search' ? ' pdfapp-law-subtab--active' : ''}`} onClick={() => setLawSubTab('search')}>Search</button>
              <button className={`pdfapp-law-subtab${lawSubTab === 'import' ? ' pdfapp-law-subtab--active' : ''}`} onClick={() => setLawSubTab('import')}>Import</button>
            </div>

            {/* ── Search sub-tab ── */}
            {lawSubTab === 'search' && (
              <div className="pdfapp-law-search-panel">

                {/* Status banner when no corpus */}
                {lawStatus && !lawStatus.available && (
                  <div className="pdfapp-law-no-corpus">
                    <span className="pdfapp-law-no-corpus-icon">⚖</span>
                    <span>No caselaw corpus loaded. Go to <button className="pdfapp-law-link-btn" onClick={() => setLawSubTab('import')}>Import</button> to add one.</span>
                  </div>
                )}

                {/* Search bar */}
                <div className="pdfapp-law-search-bar">
                  <input
                    className="pdfapp-law-search-input"
                    placeholder="Search caselaw… e.g. 'duty of care in negligence'"
                    value={lawQuery}
                    onChange={e => setLawQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleLawSearch() }}
                    disabled={!lawStatus?.available || lawSearching}
                  />
                  <button
                    className="pdfapp-law-search-btn"
                    onClick={handleLawSearch}
                    disabled={!lawStatus?.available || !lawQuery.trim() || lawSearching}
                  >
                    {lawSearching ? '…' : 'Search'}
                  </button>
                </div>

                {/* Filters */}
                <div className="pdfapp-law-filters">
                  <input
                    className="pdfapp-law-filter-input"
                    placeholder="Court (e.g. UKSC)"
                    value={lawFilters.court}
                    onChange={e => setLawFilters(f => ({ ...f, court: e.target.value }))}
                  />
                  <input
                    className="pdfapp-law-filter-input"
                    placeholder="Jurisdiction"
                    value={lawFilters.jurisdiction}
                    onChange={e => setLawFilters(f => ({ ...f, jurisdiction: e.target.value }))}
                  />
                  <input
                    className="pdfapp-law-filter-input pdfapp-law-filter-year"
                    placeholder="From year"
                    type="number"
                    min="1800" max="2099"
                    value={lawFilters.yearFrom}
                    onChange={e => setLawFilters(f => ({ ...f, yearFrom: e.target.value }))}
                  />
                  <input
                    className="pdfapp-law-filter-input pdfapp-law-filter-year"
                    placeholder="To year"
                    type="number"
                    min="1800" max="2099"
                    value={lawFilters.yearTo}
                    onChange={e => setLawFilters(f => ({ ...f, yearTo: e.target.value }))}
                  />
                </div>

                {/* Results */}
                <div className="pdfapp-law-results">
                  {lawSearching && (
                    <div className="pdfapp-law-searching">Searching corpus…</div>
                  )}
                  {!lawSearching && lawResults.length === 0 && lawQuery && !lawImportMsg && (
                    <div className="pdfapp-law-no-results">No results. Try different keywords or broaden filters.</div>
                  )}
                  {lawResults.map((r, i) => (
                    <div key={r.id || i} className="pdfapp-law-result">
                      <div className="pdfapp-law-result-header">
                        <span className="pdfapp-law-citation">{r.citation}</span>
                        <div className="pdfapp-law-result-meta">
                          {r.court && <span className="pdfapp-law-badge">{r.court}</span>}
                          {r.year  && <span className="pdfapp-law-year">{r.year}</span>}
                          <span className="pdfapp-law-score">{(r.score * 100).toFixed(0)}%</span>
                        </div>
                      </div>
                      {r.jurisdiction && <div className="pdfapp-law-jurisdiction">{r.jurisdiction}</div>}
                      <div className="pdfapp-law-snippet">{r.text}</div>
                    </div>
                  ))}
                </div>

              </div>
            )}

            {/* ── Import sub-tab ── */}
            {lawSubTab === 'import' && (
              <div className="pdfapp-law-import-panel">

                {/* Corpus status */}
                <div className="pdfapp-law-corpus-status">
                  <div className="pdfapp-law-corpus-header">
                    <span className="pdfapp-law-corpus-title">Corpus Status</span>
                    {lawStatus?.available
                      ? <span className="pdfapp-law-corpus-badge pdfapp-law-corpus-badge--ok">Active</span>
                      : <span className="pdfapp-law-corpus-badge pdfapp-law-corpus-badge--none">No corpus</span>
                    }
                  </div>
                  {lawStatus?.available ? (
                    <div className="pdfapp-law-corpus-meta">
                      <span>{lawStatus.rows?.toLocaleString()} entries</span>
                      <span className="pdfapp-law-corpus-dot">·</span>
                      <span>{lawStatus.model}</span>
                      <span className="pdfapp-law-corpus-dot">·</span>
                      <span>dim {lawStatus.embeddingDim}</span>
                      {lawStatus.lastSwapped && <>
                        <span className="pdfapp-law-corpus-dot">·</span>
                        <span>Updated {new Date(lawStatus.lastSwapped).toLocaleDateString()}</span>
                      </>}
                    </div>
                  ) : (
                    <div className="pdfapp-law-corpus-empty">{lawStatus?.message || 'No database loaded.'}</div>
                  )}
                </div>

                {/* Drop zone */}
                <div
                  className={`pdfapp-law-drop-zone${lawDragOver ? ' pdfapp-law-drop-zone--over' : ''}${lawUploadFile ? ' pdfapp-law-drop-zone--staged' : ''}`}
                  onDragOver={e => { e.preventDefault(); setLawDragOver(true) }}
                  onDragLeave={() => setLawDragOver(false)}
                  onDrop={handleLawDbDrop}
                  onClick={() => !lawUploadFile && lawFileInputRef.current?.click()}
                >
                  <input
                    ref={lawFileInputRef}
                    type="file"
                    accept=".db"
                    style={{ display: 'none' }}
                    onChange={e => handleLawDbDrop({ target: e.target, preventDefault: () => {}, dataTransfer: null })}
                  />
                  {lawUploadFile ? (
                    <>
                      <span className="pdfapp-law-drop-icon">📦</span>
                      <span className="pdfapp-law-drop-file">{lawUploadFile.name}</span>
                      <span className="pdfapp-law-drop-size">({(lawUploadFile.size / 1024 / 1024).toFixed(1)} MB)</span>
                      <button className="pdfapp-law-drop-clear" onClick={e => { e.stopPropagation(); setLawUploadFile(null); setLawImportMsg(null) }}>× Clear</button>
                    </>
                  ) : (
                    <>
                      <span className="pdfapp-law-drop-icon">⚖</span>
                      <span>Drop a caselaw <strong>.db</strong> file here or click to browse</span>
                      <span className="pdfapp-law-drop-hint">Generated by import-caselaw.mjs or a 3rd party provider</span>
                    </>
                  )}
                </div>

                {/* Import message */}
                {lawImportMsg && (
                  <div className={`pdfapp-law-import-msg pdfapp-law-import-msg--${lawImportMsg.type}`}>
                    {lawImportMsg.type === 'ok' ? '✓ ' : '✗ '}{lawImportMsg.text}
                  </div>
                )}

                {/* Activate button */}
                {lawUploadFile && (
                  <button
                    className="pdfapp-law-swap-btn"
                    onClick={handleLawSwap}
                    disabled={lawUploading}
                  >
                    {lawUploading ? 'Uploading & validating…' : 'Validate & activate corpus'}
                  </button>
                )}

                {/* Version history */}
                {lawVersions.length > 0 && (
                  <div className="pdfapp-law-versions">
                    <div className="pdfapp-law-versions-title">Backup versions</div>
                    {lawVersions.map((v, i) => (
                      <div key={v} className={`pdfapp-law-version-row${i === 0 ? ' pdfapp-law-version-row--active' : ''}`}>
                        <span className="pdfapp-law-version-name">{v}</span>
                        {i === 0 && <span className="pdfapp-law-version-active-badge">active</span>}
                      </div>
                    ))}
                  </div>
                )}

              </div>
            )}

          </div>
        )}

      </div>

      {/* ── Text Processing Guide Modal ── */}
      {chunkGuideOpen && createPortal(
        <div className="pdfapp-guide-overlay" onClick={() => setChunkGuideOpen(false)}>
          <div className="pdfapp-guide-modal" onClick={e => e.stopPropagation()}>
            <div className="pdfapp-guide-header">
              <span className="pdfapp-guide-title">Search Strategy</span>
              <button className="pdfapp-guide-close" onClick={() => setChunkGuideOpen(false)}>✕</button>
            </div>

            <div className="pdfapp-guide-body">

              <div className="pdfapp-guide-section pdfapp-guide-section--settings">
                <p className="pdfapp-guide-text">
                  Controls how the document is split into searchable passages. Change strategy then click <strong>Chunk Text</strong> — no re-upload needed.
                </p>
                <div className="pdfapp-strategy-btns" style={{ margin: '8px 0 6px' }}>
                  {Object.entries(CHUNKING_STRATEGIES).map(([key, { label }]) => (
                    <button
                      key={key}
                      className={`pdfapp-strategy-btn${chunkingStrategy === key ? ' pdfapp-strategy-btn--active' : ''}`}
                      onClick={() => setChunkingStrategy(key)}
                    >{label}</button>
                  ))}
                </div>
                <div className="pdfapp-strategy-desc">
                  {chunkingStrategy === 'clause'    && 'Clause — splits at sentences, semicolons, and legal markers (ARTICLE, Section, (a)). Best for precise clause citation and quote lookup.'}
                  {chunkingStrategy === 'sentence'  && 'Sentence — each sentence is one chunk; the AI receives ±2 surrounding sentences for context. Best for precise search with full-context answers.'}
                  {chunkingStrategy === 'recursive' && 'Recursive — fills ~300 words by merging paragraphs, splitting oversized ones into sentences. Best for general Q&A and balanced retrieval.'}
                </div>
              </div>

              {activeDoc?.file && (
                <div className="pdfapp-guide-actions">
                  <button
                    className="pdfapp-guide-action-btn pdfapp-guide-action-btn--index"
                    disabled={ragStatus === 'indexing'}
                    onClick={() => { setChunkGuideOpen(false); handleIndexDocument({ forceClear: true }) }}
                    title="Re-chunk and re-embed using the current strategy"
                  >Chunk Text</button>
                </div>
              )}

            </div>
          </div>
        </div>
      , document.body)}


      {/* ── Delete Document Confirmation Modal ── */}
      {deleteDocConfirm && createPortal(
        <div className="pdfapp-guide-overlay" onClick={() => setDeleteDocConfirm(null)}>
          <div className="pdfapp-guide-modal pdfapp-guide-modal--sm" onClick={e => e.stopPropagation()}>
            <div className="pdfapp-guide-header">
              <span className="pdfapp-guide-title">Delete Document</span>
              <button className="pdfapp-guide-close" onClick={() => setDeleteDocConfirm(null)}>✕</button>
            </div>
            <div className="pdfapp-guide-body">
              <p className="pdfapp-guide-text">
                Permanently delete <strong>{deleteDocConfirm.docName}</strong>?
              </p>
              <ul className="pdfapp-delete-list">
                <li>PDF file</li>
                {deleteDocConfirm.noteCount > 0 && <li>{deleteDocConfirm.noteCount} note{deleteDocConfirm.noteCount !== 1 ? 's' : ''}</li>}
                {deleteDocConfirm.isIndexed && <li>Search index &amp; embeddings</li>}
                <li>Chat history, highlights, analysis</li>
              </ul>
            </div>
            <div className="pdfapp-guide-actions pdfapp-guide-actions--footer">
              <button className="pdfapp-guide-action-btn" onClick={() => setDeleteDocConfirm(null)}>Cancel</button>
              <button className="pdfapp-guide-action-btn pdfapp-guide-action-btn--danger" onClick={confirmRemoveDocument}>Delete</button>
            </div>
          </div>
        </div>
      , document.body)}

    </div>
  )
}

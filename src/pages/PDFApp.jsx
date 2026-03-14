import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { useTheme } from '../useTheme.js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { uploadCaseBlob, loadCaseBlob, deleteCaseBlob, loadChatHistory, saveChatHistory, loadNotes, saveNotes, loadAllNotes, deleteNotes, deleteSummary } from '../db.js'
import { FORMAT_CATEGORIES } from '../skills/formatsIndex.js'
import { getDocRagStatus, indexDocPages, pruneDocChunks, clearDocChunks, searchDocChunks, searchCaseChunks, initFormatCategories } from '../rag.js'
import { extractAndSaveText, loadExtraction, extractPageChunksFromPDF, groupIntoParagraphs } from '../utils/pdfExtract.js'
import { getCachedThumb, setCachedThumb } from '../utils/thumbnailCache.js'
import { buildEvidenceBlock, parseCitations, tokeniseMessage, narrowCitations, distanceToScore } from '../utils/parseCitations.js'
import { streamOllamaChat, callOllama } from '../utils/ollamaStream.js'
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

function mergeChunksByTokens(pages, targetTokens) {
  const merged = []
  for (const page of pages) {
    let buf = []
    let bufTokens = 0
    const flush = () => {
      if (!buf.length) return
      const text = buf.map(c => c.text).join(' ')
      const hasBbox = buf.every(c => c.bbox)
      const bbox = hasBbox ? [
        Math.min(...buf.map(c => c.bbox[0])),
        Math.min(...buf.map(c => c.bbox[1])),
        Math.max(...buf.map(c => c.bbox[2])),
        Math.max(...buf.map(c => c.bbox[3])),
      ] : null
      merged.push({ pageNum: page.pageNum, text, bbox })
      buf = []
      bufTokens = 0
    }
    for (const chunk of page.chunks) {
      if (!chunk.text?.trim() || chunk.text.length < 15) continue
      const t = estimateTokens(chunk.text)
      if (buf.length > 0 && bufTokens + t > targetTokens) flush()
      buf.push(chunk)
      bufTokens += t
    }
    flush()
  }
  return merged
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
    return [{ id: crypto.randomUUID(), name: 'Party 1', documents: initialDocs }]
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
  const pendingNavRef = useRef(null) // { pageNum, chunkText, bbox, narrowBbox }
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
        id: String(Date.now() + Math.random()),
        name: f.name,
        file: f,
      }))
      const targetId = pendingAddPartyRef.current
      pendingAddPartyRef.current = null
      setParties(prev => {
        if (!targetId || !prev.some(p => p.id === targetId)) {
          if (prev.length === 0) return [{ id: crypto.randomUUID(), name: 'Party 1', documents: newDocs }]
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
    if (!window.confirm(`Delete "${docName}"?\n\nThis will permanently remove the PDF, all notes, and all indexed embeddings for this document.`)) return

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
      deleteCaseBlob(caseId, docId).catch(() => {})
      deleteNotes(docId, { caseId }).catch(() => {})
      deleteSummary(docId, { caseId }).catch(() => {})
      fetch(`/api/cases/${encodeURIComponent(caseId)}/extractions/${docId}`, { method: 'DELETE' }).catch(() => {})
      fetch(`/api/cases/${encodeURIComponent(caseId)}/chat/${docId}`, { method: 'DELETE' }).catch(() => {})
      clearDocChunks(docId, { caseId }).catch(() => {})
    }
  }

  const handleAddParty = () => {
    const newId = crypto.randomUUID()
    setParties(prev => [...prev, { id: newId, name: `Party ${prev.length + 1}`, documents: [] }])
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
        if (prev.length === 0) return [{ id: crypto.randomUUID(), name: 'Party 1', documents: newDocs }]
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
      setExtractedPages(null)
      setExtractionSource(null)
      setExtractionError(null)
      setExtractionStatus('')
      setExtractingText(false)
      if (extractionAbortRef.current) { extractionAbortRef.current.abort(); extractionAbortRef.current = null }
      if (pdfDocRef.current) { pdfDocRef.current.destroy(); pdfDocRef.current = null }
      pdfBufferRef.current = null
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
          if (isDocChange) {
            setPageCount(numPages)
            setPageCountsById(prev => ({ ...prev, [activeDocumentId]: numPages }))
            setPdfLoading(false)
          }
        })
        // DOM is already updated — single rAF to let the browser paint before observing
        requestAnimationFrame(() => {
          setupObserver()
          // Consume any pending cross-doc navigation (set before switching activeDocumentId)
          if (pendingNavRef.current) {
            const { pageNum, chunkText, bbox, narrowBbox } = pendingNavRef.current
            pendingNavRef.current = null
            scrollPageIntoView(pageNum, 'center')
            setActiveCitations(new Map([[1, { text: chunkText, page_num: pageNum, bbox, narrowBbox }]]))
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

        // Build text layer after the page is drawn
        if (!pdfDocRef.current) return
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
      } else if (msg.type === 'error') {
        if (!cancelled) { setPdfError(msg.error || 'PDF render error'); if (isDocChange) setPdfLoading(false) }
      }
    }

    // Init worker — reuse cached buffer on zoom, fetch fresh on doc change
    if (!isDocChange && pdfBufferRef.current) {
      // Zoom: re-init with cached buffer (zero new network requests)
      const renderBuffer = pdfBufferRef.current.slice(0)
      worker.postMessage({ type: 'init', pdfData: renderBuffer, scale: renderScale }, [renderBuffer])
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

      // Worker sends back a JPEG buffer for thumbnails — persist to IDB for next session.
      if (msg.type === 'rendered' && msg.thumbBuffer && activeDocumentId) {
        const blob = new Blob([msg.thumbBuffer], { type: 'image/jpeg' })
        setCachedThumb(activeDocumentId, msg.pageNum, blob)
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

            // Not cached — transfer canvas to worker for rendering
            if (!canvas.isConnected) return
            try {
              const offscreen = canvas.transferControlToOffscreen()
              thumbWorkerRef.current?.postMessage(
                { type: 'render', pageNum, canvas: offscreen, dpr: 1 },
                [offscreen]
              )
            } catch { /* OffscreenCanvas not supported */ }
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
    fine:     { label: 'Fine',     words: 50 },
    balanced: { label: 'Balanced', words: 100 },
    broad:    { label: 'Broad',    words: 200 },
  }
  const [chunkingStrategy, setChunkingStrategy] = useState(() =>
    (caseId && localStorage.getItem(`chunking-${caseId}`)) || 'balanced'
  )
  const [caseSettingsOpen, setCaseSettingsOpen] = useState(false)
  const [reprocessMenuOpen, setReprocessMenuOpen] = useState(false)
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
  const [rightTab, setRightTab] = useState('chat') // 'chat' | 'notes' | 'report'
  const [reportFormat, setReportFormat] = useState('')
  const [reportContent, setReportContent] = useState('')
  const [reportLoading, setReportLoading] = useState(false)
  const reportAbortRef = useRef(null)
  const isIndexingRef = useRef(false)   // ref guard — prevents concurrent / loop-triggered indexing

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

  // Scroll to the first cited page whenever activeCitations changes
  useEffect(() => {
    if (!activeCitations.size) return
    const firstChunk = activeCitations.values().next().value
    const bbox = firstChunk.bbox
    const narrowBbox = firstChunk.narrowBbox
    const bboxStr = bbox ? `[${bbox.map(v => v.toFixed(3)).join(', ')}]` : 'none'
    const bboxArea = bbox ? ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])).toFixed(3) : 'n/a'
    const isLarge = bbox && (bbox[2] - bbox[0]) > 0.8 && (bbox[3] - bbox[1]) > 0.5
    addLog(
      `[CITATION] page=${firstChunk.page_num} bbox=${bboxStr} area=${bboxArea}${isLarge ? ' ⚠ LARGE BBOX (covers most of page)' : ''} narrowBbox=${narrowBbox ? `[${narrowBbox.map(v => v.toFixed(3)).join(', ')}]` : 'none'}`,
      isLarge ? 'error' : 'ok'
    )
    scrollPageIntoView(firstChunk.page_num, 'center')
  }, [activeCitations])
  const chatAbortRef = useRef(null)
  const chatMessagesRef = useRef(null)

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight
    }
  }, [chatMessages])

  // Reset chat + RAG state when document changes; load persisted chat history
  useEffect(() => {
    setChatMessages([])
    setChatInput('')
    setRagStatus(null)
    setRagProgress('')
    setActiveCitations(new Map())
    ragQueryCacheRef.current.clear() // invalidate cached search results for previous doc

    if (!activeDocumentId) return

    // Load saved chat history (case mode only)
    if (caseId) {
      loadChatHistory(activeDocumentId, { caseId }).then(msgs => {
        if (msgs.length) setChatMessages(msgs)
      }).catch(() => {})
    }

    getDocRagStatus(activeDocumentId, { caseId }).then(({ indexed, chunks }) => {
      if (indexed) {
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

  // Load all notes for the whole case whenever the case changes
  useEffect(() => {
    if (!caseId) return
    loadAllNotes(caseId).then(setAllCaseNotes).catch(() => {})
  }, [caseId])

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

  const handleGenerateReport = useCallback(async () => {
    if (reportLoading) { reportAbortRef.current?.abort(); return }
    const allNotesList = Object.entries(allCaseNotes).flatMap(([docId, noteArr]) => {
      const p = parties.find(pt => (pt.documents || []).some(d => d.id === docId))
      const d = p?.documents?.find(doc => doc.id === docId)
      return noteArr.filter(n => n.text?.trim()).map(n => ({ ...n, docId, docName: d?.name || docId, partyName: p?.name || null }))
    })
    if (!starredSources.length && !allNotesList.length) return
    setReportContent('')
    setReportLoading(true)
    const controller = new AbortController()
    reportAbortRef.current = controller
    const caseLabel = caseName ? `Case: ${caseName}\n\n` : ''
    const evidenceBlock = [
      starredSources.length > 0
        ? '## Starred Sources\n' + starredSources.map((s, i) => {
            const provenance = [s.partyName, s.docName].filter(Boolean).join(' / ')
            return `[${i + 1}]${provenance ? ` [${provenance}]` : ''} p.${s.pageNum}${s.question ? ` (context: "${s.question}")` : ''}:\n"${s.chunkText.slice(0, 400)}"`
          }).join('\n\n')
        : '',
      allNotesList.length > 0
        ? '## User Notes\n' + allNotesList.map(n => {
            const provenance = [n.partyName, n.docName].filter(Boolean).join(' / ')
            return `${provenance ? `[${provenance}] ` : ''}p.${n.pageNum}: ${n.text}`
          }).join('\n')
        : '',
    ].filter(Boolean).join('\n\n')
    try {
      await streamOllamaChat({
        messages: [
          { role: 'system', content: 'You are a professional legal analyst. Generate a well-structured report from the provided evidence across all case documents. Use headings, bullet points, and always cite the source party, document name and page number.' },
          { role: 'user', content: `${caseLabel}${reportFormat.trim() ? `Format instructions: ${reportFormat}\n\n` : ''}Evidence:\n\n${evidenceBlock}\n\nGenerate the report.` },
        ],
        signal: controller.signal,
        onChunk: text => setReportContent(text),
      })
    } catch (err) {
      if (err.name !== 'AbortError') setReportContent(prev => prev + `\n\n[Error: ${err.message}]`)
    } finally {
      setReportLoading(false)
    }
  }, [starredSources, allCaseNotes, parties, caseName, reportFormat, reportLoading])

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
          : await searchDocChunks(activeDocumentId, text, 3, { caseId })
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
        setRagProgress('Clearing previous index…')
        await clearDocChunks(activeDocumentId, { caseId })
      }

      // Step 2 — index format categories (skips already-done ones)
      setRagProgress('Setting up categories (first time only)…')
      await initFormatCategories(FORMAT_CATEGORIES)

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

      // Step 4 — re-chunk from raw words if available (free re-grouping — no re-OCR needed),
      //           otherwise fall back to the pre-grouped paragraph chunks.
      const paragraphPages = pages.map(p =>
        p.rawWords?.length
          ? { pageNum: p.pageNum, chunks: groupIntoParagraphs(p.rawWords) }
          : p
      )
      const mergedChunks = mergeChunksByTokens(paragraphPages, CHUNKING_STRATEGIES[chunkingStrategy].words)
      const allChunks = mergedChunks.map((c, idx) => ({
        pageNum: c.pageNum,
        chunkIdx: idx,
        text: c.text,
        bbox: c.bbox,
      }))

      // Step 5 — embed + store in batches (server skips unchanged hashes)
      const BATCH = 10
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH)
        setRagProgress(`Indexing chunks ${i + 1}–${Math.min(i + BATCH, allChunks.length)} / ${allChunks.length}…`)
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

    } catch (err) {
      console.error('[RAG] indexing failed:', err)
      addLog(`Indexing failed: ${err.message}`, 'error')
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

  // Watch key status strings and mirror them into the log automatically
  useEffect(() => { if (extractionStatus) addLog(extractionStatus) }, [extractionStatus, addLog])
  useEffect(() => { if (ragProgress)      addLog(ragProgress)      }, [ragProgress, addLog])
  useEffect(() => {
    if (ragStatus === 'indexed')  addLog('RAG index complete — semantic search active', 'ok')
    if (ragStatus === 'indexing') addLog('Starting RAG indexing…', 'info')
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
          setExtractedPages(saved.pages)
          lastExtractionPagesRef.current = { docId: activeDocumentId, pages: saved.pages }
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
  // Also re-indexes when full extraction arrives after a partial index (ragStatus resets to null via
  // the doc-change effect, so the check here naturally catches both first and full runs).
  useEffect(() => {
    const cached = lastExtractionPagesRef.current
    const hasCachedPages = cached?.docId === activeDocumentId && cached?.pages
    if (extractedPages && (ragStatus === null) && activeDocumentId && (hasCachedPages || pdfDocRef.current)) {
      handleIndexDocument()
    }
  }, [extractedPages, ragStatus, activeDocumentId]) // eslint-disable-line react-hooks/exhaustive-deps

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
                className={`pdfapp-citation-chip${activeCitations.has(token) ? ' pdfapp-citation-chip--active' : ''}`}
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
                  + Litigants
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
                  <p>No parties yet.</p>
                  <button type="button" className="pdfapp-sb-litigants-btn" onClick={handleAddParty}>
                    + Add Litigant
                  </button>
                </div>
              ) : (
                parties.map(party => {
                  const isCollapsed = !!collapsedParties[party.id]
                  const isRenaming = renamingPartyId === party.id
                  return (
                    <div key={party.id} className="pdfapp-party-group">
                      {/* Party header card */}
                      <div
                        className={`pdfapp-party-header${activePartyId === party.id ? ' pdfapp-party-header--active' : ''}`}
                        onClick={() => setActivePartyId(party.id)}
                      >
                        <button
                          type="button"
                          className="pdfapp-party-chevron"
                          onClick={e => { e.stopPropagation(); setCollapsedParties(prev => ({ ...prev, [party.id]: !isCollapsed })) }}
                          aria-label={isCollapsed ? 'Expand party' : 'Collapse party'}
                        >
                          <svg
                            viewBox="0 0 24 24" width="11" height="11"
                            fill="none" stroke="currentColor" strokeWidth="2.5"
                            style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

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
                          <span
                            className="pdfapp-party-name"
                            title={party.name}
                            onDoubleClick={e => { e.stopPropagation(); setRenamingPartyId(party.id) }}
                          >
                            {party.name}
                          </span>
                        )}

                        <div className="pdfapp-party-actions">
                          <button
                            type="button"
                            className="pdfapp-party-action-btn"
                            title="Add document to this party"
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
                            title="Remove party"
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
                                      {pageCountsById[doc.id] != null && (
                                        <span className="pdfapp-doc-card-pages">{pageCountsById[doc.id]} pages</span>
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
                                            <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--loading" title={st === 'extracting' ? 'Reading…' : 'Indexing…'}>
                                              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                                                <circle cx="8" cy="8" r="6" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round"/>
                                              </svg>
                                            </span>
                                          )
                                        }
                                        if (st === 'indexed') {
                                          return (
                                            <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--indexed" title={cc ? `Indexed — ${cc} chunks` : 'Indexed'}>
                                              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                                                <circle cx="8" cy="8" r="6"/>
                                                <path d="M5 8 L7 10.5 L11 6" strokeLinecap="round" strokeLinejoin="round"/>
                                              </svg>
                                            </span>
                                          )
                                        }
                                        if (st === 'error') {
                                          return (
                                            <span className="pdfapp-doc-status-icon pdfapp-doc-status-icon--error" title="Indexing error">
                                              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                                                <circle cx="8" cy="8" r="6"/>
                                                <path d="M8 5 L8 9" strokeLinecap="round"/>
                                                <circle cx="8" cy="11.5" r="0.8" fill="currentColor"/>
                                              </svg>
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

            {/* ── Case Settings (Option D — chunking strategy) ── */}
            {caseId && (
              <div className="pdfapp-case-settings">
                <button
                  type="button"
                  className="pdfapp-case-settings-header"
                  onClick={() => setCaseSettingsOpen(o => !o)}
                >
                  <span>⚙ Search Precision</span>
                  <span className="pdfapp-log-chevron">{caseSettingsOpen ? '▾' : '▸'}</span>
                </button>
                {caseSettingsOpen && (
                  <div className="pdfapp-case-settings-body">
                    <div className="pdfapp-strategy-hint">Chunk size — affects all future indexing</div>
                    <div className="pdfapp-strategy-btns">
                      {Object.entries(CHUNKING_STRATEGIES).map(([key, { label }]) => (
                        <button
                          key={key}
                          className={`pdfapp-strategy-btn${chunkingStrategy === key ? ' pdfapp-strategy-btn--active' : ''}`}
                          onClick={() => setChunkingStrategy(key)}
                        >{label}</button>
                      ))}
                    </div>
                    <div className="pdfapp-strategy-desc">
                      {chunkingStrategy === 'fine'     && 'Fine (~50 words) — best for precise quotes'}
                      {chunkingStrategy === 'balanced' && 'Balanced (~100 words) — best for Q&A'}
                      {chunkingStrategy === 'broad'    && 'Broad (~200 words) — best for summaries'}
                    </div>
                  </div>
                )}
              </div>
            )}

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
                  {/* Note tool */}
                  <button
                    className={`pdfapp-toolbar-btn pdfapp-toolbar-btn--annot${noteMode ? ' pdfapp-toolbar-btn--active' : ''}`}
                    title={noteMode ? 'Note mode on — click anywhere on the PDF to place a note' : 'Add note'}
                    disabled={!pageCount}
                    onClick={() => { setNoteMode(m => !m); setOpenNoteId(null) }}
                  >
                    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3 1 h8 l4 4 v11 a1.5 1.5 0 0 1-1.5 1.5 H4.5 A1.5 1.5 0 0 1 3 16.5 Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                      <path d="M11 1 v3.5 a.5.5 0 0 0 .5.5 H15" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
                      <line x1="6" y1="8"  x2="13" y2="8"  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                      <line x1="6" y1="11" x2="13" y2="11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                      <line x1="6" y1="14" x2="10" y2="14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  </button>
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
                      const pageHighlights = [...activeCitations.values()].filter(c => c.page_num === pageNum && c.bbox)
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
                                const b = chunk.narrowBbox || chunk.bbox
                                return (
                                <div
                                  key={i}
                                  className={`pdfapp-highlight-rect${chunk.narrowBbox ? ' pdfapp-highlight-rect--narrow' : ''}`}
                                  style={{
                                    left:   `${b[0] * 100}%`,
                                    top:    `${b[1] * 100}%`,
                                    width:  `${(b[2] - b[0]) * 100}%`,
                                    height: `${(b[3] - b[1]) * 100}%`,
                                  }}
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

                  {/* ── Contextual single action (Option C) ── */}
                  <div className="pdfapp-extract-controls" onClick={e => e.stopPropagation()}>
                    {extractingText ? (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--stop"
                        onClick={() => { extractionAbortRef.current?.abort(); setExtractingText(false); setExtractionStatus('') }}
                      >■ Cancel</button>
                    ) : ragStatus === 'indexing' ? (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--stop"
                        onClick={() => { setRagStatus('failed'); setRagProgress('') }}
                      >■ Cancel</button>
                    ) : ragStatus === 'indexed' ? (
                      <div className="pdfapp-reprocess-wrap" style={{ position: 'relative' }}>
                        <button
                          className="pdfapp-action-btn pdfapp-action-btn--menu"
                          title="Re-process options"
                          onClick={() => setReprocessMenuOpen(v => !v)}
                        >···</button>
                        {reprocessMenuOpen && (
                          <div className="pdfapp-reprocess-dropdown" onMouseLeave={() => setReprocessMenuOpen(false)}>
                            <button onClick={() => { setReprocessMenuOpen(false); activeDoc?.file && runExtraction(activeDocumentId, activeDoc.file) }}>
                              Re-extract text
                            </button>
                            <button onClick={() => { setReprocessMenuOpen(false); handleIndexDocument({ forceClear: true }) }}>
                              Re-index
                            </button>
                          </div>
                        )}
                      </div>
                    ) : extractedPages ? (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--index"
                        onClick={handleIndexDocument}
                      >Index for search →</button>
                    ) : (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--extract"
                        disabled={!activeDoc?.file || pdfLoading}
                        onClick={() => activeDoc?.file && runExtraction(activeDocumentId, activeDoc.file)}
                      >{extractionSource === 'ocr' ? 'Re-scan pages' : activeDoc?.file ? 'Prepare for search' : 'No file loaded'}</button>
                    )}
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
                    <div className="pdfapp-chunks-body">
                      {extractedPages.map(page =>
                        page.chunks.map((chunk, idx) => (
                          <div key={`${page.pageNum}-${idx}`} className="pdfapp-chunk-card">
                            <div className="pdfapp-chunk-meta">
                              <span className="pdfapp-chunk-tag pdfapp-chunk-tag--page">P{page.pageNum}</span>
                              <span className="pdfapp-chunk-tag pdfapp-chunk-tag--idx">#{idx}</span>
                              {chunk.bbox && (
                                <span className="pdfapp-chunk-bbox">
                                  [{chunk.bbox.map(v => (v * 100).toFixed(1) + '%').join(', ')}]
                                </span>
                              )}
                            </div>
                            <p className="pdfapp-chunk-text">{chunk.text}</p>
                          </div>
                        ))
                      )}
                      {extractingText && (
                        <div className="pdfapp-extracted-prompt" style={{ paddingTop: 8 }}>
                          <div className="pdfapp-spinner pdfapp-spinner--small" />
                          <span className="pdfapp-extracted-status">{extractionStatus}</span>
                        </div>
                      )}
                    </div>
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
                          ? <>Press <strong>Prepare for search</strong> above to start extraction.</>
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
            ragStatus === 'indexing' ? (ragProgress || 'Indexing document…') :
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
          <button className={`pdfapp-right-tab${rightTab === 'report' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('report')}>Report</button>
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
                                className={`pdfapp-source-item${activeCitations.has(n) ? ' pdfapp-source-item--active' : ''}`}
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
          // Resolve docName/partyName for starred items that predate the enrichment
          const resolveDoc = (docId) => {
            const p = parties.find(pt => (pt.documents || []).some(d => d.id === docId))
            const d = p?.documents?.find(d => d.id === docId)
            return { partyName: p?.name || null, docName: d?.name || null }
          }

          // Group starred sources by party
          const starGroups = parties.map(party => ({
            party,
            sources: starredSources
              .filter(s => (party.documents || []).some(d => d.id === s.docId))
              .map(s => ({ ...s, docName: s.docName || resolveDoc(s.docId).docName, partyName: s.partyName || party.name })),
          })).filter(g => g.sources.length > 0)
          // Unassigned starred (docId not in any party — shouldn't happen but safe)
          const assignedIds = new Set(starGroups.flatMap(g => g.sources.map(s => s.id)))
          const unassigned = starredSources.filter(s => !assignedIds.has(s.id))

          // Group all-case notes by party → doc
          const noteGroups = parties.map(party => ({
            party,
            docNotes: (party.documents || [])
              .map(doc => ({ doc, notes: (allCaseNotes[doc.id] || []).filter(n => n.text?.trim()) }))
              .filter(dn => dn.notes.length > 0),
          })).filter(g => g.docNotes.length > 0)

          const totalNotes = Object.values(allCaseNotes).flat().filter(n => n.text?.trim()).length
          const isEmpty = starredSources.length === 0 && totalNotes === 0

          const goToSource = (s) => {
            const nav = { pageNum: s.pageNum, chunkText: s.chunkText, bbox: s.bbox, narrowBbox: s.narrowBbox }
            if (s.docId !== activeDocumentId) {
              pendingNavRef.current = nav
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

          return (
            <div className="pdfapp-evidence">
              {isEmpty && (
                <div className="pdfapp-evidence-empty">
                  Star sources (★) from chat responses, or add page notes via the pencil tool, to build your evidence collection.
                </div>
              )}

              {/* ── Starred sources grouped by party ── */}
              {(starGroups.length > 0 || unassigned.length > 0) && (
                <div className="pdfapp-evidence-section">
                  <div className="pdfapp-evidence-section-title">⭐ Starred Sources ({starredSources.length})</div>
                  {starGroups.map(({ party, sources }) => (
                    <div key={party.id}>
                      <div className="pdfapp-evidence-party-header">{party.name}</div>
                      {sources.map(s => (
                        <div key={s.id} className={`pdfapp-evidence-item${s.docId !== activeDocumentId ? ' pdfapp-evidence-item--other-doc' : ''}`}>
                          <div className="pdfapp-evidence-item-meta">
                            <span className="pdfapp-evidence-item-docname" title={s.docName}>{s.docName}</span>
                            <span className="pdfapp-evidence-item-page">p.{s.pageNum}</span>
                            {s.score != null && <span className="pdfapp-evidence-item-score">{s.score}%</span>}
                            <button className="pdfapp-evidence-goto" title={s.docId !== activeDocumentId ? `Switch to ${s.docName}` : 'Go to page'} onClick={() => goToSource(s)}>→</button>
                            <button className="pdfapp-evidence-remove" title="Remove" onClick={() => handleRemoveStar(s.id)}>✕</button>
                          </div>
                          {s.question && <div className="pdfapp-evidence-item-q">"{s.question.slice(0, 100)}{s.question.length > 100 ? '…' : ''}"</div>}
                          <div className="pdfapp-evidence-item-text">{s.chunkText.slice(0, 220)}{s.chunkText.length > 220 ? '…' : ''}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {unassigned.map(s => (
                    <div key={s.id} className="pdfapp-evidence-item">
                      <div className="pdfapp-evidence-item-meta">
                        <span className="pdfapp-evidence-item-page">p.{s.pageNum}</span>
                        {s.score != null && <span className="pdfapp-evidence-item-score">{s.score}%</span>}
                        <button className="pdfapp-evidence-goto" onClick={() => goToSource(s)}>→</button>
                        <button className="pdfapp-evidence-remove" onClick={() => handleRemoveStar(s.id)}>✕</button>
                      </div>
                      <div className="pdfapp-evidence-item-text">{s.chunkText.slice(0, 220)}{s.chunkText.length > 220 ? '…' : ''}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Notes grouped by party → doc ── */}
              {noteGroups.length > 0 && (
                <div className="pdfapp-evidence-section">
                  <div className="pdfapp-evidence-section-title">📝 Notes ({totalNotes})</div>
                  {noteGroups.map(({ party, docNotes }) => (
                    <div key={party.id}>
                      <div className="pdfapp-evidence-party-header">{party.name}</div>
                      {docNotes.map(({ doc, notes: docNoteList }) => (
                        <div key={doc.id}>
                          <div className="pdfapp-evidence-doc-header">{doc.name}</div>
                          {docNoteList.map(n => (
                            <div key={n.id} className={`pdfapp-evidence-item${doc.id !== activeDocumentId ? ' pdfapp-evidence-item--other-doc' : ''}`}>
                              <div className="pdfapp-evidence-item-meta">
                                <span className="pdfapp-evidence-item-page">p.{n.pageNum}</span>
                                <button className="pdfapp-evidence-goto" title={doc.id !== activeDocumentId ? `Switch to ${doc.name}` : 'Go to page'} onClick={() => goToNote(doc.id, n.pageNum)}>→</button>
                              </div>
                              <div className="pdfapp-evidence-item-text">{n.text}</div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

            </div>
          )
        })()}

        {/* ── Report tab ── */}
        {rightTab === 'report' && (
          <div className="pdfapp-report-panel">
            <div className="pdfapp-report-format">
              <textarea
                className="pdfapp-report-format-input"
                placeholder="Describe the report format… e.g. 'Executive summary with: Background, Key Findings, Risk Assessment, Recommendations'"
                value={reportFormat}
                rows={3}
                onChange={e => setReportFormat(e.target.value)}
              />
              <button
                className={`pdfapp-report-btn${reportLoading ? ' pdfapp-report-btn--stop' : ''}`}
                onClick={handleGenerateReport}
                disabled={!reportLoading && !starredSources.length && !Object.values(allCaseNotes).flat().filter(n => n.text?.trim()).length}
              >
                {reportLoading
                  ? '■ Stop'
                  : (() => { const t = starredSources.length + Object.values(allCaseNotes).flat().filter(n => n.text?.trim()).length; return `Generate Report${t > 0 ? ` (${t} items)` : ''}` })()}
              </button>
            </div>
            {!reportContent && !reportLoading && (
              <div className="pdfapp-evidence-empty">
                Add starred sources and notes in the Evidence tab, then generate your report here.
              </div>
            )}
            {reportContent && (
              <div className="pdfapp-report-output-wrap">
                <div className="pdfapp-report-output-actions">
                  <button className="pdfapp-report-copy" onClick={() => navigator.clipboard.writeText(reportContent).catch(() => {})}>Copy</button>
                  <button className="pdfapp-report-clear" onClick={() => setReportContent('')}>Clear</button>
                </div>
                <div className="pdfapp-report-output">{reportContent}</div>
              </div>
            )}
          </div>
        )}

      </div>

    </div>
  )
}

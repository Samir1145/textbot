import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { useTheme } from '../useTheme.js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker } from 'tesseract.js'
import { loadSummary, saveSummary, saveSkillResult, loadSkillResult, loadSavedSkillIds, uploadCaseBlob, loadCaseBlob, loadChatHistory, saveChatHistory } from '../db.js'
import { LEGAL_SKILLS } from '../skills/legalSkills.js'
import { FORMAT_CATEGORIES } from '../skills/formatsIndex.js'
import { getDocRagStatus, indexDocPages, pruneDocChunks, searchDocChunks, searchCaseChunks, initFormatCategories } from '../rag.js'
import { extractAndSaveText, loadExtraction, extractPageChunksFromPDF } from '../utils/pdfExtract.js'
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

// ── Shared PDF text extraction (used by both summarize and skill runs) ──
async function extractTextFromPDF(pdf, { onStatus, signal }) {
  const allPageTexts = []
  const ocrPages = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (signal?.aborted) return null
    onStatus(`Extracting text — page ${pageNum} of ${pdf.numPages}…`)
    const page = await pdf.getPage(pageNum)
    const textContent = await page.getTextContent()
    const pageText = textContent.items.map(item => item.str).join(' ').trim()
    if (pageText.length > 20) {
      allPageTexts.push({ pageNum, text: pageText })
    } else {
      ocrPages.push(pageNum)
    }
  }

  if (ocrPages.length > 0) {
    onStatus(`Running OCR on ${ocrPages.length} scanned page(s)…`)
    const worker = await createWorker('eng')
    for (const pageNum of ocrPages) {
      if (signal?.aborted) { await worker.terminate(); return null }
      onStatus(`OCR — page ${pageNum} of ${pdf.numPages}…`)
      const page = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
      const { data: { text } } = await worker.recognize(canvas)
      allPageTexts.push({ pageNum, text: text.trim() })
    }
    await worker.terminate()
  }

  allPageTexts.sort((a, b) => a.pageNum - b.pageNum)
  return allPageTexts.map(p => `--- Page ${p.pageNum} ---\n${p.text}`).join('\n\n')
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
  const [docStatuses, setDocStatuses] = useState({})
  const [renamingPartyId, setRenamingPartyId] = useState(null)
  const pendingAddPartyRef = useRef(null) // partyId to assign the next file upload to

  // Flat document list derived from parties — used by all existing pdf/extraction/chat logic
  const documents = useMemo(() => parties.flatMap(p => p.documents), [parties])

  const [activeDocumentId, setActiveDocumentId] = useState(() => {
    const first = (folder?.children || []).find(c => c.type === 'file')
    return first ? String(first.id) : null
  })
  const [activeDocUrl, setActiveDocUrl] = useState(null)
  const [pageCount, setPageCount] = useState(null)
  const [pageCountsById, setPageCountsById] = useState({})
  const [pageDims, setPageDims] = useState({})   // pageNum → {w,h} — drives skeleton sizing
  const [renderScale, setRenderScale] = useState(1.25)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState(null)
  const [thumbsOpen, setThumbsOpen] = useState(false)
  const [showChunkOverlay, setShowChunkOverlay] = useState(false)
  const [jumpPage, setJumpPage] = useState('')
  const fileInputRef = useRef(null)
  const pagesContainerRef = useRef(null)
  const thumbsContainerRef = useRef(null)
  const pdfDocRef = useRef(null)         // main-thread pdf instance for text extraction
  const pageDimsRef = useRef({})         // mirror of pageDims state, readable inside callbacks
  const renderWorkerRef = useRef(null)
  const thumbWorkerRef = useRef(null)
  const observerRef = useRef(null)
  const thumbObserverRef = useRef(null)
  const renderScaleRef = useRef(1.25)
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
    setParties(prev => prev.map(p => ({ ...p, documents: p.documents.filter(d => d.id !== docId) })))
    if (activeDocumentId === docId) setActiveDocumentId(null)
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
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return
          const canvas = entry.target
          if (canvas.dataset.transferred || !canvas.isConnected) return
          canvas.dataset.transferred = 'true'

          const pageNum = parseInt(canvas.dataset.page, 10)
          canvas.style.backgroundColor = 'transparent'
          try {
            const offscreen = canvas.transferControlToOffscreen()
            renderWorkerRef.current?.postMessage(
              { type: 'render', pageNum, canvas: offscreen, dpr: window.devicePixelRatio || 1 },
              [offscreen]
            )
          } catch (err) {
            console.warn(`[PDF] OffscreenCanvas unavailable for page ${pageNum}:`, err)
          }
        })
      }, { root: pagesContainerRef.current, rootMargin: '200px 0px 200px 0px' })

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
        // Only persist dims at default scale (avoid caching zoom-specific sizes)
        if (renderScale === 1.25) {
          try { localStorage.setItem(`pdf-dims-${activeDocumentId}`, JSON.stringify(dims)) } catch { /* quota */ }
        }
        // DOM is already updated — single rAF to let the browser paint before observing
        requestAnimationFrame(() => setupObserver())
      } else if (msg.type === 'dims-update') {
        // Some pages have different dimensions from page 1 — patch them
        const updated = { ...pageDimsRef.current, ...msg.dims }
        pageDimsRef.current = updated
        setPageDims(updated)
        if (renderScale === 1.25) {
          try { localStorage.setItem(`pdf-dims-${activeDocumentId}`, JSON.stringify(updated)) } catch { /* quota */ }
        }
      } else if (msg.type === 'rendered') {
        // Build text layer imperatively after the worker finishes drawing a page
        const { pageNum } = msg
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
      if (cancelled || msg.type !== 'ready') return
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled || !thumbsContainerRef.current) return
        const observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return
            const canvas = entry.target
            if (canvas.dataset.transferred || !canvas.isConnected) return
            canvas.dataset.transferred = 'true'
            try {
              const offscreen = canvas.transferControlToOffscreen()
              thumbWorkerRef.current?.postMessage(
                { type: 'render', pageNum: parseInt(canvas.dataset.page, 10), canvas: offscreen, dpr: 1 },
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
  const [summary, setSummary] = useState('')
  const [savedSummaryText, setSavedSummaryText] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState(null)
  const [summaryStatus, setSummaryStatus] = useState('')
  const [activeSkillName, setActiveSkillName] = useState(null)
  const [savedSkillIds, setSavedSkillIds] = useState([])
  const abortRef = useRef(null)

  // Stores bbox-rich pages from the most recent extraction for this doc (avoids re-OCR when indexing)
  const lastExtractionPagesRef = useRef({ docId: null, pages: null })
  const extractedTextRef = useRef(null)

  // ── RAG state ──
  const [ragStatus, setRagStatus] = useState(null)   // null | 'indexing' | 'indexed'
  const [ragProgress, setRagProgress] = useState('')

  // ── Activity log ──
  const [logs, setLogs] = useState([])
  const [logOpen, setLogOpen] = useState(true)
  const logBottomRef = useRef(null)

  const addLog = useCallback((msg, level = 'info') => {
    if (!msg?.trim()) return
    setLogs(prev => [
      ...prev.slice(-299),
      { id: crypto.randomUUID(), time: new Date(), msg: msg.trim(), level },
    ])
  }, [])

  // Auto-scroll log to bottom when new entries arrive
  useEffect(() => {
    if (logOpen) logBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, logOpen])

  // ── LexChat ──
  const [lexChatOpen, setLexChatOpen] = useState(false)
  const [caseSearchActive, setCaseSearchActive] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [activeCitations, setActiveCitations] = useState(new Map()) // n → chunk

  // Scroll to the first cited page whenever activeCitations changes
  useEffect(() => {
    if (!activeCitations.size) return
    const firstChunk = activeCitations.values().next().value
    const canvas = pagesContainerRef.current?.querySelector(`[data-page="${firstChunk.page_num}"]`)
    canvas?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeCitations])
  const chatAbortRef = useRef(null)
  const chatBottomRef = useRef(null)

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (lexChatOpen) chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, lexChatOpen])

  // Reset chat + RAG state when document changes; load persisted chat history
  useEffect(() => {
    setChatMessages([])
    setChatInput('')
    setRagStatus(null)
    setRagProgress('')
    setActiveCitations(new Map())

    if (!activeDocumentId) return

    // Load saved chat history (case mode only)
    if (caseId) {
      loadChatHistory(activeDocumentId, { caseId }).then(msgs => {
        if (msgs.length) setChatMessages(msgs)
      }).catch(() => {})
    }

    getDocRagStatus(activeDocumentId, { caseId }).then(({ indexed }) => {
      if (indexed) setRagStatus('indexed')
    }).catch(() => {})
  }, [activeDocumentId]) // eslint-disable-line react-hooks/exhaustive-deps


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
    let ragContext = ''
    let chunkMap = new Map()
    if (ragStatus === 'indexed' && activeDocumentId) {
      const rawChunks = caseSearchActive && caseId
        ? await searchCaseChunks(caseId, text, 5)
        : await searchDocChunks(activeDocumentId, text, 3, { caseId });
      ({ ragContext, chunkMap } = buildEvidenceBlock(rawChunks))
    }

    // Fallback: when not indexed, include full extracted text (truncated) so the model has document context
    const _extractedText = extractedTextRef.current
    const docContext = ragContext
      ? ragContext
      : _extractedText
        ? `\n\nDocument text:\n${_extractedText.slice(0, 12000)}${_extractedText.length > 12000 ? '\n[…document continues…]' : ''}`
        : ''

    // Build message history for Ollama
    const systemPrompt = `You are LexChat, an expert legal AI assistant. You help legal professionals analyze documents, answer legal questions, and provide guidance on legal matters.${summary ? `\n\nDocument analysis:\n${summary}` : ''}${docContext}

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
  }, [chatInput, chatLoading, chatMessages, summary, ragStatus, activeDocumentId, caseSearchActive, caseId, addLog])
  const [lexAgentOpen, setLexAgentOpen] = useState(false)
  const [lexAgentMessages, setLexAgentMessages] = useState([])
  const [lexAgentInput, setLexAgentInput] = useState('')
  const [lexAgentLoading, setLexAgentLoading] = useState(false)
  const lexAgentAbortRef = useRef(null)
  const lexAgentBottomRef = useRef(null)

  // Load existing summary + saved skill IDs when document changes
  useEffect(() => {
    if (!activeDocumentId) {
      setSummary('')
      setSavedSummaryText(null)
      setSavedSkillIds([])
      return
    }
    let cancelled = false
    setSummary('')
    setSavedSummaryText(null)
    setSummaryError(null)
    setSummaryStatus('')
    setSavedSkillIds([])

    Promise.all([
      loadSummary(activeDocumentId, { caseId }),
      loadSavedSkillIds(activeDocumentId, { caseId }),
    ]).then(([savedText, skillIds]) => {
      if (cancelled) return
      if (savedText) setSavedSummaryText(savedText)
      setSavedSkillIds(skillIds || [])
    }).catch(err => console.error('Failed to load saved data:', err))

    return () => { cancelled = true }
  }, [activeDocumentId])


  const handleIndexDocument = useCallback(async () => {
    if (ragStatus === 'indexing') return
    const cached = lastExtractionPagesRef.current
    const hasCachedPages = cached.docId === activeDocumentId && cached.pages
    // Need the main-thread pdf only if we have no cached pages to fall back on
    if (!hasCachedPages && !pdfDocRef.current) return

    setRagStatus('indexing')
    try {
      // Step 1 — index format categories (skips already-done ones)
      setRagProgress('Setting up categories (first time only)…')
      await initFormatCategories(FORMAT_CATEGORIES)

      // Step 2 — get bbox-aware paragraph chunks
      // Prefer cached pages from extraction (has OCR bboxes too); fallback to native re-extract
      let pages
      if (hasCachedPages) {
        pages = cached.pages
      } else {
        const pdf = pdfDocRef.current
        setRagProgress('Extracting text with coordinates…')
        pages = await extractPageChunksFromPDF(pdf, { onStatus: setRagProgress })
      }

      const allChunks = pages.flatMap(p =>
        p.chunks
          .filter(c => c.text.length > 15)
          .map((c, idx) => ({ pageNum: p.pageNum, chunkIdx: idx, text: c.text, bbox: c.bbox }))
      )

      // Step 3 — incremental embed + store in batches (server skips unchanged hashes)
      const BATCH = 10
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH)
        setRagProgress(`Indexing chunks ${i + 1}–${Math.min(i + BATCH, allChunks.length)} / ${allChunks.length}…`)
        await indexDocPages(activeDocumentId, batch, { caseId })
      }

      // Prune stale chunks (from previous versions with different chunk count/layout)
      setRagProgress('Pruning stale chunks…')
      await pruneDocChunks(activeDocumentId, allChunks.map(c => ({ pageNum: c.pageNum, chunkIdx: c.chunkIdx })), { caseId })

      setRagStatus('indexed')

    } catch (err) {
      console.error('[RAG] indexing failed:', err)
      setRagStatus(null)
    } finally {
      setRagProgress('')
    }
  }, [activeDocumentId, ragStatus, caseId])

  const handleSummarize = useCallback(async () => {
    if (savedSummaryText) {
      setSummary(savedSummaryText)
      setActiveSkillName(null)
      return
    }

    const pdf = pdfDocRef.current
    if (!pdf) {
      setSummaryError('No PDF loaded yet. Please wait for the PDF to finish loading.')
      return
    }

    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSummary('')
    setActiveSkillName(null)
    setSummarizing(true)
    setSummaryError(null)
    setSummaryStatus('Extracting text from PDF…')

    try {
      const fullText = await extractTextFromPDF(pdf, {
        onStatus: setSummaryStatus,
        signal: controller.signal,
      })
      if (!fullText || !fullText.trim()) {
        setSummaryError('Could not extract any text from this PDF.')
        return
      }

      setSummaryStatus('Generating summary…')
      const accumulated = await streamOllamaChat({
        messages: [{ role: 'user', content: `You are a document analysis assistant. Summarize the following document text. Include all key points, important details, and notable information. Format the summary clearly with sections if the document covers multiple topics.\n\n${fullText}` }],
        signal: controller.signal,
        onChunk: setSummary,
      })
      if (accumulated) {
        saveSummary(activeDocumentId, accumulated, { caseId }).catch(console.error)
        setSavedSummaryText(accumulated)
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setSummaryError(err.message || 'Failed to connect to Ollama. Is it running?')
    } finally {
      setSummarizing(false)
      setSummaryStatus('')
    }
  }, [savedSummaryText, activeDocumentId])

  const handleRunSkill = useCallback(async (skill) => {
    const pdf = pdfDocRef.current
    if (!pdf) {
      setSummaryError('No PDF loaded yet. Please wait for the PDF to finish loading.')
      return
    }

    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSummary('')
    setActiveSkillName(skill.name)
    setSummarizing(true)
    setSummaryError(null)
    setSummaryStatus('Extracting text from PDF…')

    try {
      const fullText = await extractTextFromPDF(pdf, {
        onStatus: setSummaryStatus,
        signal: controller.signal,
      })
      if (!fullText || !fullText.trim()) {
        setSummaryError('Could not extract any text from this PDF.')
        return
      }

      setSummaryStatus(`Running ${skill.name}…`)
      const accumulated = await streamOllamaChat({
        messages: [
          { role: 'system', content: skill.systemPrompt },
          { role: 'user', content: `Please analyze the following document:\n\n${fullText}` },
        ],
        signal: controller.signal,
        onChunk: setSummary,
      })

      // Save result and mark skill as saved for this document
      if (accumulated && activeDocumentId) {
        saveSkillResult(activeDocumentId, skill.id, accumulated, { caseId }).catch(console.error)
        setSavedSkillIds(prev => prev.includes(skill.id) ? prev : [...prev, skill.id])
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setSummaryError(err.message || 'Failed to connect to Ollama. Is it running?')
    } finally {
      setSummarizing(false)
      setSummaryStatus('')
    }
  }, [activeDocumentId])

  const handleStopSummarize = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setSummarizing(false)
  }, [])


  // ── LexAgent — scroll to bottom when messages update ──────────────────
  useEffect(() => {
    if (lexAgentOpen) lexAgentBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lexAgentMessages, lexAgentOpen])

  // ── LexAgent — reset messages when doc changes ─────────────────────────
  useEffect(() => {
    setLexAgentMessages([])
    setLexAgentInput('')
  }, [activeDocumentId])

  // Run a skill inside the LexAgent chat panel
  const handleLexAgentSkill = useCallback(async (skill) => {
    if (lexAgentLoading) return
    const fullText = extractedTextRef.current
    if (!fullText?.trim()) {
      setLexAgentMessages(prev => [...prev, { role: 'assistant', id: crypto.randomUUID(), content: 'Document text not yet extracted. Please wait for extraction to finish.' }])
      return
    }

    if (lexAgentAbortRef.current) lexAgentAbortRef.current.abort()
    const controller = new AbortController()
    lexAgentAbortRef.current = controller

    const userMsg = { role: 'user', id: crypto.randomUUID(), content: `Run: **${skill.name}**` }
    const assistantId = crypto.randomUUID()
    setLexAgentMessages(prev => [...prev, userMsg, { role: 'assistant', id: assistantId, content: '' }])
    setLexAgentLoading(true)

    try {
      const accumulated = await streamOllamaChat({
        messages: [
          { role: 'system', content: skill.systemPrompt },
          { role: 'user', content: `Please analyze the following document:\n\n${fullText}` },
        ],
        signal: controller.signal,
        onChunk: text => setLexAgentMessages(prev => [...prev.slice(0, -1), { role: 'assistant', id: assistantId, content: text }]),
      })

      if (accumulated && activeDocumentId) {
        saveSkillResult(activeDocumentId, skill.id, accumulated, { caseId }).catch(console.error)
        setSavedSkillIds(prev => prev.includes(skill.id) ? prev : [...prev, skill.id])
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setLexAgentMessages(prev => [...prev.slice(0, -1), { role: 'assistant', id: assistantId, content: `Error: ${err.message}` }])
    } finally {
      setLexAgentLoading(false)
    }
  }, [lexAgentLoading, activeDocumentId, caseId])

  // Send a follow-up message in LexAgent
  const handleLexAgentSend = useCallback(async () => {
    const text = lexAgentInput.trim()
    if (!text || lexAgentLoading) return

    if (lexAgentAbortRef.current) lexAgentAbortRef.current.abort()
    const controller = new AbortController()
    lexAgentAbortRef.current = controller

    const userMsg = { role: 'user', id: crypto.randomUUID(), content: text }
    const assistantId = crypto.randomUUID()
    const history = [...lexAgentMessages, userMsg]
    setLexAgentMessages([...history, { role: 'assistant', id: assistantId, content: '' }])
    setLexAgentInput('')
    setLexAgentLoading(true)

    try {
      await streamOllamaChat({
        messages: [
          { role: 'system', content: 'You are LexAgent, a legal AI assistant. Answer questions about the document analysis above. Be concise and cite the relevant parts of the analysis.' },
          ...history.map(m => ({ role: m.role, content: m.content })),
        ],
        signal: controller.signal,
        onChunk: text => setLexAgentMessages(prev => [...prev.slice(0, -1), { role: 'assistant', id: assistantId, content: text }]),
      })
    } catch (err) {
      if (err.name === 'AbortError') return
      setLexAgentMessages(prev => [...prev.slice(0, -1), { role: 'assistant', id: assistantId, content: `Error: ${err.message}` }])
    } finally {
      setLexAgentLoading(false)
    }
  }, [lexAgentInput, lexAgentLoading, lexAgentMessages, caseId])

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
    setDocStatuses(prev => ({ ...prev, [docId]: 'loading' }))
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
        setDocStatuses(prev => ({ ...prev, [docId]: 'done' }))
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
        setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'done' }))
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
    if (extractedPages && ragStatus === null && activeDocumentId && (hasCachedPages || pdfDocRef.current)) {
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
                onClick={() => setActiveCitations(new Map([[token, chunk]]))}
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
                                      {status && (
                                        <div className="pdfapp-doc-dots">
                                          <span className={`pdfapp-doc-dot pdfapp-doc-dot--${status}`} title={status} />
                                        </div>
                                      )}
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
                <div className="pdfapp-log-entries">
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
                  <div ref={logBottomRef} />
                </div>
              )}
            </div>

            {/* Footer with collapse button */}
            <div className="pdfapp-sb-footer">
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
              className="pdfapp-sb-icon-btn pdfapp-sb-expand-btn"
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
                  pagesContainerRef.current
                    ?.querySelector(`[data-page="${n}"]`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
                    className={`pdfapp-toolbar-btn${thumbsOpen ? ' pdfapp-toolbar-btn--active' : ''}`}
                    onClick={() => setThumbsOpen(o => !o)}
                    title={thumbsOpen ? 'Hide thumbnails' : 'Show page thumbnails'}
                    disabled={!pageCount}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                    </svg>
                  </button>
                  <span className="pdfapp-center-filename" title={activeDoc.name}>
                    {activeDoc.name}
                  </span>
                </div>
                <div className="pdfapp-toolbar-right">
                  {/* Chunk overlay toggle */}
                  <button
                    className={`pdfapp-toolbar-btn${showChunkOverlay ? ' pdfapp-toolbar-btn--active' : ''}`}
                    onClick={() => setShowChunkOverlay(o => !o)}
                    title={showChunkOverlay ? 'Hide chunk bboxes' : 'Show chunk bboxes'}
                    disabled={!extractedPages}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/>
                      <rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/>
                    </svg>
                  </button>
                  {/* Zoom controls */}
                  <button
                    className="pdfapp-toolbar-btn"
                    onClick={() => setRenderScale(s => Math.max(0.5, +((s - 0.25).toFixed(2))))}
                    title="Zoom out"
                    disabled={renderScale <= 0.5}
                  >−</button>
                  <span className="pdfapp-toolbar-zoom">{Math.round(renderScale * 100)}%</span>
                  <button
                    className="pdfapp-toolbar-btn"
                    onClick={() => setRenderScale(s => Math.min(3.0, +((s + 0.25).toFixed(2))))}
                    title="Zoom in"
                    disabled={renderScale >= 3.0}
                  >+</button>
                  {/* Jump to page */}
                  {pageCount && (
                    <>
                      <input
                        type="number"
                        className="pdfapp-toolbar-page-input"
                        min={1}
                        max={pageCount}
                        value={jumpPage}
                        placeholder="pg"
                        onChange={e => setJumpPage(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const n = parseInt(jumpPage, 10)
                            if (n >= 1 && n <= pageCount) {
                              pagesContainerRef.current
                                ?.querySelector(`[data-page="${n}"]`)
                                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            }
                          }
                        }}
                      />
                      <span className="pdfapp-toolbar-page-total">/ {pageCount}</span>
                    </>
                  )}
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
                      const chunkData = showChunkOverlay && extractedPages?.find(p => p.pageNum === pageNum)
                      return (
                        <div key={`${activeDocumentId}-${pageNum}-${renderScale}`} className="pdfapp-page-wrapper">
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
                          {/* Chunk bbox overlay (toggle) */}
                          {chunkData && chunkData.chunks?.length > 0 && (
                            <div className="pdfapp-chunk-overlay">
                              {chunkData.chunks.map((chunk, ci) => {
                                const b = chunk.bbox
                                if (!b) return null
                                return (
                                  <div
                                    key={ci}
                                    className="pdfapp-chunk-overlay-rect"
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

                  {/* ── Extraction controls ── */}
                  <div className="pdfapp-extract-controls" onClick={e => e.stopPropagation()}>
                    {extractingText ? (
                      <button
                        className="pdfapp-extract-btn pdfapp-extract-btn--stop"
                        title="Stop extraction"
                        onClick={() => { extractionAbortRef.current?.abort(); setExtractingText(false); setExtractionStatus('') }}
                      >
                        ■ Stop
                      </button>
                    ) : extractedPages ? (
                      <button
                        className="pdfapp-extract-btn pdfapp-extract-btn--rerun"
                        title="Re-run extraction"
                        disabled={!activeDoc?.file || pdfLoading}
                        onClick={() => activeDoc?.file && runExtraction(activeDocumentId, activeDoc.file)}
                      >
                        ↺ Re-run
                      </button>
                    ) : (
                      <button
                        className="pdfapp-extract-btn pdfapp-extract-btn--start"
                        title="Start text extraction / OCR"
                        disabled={!activeDoc?.file || pdfLoading}
                        onClick={() => activeDoc?.file && runExtraction(activeDocumentId, activeDoc.file)}
                      >
                        ▶ Extract
                      </button>
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
                        Press <strong>▶ Extract</strong> to run text extraction{activeDoc?.file ? '' : ' (no file loaded)'}.
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

      {/* ── Panel 3: Right Workspace — Summary ── */}
      <div className="pdfapp-right" style={{ flex: rightFlex }}>
        {lexAgentOpen && (
          <div className="pdfapp-lexagent">
            <div className="pdfapp-lexagent-header">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
              <span>LexAgent</span>
              {lexAgentLoading && <div className="pdfapp-spinner pdfapp-spinner--small" />}
            </div>

            <div className="pdfapp-lexagent-messages">
              {/* Skill picker — always visible at top */}
              <div className="pdfapp-lexagent-skills">
                <p className="pdfapp-lexagent-intro">
                  {lexAgentMessages.length === 0
                    ? "Hi, I'm LexAgent. Select a skill to analyze this document:"
                    : "Run another skill:"}
                </p>
                <div className="pdfapp-lexagent-skill-grid">
                  {LEGAL_SKILLS.map(skill => (
                    <button
                      key={skill.id}
                      className={`pdfapp-lexagent-skill-card${savedSkillIds.includes(skill.id) ? ' pdfapp-lexagent-skill-card--done' : ''}`}
                      onClick={() => handleLexAgentSkill(skill)}
                      disabled={lexAgentLoading || !activeDocumentId}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                      </svg>
                      <span>{skill.name}</span>
                      {savedSkillIds.includes(skill.id) && (
                        <span className="pdfapp-lexagent-skill-done" title="Saved result available">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Chat messages */}
              {lexAgentMessages.map((msg, i) => (
                <div key={msg.id ?? i} className={`pdfapp-chat-msg pdfapp-chat-msg--${msg.role}`}>
                  {msg.role === 'assistant' && <div className="pdfapp-chat-avatar">A</div>}
                  <div className="pdfapp-chat-msg-body">
                    <div className="pdfapp-chat-bubble">
                      {msg.content}
                      {msg.role === 'assistant' && lexAgentLoading && i === lexAgentMessages.length - 1 && (
                        <span className="pdfapp-cursor">▌</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={lexAgentBottomRef} />
            </div>

            {lexAgentMessages.length > 0 && (
              <div className="pdfapp-chat-input-row">
                <textarea
                  className="pdfapp-chat-input"
                  value={lexAgentInput}
                  onChange={e => setLexAgentInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleLexAgentSend() } }}
                  placeholder="Ask a follow-up question…"
                  rows={1}
                  disabled={lexAgentLoading}
                />
                <button
                  className="pdfapp-chat-send"
                  onClick={handleLexAgentSend}
                  disabled={lexAgentLoading || !lexAgentInput.trim()}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="pdfapp-summary-header">
          {summarizing ? (
            <button
              className="pdfapp-summarize-btn pdfapp-summarize-btn--stop"
              onClick={handleStopSummarize}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </button>
          ) : (
            <>
            <button
              className={`pdfapp-actions-btn${lexAgentOpen ? ' pdfapp-actions-btn--active' : ''}`}
              onClick={() => { setLexAgentOpen(o => !o); if (lexChatOpen) setLexChatOpen(false) }}
              disabled={!activeDocumentId || pdfLoading}
              title="LexAgent — run legal skills and ask follow-up questions"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
              LexAgent
            </button>
            </>
          )}
          <button
            className={`pdfapp-lexchat-btn ${lexChatOpen ? 'pdfapp-lexchat-btn--active' : ''}`}
            onClick={() => { setLexChatOpen(o => !o); if (lexAgentOpen) setLexAgentOpen(false) }}
            title={
              ragStatus === 'indexed' ? 'LexChat — RAG active (semantic search ready)' :
              ragStatus === 'indexing' ? ragProgress || 'Indexing document for RAG…' :
              'LexChat — AI legal assistant'
            }
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            LexChat
            <span
              className={`pdfapp-rag-status-dot pdfapp-rag-status-dot--${ragStatus ?? 'none'}`}
              title={
                ragStatus === 'indexed'  ? 'Indexed — semantic search active' :
                ragStatus === 'indexing' ? ragProgress || 'Indexing…' :
                'Not indexed'
              }
            />
          </button>
        </div>

        {lexChatOpen ? (
          <div className="pdfapp-chat">
            <div className="pdfapp-chat-messages">
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
                          return (
                            <button
                              key={n}
                              className={`pdfapp-source-item${activeCitations.has(n) ? ' pdfapp-source-item--active' : ''}`}
                              onClick={() => setActiveCitations(new Map([[n, chunk]]))}
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
              <div ref={chatBottomRef} />
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
                className="pdfapp-chat-send"
                onClick={handleChatSend}
                disabled={chatLoading || !chatInput.trim() || !activeDocumentId}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <div className="pdfapp-summary-body">
            {summaryError && (
              <div className="pdfapp-summary-error">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <span>{summaryError}</span>
              </div>
            )}

            {summarizing && !summary && (
              <div className="pdfapp-summary-loading">
                <div className="pdfapp-spinner" />
                <span>{summaryStatus || 'Analyzing document…'}</span>
              </div>
            )}

            {summary ? (
              <div className="pdfapp-summary-text">
                {activeSkillName && (
                  <div className="pdfapp-skill-label">{activeSkillName}</div>
                )}
                {summary}
                {summarizing && <span className="pdfapp-cursor">▌</span>}
              </div>
            ) : (
              !summarizing && !summaryError && (
                <div className="pdfapp-summary-empty">
                  <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#4b5563" strokeWidth="1.2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                  <p>Open <strong>LexAgent</strong> to run skills on this document</p>
                  <span className="pdfapp-summary-model">OCR + qwen3.5 cloud via Ollama</span>
                </div>
              )
            )}
          </div>
        )}
      </div>

    </div>
  )
}

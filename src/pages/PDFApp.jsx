import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTheme } from '../useTheme.js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker } from 'tesseract.js'
import { loadSummary, saveSummary, saveSkillResult, loadSkillResult, loadSavedSkillIds, uploadCaseBlob, loadCaseBlob } from '../db.js'
import { LEGAL_SKILLS } from '../skills/legalSkills.js'
import { FORMAT_CATEGORIES } from '../skills/formatsIndex.js'
import { getDocRagStatus, indexDocPages, clearDocChunks, searchDocChunks, searchCaseChunks, initFormatCategories, suggestFormatCategories } from '../rag.js'
import { extractAndSaveText, loadExtraction, extractPageChunksFromPDF } from '../utils/pdfExtract.js'
import { buildEvidenceBlock, parseCitations, tokeniseMessage } from '../utils/parseCitations.js'
import './PDFApp.css'

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
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState(null)
  const fileInputRef = useRef(null)
  const pagesContainerRef = useRef(null)
  const pdfDocRef = useRef(null)   // store loaded pdf for text extraction

  const containerRef = useRef(null)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartSplit = useRef(CENTER_DEFAULT_PCT)

  const handleAddDocumentClick = () => {
    if (parties.length === 0) {
      const newId = crypto.randomUUID()
      setParties([{ id: newId, name: 'Party 1', documents: [] }])
      setActivePartyId(newId)
      pendingAddPartyRef.current = newId
    } else {
      pendingAddPartyRef.current = activePartyId || parties[0].id
    }
    fileInputRef.current?.click()
  }

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

  // Load PDF via pdfjs-dist and render all pages into canvases
  useEffect(() => {
    // Reset pages immediately so old canvases are unmounted
    setPageCount(null)
    setExtractedText(null)
    setExtractedPages(null)
    setExtractionSource(null)
    setExtractionError(null)
    setExtractionStatus('')
    setExtractingText(false)
    if (extractionAbortRef.current) { extractionAbortRef.current.abort(); extractionAbortRef.current = null }

    if (!activeDocUrl) {
      setPdfLoading(false)
      setPdfError(null)
      return
    }

    let cancelled = false
    let pdfDoc = null
    setPdfLoading(true)
    setPdfError(null)

    const loadingTask = pdfjsLib.getDocument({ url: activeDocUrl })

    loadingTask.promise
      .then(async (pdf) => {
        if (cancelled) {
          pdf.destroy()
          return
        }
        pdfDoc = pdf
        pdfDocRef.current = pdf
        setPageCount(pdf.numPages)
        setPageCountsById(prev => ({ ...prev, [activeDocumentId]: pdf.numPages }))

        setPdfLoading(false)

        // Wait two frames so React can render canvases for the new pageCount
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
        if (cancelled) return

        // Fetch just the first page to get aspect ratio / dimensions
        const page1 = await pdf.getPage(1)
        const viewport1 = page1.getViewport({ scale: 1.25 })
        const pWidth = viewport1.width
        const pHeight = viewport1.height

        // Setup an IntersectionObserver to lazy-render pages
        const observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const canvas = entry.target
              if (canvas.dataset.rendered) return
              canvas.dataset.rendered = 'true'

              const pageNum = parseInt(canvas.dataset.page, 10)
              pdf.getPage(pageNum).then(async (page) => {
                if (cancelled) return
                const viewport = page.getViewport({ scale: 1.25 })
                const context = canvas.getContext('2d')
                const dpr = window.devicePixelRatio || 1

                canvas.width = Math.floor(viewport.width * dpr)
                canvas.height = Math.floor(viewport.height * dpr)
                canvas.style.width = `${Math.floor(viewport.width)}px`
                canvas.style.height = `${Math.floor(viewport.height)}px`
                // Remove skeleton background
                canvas.style.backgroundColor = 'transparent'
                context.setTransform(dpr, 0, 0, dpr, 0, 0)

                await page.render({ canvasContext: context, viewport }).promise
              }).catch(err => {
                if (!cancelled) console.error(`Error rendering page ${pageNum}:`, err)
              })
            }
          })
        }, {
          root: pagesContainerRef.current,
          rootMargin: '100% 0px 100% 0px' // render 1 screen above/below
        })

        const canvases = pagesContainerRef.current?.querySelectorAll?.('.pdfapp-page-canvas')
        canvases?.forEach?.(canvas => {
          // pre-set skeleton dimensions so scrolling works immediately
          canvas.style.width = `${Math.floor(pWidth)}px`
          canvas.style.height = `${Math.floor(pHeight)}px`
          canvas.style.backgroundColor = '#1f2937' // dark placeholder
          observer.observe(canvas)
        })

        pdfDoc._observer = observer
      })
      .catch((err) => {
        if (cancelled) return
        setPdfError(err?.message || 'Failed to load PDF')
        setPdfLoading(false)
        console.error(err)
      })

    return () => {
      cancelled = true
      if (pdfDoc) {
        if (pdfDoc._observer) pdfDoc._observer.disconnect()
        pdfDoc.destroy()
      }
    }
  }, [activeDocUrl, activeDocumentId])

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

  // ── RAG state ──
  const [ragStatus, setRagStatus] = useState(null)   // null | 'indexing' | 'indexed'
  const [ragProgress, setRagProgress] = useState('')
  const [ragSuggestions, setRagSuggestions] = useState([])

  // ── LexChat ──
  const [lexChatOpen, setLexChatOpen] = useState(false)
  const [caseSearchActive, setCaseSearchActive] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [activeCitations, setActiveCitations] = useState(new Map()) // n → chunk
  const chatAbortRef = useRef(null)
  const chatBottomRef = useRef(null)

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (lexChatOpen) chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, lexChatOpen])

  // Reset chat + RAG state when document changes; check if new doc is already indexed
  useEffect(() => {
    setChatMessages([])
    setChatInput('')
    setRagStatus(null)
    setRagSuggestions([])
    setRagProgress('')

    if (!activeDocumentId) return
    getDocRagStatus(activeDocumentId, { caseId }).then(({ indexed }) => {
      if (indexed) setRagStatus('indexed')
    }).catch(() => {})
  }, [activeDocumentId])


  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return

    const userMsg = { role: 'user', content: text }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

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

    // Build message history for Ollama
    const systemPrompt = `You are LexChat, an expert legal AI assistant. You help legal professionals analyze documents, answer legal questions, and provide guidance on legal matters.${summary ? `\n\nDocument analysis:\n${summary}` : ''}${ragContext}

Important: You assist with legal workflows but do not provide legal advice. Always recommend qualified legal professionals for final decisions.`

    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatMessages,
      userMsg,
    ]

    try {
      const res = await fetch('/api/ollama/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 68d73d3a870148f6818d364c549c2bc3._C2su8V3eWzsWN5F7Zk27DGt',
        },
        signal: controller.signal,
        body: JSON.stringify({ model: 'qwen3.5:cloud', messages, stream: true }),
      })

      if (!res.ok) throw new Error(`Ollama returned ${res.status}`)

      let accumulated = ''
      setChatMessages(prev => [...prev, { role: 'assistant', content: '' }])

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const json = JSON.parse(line)
            if (json.message?.content) {
              accumulated += json.message.content
              setChatMessages(prev => [
                ...prev.slice(0, -1),
                { role: 'assistant', content: accumulated },
              ])
            }
          } catch { /* partial JSON */ }
        }
      }

      // ATG: parse which [n] citations the LLM actually used
      const msgCitations = parseCitations(accumulated, chunkMap)
      if (msgCitations.size) {
        setChatMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: accumulated, citations: msgCitations },
        ])
        setActiveCitations(msgCitations)
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatLoading, chatMessages, summary, ragStatus, activeDocumentId, caseSearchActive, caseId])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef(null)
  const [draftingOpen, setDraftingOpen] = useState(false)
  const draftingRef = useRef(null)

  // Close dropdowns on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  useEffect(() => {
    if (!draftingOpen) return
    const handler = (e) => {
      if (draftingRef.current && !draftingRef.current.contains(e.target)) {
        setDraftingOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [draftingOpen])

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
    const pdf = pdfDocRef.current
    if (!pdf || ragStatus === 'indexing') return

    setRagStatus('indexing')
    setDraftingOpen(true)

    try {
      // Step 1 — index format categories (skips already-done ones)
      setRagProgress('Setting up categories (first time only)…')
      await initFormatCategories(FORMAT_CATEGORIES)

      // Step 2 — get bbox-aware paragraph chunks
      // Prefer cached pages from extraction (has OCR bboxes too); fallback to native re-extract
      const cached = lastExtractionPagesRef.current
      let pages
      if (cached.docId === activeDocumentId && cached.pages) {
        pages = cached.pages
      } else {
        setRagProgress('Extracting text with coordinates…')
        pages = await extractPageChunksFromPDF(pdf, { onStatus: setRagProgress })
      }

      const allChunks = pages.flatMap(p =>
        p.chunks
          .filter(c => c.text.length > 15)
          .map((c, idx) => ({ pageNum: p.pageNum, chunkIdx: idx, text: c.text, bbox: c.bbox }))
      )

      // Step 3 — clear existing + embed + store in batches
      setRagProgress('Clearing previous index…')
      await clearDocChunks(activeDocumentId, { caseId })

      const BATCH = 10
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH)
        setRagProgress(`Indexing chunks ${i + 1}–${Math.min(i + BATCH, allChunks.length)} / ${allChunks.length}…`)
        await indexDocPages(activeDocumentId, batch, { caseId })
      }

      setRagStatus('indexed')

      // Step 4 — fetch smart suggestions using summary or first chunk
      const query = (savedSummaryText || summary || allChunks[0]?.text || '').substring(0, 1000)
      if (query.trim()) {
        setRagProgress('Finding relevant templates…')
        const suggestions = await suggestFormatCategories(query)
        setRagSuggestions(suggestions)
      }
    } catch (err) {
      console.error('[RAG] indexing failed:', err)
      setRagStatus(null)
    } finally {
      setRagProgress('')
    }
  }, [activeDocumentId, ragStatus, savedSummaryText, summary])

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
      const res = await fetch('/api/ollama/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 68d73d3a870148f6818d364c549c2bc3._C2su8V3eWzsWN5F7Zk27DGt',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'qwen3.5:cloud',
          messages: [{ role: 'user', content: `You are a document analysis assistant. Summarize the following document text. Include all key points, important details, and notable information. Format the summary clearly with sections if the document covers multiple topics.\n\n${fullText}` }],
          stream: true,
        }),
      })

      if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`)

      setSummaryStatus('')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) { saveSummary(activeDocumentId, accumulated, { caseId }).catch(console.error); break }
        const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const json = JSON.parse(line)
            if (json.message?.content) { accumulated += json.message.content; setSummary(accumulated) }
            if (json.done) { saveSummary(activeDocumentId, accumulated, { caseId }).catch(console.error); setSavedSummaryText(accumulated); break }
          } catch { /* partial JSON */ }
        }
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
      const res = await fetch('/api/ollama/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 68d73d3a870148f6818d364c549c2bc3._C2su8V3eWzsWN5F7Zk27DGt',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'qwen3.5:cloud',
          messages: [
            { role: 'system', content: skill.systemPrompt },
            { role: 'user', content: `Please analyze the following document:\n\n${fullText}` },
          ],
          stream: true,
        }),
      })

      if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`)

      setSummaryStatus('')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const json = JSON.parse(line)
            if (json.message?.content) { accumulated += json.message.content; setSummary(accumulated) }
          } catch { /* partial JSON */ }
        }
      }

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
      })
      if (result) {
        setExtractedText(result.text)
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

  // Auto-trigger on document change: load from cache or run extraction
  useEffect(() => {
    if (!activeDocumentId) return
    const activeDoc = documents.find(d => d.id === activeDocumentId)
    if (!activeDoc?.file) return

    let cancelled = false
    loadExtraction(activeDocumentId, { caseId }).then(saved => {
      if (cancelled) return
      if (saved?.text) {
        setExtractedText(saved.text)
        setExtractionSource(saved.isOcr ? 'ocr' : 'text')
        setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'done' }))
      } else {
        runExtraction(activeDocumentId, activeDoc.file)
      }
    }).catch(() => {
      if (!cancelled) runExtraction(activeDocumentId, activeDoc.file)
    })

    return () => { cancelled = true }
  }, [activeDocumentId, documents, runExtraction])
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
                <span className="pdfapp-center-filename" title={activeDoc.name}>
                  {activeDoc.name}
                </span>
              </div>
              <div className="pdfapp-center-body">
                {pdfError && (
                  <div className="pdfapp-center-placeholder">
                    {pdfError}
                  </div>
                )}
                {!pdfError && (
                  <div className="pdfapp-center-pages" ref={pagesContainerRef}>
                    {pdfLoading && (
                      <div className="pdfapp-center-placeholder pdfapp-center-placeholder--inline">
                        Loading PDF…
                      </div>
                    )}
                    {pageCount != null && Array.from({ length: pageCount }, (_, index) => {
                      const pageNum = index + 1
                      return (
                        <div key={`${activeDocumentId}-${pageNum}`} className="pdfapp-page-wrapper">
                          <canvas data-page={pageNum} className="pdfapp-page-canvas" />
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
                <div
                  className="pdfapp-extracted-header"
                  onClick={() => setExtractedTextOpen(o => !o)}
                >
                  <div className="pdfapp-extracted-header-left">
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
                  </div>
                  <span className="pdfapp-extracted-arrow">{extractedTextOpen ? '▲' : '▼'}</span>
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
                    </div>
                  ) : extractedText ? (
                    <div className="pdfapp-chunks-body">
                      <div className="pdfapp-chunk-card pdfapp-chunk-card--legacy">
                        <div className="pdfapp-chunk-meta">
                          <span className="pdfapp-chunk-tag pdfapp-chunk-tag--page">cached</span>
                        </div>
                        <pre className="pdfapp-chunk-text pdfapp-chunk-text--pre">{extractedText}</pre>
                      </div>
                    </div>
                  ) : extractingText ? (
                    <div className="pdfapp-extracted-prompt">
                      <div className="pdfapp-spinner pdfapp-spinner--small" />
                      <span className="pdfapp-extracted-status">{extractionStatus || 'Extracting…'}</span>
                    </div>
                  ) : extractionError ? (
                    <div className="pdfapp-extracted-prompt">
                      <span className="pdfapp-extracted-error">{extractionError}</span>
                      <button
                        className="pdfapp-extracted-run-btn"
                        onClick={() => activeDoc?.file && runExtraction(activeDocumentId, activeDoc.file)}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <div className="pdfapp-extracted-prompt">
                      <span className="pdfapp-extracted-placeholder">No text extracted yet.</span>
                      <button
                        className="pdfapp-extracted-run-btn"
                        onClick={() => activeDoc?.file && runExtraction(activeDocumentId, activeDoc.file)}
                        disabled={!activeDocumentId || pdfLoading}
                      >
                        Run text extraction
                      </button>
                    </div>
                  )
                )}
              </div>
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
            <div className="pdfapp-actions-dropdown" ref={draftingRef}>
              <button
                className="pdfapp-actions-btn"
                onClick={() => setDraftingOpen(o => !o)}
                disabled={!activeDocumentId || pdfLoading}
              >
                Drafting
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {draftingOpen && (
                <div className="pdfapp-actions-menu">
                  {/* RAG: suggest templates when indexed */}
                  {ragStatus === 'indexing' && (
                    <div className="pdfapp-drafting-loading">
                      <div className="pdfapp-spinner pdfapp-spinner--small" />
                      <span>{ragProgress || 'Indexing document…'}</span>
                    </div>
                  )}

                  {ragStatus === 'indexed' && ragSuggestions.length > 0 && (<>
                    <div className="pdfapp-actions-menu-section">AI Suggestions</div>
                    {ragSuggestions.map(s => (
                      <button
                        key={s.name}
                        className="pdfapp-actions-menu-item pdfapp-actions-menu-item--drafting"
                        onClick={() => setDraftingOpen(false)}
                        title={s.description}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        <span className="pdfapp-drafting-item-text">
                          <strong>{s.name}</strong>
                          <em>{s.description}</em>
                        </span>
                      </button>
                    ))}
                    <div className="pdfapp-actions-menu-divider" />
                  </>)}

                  {/* Index button when not yet indexed */}
                  {ragStatus === null && activeDocumentId && (
                    <>
                      <button
                        className="pdfapp-actions-menu-item pdfapp-rag-index-btn"
                        onClick={() => { handleIndexDocument() }}
                        disabled={pdfLoading}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        ✨ Smart Suggestions — Index Document
                      </button>
                      <div className="pdfapp-actions-menu-divider" />
                    </>
                  )}

                  <div className="pdfapp-actions-menu-section">All Categories</div>
                  {FORMAT_CATEGORIES.map(cat => (
                    <button
                      key={cat.name}
                      className="pdfapp-actions-menu-item"
                      onClick={() => setDraftingOpen(false)}
                      title={cat.description}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      {cat.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="pdfapp-actions-dropdown" ref={dropdownRef}>
              <button
                className="pdfapp-actions-btn"
                onClick={() => setDropdownOpen(o => !o)}
                disabled={!activeDocumentId || pdfLoading}
              >
                Analysis
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {dropdownOpen && (
                <div className="pdfapp-actions-menu">
                  {/* Saved results — only shown if at least one exists */}
                  {(savedSummaryText || savedSkillIds.length > 0) && (<>
                    {savedSummaryText && (
                      <button
                        className="pdfapp-actions-menu-item pdfapp-actions-menu-item--saved"
                        onClick={() => { setDropdownOpen(false); handleSummarize() }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        View Saved <strong>Summary</strong>
                      </button>
                    )}
                    {savedSkillIds.map(skillId => {
                      const skill = LEGAL_SKILLS.find(s => s.id === skillId)
                      if (!skill) return null
                      return (
                        <button
                          key={skillId}
                          className="pdfapp-actions-menu-item pdfapp-actions-menu-item--saved"
                          onClick={async () => {
                            setDropdownOpen(false)
                            const text = await loadSkillResult(activeDocumentId, skillId, { caseId })
                            if (text) { setSummary(text); setActiveSkillName(skill.name) }
                          }}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          View Saved <strong>{skill.name}</strong>
                        </button>
                      )
                    })}
                    <div className="pdfapp-actions-menu-divider" />
                  </>)}

                  {/* Legal skills to run */}
                  <div className="pdfapp-actions-menu-section">Legal Skills</div>
                  {LEGAL_SKILLS.map(skill => (
                    <button
                      key={skill.id}
                      className="pdfapp-actions-menu-item"
                      onClick={() => { setDropdownOpen(false); handleRunSkill(skill) }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                      </svg>
                      {skill.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            </>
          )}
          <button
            className={`pdfapp-lexchat-btn ${lexChatOpen ? 'pdfapp-lexchat-btn--active' : ''}`}
            onClick={() => setLexChatOpen(o => !o)}
            title={ragStatus === 'indexed' ? 'LexChat — RAG enabled (semantic search active)' : 'LexChat — AI legal assistant'}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            LexChat
            {ragStatus === 'indexed' && <span className="pdfapp-rag-dot" title="RAG active" />}
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
                  <div className="pdfapp-chat-bubble">
                    {renderMessageContent(msg, i === chatMessages.length - 1)}
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
                  <p>Select an action from the <strong>Analysis</strong> dropdown to analyze this document</p>
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

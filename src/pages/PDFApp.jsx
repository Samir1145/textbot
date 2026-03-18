import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { flushSync, createPortal } from 'react-dom'
import { useTheme } from '../useTheme.js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { uploadCaseBlob, loadCaseBlob, deleteCaseBlob, loadChatHistory, saveChatHistory, loadNotes, saveNotes, loadAllNotes, deleteNotes, deleteSummary } from '../db.js'
import { FORMAT_CATEGORIES } from '../skills/formatsIndex.js'
import { getDocRagStatus, getCaseRagStatus, indexDocPages, pruneDocChunks, clearDocChunks, searchDocChunks, searchCaseChunks, initFormatCategories, embedManualNote } from '../rag.js'
import { extractAndSaveText, loadExtraction, extractPageChunksFromPDF, groupIntoParagraphs } from '../utils/pdfExtract.js'
import { getCachedThumb, setCachedThumb } from '../utils/thumbnailCache.js'
import { buildEvidenceBlock, parseCitations, tokeniseMessage, narrowCitations, distanceToScore } from '../utils/parseCitations.js'
import { findTextInTextLayer } from '../utils/textLayerSearch.js'
import { streamOllamaChat, callOllama, checkLlmHealth, LLM_BACKEND_NAME, LLM_MODEL_NAME } from '../utils/ollamaStream.js'
import './PDFApp.css'

// ── Agent definitions ────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'case-summarizer',   icon: '📋', color: '#2563eb', name: 'Case Summarizer',      tagline: 'Structured brief from all case documents',    defaultTask: 'Summarise all documents in this case into a structured legal brief with key facts, issues, and arguments.' },
  { id: 'contract-reviewer', icon: '📝', color: '#059669', name: 'Contract Reviewer',    tagline: 'Red flags and liability clause scanner',      defaultTask: 'Review all contracts for liability clauses, red flags, unusual terms, and missing standard provisions.' },
  { id: 'evidence-analyzer', icon: '🔍', color: '#d97706', name: 'Evidence Analyzer',    tagline: 'Timeline builder from exhibits and statements', defaultTask: 'Build a chronological timeline of events from exhibits, witness statements, and supporting documents.' },
  { id: 'due-diligence',     icon: '✅', color: '#7c3aed', name: 'Due Diligence Agent',  tagline: 'Comprehensive cross-document risk review',     defaultTask: 'Conduct a comprehensive due diligence review across all case documents and flag material risks.' },
  { id: 'legal-research',    icon: '⚖️', color: '#dc2626', name: 'Legal Research',       tagline: 'Statutes, precedents, and citations',          defaultTask: 'Identify all statutory references, case citations, and legal precedents mentioned in the documents.' },
]

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

// ── Citation live-data enrichment ───────────────────────────────────────────
// Replaces stale SQLite bbox/chunk_idx on citation objects with live data from
// extractedPages: fresh bbox, lineRects, and the PAGE-LOCAL chunk index needed
// for chunk panel scrolling. Matches by text prefix (first 60 chars).
function enrichCitationsWithLiveData(citations, extractedPages) {
  if (!extractedPages || !citations.size) return citations
  const out = new Map()
  for (const [n, chunk] of citations) {
    const page = extractedPages.find(p => p.pageNum === chunk.page_num)
    if (!page) { out.set(n, chunk); continue }
    const prefix = chunk.text.slice(0, 60)
    const localIdx = page.chunks.findIndex(c => c.text.slice(0, 60) === prefix)
    if (localIdx < 0) { out.set(n, chunk); continue }
    const live = page.chunks[localIdx]
    out.set(n, {
      ...chunk,
      bbox:         live.bbox      ?? chunk.bbox,
      lineRects:    live.lineRects ?? null,
      pageLocalIdx: localIdx,
    })
  }
  return out
}

function diag(msg) {
  console.log(`[DIAG] ${msg}`)
  fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {})
}

// ── Word-count-based chunk merging ──────────────────────────────────────────
// Merges paragraph chunks so each resulting chunk is ≤ targetWords words.
// Named countWords (not estimateTokens) because it counts whitespace-delimited
// words, not sub-word tokens. Legal text typically runs ~1.3 tokens/word so a
// 100-word chunk ≈ 130 tokens — safely within nomic-embed-text-v1.5's 8192 limit.
function countWords(text) {
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


// ── Shared abbreviation guard (prevents splitting on "Dr.", "s.", "v.", etc.) ──
// Covers general English + common Indian/UK legal citations.
// Add entries here when a false sentence-split is observed in practice.
const _ABBREVS = /^(Mr|Mrs|Ms|Dr|Prof|Hon|Inc|Ltd|Co|Corp|vs|v|cf|et|al|ibid|viz|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|No|Art|Sec|Sch|Reg|Vol|Ch|Pt|Div|Ord|cl|para|s|r|O|p|pp)\.$/

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
      // Next word starts a new sentence: capital letter, opening paren/quote, or a
      // digit (handles numbered clauses "1.", "2." and roman numerals common in legal docs)
      && (!next || /^[A-Z("0-9]/.test(next.text.trim()))
    // >= 5 words: prevents flushing ultra-short clauses as their own sentence chunk,
    // which would produce orphan fragments too small for useful semantic search.
    if (isBoundary && cur.length >= 5) {
      sentences.push({ text: cur.map(w => w.text).join(' '), words: [...cur] })
      cur = []
    }
  }
  if (cur.length > 0) {
    // Append tiny trailing fragments (< 3 words) to the last sentence rather than
    // dropping them — avoids silent data loss for short clause-endings.
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

// ── Chunking constants ───────────────────────────────────────────────────
const CHUNK_TARGET_WORDS  = 100
// Words carried forward from end of one chunk into start of the next.
const CHUNK_OVERLAP_WORDS = 25

// ── Chunking: Recursive ─────────────────────────────────────────────────
// Accumulates paragraphs up to targetWords. If a paragraph exceeds the
// target it's split into sentences; sentences that still exceed are split
// by words. Merges adjacent small units to avoid orphan fragments.
// Best for general Q&A with balanced precision and context.
function chunkRecursive(pages, targetWords = 100, overlapWords = CHUNK_OVERLAP_WORDS) {
  const result = []
  for (const page of pages) {
    const paragraphs = page.rawWords?.length
      ? groupIntoParagraphs(page.rawWords)
      : (page.chunks ?? [])

    let acc = [], accT = 0
    // carry=true: keep last overlapWords as seed for next chunk (mid-page flush)
    // carry=false: fully reset (end-of-page flush — no cross-page overlap)
    const flushAcc = (carry = true) => {
      if (!acc.length) return
      result.push({ pageNum: page.pageNum, text: acc.map(w => w.text).join(' '), bbox: _bboxFromWords(acc), lineRects: _lineRectsFromWords(acc), sourceWords: acc })
      if (carry && overlapWords > 0 && acc.length > overlapWords) {
        const tail = acc.slice(-overlapWords)
        acc = tail; accT = tail.length
      } else {
        acc = []; accT = 0
      }
    }

    for (const para of paragraphs) {
      const paraWords = para.sourceWords ?? []
      const t = countWords(para.text)

      if (t <= targetWords) {
        if (accT > 0 && accT + t > targetWords) flushAcc()
        if (paraWords.length) {
          acc.push(...paraWords)
        } else {
          // No sourceWords (old extraction format) — synthesize word objects so text
          // is preserved in the chunk. Coords are zero so bbox will be null, but the
          // text content is not lost.
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
    flushAcc(false)  // end of page — no cross-page overlap
  }
  return result
}

// ── Chunking shared helpers ──────────────────────────────────────────────────
// CHUNK_TARGET_WORDS and CHUNK_OVERLAP_WORDS are defined above chunkRecursive.

// Map rawChunks (output of chunkRecursive) back onto rawPages, producing pages
// where each page.chunks is the array of semantic chunks for that page.
// Keeping this separate from applyChunkStrategy lets handleIndexDocument reuse
// the same rawChunks array for both the display update and the embed payload
// without running chunkRecursive twice.
function buildChunkedPages(rawPages, rawChunks) {
  const byPage = new Map()
  for (const c of rawChunks) {
    if (!byPage.has(c.pageNum)) byPage.set(c.pageNum, [])
    byPage.get(c.pageNum).push(c)
  }
  return rawPages.map(p => ({ ...p, chunks: byPage.get(p.pageNum) ?? [] }))
}

// Convenience wrapper: chunk raw pages and return display-ready pages in one call.
// Used by reloadChunksOnly and the doc-change effect where rawChunks are not needed
// separately. Do NOT call this from handleIndexDocument — it needs rawChunks separately.
function applyChunkStrategy(rawPages) {
  return buildChunkedPages(rawPages, chunkRecursive(rawPages, CHUNK_TARGET_WORDS))
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

// ── Workspace settings helpers ──────────────────────────────────────────────
const WS_SETTINGS_KEY = 'textbot-model-settings'
function _loadWsSettings() {
  try { return JSON.parse(localStorage.getItem(WS_SETTINGS_KEY) || '{}') } catch { return {} }
}
function _saveWsSettings(obj) {
  localStorage.setItem(WS_SETTINGS_KEY, JSON.stringify(obj))
}

function WorkspaceModal({ onClose }) {
  const [ollamaModels, setOllamaModels] = useState([])
  const [genModel,     setGenModel]     = useState('')
  const [embedModel,   setEmbedModel]   = useState('')
  const [embedBackend, setEmbedBackend] = useState('ollama')
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  const [lawStatus,     setLawStatus]     = useState(null)
  const [lawVersions,   setLawVersions]   = useState([])
  const [lawUploadFile, setLawUploadFile] = useState(null)
  const [lawUploading,  setLawUploading]  = useState(false)
  const [lawImportMsg,  setLawImportMsg]  = useState(null)
  const [lawDragOver,   setLawDragOver]   = useState(false)
  const lawFileInputRef = useRef(null)

  const refreshLawStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/caselaw/status').then(r => r.json())
      setLawStatus(d)
      const versions = []
      if (d.activeFile) versions.push(d.activeFile)
      if (Array.isArray(d.backups)) versions.push(...d.backups)
      setLawVersions(versions)
    } catch {
      setLawStatus({ available: false, message: 'Server unreachable' })
    }
  }, [])

  const handleLawDbDrop = useCallback((e) => {
    e.preventDefault?.()
    setLawDragOver(false)
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.db')) { setLawImportMsg({ type: 'err', text: 'Only .db files are accepted' }); return }
    setLawUploadFile(file)
    setLawImportMsg(null)
  }, [])

  const handleLawSwap = useCallback(async () => {
    if (!lawUploadFile || lawUploading) return
    setLawUploading(true)
    setLawImportMsg(null)
    try {
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
      await refreshLawStatus()
    } catch (err) {
      setLawImportMsg({ type: 'err', text: err.message })
    } finally {
      setLawUploading(false)
    }
  }, [lawUploadFile, lawUploading, refreshLawStatus])

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => {
      setGenModel(d.genModel || '')
      setEmbedModel(d.embedModel || '')
      setEmbedBackend(d.embedBackend || 'ollama')
      const local = _loadWsSettings()
      if (local.genModel) setGenModel(local.genModel)
    }).catch(() => {
      setGenModel(_loadWsSettings().genModel || '')
    })
    fetch('/api/ollama/api/tags').then(r => r.json()).then(d => {
      setOllamaModels((d.models || []).map(m => m.name).filter(Boolean))
    }).catch(() => {})
    refreshLawStatus()
  }, [refreshLawStatus])

  const handleSave = async () => {
    setSaving(true)
    _saveWsSettings({ ..._loadWsSettings(), genModel })
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genModel, embedModel }),
      })
    } catch {}
    setSaving(false)
    setSaved(true)
    setTimeout(() => { setSaved(false); onClose() }, 800)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Workspace</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <label className="settings-label">
              Generative Model
              <span className="settings-hint">default model for chat and summaries (agents override per-agent in Tools tab)</span>
            </label>
            {ollamaModels.length > 0 && (
              <select className="settings-select" value={genModel} onChange={e => setGenModel(e.target.value)}>
                <option value="">— select model —</option>
                {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <input className="settings-input" placeholder="e.g. gemma3n:e2b or qwen2.5:7b" value={genModel} onChange={e => setGenModel(e.target.value)} />
          </div>
          <div className="settings-section">
            <label className="settings-label">
              Embedding Model
              <span className="settings-hint">{embedBackend} · used for document search indexing</span>
            </label>
            {ollamaModels.length > 0 && (
              <select className="settings-select" value={embedModel} onChange={e => setEmbedModel(e.target.value)}>
                <option value="">— select model —</option>
                {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <input className="settings-input" placeholder="e.g. nomic-embed-text:latest" value={embedModel} onChange={e => setEmbedModel(e.target.value)} />
            <p className="settings-warn">⚠ Changing the embedding model requires re-indexing all documents.</p>
          </div>
          <div className="settings-section">
            <label className="settings-label">
              Caselaw Database
              <span className="settings-hint">SQLite .db corpus for offline legal search</span>
            </label>
            <div className="settings-law-status">
              {lawStatus?.available ? (
                <>
                  <span className="settings-law-badge settings-law-badge--ok">Active</span>
                  <span className="settings-law-meta">
                    {lawStatus.rows?.toLocaleString()} entries · {lawStatus.model} · dim {lawStatus.embeddingDim}
                    {lawStatus.lastSwapped ? ` · Updated ${new Date(lawStatus.lastSwapped).toLocaleDateString()}` : ''}
                  </span>
                </>
              ) : (
                <>
                  <span className="settings-law-badge settings-law-badge--none">No corpus</span>
                  <span className="settings-law-meta">{lawStatus?.message || 'No database loaded'}</span>
                </>
              )}
            </div>
            <div
              className={`settings-law-drop${lawDragOver ? ' settings-law-drop--over' : ''}${lawUploadFile ? ' settings-law-drop--staged' : ''}`}
              onDragOver={e => { e.preventDefault(); setLawDragOver(true) }}
              onDragLeave={() => setLawDragOver(false)}
              onDrop={handleLawDbDrop}
              onClick={() => !lawUploadFile && lawFileInputRef.current?.click()}
            >
              <input ref={lawFileInputRef} type="file" accept=".db" style={{ display: 'none' }} onChange={e => handleLawDbDrop({ target: e.target })} />
              {lawUploadFile ? (
                <>
                  <span>📦 {lawUploadFile.name}</span>
                  <span className="settings-law-drop-size">({(lawUploadFile.size / 1024 / 1024).toFixed(1)} MB)</span>
                  <button className="settings-law-drop-clear" onClick={e => { e.stopPropagation(); setLawUploadFile(null); setLawImportMsg(null) }}>× Clear</button>
                </>
              ) : (
                <span>⚖ Drop a <strong>.db</strong> file here or click to browse</span>
              )}
            </div>
            {lawImportMsg && (
              <p className={`settings-law-msg settings-law-msg--${lawImportMsg.type}`}>
                {lawImportMsg.type === 'ok' ? '✓ ' : '✗ '}{lawImportMsg.text}
              </p>
            )}
            {lawUploadFile && (
              <button className="settings-law-activate-btn" onClick={handleLawSwap} disabled={lawUploading}>
                {lawUploading ? 'Uploading & validating…' : 'Validate & activate corpus'}
              </button>
            )}
            {lawVersions.length > 0 && (
              <div className="settings-law-versions">
                <span className="settings-law-versions-label">Backup versions</span>
                {lawVersions.map((v, i) => (
                  <div key={v} className="settings-law-version-row">
                    <span>{v}</span>
                    {i === 0 && <span className="settings-law-version-active">active</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="settings-footer">
          <button className="settings-cancel" onClick={onClose}>Cancel</button>
          <button className="settings-save" onClick={handleSave} disabled={saving || saved}>
            {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PDFApp({ folder, caseId, caseName, onBack, onAddFiles }) {
  const { theme, toggleTheme } = useTheme()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
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
  const docChunkCountsByIdRef = useRef(docChunkCountsById)
  useEffect(() => { docChunkCountsByIdRef.current = docChunkCountsById }, [docChunkCountsById])
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

  // ── Unified chunk selection — single entry point for all four panels ───
  // Calling selectChunk updates: PDF highlight, chunk panel card, notes panel
  // scroll+highlight, and the reverse-active [n] badge in chat — all in one
  // synchronous React batch, so the panels stay in sync regardless of which
  // panel the user interacted with.
  const selectChunk = useCallback(({ pageNum, pageLocalIdx, text, bbox, lineRects }) => {
    const chunkKey = `${pageNum}-${pageLocalIdx}`

    // 1. PDF highlight + scroll
    setActiveCitations(new Map([[1, { text, page_num: pageNum, bbox, lineRects, pageLocalIdx }]]))
    scrollBboxIntoView(pageNum, lineRects ?? bbox)

    // 2. Chunk panel
    setActiveChunkKey(chunkKey)
    setExtractedTextOpen(true)

    // 3. Notes panel
    setActiveNoteChunkKey(chunkKey)

    // 4. Chat [n] reverse lookup — find if any [n] in the last assistant
    //    message maps to this chunk; if so, light up that badge.
    const msgs = latestChatMsgsRef.current
    const lastCited = [...msgs].reverse().find(m => m.role === 'assistant' && m.citations?.size)
    let matched = null
    if (lastCited?.citations) {
      for (const [n, c] of lastCited.citations) {
        if (c.page_num === pageNum && (c.pageLocalIdx === pageLocalIdx ||
            (c.pageLocalIdx == null && c.text?.slice(0, 40) === text?.slice(0, 40)))) {
          matched = n
          break
        }
      }
    }
    setActiveCitationNum(matched)
  }, [scrollBboxIntoView]) // latestChatMsgsRef is a ref — no dep needed

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
      reloadChunksAttemptedRef.current = null
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
              const ck = `${pageNum}-${chunkIdx}`
              setActiveChunkKey(ck)
              setActiveNoteChunkKey(ck)
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
  // Guards the recovery effect from looping: tracks the last docId+ragStatus combo that triggered reloadChunksOnly
  const reloadChunksAttemptedRef = useRef(null)

  // ── RAG state ──
  const [ragStatus, setRagStatus] = useState(null)   // null | 'indexing' | 'indexed' | 'failed'
  const [ragStatusChecked, setRagStatusChecked] = useState(false) // true once getDocRagStatus resolves for activeDoc
  const [ragProgress, setRagProgress] = useState('')

  // CHUNK_TARGET_WORDS is defined at module scope (above the component).
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

  // Persistence effects for chunk counts — must be after their declarations (TDZ)
  useEffect(() => {
    if (caseId) localStorage.setItem(`pdf-chunkcounts-${caseId}`, JSON.stringify(docChunkCountsById))
  }, [docChunkCountsById, caseId])

  // Batch-fetch chunk counts for ALL docs in the case on case load — single DB round-trip.
  // Merges into docChunkCountsById (localStorage values stay for docs not yet in DB).
  useEffect(() => {
    if (!caseId) return
    getCaseRagStatus(caseId).then(counts => {
      if (!counts || !Object.keys(counts).length) return
      setDocChunkCountsById(prev => ({ ...prev, ...counts }))
    }).catch(() => {})
  }, [caseId])

  // ── Evidence (starred sources + notes → report) ──
  const [starredSources, setStarredSources] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`starred-${caseId || 'solo'}`) || '[]') } catch { return [] }
  })
  const [allCaseNotes, setAllCaseNotes] = useState({}) // { [docId]: NoteObject[] }
  const [rightTab, setRightTab] = useState('chat') // 'chat' | 'notes' | 'aide'
  const [notesCollapsed, setNotesCollapsed] = useState({}) // { 'section:starred'|'party:id'|'doc:id'|'note-exp:id': bool }
  const [editingNoteId, setEditingNoteId] = useState(null)
  const [editingNoteDraft, setEditingNoteDraft] = useState('')
  // ── Aide state ──
  const [activeAgentId, setActiveAgentId] = useState(null) // null = agent list, string = modal open
  const [aideTask,   setAideTask]   = useState('')
  const [aideIntent, setAideIntent] = useState('')
  const [aideRole,   setAideRole]   = useState('')
  const [aideJobId,  setAideJobId]  = useState(null)
  const [aideSteps,  setAideSteps]  = useState([])
  const [aideStatus, setAideStatus] = useState('idle') // 'idle'|'running'|'done'|'error'|'cancelled'
  const [aideResult, setAideResult] = useState(null)
  const aideEsRef = useRef(null)

  // ── Aide Soul / Memory ────────────────────────────────────────────────────
  const [aideSoulTab,    setAideSoulTab]    = useState('run') // 'run' | 'identity' | 'skills' | 'tools' | 'rag' | 'audit' | 'memory'
  const [aideSoul,       setAideSoul]       = useState({ skillMd: '', redFlags: '', styleGuide: '', corrections: [], styleSamples: [], toolConfig: { executionMode: 'local', enabledTools: { search_case: true, search_doc: true, search_caselaw: true, add_note: true }, maxSteps: 15, temperature: 0.3 }, docScope: [] })
  const [aideSkillPreview,       setAideSkillPreview]       = useState(false)
  const [aideDiaryClearConfirm,  setAideDiaryClearConfirm]  = useState(false)
  const [aideDiary,      setAideDiary]      = useState([])
  const [aideSoulDirty,  setAideSoulDirty]  = useState(false)
  const [aideSoulSaving, setAideSoulSaving] = useState(false)
  const [aideSoulSavedAt,setAideSoulSavedAt]= useState(null)
  const [aideNewCorrection, setAideNewCorrection] = useState('')
  const [aideDiaryOpen,  setAideDiaryOpen]  = useState(new Set())
  const [aideSkillFileName, setAideSkillFileName] = useState('')
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


  const chatAbortRef = useRef(null)
  const chatMessagesRef    = useRef(null)
  const chunksPanelRef     = useRef(null)
  const notesPanelRef      = useRef(null)
  const latestChatMsgsRef  = useRef([])   // mirror of chatMessages for stable selectChunk closure
  const [activeChunkKey, setActiveChunkKey]         = useState(null)
  const [activeNoteChunkKey, setActiveNoteChunkKey] = useState(null) // "${pageNum}-${localIdx}"
  const [activeCitationNum, setActiveCitationNum]   = useState(null) // which [n] is reverse-active
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

  // Keep stable ref for selectChunk's reverse-citation lookup
  useEffect(() => { latestChatMsgsRef.current = chatMessages }, [chatMessages])

  // Scroll chunk panel to the active card when activeChunkKey changes
  useEffect(() => {
    if (!activeChunkKey || !chunksPanelRef.current) return
    const card = chunksPanelRef.current.querySelector(`[data-chunk-key="${activeChunkKey}"]`)
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeChunkKey])

  // Scroll notes panel to the active chunk group when activeNoteChunkKey changes
  useEffect(() => {
    if (!activeNoteChunkKey || !notesPanelRef.current) return
    const el = notesPanelRef.current.querySelector(`[data-note-chunk-key="${activeNoteChunkKey}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeNoteChunkKey])

  // Reset chat + RAG state when document changes; load persisted chat history
  useEffect(() => {
    // Restore immediately from in-session cache — no async round-trip, no blank flash
    const sessionMsgs = chatByDocRef.current[activeDocumentId] || []
    const sessionLastCited = [...sessionMsgs].reverse().find(m => m.role === 'assistant' && m.citations?.size)
    setChatMessages(sessionMsgs)
    setActiveCitations(sessionLastCited?.citations ?? new Map())
    setActiveChunkKey(null)
    setActiveNoteChunkKey(null)
    setActiveCitationNum(null)
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

    setRagStatusChecked(false)  // reset on every doc switch — must re-confirm before auto-index
    getDocRagStatus(activeDocumentId, { caseId }).then(({ indexed, chunks }) => {
      if (indexed) {
        ragStatusByDocRef.current[activeDocumentId] = 'indexed'
        setRagStatus('indexed')
        setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'indexed' }))
        if (chunks) setDocChunkCountsById(prev => ({ ...prev, [activeDocumentId]: chunks }))
      }
      setRagStatusChecked(true)  // DB has responded — auto-index may now fire if needed
    }).catch(() => { setRagStatusChecked(true) })  // on error, unblock anyway
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
      const results = await searchDocChunks(activeDocumentId, q, 10, { caseId, windowSize: 2 })
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
      body: JSON.stringify({ task: aideTask, intent: aideIntent, role: aideRole, caseId, agentId: activeAgentId, toolConfig: aideSoul.toolConfig }),
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
  }, [aideTask, aideIntent, aideRole, caseId, activeAgentId, aideSoul, setAllCaseNotes])

  const handleAideStop = useCallback(async () => {
    aideEsRef.current?.close()
    aideEsRef.current = null
    if (aideJobId) {
      await fetch(`/api/agent/${aideJobId}`, { method: 'DELETE' }).catch(() => {})
    }
    setAideStatus('cancelled')
  }, [aideJobId])

  // Reset run state and pre-fill task when agent modal opens
  useEffect(() => {
    if (!activeAgentId) return
    const agent = AGENTS.find(a => a.id === activeAgentId)
    setAideTask(agent?.defaultTask ?? '')
    setAideSteps([])
    setAideStatus('idle')
    setAideResult(null)
    setAideSoulTab('run')
  }, [activeAgentId])

  // Load soul + diary whenever the case or active agent changes
  useEffect(() => {
    if (!caseId || !activeAgentId) return
    const agentParam = `?agentId=${encodeURIComponent(activeAgentId)}`
    fetch(`/api/cases/${caseId}/aide/soul${agentParam}`).then(r => r.json()).then(d => {
      setAideSoul(d.soul || { skillMd: '', redFlags: '', styleGuide: '', corrections: [], styleSamples: [], toolConfig: { executionMode: 'local', enabledTools: { search_case: true, search_doc: true, search_caselaw: true, add_note: true }, maxSteps: 15, temperature: 0.3 }, docScope: [] })
      setAideSoulDirty(false)
      setAideSoulSavedAt(d.savedAt || null)
    }).catch(() => {})
    fetch(`/api/cases/${caseId}/aide/diary${agentParam}`).then(r => r.json()).then(d => {
      setAideDiary(Array.isArray(d) ? d : [])
    }).catch(() => {})
  }, [caseId, activeAgentId])

  const handleAideSoulSave = useCallback(async () => {
    if (!caseId || aideSoulSaving) return
    setAideSoulSaving(true)
    try {
      const agentParam = activeAgentId ? `?agentId=${encodeURIComponent(activeAgentId)}` : ''
      const res = await fetch(`/api/cases/${caseId}/aide/soul${agentParam}`, {
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
  }, [caseId, activeAgentId, aideSoul, aideSoulSaving])

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

  const aideAuditData = useMemo(() => {
    const s = aideSoul
    const tc = s.toolConfig || {}
    const enabledToolNames = Object.entries(tc.enabledTools || {}).filter(([,v]) => v !== false).map(([k]) => k)
    const tok = t => Math.round((t?.length || 0) / 4)
    const breakdown = {
      'Skill / Persona': tok(s.skillMd),
      'Standing checklist': tok(s.redFlags),
      'Style guide': tok(s.styleGuide),
      'Example outputs': tok((s.styleSamples || []).map(x => x.text).join('\n')),
      'Corrections': tok((s.corrections || []).map(c => c.text).join('\n')),
      'Session diary (last 3)': tok(aideDiary.slice(0, 3).map(e => (e.task || '') + (e.reflection || '')).join('\n')),
    }
    const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
    const parts = [
      s.skillMd?.trim() || 'You are a professional document analyst with access to tools that search case documents.',
      s.redFlags?.trim()    ? `## Standing Checklist\n${s.redFlags}` : '',
      s.styleGuide?.trim()  ? `## Writing Style\n${s.styleGuide}` : '',
      s.styleSamples?.length ? `## Example Outputs\n${s.styleSamples.map(x => x.text).filter(Boolean).join('\n---\n')}` : '',
      s.corrections?.length  ? `## Corrections\n${s.corrections.map(c => `- ${c.text || c}`).join('\n')}` : '',
      `[Tools: ${enabledToolNames.join(', ') || 'none'} | Max steps: ${tc.maxSteps || 15} | Temp: ${(tc.temperature ?? 0.3).toFixed(2)} | Mode: ${tc.executionMode || 'local'}]`,
    ]
    return { breakdown, total, systemPrompt: parts.filter(Boolean).join('\n\n') }
  }, [aideSoul, aideDiary])



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

    // ── /embed command — store text directly as a RAG chunk ──────────────
    if (text.startsWith('/embed ')) {
      const content = text.slice(7).trim()
      if (!content) return
      setChatInput('')
      const noteId = crypto.randomUUID()
      setChatMessages(prev => [...prev, { role: 'system-note', id: noteId, content: `Embedding…` }])
      try {
        await embedManualNote(content, { caseId })
        setChatMessages(prev => prev.map(m => m.id === noteId
          ? { ...m, content: `Note embedded: "${content.slice(0, 120)}${content.length > 120 ? '…' : ''}"` }
          : m))
      } catch (err) {
        setChatMessages(prev => prev.map(m => m.id === noteId
          ? { ...m, content: `Embed failed: ${err.message}` }
          : m))
      }
      return
    }

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
    if ((ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId] || (caseSearchActive && caseId)) && activeDocumentId) {
      const cacheKey = `${caseSearchActive ? `case:${caseId}` : `doc:${activeDocumentId}`}::${text}`
      let rawChunks = ragQueryCacheRef.current.get(cacheKey)
      if (!rawChunks) {
        rawChunks = caseSearchActive && caseId
          ? await searchCaseChunks(caseId, text, 5)
          : await searchDocChunks(activeDocumentId, text, 3, { caseId, windowSize: 2 })
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
    const citationRule = ragContext
      ? `\n\nCITATION RULES (mandatory):\n- Every factual claim MUST end with an inline citation like [1] or [2].\n- Use the number from the Evidence list above.\n- Never write a sentence about the document without citing it.\n- If multiple sources support a claim, cite all: [1][2].\n- Example: "Members must pay an entrance fee [1]. The fee is reviewed annually [2]."`
      : ''
    const systemPrompt = `You are LexChat, a legal AI assistant. Analyze documents and answer legal questions precisely. Not a substitute for qualified legal counsel.${docContext}${citationRule}`

    // Keep only the last 6 messages (3 exchanges) to limit context growth
    const recentHistory = chatMessages.slice(-6)
    // Append a citation reminder to the user message when RAG context is active.
    // Small local LLMs respond far better to instructions in the last user turn than in system.
    const userMsgWithReminder = ragContext
      ? { ...userMsg, content: userMsg.content + '\n\n(Remember: cite every claim with [1], [2], etc.)' }
      : userMsg
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      userMsgWithReminder,
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

      // Parse which [n] citations the LLM used, then enrich with live bbox + pageLocalIdx
      let msgCitations = parseCitations(accumulated_final, chunkMap)
      if (msgCitations.size) {
        const cachedPages = lastExtractionPagesRef.current?.docId === activeDocumentId
          ? lastExtractionPagesRef.current.pages : null
        // Enrich first: replaces stale SQLite bbox with live coords + page-local idx + lineRects
        msgCitations = enrichCitationsWithLiveData(msgCitations, cachedPages)
        // Then narrow to sentence-level bbox where possible (now uses correct pageLocalIdx)
        msgCitations = narrowCitations(msgCitations, accumulated_final, cachedPages)
      }
      const assistantMsg = msgCitations.size
        ? { id: assistantId, role: 'assistant', content: accumulated_final, citations: msgCitations }
        : { id: assistantId, role: 'assistant', content: accumulated_final }

      finalMessages = [...finalMessages.slice(0, -1), assistantMsg]
      setChatMessages(prev => [...prev.slice(0, -1), assistantMsg])
      if (msgCitations.size) { setActiveCitations(msgCitations); setActiveCitationNum(null) }

      // Persist chat history (case mode only)
      if (caseId) saveChatHistory(activeDocumentId, finalMessages, { caseId }).catch(() => {})

      addLog('LexChat response received', 'ok')
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
  }, [chatInput, chatLoading, chatMessages, ragStatus, docChunkCountsById, activeDocumentId, caseSearchActive, caseId, parties, addLog])
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
        setDocChunkCountsById(prev => ({ ...prev, [activeDocumentId]: 0 }))
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
        diag(`handleIndexDocument: using cached pages (${cached.pages.length} pages)`)
        pages = cached.pages
      } else {
        diag(`handleIndexDocument: no cached pages — falling back to native extractPageChunksFromPDF (NO OCR)`)
        const pdf = pdfDocRef.current
        setRagProgress('Extracting text with coordinates…')
        pages = await extractPageChunksFromPDF(pdf, { onStatus: setRagProgress })
      }
      diag(`handleIndexDocument: pages=${pages.length} totalRawWords=${pages.reduce((s,p)=>(s+(p.rawWords?.length||0)),0)} totalChunks=${pages.reduce((s,p)=>(s+(p.chunks?.length||0)),0)}`)

      // If fallback native extraction produced 0 words across all pages, the PDF is likely
      // scanned. Abort early — indexing 0 chunks silently marks the doc as indexed and makes
      // the chunk panel appear empty with no indication of why.
      if (!hasCachedPages) {
        const totalWords = pages.reduce((s, p) => s + (p.rawWords?.length || 0) + (p.chunks?.length || 0), 0)
        if (totalWords === 0) {
          throw new Error('No text found — this PDF may be scanned. Run extraction (OCR) first, then index.')
        }
      }

      // Step 4 — chunk using recursive strategy (paragraph → sentence → word, ~100 words)
      const rawChunks = chunkRecursive(pages, CHUNK_TARGET_WORDS)
      diag(`chunkRecursive produced ${rawChunks.length} chunks`)
      const allChunks = rawChunks.map((c, idx) => ({
        pageNum: c.pageNum,
        chunkIdx: idx,
        text: c.text,
        bbox: c.bbox,
      }))

      // Update the chunk panel to reflect the new strategy chunks.
      // buildChunkedPages reuses rawChunks already in hand — no second chunkRecursive call.
      // lastExtractionPagesRef is intentionally NOT updated here: it must hold raw page data
      // (paragraphs/words) so future calls to chunkRecursive get clean input. Writing semantic
      // chunks into the ref would cause double-chunking on the next reloadChunksOnly call.
      setExtractedPages(prev => buildChunkedPages(prev ?? pages, rawChunks))

      // Step 5 — embed + store in batches (server skips unchanged hashes)
      // Update sidebar chunk count after each batch so the user sees real-time progress.
      const BATCH = 10
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH)
        setRagProgress(`Embedding chunks ${i + 1}–${Math.min(i + BATCH, allChunks.length)} / ${allChunks.length}…`)
        await indexDocPages(activeDocumentId, batch, { caseId })
        setDocChunkCountsById(prev => ({ ...prev, [activeDocumentId]: i + batch.length }))
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
  }, [activeDocumentId, caseId, addLog])

  // Lightweight chunk reload — display-only, never re-embeds.
  // Used by: recovery effect + manual "Reload chunks" button.
  // Path 1: try server extraction cache → apply strategy → set extractedPages.
  // Path 2: if cache missing, re-extract from the main-thread pdfDoc → apply strategy.
  // Embeddings are NOT touched (they already exist in SQLite).
  const reloadChunksOnly = useCallback(async () => {
    if (!activeDocumentId) return
    // Path 1: try server extraction cache → apply strategy → set extractedPages.
    try {
      const saved = await loadExtraction(activeDocumentId, { caseId })
      if (saved?.pages?.length) {
        const pages = applyChunkStrategy(saved.pages)
        setExtractedPages(pages)
        lastExtractionPagesRef.current = { docId: activeDocumentId, pages: saved.pages }
        return
      }
    } catch { /* fall through to Path 2 */ }
    // Path 2: cache missing — re-extract from the main-thread PDF (display-only, no save,
    // no re-embed). Gated on knownIndexed so this never triggers auto-index on unindexed docs
    // (auto-index guards on ragStatus===null which is false for indexed docs).
    const knownIndexed = ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId]
    if (!knownIndexed || !pdfDocRef.current) return
    try {
      const rawPages = await extractPageChunksFromPDF(pdfDocRef.current)
      // Only update if there's actual text — scanned PDFs return 0 words from native extraction
      if (rawPages?.some(p => p.chunks?.length > 0)) {
        const pages = applyChunkStrategy(rawPages)
        setExtractedPages(pages)
        lastExtractionPagesRef.current = { docId: activeDocumentId, pages: rawPages }
      }
    } catch { /* silently fail — PDF might be a scan or not yet loaded */ }
  }, [activeDocumentId, caseId, ragStatus, docChunkCountsById]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // Fix A: keep sidebar chunk count in sync with the display count whenever extractedPages
  // changes. Without this, docChunkCountsById holds the SQLite count from the last indexing
  // run (possibly with an old strategy), while the chunk panel shows the current display count.
  useEffect(() => {
    if (!activeDocumentId || !extractedPages || prevCachedExtDocIdRef.current !== activeDocumentId) return
    const count = extractedPages.reduce((s, p) => s + (p.chunks?.length ?? 0), 0)
    if (count > 0) {
      setDocChunkCountsById(prev =>
        prev[activeDocumentId] === count ? prev : { ...prev, [activeDocumentId]: count }
      )
    }
  }, [extractedPages, activeDocumentId])

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
        // If SQLite has no chunks (bad prior index), reset ragStatus so auto-index can re-fire
        setRagStatus(prev => (prev === 'indexed' || prev === 'failed') && !(docChunkCountsByIdRef.current[docId] > 0) ? null : prev)
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
    // Only proceed if extraction actually produced pages for this doc
    const cached = lastExtractionPagesRef.current
    if (cached?.docId !== docId || !cached?.pages?.length) return
    await handleIndexDocument({ forceClear: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On document change: load from cache if available (user manually starts extraction otherwise)
  useEffect(() => {
    if (!activeDocumentId) return
    let cancelled = false
    loadExtraction(activeDocumentId, { caseId }).then(saved => {
      if (cancelled) return
      if (saved?.text && saved?.pages?.length) {
        setExtractedText(saved.text)
        extractedTextRef.current = saved.text
        setExtractionSource(saved.isOcr ? 'ocr' : 'text')
        setDocStatuses(prev => ({ ...prev, [activeDocumentId]: 'extracted' }))
        if (saved.pages) {
          // Always apply semantic chunking for display — this is pure presentation and must
          // NOT be gated on ragStatusByDocRef. Gating caused a race where loadExtraction
          // resolved before getDocRagStatus, leaving raw paragraphs in extractedPages and
          // blocking the recovery effect (which checks !extractedPages).
          // lastExtractionPagesRef always stores raw saved.pages so chunkRecursive gets
          // clean paragraph input on future calls.
          const pages = applyChunkStrategy(saved.pages)
          setExtractedPages(pages)
          lastExtractionPagesRef.current = { docId: activeDocumentId, pages: saved.pages }
        }
      } else if (saved) {
        // Stale cache (no text or no pages) — delete it so next manual run starts fresh
        const url = caseId
          ? `/api/cases/${encodeURIComponent(caseId)}/extractions/${activeDocumentId}`
          : `/api/extractions/${activeDocumentId}`
        fetch(url, { method: 'DELETE' }).catch(() => {})
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [activeDocumentId, caseId])

  // Auto-index for RAG after extraction completes.
  // Guards:
  //  ragStatusChecked — getDocRagStatus has resolved for this doc, so ragStatus is authoritative.
  //                     Without this, a reloadChunksOnly call that sets extractedPages before the
  //                     DB check returns would incorrectly trigger a full re-embed.
  //  !knownIndexed   — localStorage cache confirms doc was never indexed in any prior session.
  //  ragStatus===null — DB confirmed it is not already indexed this session.
  //  !extractingText  — Fix B: extraction is complete. Partial pages from onPartialResult must
  //                     not trigger indexing; only the full result (which sets extractingText=false)
  //                     should start the embed. lastExtractionPagesRef is also only authoritative
  //                     after extraction finishes.
  useEffect(() => {
    const cached = lastExtractionPagesRef.current
    const hasCachedPages = cached?.docId === activeDocumentId && cached?.pages
    // Once DB has confirmed status (ragStatusChecked=true), trust ragStatus over localStorage.
    // ragStatus=null means DB has no chunks — treat as not indexed regardless of localStorage.
    const knownIndexed = ragStatusChecked ? false : !!docChunkCountsById[activeDocumentId]
    diag(`auto-index check: extractedPages=${!!extractedPages} ragStatusChecked=${ragStatusChecked} ragStatus=${ragStatus} knownIndexed=${knownIndexed} extractingText=${extractingText} hasCachedPages=${!!hasCachedPages} hasPdfDoc=${!!pdfDocRef.current}`)
    if (extractedPages && ragStatusChecked && ragStatus === null && !knownIndexed && !extractingText && activeDocumentId && (hasCachedPages || pdfDocRef.current)) {
      diag(`auto-index FIRING`)
      handleIndexDocument()
    }
  }, [extractedPages, ragStatus, ragStatusChecked, extractingText, activeDocumentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Recovery: doc is confirmed indexed in SQLite but extraction cache is missing (extractedPages
  // still null after loadExtraction returned nothing). Re-extract from the loaded PDF so the Text
  // Chunks panel shows content. Uses pdfMainThreadReady (state) so the effect reliably re-fires
  // once the main-thread pdfDoc is available — pageCount alone isn't enough because the render
  // worker sends 'ready' before the main-thread pdfjsLib.getDocument() promise resolves.
  // forceClear:false keeps existing embeddings; server re-upserts unchanged chunks harmlessly.
  useEffect(() => {
    // Fire when: doc is known to be indexed but no chunks are displayed yet.
    // "Known indexed" = ragStatus confirmed from DB OR docChunkCountsById has a cached count
    // (localStorage-persisted from a prior session — available immediately on doc select).
    // pdfMainThreadReady is NOT a gate — Path 1 (server cache) works without the PDF loaded.
    // It IS a dep so the effect re-fires when the PDF loads, allowing Path 2 fallback if needed.
    const chunkCount = extractedPages?.reduce((s, p) => s + (p.chunks?.length ?? 0), 0) ?? 0
    const knownIndexed = ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId]
    if (!knownIndexed || chunkCount > 0 || !activeDocumentId) return
    // Guard: only attempt once per docId+ragStatus combination to prevent infinite loops
    // when the server cache has 0 chunks (e.g. bad prior index). Reset when doc or status changes.
    const attemptKey = `${activeDocumentId}:${ragStatus}`
    if (reloadChunksAttemptedRef.current === attemptKey) return
    reloadChunksAttemptedRef.current = attemptKey
    reloadChunksOnly()
  }, [ragStatus, extractedPages, activeDocumentId, pdfMainThreadReady, docChunkCountsById]) // eslint-disable-line react-hooks/exhaustive-deps

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
                className={`pdfapp-citation-chip${displayCitations.has(token) ? ' pdfapp-citation-chip--active' : ''}${activeCitationNum === token ? ' pdfapp-citation-chip--current' : ''}`}
                title={`Page ${chunk.page_num} — ${chunk.text.slice(0, 120)}${chunk.text.length > 120 ? '…' : ''}`}
                onClick={() => {
                  addLog(`[CLICK] citation chip [${token}] → page ${chunk.page_num}`, 'info')
                  setActiveCitationNum(token)
                  selectChunk({ pageNum: chunk.page_num, pageLocalIdx: chunk.pageLocalIdx, text: chunk.text, bbox: chunk.bbox, lineRects: chunk.lineRects ?? null })
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
                  <button
                    type="button"
                    className="pdfapp-sb-icon-btn"
                    onClick={() => setWorkspaceOpen(true)}
                    title="Workspace settings"
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                </div>

                <span className="pdfapp-sb-case-title" title={caseName || folder?.name}>
                  {caseName || folder?.name || 'Documents'}
                </span>

                <button type="button" className="pdfapp-sb-litigants-btn" onClick={handleAddParty} title="Add folder">
                  <svg viewBox="0 0 100 90" width="22" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    {/* Folder body */}
                    <path d="M8 22 C8 16 12 12 18 12 L38 12 C41 12 43 14 45 17 L49 22 L82 22 C88 22 92 26 92 32 L92 74 C92 80 88 84 82 84 L18 84 C12 84 8 80 8 74 Z" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/>
                    {/* Folder tab */}
                    <path d="M8 22 L8 18 C8 14 11 11 15 11 L36 11 C39 11 41 13 43 16 L48 22" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/>
                    {/* Plus circle */}
                    <circle cx="62" cy="66" r="20" fill="currentColor"/>
                    <line x1="62" y1="56" x2="62" y2="76" stroke="white" strokeWidth="5" strokeLinecap="round"/>
                    <line x1="52" y1="66" x2="72" y2="66" stroke="white" strokeWidth="5" strokeLinecap="round"/>
                  </svg>
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
                  <button type="button" className="pdfapp-sb-litigants-btn" onClick={handleAddParty} title="Add folder">
                    <svg viewBox="0 0 100 90" width="22" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M8 22 C8 16 12 12 18 12 L38 12 C41 12 43 14 45 17 L49 22 L82 22 C88 22 92 26 92 32 L92 74 C92 80 88 84 82 84 L18 84 C12 84 8 80 8 74 Z" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/>
                      <path d="M8 22 L8 18 C8 14 11 11 15 11 L36 11 C39 11 41 13 43 16 L48 22" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/>
                      <circle cx="62" cy="66" r="20" fill="currentColor"/>
                      <line x1="62" y1="56" x2="62" y2="76" stroke="white" strokeWidth="5" strokeLinecap="round"/>
                      <line x1="52" y1="66" x2="72" y2="66" stroke="white" strokeWidth="5" strokeLinecap="round"/>
                    </svg>
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

      {/* ── Panel 2: Center (PDF viewer) ── */}
      <div className="pdfapp-center" style={{ flex: centerFlex }}>
        {(() => {
          const activeDoc = documents.find(d => d.id === activeDocumentId)
          return (
            <div className="pdfapp-center-content">
              <div className="pdfapp-center-header">
                <div className="pdfapp-toolbar-left">
                </div>
                <span className="pdfapp-center-filename" title={activeDoc?.name || ''}>
                  {activeDoc ? (activeDoc.name.length > 50 ? activeDoc.name.slice(0, 50) + '…' : activeDoc.name) : ''}
                </span>
                <div className="pdfapp-toolbar-right">
                  <button
                    className={`pdfapp-toolbar-btn pdfapp-toolbar-btn--thumb${thumbsOpen ? ' pdfapp-toolbar-btn--active' : ''}`}
                    onClick={() => setThumbsOpen(o => !o)}
                    title={thumbsOpen ? 'Hide thumbnails' : 'Show page thumbnails'}
                    style={{ visibility: activeDoc ? 'visible' : 'hidden' }}
                  >
                  </button>
                </div>
              </div>
              {!activeDoc ? (
                <div className="pdfapp-center-placeholder">
                  Select a document from the sidebar
                </div>
              ) : (<>
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
                                  const localIdx = chunk.pageLocalIdx ?? pg.chunks.findIndex(c =>
                                    c.bbox && chunk.bbox &&
                                    Math.abs(c.bbox[0] - chunk.bbox[0]) < 0.005 &&
                                    Math.abs(c.bbox[1] - chunk.bbox[1]) < 0.005
                                  )
                                  if (localIdx < 0) return
                                  const live = pg.chunks[localIdx]
                                  selectChunk({ pageNum: chunk.page_num, pageLocalIdx: localIdx, text: live?.text ?? chunk.text, bbox: live?.bbox ?? chunk.bbox, lineRects: live?.lineRects ?? chunk.lineRects ?? null })
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
                    <span
                      className="pdfapp-chunks-reload-link"
                      onClick={e => { e.stopPropagation(); reloadChunksOnly() }}
                      title="Click to reload chunks from database"
                    >
                      Text Chunks — {
                        extractedPages
                          ? extractedPages.reduce((s, p) => s + p.chunks.length, 0)
                          : (docChunkCountsById[activeDocumentId] ?? 0)
                      } chunks
                    </span>
                    <button
                      className="pdfapp-chunks-refresh-btn"
                      onClick={e => { e.stopPropagation(); reloadChunksOnly() }}
                      title="Force reload chunks from database"
                    >↺</button>
                    {extractionSource && (
                      <span className={`pdfapp-extraction-badge pdfapp-extraction-badge--${extractionSource}`}>
                        {extractionSource === 'ocr' ? 'OCR' : 'Text'}
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
                    {activeDoc?.file && !extractingText && (
                      <button
                        className="pdfapp-action-btn"
                        onClick={() => runExtraction(activeDocumentId, activeDoc.file)}
                        title="Re-extract text (runs OCR on scanned PDFs)"
                      >Re-extract</button>
                    )}
                    {activeDoc?.file && (
                      <button
                        className="pdfapp-action-btn pdfapp-action-btn--chunk"
                        disabled={(() => {
                          if (ragStatus === 'indexing' || extractingText) return true
                          // ragStatus=null after DB check = not indexed; always allow
                          if (ragStatusChecked && ragStatus === null) return false
                          if (ragStatus === 'indexed') return true
                          const storedCount = docChunkCountsById[activeDocumentId] ?? 0
                          return storedCount > 0
                        })()}
                        onClick={() => handleIndexDocument({ forceClear: true })}
                        title={(() => {
                          const storedCount = docChunkCountsById[activeDocumentId] ?? 0
                          if (storedCount === 0) return 'Index document for semantic search'
                          return 'Text already chunked'
                        })()}
                      >Chunk Text</button>
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
                                if (e.target.closest('.pdfapp-chunk-note-btn') || e.target.closest('.pdfapp-chunk-note-area')) return
                                selectChunk({ pageNum: page.pageNum, pageLocalIdx: idx, text: chunk.text, bbox: chunk.bbox, lineRects: chunk.lineRects ?? null })
                              }}
                            >
                              <div className="pdfapp-chunk-meta">
                                <span className="pdfapp-chunk-tag pdfapp-chunk-tag--page">P{page.pageNum}</span>
                                <span className="pdfapp-chunk-tag pdfapp-chunk-tag--idx">#{idx}</span>
                                {score != null && (
                                  <span className="pdfapp-chunk-tag pdfapp-chunk-tag--score">{Math.round(score * 100)}%</span>
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
              </>)}
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

      {/* ── Thumbnails strip (right of center) ── */}
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
                onClick={() => scrollPageIntoView(n, 'start')}
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

      {/* ── Panel 3: Right Workspace ── */}
      <div className="pdfapp-right" style={{ flex: rightFlex }}>
        {/* Tab bar */}
        <div className="pdfapp-right-tabs">
          <button className={`pdfapp-right-tab${rightTab === 'chat' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('chat')}>Query Docs</button>
          <button className={`pdfapp-right-tab${rightTab === 'notes' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('notes')}>
            {(() => {
              const merged = { ...allCaseNotes, ...(activeDocumentId ? { [activeDocumentId]: notes } : {}) }
              const t = Object.values(merged).flat().filter(n => n.text?.trim()).length
              return `Review Notes (${t})`
            })()}
          </button>
          <button className={`pdfapp-right-tab${rightTab === 'aide' ? ' pdfapp-right-tab--active' : ''}`} onClick={() => setRightTab('aide')}>
            Run Agents{aideStatus === 'running' ? ' ⟳' : ''}
          </button>
        </div>

        {/* ── Chat tab ── */}
        {rightTab === 'chat' && <div className="pdfapp-chat">
          <div className="pdfapp-chat-toolbar">
            {caseId && (
              <button
                className={`pdfapp-chat-scope-btn${caseSearchActive ? ' pdfapp-chat-scope-btn--active' : ''}`}
                onClick={() => setCaseSearchActive(v => !v)}
                title={caseSearchActive ? 'Searching entire case — click to limit to active document' : 'Click to search all documents in this case'}
              >
                {caseSearchActive ? 'Searching: entire case' : 'Searching: active doc'}
              </button>
            )}
            {chatMessages.length > 0 && (
              <button
                className="pdfapp-chat-download-btn"
                title="Download chat as .txt"
                onClick={() => {
                  const docName = documents.find(d => d.id === activeDocumentId)?.name || ''
                  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
                  const lines = []
                  lines.push(`Chat Export${docName ? ` — ${docName}` : ''}${caseName ? ` (${caseName})` : ''} — ${dateStr}`)
                  lines.push('='.repeat(60))
                  lines.push('')
                  for (const msg of chatMessages) {
                    if (msg.role === 'user') {
                      lines.push('[You]')
                      lines.push(msg.content)
                    } else {
                      lines.push('[LexChat]')
                      lines.push(msg.content)
                      if (msg.citations?.size > 0) {
                        const srcParts = [...msg.citations.entries()].map(([n, c]) => `[${n}] p.${c.page_num}`)
                        lines.push(`Sources: ${srcParts.join(', ')}`)
                      }
                    }
                    lines.push('')
                    lines.push('—'.repeat(40))
                    lines.push('')
                  }
                  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `chat${docName ? `-${docName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '_').toLowerCase()}` : ''}.txt`
                  a.click()
                  URL.revokeObjectURL(url)
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export
              </button>
            )}
          </div>
          <div className="pdfapp-chat-messages" ref={chatMessagesRef}>
              {chatMessages.length === 0 && (
                <div className="pdfapp-chat-welcome">
                  <div className="pdfapp-chat-welcome-icon">
                    <svg viewBox="0 0 100 100" width="56" height="56" fill="none">
                      {[0,30,60,90,120,150].map(deg => {
                        const r = deg * Math.PI / 180
                        const x1 = 50 + 14 * Math.cos(r), y1 = 50 + 14 * Math.sin(r)
                        const x2 = 50 + 44 * Math.cos(r), y2 = 50 + 44 * Math.sin(r)
                        return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d4846a" strokeWidth="9" strokeLinecap="round"/>
                      })}
                    </svg>
                  </div>
                  <h2 className="pdfapp-chat-welcome-title">LexChat</h2>
                  <p className="pdfapp-chat-welcome-sub">Ask anything about the active document</p>
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
                                className={`pdfapp-source-item${displayCitations.has(n) ? ' pdfapp-source-item--active' : ''}${activeCitationNum === n ? ' pdfapp-source-item--current' : ''}`}
                                onClick={() => {
                                  addLog(`[CLICK] source [${n}] → page ${chunk.page_num}`, 'info')
                                  setActiveCitationNum(n)
                                  selectChunk({ pageNum: chunk.page_num, pageLocalIdx: chunk.pageLocalIdx, text: chunk.text, bbox: chunk.bbox, lineRects: chunk.lineRects ?? null })
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
            <div className="pdfapp-chat-input-row">
              <div className="pdfapp-chat-input-wrap">
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
                    ? <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="8" y="8" width="8" height="8" rx="1.5"/></svg>
                    : <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="6,3 21,12 6,21"/></svg>
                  }
                </button>
              </div>
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

          const downloadNotesMarkdown = () => {
            const lines = []
            const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
            lines.push(`# Notes Export${caseName ? ` — ${caseName}` : ''} — ${dateStr}`)
            lines.push('')

            if (starGroups.length > 0 || unassigned.length > 0) {
              lines.push('## ⭐ Starred Sources')
              lines.push('')
              for (const { party, sources } of starGroups) {
                lines.push(`### ${party.name}`)
                lines.push('')
                for (const s of sources) {
                  lines.push(`**Page ${s.pageNum}** — ${s.docName || ''}${s.score != null ? ` · ${s.score}%` : ''}`)
                  if (s.chunkText) lines.push(`> ${s.chunkText.replace(/\n/g, '\n> ')}`)
                  lines.push('')
                }
              }
              if (unassigned.length > 0) {
                for (const s of unassigned) {
                  lines.push(`**Page ${s.pageNum}**${s.score != null ? ` · ${s.score}%` : ''}`)
                  if (s.chunkText) lines.push(`> ${s.chunkText.replace(/\n/g, '\n> ')}`)
                  lines.push('')
                }
              }
            }

            if (noteGroups.length > 0) {
              lines.push('## 📝 Notes')
              lines.push('')
              for (const { party, docNotes } of noteGroups) {
                lines.push(`### ${party.name}`)
                lines.push('')
                for (const { doc, notes: docNoteList } of docNotes) {
                  lines.push(`#### ${doc.name}`)
                  lines.push('')
                  for (const n of docNoteList) {
                    const noteDateStr = n.createdAt ? new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
                    const metaParts = [`Page ${n.pageNum}`]
                    if (n.chunkIdx != null) metaParts.push(`Chunk ${n.chunkIdx}`)
                    lines.push(`**${metaParts.join(' · ')}**${noteDateStr ? ` — ${noteDateStr}` : ''}`)
                    if (n.chunkText) lines.push(`> ${n.chunkText.replace(/\n/g, '\n> ')}`)
                    lines.push('')
                    lines.push(n.text)
                    lines.push('')
                  }
                }
              }
            }

            const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `notes${caseName ? `-${caseName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}` : ''}.txt`
            a.click()
            URL.revokeObjectURL(url)
          }

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
            if (docId !== activeDocumentId) {
              pendingNavRef.current = { pageNum: n.pageNum, chunkText, bbox, narrowBbox: null, lineRects, chunkIdx: n.chunkIdx }
              setActiveDocumentId(docId)
            } else {
              selectChunk({ pageNum: n.pageNum, pageLocalIdx: n.chunkIdx, text: chunkText, bbox, lineRects })
            }
          }

          // ── Note row renderer ──
          const renderNoteRow = (n, doc) => {
            const isEditing = editingNoteId === n.id
            const dateStr = n.createdAt ? new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
            const navigate = () => n.chunkIdx != null ? goToChunk(doc.id, n) : goToNote(doc.id, n.pageNum)
            const noteChunkKey = n.chunkIdx != null ? `${n.pageNum}-${n.chunkIdx}` : null
            const isActiveChunk = noteChunkKey && activeNoteChunkKey === noteChunkKey && doc.id === activeDocumentId
            return (
              <div key={n.id}
                data-note-chunk-key={noteChunkKey ?? undefined}
                className={`nt-note-row${doc.id !== activeDocumentId ? ' nt-note-row--other' : ''}${isActiveChunk ? ' nt-note-row--active' : ''}`}>
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
            <div className="nt-root" ref={notesPanelRef}>
              {!isEmpty && (
                <div className="nt-toolbar">
                  <button className="nt-download-btn" title="Download notes as Markdown" onClick={downloadNotesMarkdown}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Export
                  </button>
                </div>
              )}
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

        {/* ── Run Agents tab ── */}
        {rightTab === 'aide' && (
          <div className="pdfapp-aide-panel">

          {/* ── Agent list (marketplace) ── */}
          {!activeAgentId && (
            <div className="pdfapp-agents-list">
              <div className="pdfapp-agents-list-header">
                <span className="pdfapp-agents-list-title">Agents</span>
                <span className="pdfapp-agents-list-hint">Select an agent to run</span>
              </div>
              {AGENTS.map(agent => (
                <button key={agent.id} className="pdfapp-agent-card" onClick={() => setActiveAgentId(agent.id)}>
                  <div className="pdfapp-agent-card-icon" style={{ background: agent.color }}>{agent.icon}</div>
                  <div className="pdfapp-agent-card-info">
                    <span className="pdfapp-agent-card-name">{agent.name}</span>
                    <span className="pdfapp-agent-card-tagline">{agent.tagline}</span>
                    <span className="pdfapp-agent-badge">Active</span>
                  </div>
                  <div className="pdfapp-agent-card-meta">
                    <span className="pdfapp-agent-card-meta-arrow">›</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* ── Agent modal (run / soul / memory) ── */}
          {activeAgentId && (() => {
            const agent = AGENTS.find(a => a.id === activeAgentId)
            return (
              <>
                {/* Modal header */}
                <div className="pdfapp-agent-modal-header">
                  <button className="pdfapp-agent-modal-back" onClick={() => { aideEsRef.current?.close(); setActiveAgentId(null) }}>‹ Agents</button>
                  <div className="pdfapp-agent-modal-title-row">
                    <span className="pdfapp-agent-modal-icon" style={{ background: agent.color }}>{agent.icon}</span>
                    <span className="pdfapp-agent-modal-name">{agent.name}</span>
                  </div>
                </div>

                {/* Sub-tab bar */}
                <div className="pdfapp-aide-subtabs">
                  {[
                    { id: 'run',      label: 'Run' },
                    { id: 'identity', label: 'Identity' },
                    { id: 'skills',   label: 'Skills' },
                    { id: 'tools',    label: 'Tools' },
                    { id: 'rag',      label: 'RAG' },
                    { id: 'audit',    label: 'Audit' },
                    { id: 'memory',   label: 'Memory', badge: aideDiary.length > 0 ? aideDiary.length : null },
                  ].map(t => (
                    <button key={t.id} className={`pdfapp-aide-subtab${aideSoulTab === t.id ? ' pdfapp-aide-subtab--active' : ''}`} onClick={() => setAideSoulTab(t.id)}>
                      {t.label}
                      {t.badge && <span className="pdfapp-aide-subtab-badge">{t.badge}</span>}
                    </button>
                  ))}
                </div>
              </>
            )
          })()}

            {/* ── Run / Soul / Memory subtabs — only shown when an agent is selected ── */}
            {activeAgentId && aideSoulTab === 'run' && (<>
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
                        {aideStatus === 'idle' ? 'Run →' : 'Run Again →'}
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

            {/* ── Identity sub-tab ── */}
            {activeAgentId && aideSoulTab === 'identity' && (
              <div className="pdfapp-aide-soul-panel">
                <div className="pdfapp-aide-soul-header">
                  <span className="pdfapp-aide-soul-title">{AGENTS.find(a => a.id === activeAgentId)?.name ?? 'Agent'} — Identity</span>
                  <div className="pdfapp-aide-soul-actions">
                    {aideSoulSavedAt && !aideSoulDirty && (
                      <span className="pdfapp-aide-soul-saved">Saved {new Date(aideSoulSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                    <button
                      className={`pdfapp-aide-soul-save-btn${aideSoulDirty ? ' pdfapp-aide-soul-save-btn--dirty' : ''}`}
                      onClick={handleAideSoulSave}
                      disabled={!aideSoulDirty || aideSoulSaving || !caseId}
                    >
                      {aideSoulSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
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

            {/* ── Skills sub-tab ── */}
            {activeAgentId && aideSoulTab === 'skills' && (
              <div className="pdfapp-aide-soul-panel">
                <div className="pdfapp-aide-soul-header">
                  <span className="pdfapp-aide-soul-title">Skills — Persona &amp; Instruction File</span>
                  <div className="pdfapp-aide-soul-actions">
                    {aideSoul.skillMd && (
                      <button className="pdfapp-aide-skill-preview-toggle" onClick={() => setAideSkillPreview(p => !p)}>
                        {aideSkillPreview ? 'Edit' : 'Preview'}
                      </button>
                    )}
                    {aideSoulSavedAt && !aideSoulDirty && (
                      <span className="pdfapp-aide-soul-saved">Saved {new Date(aideSoulSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                    <button
                      className={`pdfapp-aide-soul-save-btn${aideSoulDirty ? ' pdfapp-aide-soul-save-btn--dirty' : ''}`}
                      onClick={handleAideSoulSave}
                      disabled={!aideSoulDirty || aideSoulSaving || !caseId}
                    >
                      {aideSoulSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Skill file <span className="pdfapp-aide-soul-hint">(injected as system prompt — defines who this agent is)</span></div>
                  {aideSoul.skillMd && aideSkillPreview ? (
                    <div className="pdfapp-aide-skill-md-preview">{aideSoul.skillMd}</div>
                  ) : aideSoul.skillMd ? (
                    <div className="pdfapp-aide-skill-loaded">
                      <span className="pdfapp-aide-skill-filename">{aideSkillFileName || 'skill.md'}</span>
                      <span className="pdfapp-aide-skill-preview">{aideSoul.skillMd.slice(0, 120)}{aideSoul.skillMd.length > 120 ? '…' : ''}</span>
                      <button className="pdfapp-aide-skill-remove" onClick={() => { patchSoul('skillMd', ''); setAideSkillFileName('') }}>× Remove</button>
                    </div>
                  ) : (
                    <>
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
                      <textarea
                        className="pdfapp-aide-soul-textarea"
                        placeholder="Or paste your skill / persona here…"
                        rows={6}
                        value=""
                        onChange={e => { if (e.target.value) patchSoul('skillMd', e.target.value) }}
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Tools sub-tab ── */}
            {activeAgentId && aideSoulTab === 'tools' && (() => {
              const tc = aideSoul.toolConfig || { executionMode: 'local', enabledTools: { search_case: true, search_doc: true, search_caselaw: true, add_note: true }, maxSteps: 15, temperature: 0.3 }
              const patchTc = (key, val) => patchSoul('toolConfig', { ...tc, [key]: val })
              const patchTool = (toolName, val) => patchTc('enabledTools', { ...tc.enabledTools, [toolName]: val })
              return (
                <div className="pdfapp-aide-soul-panel">
                  <div className="pdfapp-aide-soul-header">
                    <span className="pdfapp-aide-soul-title">Tools &amp; Execution</span>
                    <div className="pdfapp-aide-soul-actions">
                      {aideSoulSavedAt && !aideSoulDirty && (
                        <span className="pdfapp-aide-soul-saved">Saved {new Date(aideSoulSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      <button
                        className={`pdfapp-aide-soul-save-btn${aideSoulDirty ? ' pdfapp-aide-soul-save-btn--dirty' : ''}`}
                        onClick={handleAideSoulSave}
                        disabled={!aideSoulDirty || aideSoulSaving || !caseId}
                      >
                        {aideSoulSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>

                  {/* Execution mode */}
                  <div className="pdfapp-aide-soul-section">
                    <div className="pdfapp-aide-soul-section-label">Execution mode</div>
                    <div className="pdfapp-aide-exec-mode-row">
                      <button
                        className={`pdfapp-aide-exec-btn${tc.executionMode === 'local' ? ' pdfapp-aide-exec-btn--active' : ''}`}
                        onClick={() => patchTc('executionMode', 'local')}
                      >
                        <span className="pdfapp-aide-exec-icon">⚙</span>
                        <div className="pdfapp-aide-exec-info">
                          <span className="pdfapp-aide-exec-label">Local</span>
                          <span className="pdfapp-aide-exec-hint">Runs on your device via Ollama. Private, no internet required.</span>
                        </div>
                      </button>
                      <button
                        className={`pdfapp-aide-exec-btn${tc.executionMode === 'internet' ? ' pdfapp-aide-exec-btn--active' : ''}`}
                        onClick={() => patchTc('executionMode', 'internet')}
                      >
                        <span className="pdfapp-aide-exec-icon">☁</span>
                        <div className="pdfapp-aide-exec-info">
                          <span className="pdfapp-aide-exec-label">Internet</span>
                          <span className="pdfapp-aide-exec-hint">Uses Claude API. Faster, smarter — requires API key.</span>
                        </div>
                      </button>
                    </div>
                    {tc.executionMode === 'local' && (
                      <div className="pdfapp-aide-exec-model-row">
                        <span className="pdfapp-aide-soul-hint">Model:</span>
                        <select className="pdfapp-aide-select" style={{ flex: 1 }} value={tc.localModel || 'qwen2.5:7b'} onChange={e => patchTc('localModel', e.target.value)}>
                          <option value="qwen2.5:3b">qwen2.5:3b (~2 GB RAM)</option>
                          <option value="qwen2.5:7b">qwen2.5:7b (~5 GB RAM)</option>
                          <option value="qwen2.5:14b">qwen2.5:14b (~9 GB RAM)</option>
                          <option value="gemma3n:e2b">gemma3n:e2b (~3 GB RAM)</option>
                        </select>
                      </div>
                    )}
                    {tc.executionMode === 'internet' && (
                      <div className="pdfapp-aide-exec-model-row">
                        <span className="pdfapp-aide-soul-hint">Model:</span>
                        <select className="pdfapp-aide-select" style={{ flex: 1 }} value={tc.internetModel || 'claude-sonnet-4-6'} onChange={e => patchTc('internetModel', e.target.value)}>
                          <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (fast, cheap)</option>
                          <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (balanced)</option>
                          <option value="claude-opus-4-6">Claude Opus 4.6 (most capable)</option>
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Enabled tools */}
                  <div className="pdfapp-aide-soul-section">
                    <div className="pdfapp-aide-soul-section-label">Enabled tools</div>
                    {[
                      { id: 'search_case',    label: 'search_case',    desc: 'Search all documents in the case' },
                      { id: 'search_doc',     label: 'search_doc',     desc: 'Search a specific document by ID' },
                      { id: 'search_caselaw', label: 'search_caselaw', desc: 'Search offline case law database' },
                      { id: 'add_note',       label: 'add_note',       desc: 'Save findings as notes' },
                    ].map(tool => (
                      <label key={tool.id} className="pdfapp-aide-tool-row">
                        <input
                          type="checkbox"
                          className="pdfapp-aide-tool-checkbox"
                          checked={tc.enabledTools?.[tool.id] !== false}
                          onChange={e => patchTool(tool.id, e.target.checked)}
                        />
                        <div className="pdfapp-aide-tool-info">
                          <span className="pdfapp-aide-tool-name">{tool.label}</span>
                          <span className="pdfapp-aide-soul-hint">{tool.desc}</span>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Max steps */}
                  <div className="pdfapp-aide-soul-section">
                    <div className="pdfapp-aide-soul-section-label">Max steps <span className="pdfapp-aide-soul-hint">(tool calls before stopping)</span></div>
                    <div className="pdfapp-aide-slider-row">
                      <input type="range" min={3} max={30} step={1} value={tc.maxSteps || 15}
                        onChange={e => patchTc('maxSteps', Number(e.target.value))}
                        className="pdfapp-aide-slider"
                      />
                      <span className="pdfapp-aide-slider-val">{tc.maxSteps || 15}</span>
                    </div>
                  </div>

                  {/* Temperature */}
                  <div className="pdfapp-aide-soul-section">
                    <div className="pdfapp-aide-soul-section-label">Temperature <span className="pdfapp-aide-soul-hint">(0 = precise, 1 = creative)</span></div>
                    <div className="pdfapp-aide-slider-row">
                      <input type="range" min={0} max={1} step={0.05} value={tc.temperature ?? 0.3}
                        onChange={e => patchTc('temperature', Number(e.target.value))}
                        className="pdfapp-aide-slider"
                      />
                      <span className="pdfapp-aide-slider-val">{(tc.temperature ?? 0.3).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* ── RAG sub-tab ── */}
            {activeAgentId && aideSoulTab === 'rag' && (
              <div className="pdfapp-aide-soul-panel">
                <div className="pdfapp-aide-soul-header">
                  <span className="pdfapp-aide-soul-title">RAG — Document Scope</span>
                  <div className="pdfapp-aide-soul-actions">
                    {aideSoulSavedAt && !aideSoulDirty && (
                      <span className="pdfapp-aide-soul-saved">Saved {new Date(aideSoulSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                    <button
                      className={`pdfapp-aide-soul-save-btn${aideSoulDirty ? ' pdfapp-aide-soul-save-btn--dirty' : ''}`}
                      onClick={handleAideSoulSave}
                      disabled={!aideSoulDirty || aideSoulSaving || !caseId}
                    >
                      {aideSoulSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Search scope <span className="pdfapp-aide-soul-hint">(which documents this agent can search)</span></div>
                  <div className="pdfapp-aide-rag-scope-row">
                    <button
                      className={`pdfapp-aide-rag-scope-btn${!aideSoul.docScope?.length ? ' pdfapp-aide-rag-scope-btn--active' : ''}`}
                      onClick={() => patchSoul('docScope', [])}
                    >
                      All documents
                    </button>
                    <button
                      className={`pdfapp-aide-rag-scope-btn${aideSoul.docScope?.length > 0 ? ' pdfapp-aide-rag-scope-btn--active' : ''}`}
                      onClick={() => { if (!aideSoul.docScope?.length) patchSoul('docScope', ['contract']) }}
                    >
                      Filter by type
                    </button>
                  </div>
                  {aideSoul.docScope?.length > 0 && (
                    <>
                      <div className="pdfapp-aide-soul-hint" style={{ marginTop: 8, marginBottom: 4 }}>Select document types to include:</div>
                      {['contract', 'exhibit', 'statement', 'correspondence', 'pleading', 'order', 'report', 'invoice', 'other'].map(dt => {
                        const checked = aideSoul.docScope?.includes(dt)
                        return (
                          <label key={dt} className="pdfapp-aide-tool-row">
                            <input
                              type="checkbox"
                              className="pdfapp-aide-tool-checkbox"
                              checked={checked}
                              onChange={e => {
                                const next = e.target.checked
                                  ? [...(aideSoul.docScope || []), dt]
                                  : (aideSoul.docScope || []).filter(x => x !== dt)
                                patchSoul('docScope', next)
                              }}
                            />
                            <span className="pdfapp-aide-tool-name">{dt}</span>
                          </label>
                        )
                      })}
                    </>
                  )}
                </div>

                <div className="pdfapp-aide-soul-section">
                  <div className="pdfapp-aide-soul-section-label">Case RAG database</div>
                  {caseId ? (
                    <div className="pdfapp-aide-rag-db-info">
                      <span className="pdfapp-aide-rag-db-label">sqlite-vec</span>
                      <span className="pdfapp-aide-soul-hint">Case ID: {caseId.slice(0, 16)}…</span>
                      <span className="pdfapp-aide-soul-hint">Scope: {aideSoul.docScope?.length ? aideSoul.docScope.join(', ') : 'all documents'}</span>
                    </div>
                  ) : (
                    <div className="pdfapp-aide-soul-empty">Open a case to see RAG database info.</div>
                  )}
                </div>
              </div>
            )}

            {/* ── Audit sub-tab ── */}
            {activeAgentId && aideSoulTab === 'audit' && (() => {
              const { breakdown, total, systemPrompt } = aideAuditData
              return (
                <div className="pdfapp-aide-memory-panel">
                  {/* Token breakdown */}
                  <div className="pdfapp-aide-audit-header">Token Budget</div>
                  <div className="pdfapp-aide-audit-breakdown">
                    {Object.entries(breakdown).map(([label, tokens]) => (
                      <div key={label} className="pdfapp-aide-audit-row">
                        <span className="pdfapp-aide-audit-row-label">{label}</span>
                        <span className={`pdfapp-aide-audit-row-tokens${tokens > 1000 ? ' pdfapp-aide-audit-tokens--warn' : ''}`}>{tokens.toLocaleString()} tok</span>
                      </div>
                    ))}
                    <div className="pdfapp-aide-audit-row pdfapp-aide-audit-row--total">
                      <span className="pdfapp-aide-audit-row-label">Total</span>
                      <span className={`pdfapp-aide-audit-row-tokens${total > 3000 ? ' pdfapp-aide-audit-tokens--warn' : ''}`}>{total.toLocaleString()} tok</span>
                    </div>
                    {total > 3000 && <div className="pdfapp-aide-audit-warn">⚠ Context is large — consider trimming Soul / Skills content</div>}
                  </div>

                  {/* Files in scope */}
                  <div className="pdfapp-aide-audit-header" style={{ marginTop: 12 }}>Files &amp; Config</div>
                  <div className="pdfapp-aide-audit-files">
                    {aideSoul.skillMd && (
                      <div className="pdfapp-aide-audit-file-row">
                        <span className="pdfapp-aide-audit-file-icon">📄</span>
                        <span className="pdfapp-aide-audit-file-name">{aideSkillFileName || 'skill.md'}</span>
                        <span className="pdfapp-aide-audit-file-size">{Math.round(aideSoul.skillMd.length / 1024 * 10) / 10} KB</span>
                      </div>
                    )}
                    {aideSoul.redFlags?.trim() && (
                      <div className="pdfapp-aide-audit-file-row">
                        <span className="pdfapp-aide-audit-file-icon">🚩</span>
                        <span className="pdfapp-aide-audit-file-name">Standing checklist</span>
                        <span className="pdfapp-aide-audit-file-size">{(aideSoul.redFlags.match(/\n/g) || []).length + 1} items</span>
                      </div>
                    )}
                    {aideSoul.corrections?.length > 0 && (
                      <div className="pdfapp-aide-audit-file-row">
                        <span className="pdfapp-aide-audit-file-icon">✏️</span>
                        <span className="pdfapp-aide-audit-file-name">Corrections</span>
                        <span className="pdfapp-aide-audit-file-size">{aideSoul.corrections.length} items</span>
                      </div>
                    )}
                    {aideDiary.length > 0 && (
                      <div className="pdfapp-aide-audit-file-row">
                        <span className="pdfapp-aide-audit-file-icon">📓</span>
                        <span className="pdfapp-aide-audit-file-name">Session diary</span>
                        <span className="pdfapp-aide-audit-file-size">{aideDiary.length} entries (last 3 injected)</span>
                      </div>
                    )}
                    {!aideSoul.skillMd && !aideSoul.redFlags?.trim() && !aideSoul.corrections?.length && !aideDiary.length && (
                      <div className="pdfapp-aide-soul-empty">No .md files or config loaded for this agent.</div>
                    )}
                  </div>

                  {/* System prompt preview */}
                  <div className="pdfapp-aide-audit-header" style={{ marginTop: 12 }}>System Prompt Preview</div>
                  <pre className="pdfapp-aide-audit-prompt">{systemPrompt}</pre>
                </div>
              )
            })()}

            {/* ── Memory sub-tab ── */}
            {activeAgentId && aideSoulTab === 'memory' && (
              <div className="pdfapp-aide-memory-panel">
                {/* Header with clear button */}
                <div className="pdfapp-aide-memory-header-row">
                  <span className="pdfapp-aide-memory-header">Session Diary</span>
                  {aideDiary.length > 0 && (
                    aideDiaryClearConfirm
                      ? <div className="pdfapp-aide-diary-clear-confirm">
                          Clear all {aideDiary.length} entries?
                          <button className="pdfapp-aide-soul-save-btn pdfapp-aide-soul-save-btn--dirty" onClick={async () => {
                            if (!caseId) return
                            const agentParam = activeAgentId ? `?agentId=${encodeURIComponent(activeAgentId)}` : ''
                            await fetch(`/api/cases/${caseId}/aide/diary${agentParam}`, { method: 'DELETE' }).catch(() => {})
                            setAideDiary([])
                            setAideDiaryClearConfirm(false)
                          }}>Confirm</button>
                          <button className="pdfapp-aide-soul-add-btn" onClick={() => setAideDiaryClearConfirm(false)}>Cancel</button>
                        </div>
                      : <button className="pdfapp-aide-soul-add-btn" onClick={() => setAideDiaryClearConfirm(true)}>Clear all</button>
                  )}
                </div>
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
                          {entry.reflection && (
                            <button className="pdfapp-aide-diary-pin-btn" onClick={() => {
                              const pinText = `Session (${entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : 'past'}): ${entry.reflection}`
                              setAideSoul(prev => ({
                                ...prev,
                                corrections: [...(prev.corrections || []), { id: crypto.randomUUID(), text: pinText, createdAt: new Date().toISOString() }]
                              }))
                              setAideSoulDirty(true)
                            }}>+ Pin to Identity</button>
                          )}
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



      {/* ── Workspace Modal ── */}
      {workspaceOpen && <WorkspaceModal onClose={() => setWorkspaceOpen(false)} />}

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

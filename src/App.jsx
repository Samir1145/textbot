import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'
import PDFApp from './pages/PDFApp.jsx'
import Calendar from './pages/Calendar.jsx'
import { saveTrash, loadTrash } from './db.js'
import { useTheme } from './useTheme.js'

const SETTINGS_KEY = 'textbot-model-settings'
function loadLocalSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } catch { return {} }
}
function saveLocalSettings(obj) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj))
}

const SunIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
)
const MoonIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

function SettingsModal({ onClose }) {
  const [ollamaModels, setOllamaModels] = useState([])
  const [genModel, setGenModel]         = useState('')
  const [embedModel, setEmbedModel]     = useState('')
  const [embedBackend, setEmbedBackend] = useState('ollama')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)

  // Caselaw import state
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
    // Load current settings from server
    fetch('/api/settings').then(r => r.json()).then(d => {
      setGenModel(d.genModel || '')
      setEmbedModel(d.embedModel || '')
      setEmbedBackend(d.embedBackend || 'ollama')
      // Merge local override for gen model
      const local = loadLocalSettings()
      if (local.genModel) setGenModel(local.genModel)
    }).catch(() => {
      const local = loadLocalSettings()
      setGenModel(local.genModel || '')
    })
    // Fetch available Ollama models
    fetch('/api/ollama/api/tags').then(r => r.json()).then(d => {
      const names = (d.models || []).map(m => m.name).filter(Boolean)
      setOllamaModels(names)
    }).catch(() => {})
    // Load caselaw status
    refreshLawStatus()
  }, [refreshLawStatus])

  const handleSave = async () => {
    setSaving(true)
    // Save gen model to localStorage (client-side override)
    saveLocalSettings({ ...loadLocalSettings(), genModel })
    // Save embed model to server
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
          <span className="settings-title">Model Settings</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          {/* Generative model */}
          <div className="settings-section">
            <label className="settings-label">
              Generative Model
              <span className="settings-hint">used for chat, agents, and summaries</span>
            </label>
            {ollamaModels.length > 0 ? (
              <select className="settings-select" value={genModel} onChange={e => setGenModel(e.target.value)}>
                <option value="">— select model —</option>
                {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : null}
            <input
              className="settings-input"
              placeholder="e.g. gemma3n:e2b or qwen2.5:7b"
              value={genModel}
              onChange={e => setGenModel(e.target.value)}
            />
          </div>

          {/* Embedding model */}
          <div className="settings-section">
            <label className="settings-label">
              Embedding Model
              <span className="settings-hint">{embedBackend} · used for document search</span>
            </label>
            {ollamaModels.length > 0 ? (
              <select className="settings-select" value={embedModel} onChange={e => setEmbedModel(e.target.value)}>
                <option value="">— select model —</option>
                {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : null}
            <input
              className="settings-input"
              placeholder="e.g. nomic-embed-text:latest"
              value={embedModel}
              onChange={e => setEmbedModel(e.target.value)}
            />
            <p className="settings-warn">⚠ Changing the embedding model requires re-indexing all documents.</p>
          </div>

          {/* Caselaw database */}
          <div className="settings-section">
            <label className="settings-label">
              Caselaw Database
              <span className="settings-hint">SQLite .db corpus for offline legal search</span>
            </label>

            {/* Corpus status */}
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

            {/* Drop zone */}
            <div
              className={`settings-law-drop${lawDragOver ? ' settings-law-drop--over' : ''}${lawUploadFile ? ' settings-law-drop--staged' : ''}`}
              onDragOver={e => { e.preventDefault(); setLawDragOver(true) }}
              onDragLeave={() => setLawDragOver(false)}
              onDrop={handleLawDbDrop}
              onClick={() => !lawUploadFile && lawFileInputRef.current?.click()}
            >
              <input ref={lawFileInputRef} type="file" accept=".db" style={{ display: 'none' }}
                onChange={e => handleLawDbDrop({ target: e.target })} />
              {lawUploadFile ? (
                <>
                  <span>📦 {lawUploadFile.name}</span>
                  <span className="settings-law-drop-size">({(lawUploadFile.size / 1024 / 1024).toFixed(1)} MB)</span>
                  <button className="settings-law-drop-clear" onClick={e => { e.stopPropagation(); setLawUploadFile(null); setLawImportMsg(null) }}>× Clear</button>
                </>
              ) : (
                <>
                  <span>⚖ Drop a <strong>.db</strong> file here or click to browse</span>
                </>
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

const TrashIcon = ({ size = 120 }) => (
  <svg viewBox="0 0 100 110" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
    <rect x="30" y="5" width="18" height="22" rx="2" fill="white" stroke="#ccc" strokeWidth="1" transform="rotate(-10 30 5)" />
    <rect x="48" y="2" width="18" height="22" rx="2" fill="white" stroke="#ccc" strokeWidth="1" transform="rotate(5 48 2)" />
    <rect x="10" y="28" width="80" height="72" rx="6" ry="6" fill="#b8cce4" />
    <rect x="5" y="22" width="90" height="12" rx="4" ry="4" fill="#c5d8ef" />
    <rect x="35" y="16" width="30" height="8" rx="4" ry="4" fill="#c5d8ef" />
    <line x1="35" y1="42" x2="33" y2="90" stroke="white" strokeWidth="5" strokeLinecap="round" />
    <line x1="50" y1="42" x2="50" y2="90" stroke="white" strokeWidth="5" strokeLinecap="round" />
    <line x1="65" y1="42" x2="67" y2="90" stroke="white" strokeWidth="5" strokeLinecap="round" />
  </svg>
)

function App() {
  const { theme, toggleTheme } = useTheme()
  const [trash, setTrash] = useState([])
  const [view, setView] = useState('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [openCaseId, setOpenCaseId] = useState(null)
  const [openCaseData, setOpenCaseData] = useState(null)
  const [dbReady, setDbReady] = useState(false)

  // ── Load from IndexedDB on mount ──
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const savedTrash = await loadTrash()
        if (cancelled) return
        setTrash(savedTrash)
      } catch (err) {
        console.error('Failed to load from server:', err)
      }
      if (!cancelled) setDbReady(true)
    }
    load()
    return () => { cancelled = true }
  }, [])

  // ── Auto-save trash to IndexedDB on changes ──
  useEffect(() => {
    if (!dbReady) return
    saveTrash(trash).catch(err => console.error('Failed to save trash:', err))
  }, [trash, dbReady])

  const handleOpenCase = useCallback((caseObj) => {
    setOpenCaseId(caseObj.id)
    setOpenCaseData(caseObj)
  }, [])

  const restoreFromTrash = (id) => {
    setTrash(prev => prev.filter(i => i.id !== id))
  }

  const emptyTrash = () => setTrash([])

  if (!dbReady) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#9ca3af', fontSize: '1.2rem' }}>Loading workspace...</p>
      </div>
    )
  }

  if (openCaseId) {
    // Open PDFApp scoped to a case — no folder, parties managed via localStorage
    const caseFolder = { id: openCaseId, name: openCaseData?.name || 'Case', children: [] }
    return (
      <PDFApp
        folder={caseFolder}
        caseId={openCaseId}
        caseName={openCaseData?.name}
        onBack={() => { setOpenCaseId(null); setOpenCaseData(null) }}
        onAddFiles={() => {}}
      />
    )
  }

  return (
    <div className="app">
      {/* Top bar */}
      <div className="topbar">
        <h1 className="page-title">{view === 'home' ? 'Cases' : 'Trash Bin'}</h1>
        <div className="topbar-actions">
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            <GearIcon />
          </button>
          <button className="icon-btn" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className={`icon-btn ${view === 'trash' ? 'active' : ''}`} title="Trash Bin" onClick={() => setView(v => v === 'trash' ? 'home' : 'trash')}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
            {trash.length > 0 && <span className="badge">{trash.length}</span>}
          </button>
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {/* Content */}
      {view === 'home' ? (
        <Calendar onOpenCase={handleOpenCase} />
      ) : (
        <div className="trash-view">
          {trash.length === 0 ? (
            <div className="empty-trash">
              <TrashIcon size={140} />
              <p>Trash is empty</p>
            </div>
          ) : (
            <>
              <div className="trash-toolbar">
                <button className="btn-danger" onClick={emptyTrash}>Empty Trash</button>
              </div>
              <div className="grid">
                {trash.map(item => (
                  <div key={item.id} className="item">
                    {item.type === 'folder' ? (
                      <svg viewBox="0 0 100 80" width="120" height="100" xmlns="http://www.w3.org/2000/svg">
                        <rect x="0" y="18" width="100" height="62" rx="6" ry="6" fill="#b8cce4" />
                        <rect x="0" y="12" width="40" height="16" rx="4" ry="4" fill="#b8cce4" />
                        <rect x="0" y="18" width="100" height="60" rx="6" ry="6" fill="#c5d8ef" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 80 100" width="90" height="110" xmlns="http://www.w3.org/2000/svg">
                        <rect x="5" y="5" width="70" height="90" rx="6" fill="#dde8f5" stroke="#b8cce4" strokeWidth="2" />
                        <polyline points="45,5 45,30 70,30" fill="#c5d8ef" stroke="#b8cce4" strokeWidth="2" />
                      </svg>
                    )}
                    <span className="item-name">{item.name}</span>
                    <button className="restore-btn" onClick={() => restoreFromTrash(item.id)}>Restore</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default App

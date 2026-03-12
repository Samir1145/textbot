import { useState, useEffect, useCallback } from 'react'
import './App.css'
import PDFApp from './pages/PDFApp.jsx'
import Calendar from './pages/Calendar.jsx'
import { saveTrash, loadTrash } from './db.js'
import { useTheme } from './useTheme.js'

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

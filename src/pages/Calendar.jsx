import { useState, useCallback, useMemo } from 'react'
import { deleteCase } from '../db.js'
import './Calendar.css'

const CASE_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
]

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function loadCases() {
  try {
    return JSON.parse(localStorage.getItem('pdf-app-cases') || '[]')
  } catch {
    return []
  }
}

function saveCases(cases) {
  localStorage.setItem('pdf-app-cases', JSON.stringify(cases))
}

function toDateStr(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDateStr(dateStr) {
  // Returns { year, month (0-based), day }
  const [y, m, d] = dateStr.split('-').map(Number)
  return { year: y, month: m - 1, day: d }
}

function formatDate(dateStr) {
  const { year, month, day } = parseDateStr(dateStr)
  const today = new Date()
  const caseDate = new Date(year, month, day)
  const diffMs = caseDate - new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diffDays = Math.round(diffMs / 86400000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays > 0 && diffDays <= 6) return `In ${diffDays} days`

  const sameYear = year === today.getFullYear()
  return sameYear
    ? `${MONTHS_SHORT[month]} ${day}`
    : `${MONTHS_SHORT[month]} ${day}, ${year}`
}

// ── Add Case Modal ─────────────────────────────────────────────────
function AddCaseModal({ initialDate, onConfirm, onCancel }) {
  const today = new Date()
  const defaultDate = initialDate || toDateStr(today.getFullYear(), today.getMonth(), today.getDate())
  const [name, setName] = useState('')
  const [date, setDate] = useState(defaultDate)
  const [colorIdx, setColorIdx] = useState(0)

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed || !date) return
    onConfirm({ name: trimmed, date, color: CASE_COLORS[colorIdx] })
  }

  return (
    <div className="cal-modal-overlay" onClick={onCancel}>
      <div className="cal-modal" onClick={e => e.stopPropagation()}>
        <div className="cal-modal-header">
          <span>New Case</span>
          <button className="cal-modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="cal-modal-body">
          <label className="cal-modal-label">Case name</label>
          <input
            className="cal-modal-input"
            autoFocus
            placeholder="e.g. Smith v. Jones"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onCancel() }}
          />
          <label className="cal-modal-label">Date</label>
          <input
            className="cal-modal-input"
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
          <label className="cal-modal-label">Color</label>
          <div className="cal-color-grid">
            {CASE_COLORS.map((c, i) => (
              <button
                key={c}
                className={`cal-color-swatch${colorIdx === i ? ' cal-color-swatch--active' : ''}`}
                style={{ background: c }}
                onClick={() => setColorIdx(i)}
                aria-label={`Color ${i + 1}`}
              />
            ))}
          </div>
        </div>
        <div className="cal-modal-footer">
          <button className="cal-btn cal-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="cal-btn cal-btn--primary" onClick={handleSubmit} disabled={!name.trim() || !date}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sidebar case row ───────────────────────────────────────────────
function CaseRow({ c, onOpen, onJump, onDelete }) {
  return (
    <div className="cal-sb-case" onClick={() => onJump(c)}>
      <span className="cal-sb-dot" style={{ background: c.color }} />
      <div className="cal-sb-case-info">
        <span className="cal-sb-case-name">{c.name}</span>
        <span className="cal-sb-case-date">{formatDate(c.date)}</span>
      </div>
      <button
        className="cal-sb-open-btn"
        title="Open case"
        onClick={e => { e.stopPropagation(); onOpen(c) }}
      >
        →
      </button>
      {onDelete && (
        <button
          className="cal-sb-delete-btn"
          title="Delete case"
          onClick={e => { e.stopPropagation(); onDelete(c) }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ── Calendar Sidebar ───────────────────────────────────────────────
function CalendarSidebar({ cases, onOpenCase, onJumpTo, onDeleteCase, onAddCase }) {
  const [query, setQuery] = useState('')

  const today = new Date()
  const todayStr = toDateStr(today.getFullYear(), today.getMonth(), today.getDate())
  const in30Str = toDateStr(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 30
  )

  const sorted = useMemo(() =>
    [...cases].sort((a, b) => a.date.localeCompare(b.date)),
    [cases]
  )

  const filtered = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return sorted.filter(c => c.name.toLowerCase().includes(q))
  }, [query, sorted])

  const upcoming = useMemo(() =>
    sorted.filter(c => c.date >= todayStr && c.date <= in30Str),
    [sorted, todayStr, in30Str]
  )

  const past = useMemo(() =>
    sorted.filter(c => c.date < todayStr).reverse(),
    [sorted, todayStr]
  )

  const isSearching = query.trim().length > 0

  return (
    <div className="cal-sb">
      {/* Search */}
      <div className="cal-sb-search-wrap">
        <svg className="cal-sb-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          className="cal-sb-search"
          placeholder="Search cases…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && (
          <button className="cal-sb-search-clear" onClick={() => setQuery('')}>✕</button>
        )}
      </div>

      <div className="cal-sb-body">
        {isSearching ? (
          <>
            <div className="cal-sb-section-label">
              {filtered.length} result{filtered.length !== 1 ? 's' : ''}
            </div>
            {filtered.length === 0 ? (
              <div className="cal-sb-empty">No cases match "{query}"</div>
            ) : (
              filtered.map(c => (
                <CaseRow key={c.id} c={c} onOpen={onOpenCase} onJump={onJumpTo} onDelete={onDeleteCase} />
              ))
            )}
          </>
        ) : (
          <>
            {/* Upcoming */}
            <div className="cal-sb-section-label">Upcoming (30 days)</div>
            {upcoming.length === 0 ? (
              <div className="cal-sb-empty">No upcoming cases</div>
            ) : (
              upcoming.map(c => (
                <CaseRow key={c.id} c={c} onOpen={onOpenCase} onJump={onJumpTo} onDelete={onDeleteCase} />
              ))
            )}

            {/* Past */}
            {past.length > 0 && (
              <>
                <div className="cal-sb-section-label" style={{ marginTop: 16 }}>Recent</div>
                {past.slice(0, 10).map(c => (
                  <CaseRow key={c.id} c={c} onOpen={onOpenCase} onJump={onJumpTo} onDelete={onDeleteCase} />
                ))}
                {past.length > 10 && (
                  <div className="cal-sb-more">+{past.length - 10} older cases</div>
                )}
              </>
            )}

            {cases.length === 0 && (
              <div className="cal-sb-empty">
                No cases yet.
                <button className="cal-sb-add-btn" onClick={onAddCase}>+ Add case</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Main Calendar ──────────────────────────────────────────────────
export default function Calendar({ onOpenCase }) {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [cases, setCases] = useState(loadCases)
  const [modal, setModal] = useState(null)
  const [highlightId, setHighlightId] = useState(null)

  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1) }
    else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1) }
    else setMonth(m => m + 1)
  }

  const handleAddCase = useCallback((data) => {
    const newCase = { id: crypto.randomUUID(), ...data }
    const updated = [...cases, newCase]
    setCases(updated)
    saveCases(updated)
    setModal(null)
  }, [cases])

  const handleDeleteCase = useCallback(async (c) => {
    if (!window.confirm(`Delete "${c.name}"? This will permanently remove all documents, extractions, and analysis for this case.`)) return
    await deleteCase(c.id)
    const updated = cases.filter(x => x.id !== c.id)
    setCases(updated)
    saveCases(updated)
    localStorage.removeItem(`pdf-parties-${c.id}`)
  }, [cases])

  // Jump to a case's month and briefly highlight it
  const handleJumpTo = useCallback((c) => {
    const { year: y, month: m } = parseDateStr(c.date)
    setYear(y)
    setMonth(m)
    setHighlightId(c.id)
    setTimeout(() => setHighlightId(null), 1800)
  }, [])

  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = i - firstDow + 1
    return (day >= 1 && day <= daysInMonth) ? day : null
  })

  return (
    <div className="cal-root">
      {/* Left sidebar */}
      <CalendarSidebar
        cases={cases}
        onOpenCase={onOpenCase}
        onJumpTo={handleJumpTo}
        onDeleteCase={handleDeleteCase}
        onAddCase={() => setModal({ date: null })}
      />

      {/* Main calendar area */}
      <div className="cal-main">
        {/* Top bar */}
        <div className="cal-topbar">
          <div className="cal-nav">
            <button className="cal-nav-btn" onClick={prevMonth}>‹</button>
            <h2 className="cal-month-label">{MONTHS[month]} {year}</h2>
            <button className="cal-nav-btn" onClick={nextMonth}>›</button>
          </div>
          <button className="cal-btn cal-btn--primary" onClick={() => setModal({ date: null })}>
            + Add Case
          </button>
        </div>

        {/* Day headers */}
        <div className="cal-grid-header">
          {DAYS.map(d => <div key={d} className="cal-day-label">{d}</div>)}
        </div>

        {/* Calendar grid */}
        <div className="cal-grid">
          {cells.map((day, i) => {
            if (!day) return <div key={i} className="cal-cell cal-cell--empty" />
            const dateStr = toDateStr(year, month, day)
            const dayCases = cases.filter(c => c.date === dateStr)
            const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day
            return (
              <div
                key={i}
                className={`cal-cell${isToday ? ' cal-cell--today' : ''}`}
                onClick={() => setModal({ date: dateStr })}
              >
                <span className={`cal-day-num${isToday ? ' cal-day-num--today' : ''}`}>{day}</span>
                <div className="cal-pills">
                  {dayCases.slice(0, 2).map(c => (
                    <button
                      key={c.id}
                      className={`cal-pill${highlightId === c.id ? ' cal-pill--highlight' : ''}`}
                      style={{ background: c.color, color: '#fff' }}
                      title={c.name}
                      onClick={e => { e.stopPropagation(); onOpenCase(c) }}
                    >
                      {c.name}
                    </button>
                  ))}
                  {dayCases.length > 2 && (
                    <span className="cal-overflow">+{dayCases.length - 2} more</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {modal && (
        <AddCaseModal
          initialDate={modal.date}
          onConfirm={handleAddCase}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}

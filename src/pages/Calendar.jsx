import { useState, useCallback, useMemo, useEffect } from 'react'
import { deleteCase } from '../db.js'
import './Calendar.css'

const CASE_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#06b6d4']
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function loadCases() { try { return JSON.parse(localStorage.getItem('pdf-app-cases')||'[]') } catch { return [] } }
function saveCases(cases) { localStorage.setItem('pdf-app-cases', JSON.stringify(cases)) }
function toDateStr(year,month,day) { return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` }
function parseDateStr(dateStr) { const [y,m,d]=dateStr.split('-').map(Number); return {year:y,month:m-1,day:d} }

function getDocCount(caseId) {
  try {
    const parties = JSON.parse(localStorage.getItem(`pdf-parties-${caseId}`) || '[]')
    return parties.reduce((s,p) => s + (p.documents?.length||0), 0)
  } catch { return 0 }
}

function relativeDate(dateStr) {
  if (!dateStr) return ''
  const {year,month,day} = parseDateStr(dateStr)
  const today = new Date()
  const d = new Date(year, month, day)
  const diff = Math.round((d - new Date(today.getFullYear(),today.getMonth(),today.getDate())) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff <= 6) return `In ${diff} days`
  if (diff < 0 && diff >= -6) return `${Math.abs(diff)} days ago`
  const sameYear = year === today.getFullYear()
  return sameYear ? `${MONTHS_SHORT[month]} ${day}` : `${MONTHS_SHORT[month]} ${day}, ${year}`
}

function relativeTime(isoStr) {
  if (!isoStr) return ''
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`
  if (diff < 86400*7) return `${Math.floor(diff/86400)}d ago`
  return new Date(isoStr).toLocaleDateString([], {month:'short', day:'numeric'})
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

// ── Main Dashboard ──────────────────────────────────────────────────
export default function Calendar({ onOpenCase }) {
  const today = new Date()
  const [cases, setCases] = useState(loadCases)
  const [modal, setModal] = useState(null)            // null | { date }
  const [deleteCaseConfirm, setDeleteCaseConfirm] = useState(null)
  const [sortBy, setSortBy] = useState('recent')      // 'recent' | 'date' | 'alpha'
  const [filterBy, setFilterBy] = useState('all')     // 'all' | 'upcoming' | 'recent'
  const [searchQuery, setSearchQuery] = useState('')

  // Mini calendar state
  const [calYear, setCalYear] = useState(today.getFullYear())
  const [calMonth, setCalMonth] = useState(today.getMonth())

  // System status
  const [ollamaStatus, setOllamaStatus] = useState(null)   // null | { ok, models }
  const [lawStatus, setLawStatus] = useState(null)          // null | { available, rows, model }

  // Lazy stats (fetched after mount for top 8 cases)
  const [caseStats, setCaseStats] = useState({})  // { [caseId]: { noteCount, agentRuns } }
  const [activityFeed, setActivityFeed] = useState([])  // [{ type, caseName, caseColor, text, time }]
  const [statsLoading, setStatsLoading] = useState(true)

  // Load system status on mount
  useEffect(() => {
    fetch('/api/ollama/api/tags').then(r=>r.json()).then(d=>{
      setOllamaStatus({ ok: true, models: (d.models||[]).map(m=>m.name) })
    }).catch(()=>setOllamaStatus({ ok: false, models: [] }))

    fetch('/api/caselaw/status').then(r=>r.json()).then(d=>{
      setLawStatus(d)
    }).catch(()=>setLawStatus({ available: false }))
  }, [])

  // Load lazy stats for cases
  useEffect(() => {
    if (cases.length === 0) { setStatsLoading(false); return }
    const topCases = [...cases].slice(0, 8) // limit to 8 to avoid hammering server
    let cancelled = false
    async function fetchStats() {
      const stats = {}
      const feedItems = []
      await Promise.all(topCases.map(async c => {
        try {
          const [notesRes, diaryRes] = await Promise.all([
            fetch(`/api/cases/${c.id}/all-notes`).then(r=>r.json()).catch(()=>({})),
            fetch(`/api/cases/${c.id}/aide/diary`).then(r=>r.json()).catch(()=>[]),
          ])
          const noteCount = Object.values(notesRes).reduce((s,arr)=>s+(Array.isArray(arr)?arr.length:0),0)
          const agentRuns = Array.isArray(diaryRes) ? diaryRes.length : 0
          stats[c.id] = { noteCount, agentRuns }
          // Build activity feed items from notes
          Object.values(notesRes).flat().slice(0,3).forEach(note => {
            if (note?.createdAt) feedItems.push({ type:'note', caseId:c.id, caseName:c.name, caseColor:c.color, text: note.text?.slice(0,80)||'Note', time: note.createdAt })
          })
          // Build feed items from diary
          if (Array.isArray(diaryRes)) diaryRes.slice(0,2).forEach(entry => {
            if (entry?.createdAt) feedItems.push({ type:'agent', caseId:c.id, caseName:c.name, caseColor:c.color, text: entry.task?.slice(0,80)||'Agent run', time: entry.createdAt })
          })
        } catch {}
      }))
      if (!cancelled) {
        setCaseStats(stats)
        // sort feed by time desc, take top 15
        feedItems.sort((a,b)=>new Date(b.time)-new Date(a.time))
        setActivityFeed(feedItems.slice(0,15))
        setStatsLoading(false)
      }
    }
    fetchStats()
    return () => { cancelled = true }
  }, [cases])

  // Computed: last opened case
  const lastOpenedCase = useMemo(() => {
    try {
      const lo = JSON.parse(localStorage.getItem('pdf-last-opened')||'null')
      if (!lo?.caseId) return null
      const c = cases.find(x=>x.id===lo.caseId)
      return c ? { ...c, openedAt: lo.openedAt } : null
    } catch { return null }
  }, [cases])

  // Computed: total stats
  const totalDocs = useMemo(() => cases.reduce((s,c)=>s+getDocCount(c.id),0), [cases])
  const totalNotes = useMemo(() => Object.values(caseStats).reduce((s,x)=>s+(x.noteCount||0),0), [caseStats])
  const totalAgentRuns = useMemo(() => Object.values(caseStats).reduce((s,x)=>s+(x.agentRuns||0),0), [caseStats])

  // Computed: filtered/sorted cases
  const todayStr = toDateStr(today.getFullYear(),today.getMonth(),today.getDate())
  const in30Str  = toDateStr(today.getFullYear(),today.getMonth(),today.getDate()+30)
  const filteredCases = useMemo(() => {
    let result = [...cases]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(c=>c.name.toLowerCase().includes(q))
    }
    if (filterBy === 'upcoming') result = result.filter(c=>c.date>=todayStr && c.date<=in30Str)
    if (filterBy === 'recent') result = result.filter(c=>c.date<todayStr)
    if (sortBy === 'alpha') result.sort((a,b)=>a.name.localeCompare(b.name))
    else if (sortBy === 'date') result.sort((a,b)=>b.date.localeCompare(a.date))
    else result.sort((a,b)=>b.date.localeCompare(a.date)) // 'recent' = by date desc
    return result
  }, [cases, searchQuery, filterBy, sortBy, todayStr, in30Str])

  // Upcoming (next 7 days)
  const in7Str = toDateStr(today.getFullYear(),today.getMonth(),today.getDate()+7)
  const upcomingCases = useMemo(()=>
    [...cases].filter(c=>c.date>=todayStr&&c.date<=in7Str).sort((a,b)=>a.date.localeCompare(b.date)),
    [cases,todayStr,in7Str]
  )

  // Handlers
  const handleAddCase = useCallback((data) => {
    const newCase = { id: crypto.randomUUID(), ...data }
    const updated = [...cases, newCase]
    setCases(updated); saveCases(updated); setModal(null)
  }, [cases])

  const handleDeleteCase = useCallback((c) => {
    const docCount = getDocCount(c.id)
    setDeleteCaseConfirm({ c, docCount })
  }, [])

  const confirmDeleteCase = useCallback(async () => {
    if (!deleteCaseConfirm) return
    const { c } = deleteCaseConfirm
    setDeleteCaseConfirm(null)
    try { await fetch(`/api/cases/${c.id}`, { method: 'DELETE' }).catch(()=>{}) } catch {}
    const updated = cases.filter(x=>x.id!==c.id)
    setCases(updated); saveCases(updated)
    localStorage.removeItem(`pdf-parties-${c.id}`)
  }, [deleteCaseConfirm, cases])

  // Mini calendar data
  const firstDow = new Date(calYear, calMonth, 1).getDay()
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate()
  const miniCells = Array.from({length:42},(_,i)=>{ const d=i-firstDow+1; return (d>=1&&d<=daysInMonth)?d:null })
  const caseDateSet = useMemo(()=>{
    const m = {}
    cases.forEach(c=>{ if(!m[c.date]) m[c.date]=[]; m[c.date].push(c) })
    return m
  },[cases])

  return (
    <div className="dash-root">
      {/* ── Main area ── */}
      <div className="dash-main">

        {/* Hero */}
        {lastOpenedCase && (
          <div className="dash-hero" style={{'--case-color': lastOpenedCase.color}}>
            <div className="dash-hero-accent" />
            <div className="dash-hero-body">
              <div className="dash-hero-meta">
                <span className="dash-hero-label">Continue working</span>
                <span className="dash-hero-opened">Last opened {relativeTime(lastOpenedCase.openedAt)}</span>
              </div>
              <div className="dash-hero-name">{lastOpenedCase.name}</div>
              <div className="dash-hero-stats">
                <span className="dash-hero-stat">{getDocCount(lastOpenedCase.id)} docs</span>
                {caseStats[lastOpenedCase.id]?.noteCount > 0 && <span className="dash-hero-stat">{caseStats[lastOpenedCase.id].noteCount} notes</span>}
                {caseStats[lastOpenedCase.id]?.agentRuns > 0 && <span className="dash-hero-stat">{caseStats[lastOpenedCase.id].agentRuns} agent runs</span>}
                <span className="dash-hero-date">{relativeDate(lastOpenedCase.date)}</span>
              </div>
            </div>
            <button className="dash-hero-btn" onClick={()=>onOpenCase(lastOpenedCase)}>Resume →</button>
          </div>
        )}

        {/* Stat pills */}
        <div className="dash-stats-row">
          {[
            { label: 'Cases', value: cases.length, icon: '⚖' },
            { label: 'Documents', value: totalDocs, icon: '📄' },
            { label: 'Notes', value: statsLoading ? '…' : totalNotes, icon: '📝' },
            { label: 'Agent runs', value: statsLoading ? '…' : totalAgentRuns, icon: '🤖' },
          ].map(s=>(
            <div key={s.label} className="dash-stat-pill">
              <span className="dash-stat-icon">{s.icon}</span>
              <span className="dash-stat-value">{s.value}</span>
              <span className="dash-stat-label">{s.label}</span>
            </div>
          ))}
        </div>

        {/* Cases section */}
        <div className="dash-section-header">
          <div className="dash-section-left">
            <span className="dash-section-title">Cases</span>
            <div className="dash-filter-tabs">
              {['all','upcoming','recent'].map(f=>(
                <button key={f} className={`dash-filter-tab${filterBy===f?' dash-filter-tab--active':''}`} onClick={()=>setFilterBy(f)}>
                  {f.charAt(0).toUpperCase()+f.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="dash-section-right">
            <div className="dash-search-wrap">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input className="dash-search" placeholder="Search…" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} />
              {searchQuery && <button className="dash-search-clear" onClick={()=>setSearchQuery('')}>✕</button>}
            </div>
            <select className="dash-sort-select" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
              <option value="recent">Recent</option>
              <option value="date">By date</option>
              <option value="alpha">A – Z</option>
            </select>
          </div>
        </div>

        <div className="dash-cases-grid">
          {filteredCases.map(c => (
            <div key={c.id} className="dash-case-card" style={{'--case-color':c.color}}>
              <div className="dash-case-card-accent" />
              <div className="dash-case-card-body" onClick={()=>onOpenCase(c)}>
                <div className="dash-case-card-name">{c.name}</div>
                <div className="dash-case-card-meta">
                  <span className="dash-case-card-date">{relativeDate(c.date)}</span>
                  <span className="dash-case-card-docs">{getDocCount(c.id)} docs</span>
                  {caseStats[c.id]?.noteCount > 0 && <span className="dash-case-card-notes">{caseStats[c.id].noteCount} notes</span>}
                </div>
              </div>
              <div className="dash-case-card-actions">
                <button className="dash-case-open-btn" onClick={()=>onOpenCase(c)} title="Open case">→</button>
                <button className="dash-case-del-btn" onClick={e=>{e.stopPropagation();handleDeleteCase(c)}} title="Delete case">✕</button>
              </div>
            </div>
          ))}
          {/* New case card */}
          <button className="dash-case-card dash-case-card--new" onClick={()=>setModal({date:null})}>
            <span className="dash-case-new-icon">+</span>
            <span className="dash-case-new-label">New Case</span>
          </button>
        </div>

        {filteredCases.length === 0 && !searchQuery && (
          <div className="dash-empty-state">
            <span className="dash-empty-icon">⚖</span>
            <span className="dash-empty-text">No cases yet — create your first case above</span>
          </div>
        )}

        {filteredCases.length === 0 && searchQuery && (
          <div className="dash-empty-state">
            <span className="dash-empty-text">No cases match "{searchQuery}"</span>
          </div>
        )}

        {/* Activity feed */}
        {activityFeed.length > 0 && (
          <>
            <div className="dash-section-header" style={{marginTop:24}}>
              <span className="dash-section-title">Recent Activity</span>
            </div>
            <div className="dash-feed">
              {activityFeed.map((item,i) => (
                <div key={i} className="dash-feed-item" onClick={()=>{const c=cases.find(x=>x.id===item.caseId);if(c)onOpenCase(c)}}>
                  <span className="dash-feed-dot" style={{background:item.caseColor}} />
                  <div className="dash-feed-body">
                    <span className="dash-feed-case">{item.caseName}</span>
                    <span className="dash-feed-icon">{item.type==='note'?'📝':'🤖'}</span>
                    <span className="dash-feed-text">{item.text}</span>
                  </div>
                  <span className="dash-feed-time">{relativeTime(item.time)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Right rail ── */}
      <div className="dash-rail">

        {/* Mini calendar */}
        <div className="dash-rail-section">
          <div className="dash-mini-cal-header">
            <button className="dash-mini-cal-nav" onClick={()=>{ if(calMonth===0){setCalMonth(11);setCalYear(y=>y-1)}else setCalMonth(m=>m-1) }}>‹</button>
            <span className="dash-mini-cal-title">{MONTHS_SHORT[calMonth]} {calYear}</span>
            <button className="dash-mini-cal-nav" onClick={()=>{ if(calMonth===11){setCalMonth(0);setCalYear(y=>y+1)}else setCalMonth(m=>m+1) }}>›</button>
          </div>
          <div className="dash-mini-cal-days">
            {DAYS.map(d=><span key={d} className="dash-mini-cal-dow">{d.slice(0,1)}</span>)}
          </div>
          <div className="dash-mini-cal-grid">
            {miniCells.map((day,i)=>{
              if(!day) return <div key={i} className="dash-mini-cal-cell dash-mini-cal-cell--empty" />
              const dateStr = toDateStr(calYear,calMonth,day)
              const dayCases = caseDateSet[dateStr]||[]
              const isToday = today.getFullYear()===calYear && today.getMonth()===calMonth && today.getDate()===day
              return (
                <div key={i} className={`dash-mini-cal-cell${isToday?' dash-mini-cal-cell--today':''}`} title={dayCases.map(c=>c.name).join(', ')||undefined}>
                  <span className="dash-mini-cal-day">{day}</span>
                  {dayCases.length>0 && (
                    <div className="dash-mini-cal-dots">
                      {dayCases.slice(0,3).map(c=><span key={c.id} className="dash-mini-cal-dot" style={{background:c.color}} />)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Upcoming */}
        <div className="dash-rail-section">
          <div className="dash-rail-label">Upcoming — 7 days</div>
          {upcomingCases.length===0 ? (
            <div className="dash-rail-empty">No upcoming deadlines</div>
          ) : (
            upcomingCases.map(c=>{
              const rd = relativeDate(c.date)
              const isUrgent = rd==='Today'||rd==='Tomorrow'
              return (
                <div key={c.id} className={`dash-upcoming-row${isUrgent?' dash-upcoming-row--urgent':''}`} onClick={()=>onOpenCase(c)}>
                  <span className="dash-upcoming-dot" style={{background:c.color}} />
                  <span className="dash-upcoming-name">{c.name}</span>
                  <span className="dash-upcoming-date">{rd}</span>
                </div>
              )
            })
          )}
        </div>

        {/* System status */}
        <div className="dash-rail-section">
          <div className="dash-rail-label">System</div>
          <div className="dash-status-row">
            <span className={`dash-status-dot${ollamaStatus?.ok?' dash-status-dot--ok':ollamaStatus?' dash-status-dot--err':' dash-status-dot--idle'}`} />
            <span className="dash-status-name">Ollama</span>
            <span className="dash-status-detail">{ollamaStatus?.ok ? `${ollamaStatus.models.length} model${ollamaStatus.models.length!==1?'s':''}` : ollamaStatus ? 'Offline' : '…'}</span>
          </div>
          <div className="dash-status-row">
            <span className={`dash-status-dot${totalDocs>0?' dash-status-dot--ok':' dash-status-dot--idle'}`} />
            <span className="dash-status-name">Documents</span>
            <span className="dash-status-detail">{totalDocs} indexed</span>
          </div>
          <div className="dash-status-row">
            <span className={`dash-status-dot${lawStatus?.available?' dash-status-dot--ok':lawStatus?' dash-status-dot--err':' dash-status-dot--idle'}`} />
            <span className="dash-status-name">Caselaw</span>
            <span className="dash-status-detail">{lawStatus?.available ? `${lawStatus.rows?.toLocaleString()} entries` : lawStatus ? 'No corpus' : '…'}</span>
          </div>
        </div>
      </div>

      {/* ── Modals ── */}
      {modal && <AddCaseModal initialDate={modal.date} onConfirm={handleAddCase} onCancel={()=>setModal(null)} />}

      {deleteCaseConfirm && (
        <div className="cal-modal-overlay" onClick={()=>setDeleteCaseConfirm(null)}>
          <div className="cal-modal cal-modal--sm" onClick={e=>e.stopPropagation()}>
            <div className="cal-modal-header">
              <span>Delete Case</span>
              <button className="cal-modal-close" onClick={()=>setDeleteCaseConfirm(null)}>✕</button>
            </div>
            <div className="cal-modal-body">
              <p style={{margin:'0 0 10px',fontSize:14}}>Permanently delete <strong>{deleteCaseConfirm.c.name}</strong>?</p>
              <ul className="cal-delete-list">
                {deleteCaseConfirm.docCount>0 && <li>{deleteCaseConfirm.docCount} document{deleteCaseConfirm.docCount!==1?'s':''} &amp; PDFs</li>}
                <li>All extractions, notes, and analysis</li>
                <li>Search index &amp; embeddings</li>
              </ul>
            </div>
            <div className="cal-modal-footer">
              <button className="cal-btn cal-btn--ghost" onClick={()=>setDeleteCaseConfirm(null)}>Cancel</button>
              <button className="cal-btn cal-btn--danger" onClick={confirmDeleteCase}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

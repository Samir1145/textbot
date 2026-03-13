/**
 * Persistent storage via local REST API (server.js).
 * Data is saved to the `data/` directory on disk and survives computer restarts.
 */

// ── Helpers ──

async function postJSON(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    return res.json()
}

// ── Trash ──

export async function saveTrash(trashItems) {
    await postJSON('/api/storage/trash', trashItems.map(({ file, ...meta }) => meta))
}

export async function loadTrash() {
    const res = await fetch('/api/storage/trash')
    return res.json()
}

// ── Summaries ──

export async function saveSummary(docId, text, { caseId } = {}) {
    await postJSON(`/api/cases/${encodeURIComponent(caseId)}/summaries/${docId}`, { text, createdAt: new Date().toISOString() })
}

export async function loadSummary(docId, { caseId } = {}) {
    const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/summaries/${docId}`)
    if (!res.ok) return ''
    const entry = await res.json()
    return entry?.text || ''
}

export async function deleteSummary(docId, { caseId } = {}) {
    await fetch(`/api/cases/${encodeURIComponent(caseId)}/summaries/${docId}`, { method: 'DELETE' })
}

// ── Skill Results ──

export async function saveSkillResult(docId, skillId, text, { caseId } = {}) {
    await postJSON(`/api/cases/${encodeURIComponent(caseId)}/skill-results/${docId}/${skillId}`, { text, createdAt: new Date().toISOString() })
}

export async function loadSkillResult(docId, skillId, { caseId } = {}) {
    const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/skill-results/${docId}/${skillId}`)
    if (!res.ok) return ''
    const entry = await res.json()
    return entry?.text || ''
}

export async function loadSavedSkillIds(docId, { caseId } = {}) {
    const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/skill-results/${docId}`)
    if (!res.ok) return []
    return res.json()
}

// ── Case Blobs ──

export async function uploadCaseBlob(caseId, docId, name, file) {
    const buffer = await file.arrayBuffer()
    await fetch(`/api/cases/${encodeURIComponent(caseId)}/blobs/${docId}?name=${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
    })
}

export async function loadCaseBlob(caseId, docId, name) {
    const url = `/api/cases/${encodeURIComponent(caseId)}/blobs/${docId}`
    try {
        // Check browser Cache API first — avoids re-downloading the PDF on every reload
        if ('caches' in window) {
            const cache     = await caches.open('textbot-pdfs-v1')
            const cached    = await cache.match(url)
            if (cached) {
                const blob = await cached.blob()
                return new File([blob], name, { type: 'application/pdf' })
            }
        }

        const r = await fetch(url)
        if (!r.ok) return null

        // Persist to cache in the background (don't block the return)
        if ('caches' in window) {
            caches.open('textbot-pdfs-v1')
                .then(cache => cache.put(url, r.clone()))
                .catch(() => {})
        }

        const blob = await r.blob()
        return new File([blob], name, { type: 'application/pdf' })
    } catch {
        return null
    }
}

// ── Chat History ──

/**
 * Load chat messages for a doc. Citations are stored as [[n, chunk], ...] arrays
 * and restored to Map<number, chunk> on load.
 */
export async function loadChatHistory(docId, { caseId } = {}) {
    if (!caseId) return []
    try {
        const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/chat/${encodeURIComponent(docId)}`)
        if (!res.ok) return []
        const msgs = await res.json()
        if (!Array.isArray(msgs)) return []
        return msgs.map(msg => ({
            role: msg.role,
            content: msg.content,
            citations: msg.citations_data
                ? new Map(msg.citations_data.map(([k, v]) => [k, v]))
                : undefined,
        }))
    } catch {
        return []
    }
}

/**
 * Persist the full chat message array for a doc.
 * Citations Map is serialized to [[n, chunk], ...] for JSON storage.
 */
export async function saveChatHistory(docId, messages, { caseId } = {}) {
    if (!caseId) return
    const serializable = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        citations_data: msg.citations ? [...msg.citations.entries()] : undefined,
    }))
    await postJSON(`/api/cases/${encodeURIComponent(caseId)}/chat/${encodeURIComponent(docId)}`, serializable)
}

// ── PDF Notes ──

export async function loadNotes(docId, { caseId } = {}) {
    if (!caseId) return []
    try {
        const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/notes/${encodeURIComponent(docId)}`)
        if (!res.ok) return []
        return res.json()
    } catch { return [] }
}

export async function saveNotes(docId, notes, { caseId } = {}) {
    if (!caseId) return
    await postJSON(`/api/cases/${encodeURIComponent(caseId)}/notes/${encodeURIComponent(docId)}`, notes)
}

// Returns all notes across every document in a case: { [docId]: NoteObject[] }
export async function loadAllNotes(caseId) {
    if (!caseId) return {}
    try {
        const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/all-notes`)
        if (!res.ok) return {}
        return res.json()
    } catch { return {} }
}

// ── Case Delete ──

export async function deleteCase(caseId) {
    await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { method: 'DELETE' })
}

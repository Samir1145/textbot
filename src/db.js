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
    try {
        const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}/blobs/${docId}`)
        if (!r.ok) return null
        const blob = await r.blob()
        return new File([blob], name, { type: 'application/pdf' })
    } catch {
        return null
    }
}

// ── Case Delete ──

export async function deleteCase(caseId) {
    await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { method: 'DELETE' })
}

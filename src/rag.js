/**
 * Client helpers for the local RAG API (server.js → sqlite-vec).
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** Returns { [docId]: chunkCount } for all indexed docs in a case — single DB round-trip. */
export async function getCaseRagStatus(caseId) {
    try {
        const res = await fetch(`/api/rag/case-status?caseId=${encodeURIComponent(caseId)}`)
        if (!res.ok) return {}
        return res.json()
    } catch {
        return {}
    }
}

/** Returns { indexed: bool, chunks: number } for a document. */
export async function getDocRagStatus(docId, { caseId } = {}) {
    try {
        const url = caseId
            ? `/api/rag/doc-status/${docId}?caseId=${encodeURIComponent(caseId)}`
            : `/api/rag/doc-status/${docId}`
        const res = await fetch(url)
        if (!res.ok) return { indexed: false, chunks: 0 }
        return res.json()
    } catch {
        return { indexed: false, chunks: 0 }
    }
}

/**
 * Clear all indexed chunks for a document (call before re-indexing).
 */
export async function clearDocChunks(docId, { caseId } = {}) {
    const url = caseId
        ? `/api/rag/clear-doc/${encodeURIComponent(docId)}?caseId=${encodeURIComponent(caseId)}`
        : `/api/rag/clear-doc/${encodeURIComponent(docId)}`
    const res = await fetch(url, { method: 'DELETE' })
    if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`Clear error ${res.status}: ${body.error ?? 'unknown'}`)
    }
    return res.json()
}

/**
 * Remove chunks not present in the keep list (stale chunk cleanup after incremental index).
 * keep: [{ pageNum, chunkIdx }]
 */
export async function pruneDocChunks(docId, keep, { caseId } = {}) {
    try {
        const res = await fetch('/api/rag/prune-doc', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ docId, keep, caseId }),
        })
        if (!res.ok) throw new Error(`Prune error ${res.status}`)
        return res.json()
    } catch {
        return { ok: false, pruned: 0 }
    }
}

/**
 * Index a batch of paragraph chunks for a document.
 * chunks: [{ pageNum, chunkIdx, text, bbox }]
 */
export async function indexDocPages(docId, chunks, { caseId } = {}) {
    const res = await fetch('/api/rag/index-doc', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ docId, chunks, caseId }),
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`Index error ${res.status}: ${body.error ?? 'unknown'}`)
    }
    return res.json()
}

/**
 * Semantic search within an indexed document.
 * Returns [{ page_num, text, distance }]
 */
export async function searchDocChunks(docId, query, k = 3, { caseId, windowSize = 0 } = {}) {
    try {
        const res = await fetch('/api/rag/search', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ docId, query, k, caseId, windowSize }),
        })
        if (!res.ok) return []
        return res.json()
    } catch {
        return []
    }
}

/**
 * Semantic search across ALL documents in a case.
 * Returns [{ doc_id, page_num, text, distance }]
 */
export async function searchCaseChunks(caseId, query, k = 5) {
    try {
        const res = await fetch('/api/rag/search-case', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ caseId, query, k }),
        })
        if (!res.ok) return []
        return res.json()
    } catch {
        return []
    }
}

/**
 * Index format categories (skips already-indexed ones).
 * categories: [{ name, description }]
 */
export async function initFormatCategories(categories) {
    const res = await fetch('/api/rag/init-categories', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ categories }),
    })
    if (!res.ok) throw new Error(`init-categories error ${res.status}`)
    return res.json()
}

/**
 * Get top-K suggested format categories for a query text.
 * Returns [{ name, description, distance }]
 */
export async function suggestFormatCategories(query, k = 5) {
    try {
        const res = await fetch('/api/rag/suggest-formats', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ query, k }),
        })
        if (!res.ok) return []
        return res.json()
    } catch {
        return []
    }
}

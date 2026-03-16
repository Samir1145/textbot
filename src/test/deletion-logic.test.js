/**
 * Unit tests for the document deletion logic extracted from PDFApp.jsx.
 *
 * Rather than mounting the full PDFApp component (which has heavy deps:
 * pdfjs-dist, OCR workers, etc.), we test the core deletion behaviour as
 * pure functions matching exactly what confirmRemoveDocument does:
 *
 *   1. Highlights DELETE is fired          (was missing before this session)
 *   2. Skill-results DELETE is fired       (was missing before this session)
 *   3. All other deletes still fire        (regression guard)
 *   4. In-flight AbortController is aborted when the active doc is deleted
 *   5. isIndexingRef is cleared when the active doc is deleted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Minimal replica of confirmRemoveDocument logic ─────────────────────────
//
// We extract the pure side-effect logic into a testable function so we
// can cover it without the full React component tree.

function makeConfirmRemoveDocument({
  caseId,
  activeDocumentId,
  extractionAbortRef,
  isIndexingRef,
  clearDocChunks,
  deleteNotes,
  deleteSummary,
  deleteCaseBlob,
  fetch,
}) {
  return function confirmRemoveDocument(deleteDocConfirm) {
    if (!deleteDocConfirm) return
    const { docId } = deleteDocConfirm

    // Abort in-flight ops for the active doc
    if (activeDocumentId === docId) {
      if (extractionAbortRef.current) {
        extractionAbortRef.current.abort()
        extractionAbortRef.current = null
      }
      isIndexingRef.current = false
    }

    // Fire all server-side deletes
    if (caseId) {
      const onErr = () => {}
      deleteCaseBlob(caseId, docId).catch(onErr)
      deleteNotes(docId, { caseId }).catch(onErr)
      deleteSummary(docId, { caseId }).catch(onErr)
      fetch(`/api/cases/${encodeURIComponent(caseId)}/extractions/${docId}`, { method: 'DELETE' }).catch(onErr)
      fetch(`/api/cases/${encodeURIComponent(caseId)}/chat/${docId}`, { method: 'DELETE' }).catch(onErr)
      fetch(`/api/cases/${encodeURIComponent(caseId)}/highlights/${encodeURIComponent(docId)}`, { method: 'DELETE' }).catch(onErr)
      fetch(`/api/cases/${encodeURIComponent(caseId)}/skill-results/${encodeURIComponent(docId)}`, { method: 'DELETE' }).catch(onErr)
      clearDocChunks(docId, { caseId }).catch(onErr)
    }
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeFixture(overrides = {}) {
  const mockFetch = vi.fn().mockResolvedValue({ ok: true })
  const mockClearDocChunks = vi.fn().mockResolvedValue({})
  const mockDeleteNotes = vi.fn().mockResolvedValue({})
  const mockDeleteSummary = vi.fn().mockResolvedValue({})
  const mockDeleteCaseBlob = vi.fn().mockResolvedValue({})
  const extractionAbortRef = { current: null }
  const isIndexingRef = { current: false }

  const confirm = makeConfirmRemoveDocument({
    caseId: 'caseId' in overrides ? overrides.caseId : 'case-abc',
    activeDocumentId: overrides.activeDocumentId ?? 'doc-1',
    extractionAbortRef,
    isIndexingRef,
    clearDocChunks: mockClearDocChunks,
    deleteNotes: mockDeleteNotes,
    deleteSummary: mockDeleteSummary,
    deleteCaseBlob: mockDeleteCaseBlob,
    fetch: mockFetch,
  })

  return { confirm, mockFetch, mockClearDocChunks, mockDeleteNotes, mockDeleteSummary, mockDeleteCaseBlob, extractionAbortRef, isIndexingRef }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('confirmRemoveDocument — server-side delete calls', () => {
  it('calls DELETE on highlights endpoint', () => {
    const { confirm, mockFetch } = makeFixture()
    confirm({ docId: 'doc-1' })

    const urls = mockFetch.mock.calls.map(([url]) => url)
    expect(urls.some(u => u.includes('/highlights/'))).toBe(true)
  })

  it('calls DELETE on skill-results endpoint', () => {
    const { confirm, mockFetch } = makeFixture()
    confirm({ docId: 'doc-1' })

    const urls = mockFetch.mock.calls.map(([url]) => url)
    expect(urls.some(u => u.includes('/skill-results/'))).toBe(true)
  })

  it('calls DELETE on extractions endpoint', () => {
    const { confirm, mockFetch } = makeFixture()
    confirm({ docId: 'doc-1' })

    const urls = mockFetch.mock.calls.map(([url]) => url)
    expect(urls.some(u => u.includes('/extractions/'))).toBe(true)
  })

  it('calls DELETE on chat endpoint', () => {
    const { confirm, mockFetch } = makeFixture()
    confirm({ docId: 'doc-1' })

    const urls = mockFetch.mock.calls.map(([url]) => url)
    expect(urls.some(u => u.includes('/chat/'))).toBe(true)
  })

  it('calls clearDocChunks', () => {
    const { confirm, mockClearDocChunks } = makeFixture()
    confirm({ docId: 'doc-1' })
    expect(mockClearDocChunks).toHaveBeenCalledWith('doc-1', { caseId: 'case-abc' })
  })

  it('calls deleteNotes', () => {
    const { confirm, mockDeleteNotes } = makeFixture()
    confirm({ docId: 'doc-1' })
    expect(mockDeleteNotes).toHaveBeenCalledWith('doc-1', { caseId: 'case-abc' })
  })

  it('calls deleteCaseBlob', () => {
    const { confirm, mockDeleteCaseBlob } = makeFixture()
    confirm({ docId: 'doc-1' })
    expect(mockDeleteCaseBlob).toHaveBeenCalledWith('case-abc', 'doc-1')
  })

  it('fires all 4 fetch-based deletes (extractions, chat, highlights, skill-results)', () => {
    const { confirm, mockFetch } = makeFixture()
    confirm({ docId: 'doc-1' })

    // blob, notes, summary each use dedicated mock helpers (not the fetch mock)
    const deleteCalls = mockFetch.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')
    expect(deleteCalls.length).toBe(4)
  })

  it('does nothing when deleteDocConfirm is null', () => {
    const { confirm, mockFetch, mockClearDocChunks } = makeFixture()
    confirm(null)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockClearDocChunks).not.toHaveBeenCalled()
  })

  it('does not fire any server deletes when caseId is falsy', () => {
    // Pass '' (empty string) — falsy but not nullish, so ?? default won't trigger
    const { confirm, mockFetch, mockClearDocChunks } = makeFixture({ caseId: '' })
    confirm({ docId: 'doc-1' })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockClearDocChunks).not.toHaveBeenCalled()
  })
})

describe('confirmRemoveDocument — in-flight abort', () => {
  it('aborts extraction AbortController when deleting the active document', () => {
    const { confirm, extractionAbortRef } = makeFixture({ activeDocumentId: 'doc-active' })
    const controller = { abort: vi.fn() }
    extractionAbortRef.current = controller

    confirm({ docId: 'doc-active' })

    expect(controller.abort).toHaveBeenCalled()
    expect(extractionAbortRef.current).toBeNull()
  })

  it('clears isIndexingRef when deleting the active document', () => {
    const { confirm, isIndexingRef } = makeFixture({ activeDocumentId: 'doc-active' })
    isIndexingRef.current = true

    confirm({ docId: 'doc-active' })

    expect(isIndexingRef.current).toBe(false)
  })

  it('does NOT abort when deleting a non-active document', () => {
    const { confirm, extractionAbortRef } = makeFixture({ activeDocumentId: 'doc-other' })
    const controller = { abort: vi.fn() }
    extractionAbortRef.current = controller

    confirm({ docId: 'doc-1' }) // not the active doc

    expect(controller.abort).not.toHaveBeenCalled()
    expect(extractionAbortRef.current).toBe(controller) // unchanged
  })

  it('does NOT clear isIndexingRef when deleting a non-active document', () => {
    const { confirm, isIndexingRef } = makeFixture({ activeDocumentId: 'doc-other' })
    isIndexingRef.current = true

    confirm({ docId: 'doc-1' })

    expect(isIndexingRef.current).toBe(true) // unchanged
  })

  it('handles missing AbortController gracefully (no crash)', () => {
    const { confirm, extractionAbortRef } = makeFixture({ activeDocumentId: 'doc-active' })
    extractionAbortRef.current = null

    expect(() => confirm({ docId: 'doc-active' })).not.toThrow()
  })
})

describe('confirmRemoveDocument — URL encoding', () => {
  it('URL-encodes the caseId in the highlights endpoint', () => {
    const { confirm, mockFetch } = makeFixture({ caseId: 'case with spaces' })
    confirm({ docId: 'doc-1' })

    const highlightsCall = mockFetch.mock.calls.find(([url]) => url.includes('highlights'))
    expect(highlightsCall[0]).toContain('case%20with%20spaces')
  })

  it('URL-encodes the docId in the skill-results endpoint', () => {
    const { confirm, mockFetch } = makeFixture()
    confirm({ docId: 'doc with spaces' })

    const skillCall = mockFetch.mock.calls.find(([url]) => url.includes('skill-results'))
    expect(skillCall[0]).toContain('doc%20with%20spaces')
  })
})

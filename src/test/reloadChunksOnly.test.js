/**
 * Unit tests for the reloadChunksOnly / auto-index guard logic from PDFApp.jsx.
 *
 * These are integration-style unit tests that test the CONDITION LOGIC extracted
 * from the React hooks — without mounting the full component.  The goal is to
 * verify that the guard predicates (Path 2 gate, Fix B auto-index guard) behave
 * correctly given different combinations of state values.
 *
 * Covered logic:
 *
 *   Path 2 gate (in reloadChunksOnly):
 *     const knownIndexed = ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId]
 *     if (!knownIndexed || !pdfDocRef.current) return
 *
 *   Fix B auto-index guard (in the auto-index useEffect):
 *     const knownIndexed = !!docChunkCountsById[activeDocumentId]
 *     if (extractedPages && ragStatusChecked && ragStatus === null &&
 *         !knownIndexed && !extractingText && activeDocumentId && (hasCachedPages || pdfDoc)) {
 *       handleIndexDocument()
 *     }
 *
 *   Recovery effect gate:
 *     const chunkCount = extractedPages?.reduce(…) ?? 0
 *     const knownIndexed = ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId]
 *     if (!knownIndexed || chunkCount > 0 || !activeDocumentId) return
 *     reloadChunksOnly()
 */

import { describe, it, expect, vi } from 'vitest'

// ─── Replica: Path 2 gate ────────────────────────────────────────────────────
// Returns true if Path 2 should proceed, false if it should bail out early.
function shouldRunPath2({ ragStatus, docChunkCountsById, activeDocumentId, pdfDoc }) {
  const knownIndexed = ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId]
  if (!knownIndexed || !pdfDoc) return false
  return true
}

// ─── Replica: Fix B — auto-index guard ──────────────────────────────────────
// Returns true if handleIndexDocument should be called.
function shouldAutoIndex({
  extractedPages,
  ragStatusChecked,
  ragStatus,
  docChunkCountsById,
  extractingText,
  activeDocumentId,
  hasCachedPages,
  pdfDoc,
}) {
  const knownIndexed = !!docChunkCountsById[activeDocumentId]
  return !!(
    extractedPages &&
    ragStatusChecked &&
    ragStatus === null &&
    !knownIndexed &&
    !extractingText &&
    activeDocumentId &&
    (hasCachedPages || pdfDoc)
  )
}

// ─── Replica: recovery effect gate ──────────────────────────────────────────
// Returns true if reloadChunksOnly should be called.
function shouldReloadChunks({ ragStatus, docChunkCountsById, activeDocumentId, extractedPages }) {
  const chunkCount = extractedPages?.reduce((s, p) => s + (p.chunks?.length ?? 0), 0) ?? 0
  const knownIndexed = ragStatus === 'indexed' || !!docChunkCountsById[activeDocumentId]
  if (!knownIndexed || chunkCount > 0 || !activeDocumentId) return false
  return true
}

// ─── Path 2 gate tests ───────────────────────────────────────────────────────

describe('reloadChunksOnly — Path 2 gate', () => {
  const base = {
    ragStatus: 'indexed',
    docChunkCountsById: {},
    activeDocumentId: 'doc-1',
    pdfDoc: { numPages: 10 }, // truthy pdfDoc
  }

  it('proceeds when ragStatus=indexed and pdfDoc is loaded', () => {
    expect(shouldRunPath2(base)).toBe(true)
  })

  it('proceeds when docChunkCountsById has a count for the doc (even if ragStatus is null)', () => {
    expect(shouldRunPath2({
      ...base,
      ragStatus: null,
      docChunkCountsById: { 'doc-1': 42 },
    })).toBe(true)
  })

  it('bails when neither ragStatus=indexed NOR docChunkCountsById has a count', () => {
    expect(shouldRunPath2({
      ...base,
      ragStatus: null,
      docChunkCountsById: {},
    })).toBe(false)
  })

  it('bails when pdfDoc is null even if knownIndexed is true', () => {
    expect(shouldRunPath2({ ...base, pdfDoc: null })).toBe(false)
  })

  it('bails when pdfDoc is undefined', () => {
    expect(shouldRunPath2({ ...base, pdfDoc: undefined })).toBe(false)
  })

  it('docChunkCountsById[docId]=0 is falsy — does not count as knownIndexed', () => {
    // 0 is falsy in JS; a zero count should not satisfy the knownIndexed guard
    expect(shouldRunPath2({
      ...base,
      ragStatus: null,
      docChunkCountsById: { 'doc-1': 0 },
    })).toBe(false)
  })
})

// ─── Fix B — auto-index guard tests ─────────────────────────────────────────

describe('Fix B — auto-index guard: !extractingText prevents early embed trigger', () => {
  const base = {
    extractedPages: [{ pageNum: 1, chunks: [{ text: 'x' }] }],
    ragStatusChecked: true,
    ragStatus: null,
    docChunkCountsById: {},
    extractingText: false,
    activeDocumentId: 'doc-1',
    hasCachedPages: true,
    pdfDoc: null,
  }

  it('triggers indexing when all conditions are met', () => {
    expect(shouldAutoIndex(base)).toBe(true)
  })

  it('does NOT trigger when extractingText=true (Fix B)', () => {
    expect(shouldAutoIndex({ ...base, extractingText: true })).toBe(false)
  })

  it('does NOT trigger when ragStatus is already "indexed"', () => {
    expect(shouldAutoIndex({ ...base, ragStatus: 'indexed' })).toBe(false)
  })

  it('does NOT trigger when ragStatus is "indexing"', () => {
    expect(shouldAutoIndex({ ...base, ragStatus: 'indexing' })).toBe(false)
  })

  it('does NOT trigger when ragStatusChecked is false (DB result not yet arrived)', () => {
    expect(shouldAutoIndex({ ...base, ragStatusChecked: false })).toBe(false)
  })

  it('does NOT trigger when docChunkCountsById has a cached count (already indexed)', () => {
    expect(shouldAutoIndex({
      ...base,
      docChunkCountsById: { 'doc-1': 50 },
    })).toBe(false)
  })

  it('does NOT trigger when extractedPages is null (no text yet)', () => {
    expect(shouldAutoIndex({ ...base, extractedPages: null })).toBe(false)
  })

  it('does NOT trigger when activeDocumentId is null', () => {
    expect(shouldAutoIndex({ ...base, activeDocumentId: null })).toBe(false)
  })

  it('does NOT trigger when neither hasCachedPages nor pdfDoc are available', () => {
    expect(shouldAutoIndex({ ...base, hasCachedPages: false, pdfDoc: null })).toBe(false)
  })

  it('triggers when pdfDoc is available even if hasCachedPages is false', () => {
    expect(shouldAutoIndex({ ...base, hasCachedPages: false, pdfDoc: { numPages: 5 } })).toBe(true)
  })
})

// ─── Recovery effect gate tests ──────────────────────────────────────────────

describe('recovery effect — shouldReloadChunks gate', () => {
  const base = {
    ragStatus: 'indexed',
    docChunkCountsById: {},
    activeDocumentId: 'doc-1',
    extractedPages: null, // no chunks yet → chunkCount = 0
  }

  it('triggers reload when doc is indexed but no chunks are displayed', () => {
    expect(shouldReloadChunks(base)).toBe(true)
  })

  it('does NOT trigger when chunkCount > 0 (chunks already visible)', () => {
    expect(shouldReloadChunks({
      ...base,
      extractedPages: [{ pageNum: 1, chunks: [{ text: 'a' }, { text: 'b' }] }],
    })).toBe(false)
  })

  it('does NOT trigger when knownIndexed is false', () => {
    expect(shouldReloadChunks({
      ...base,
      ragStatus: null,
      docChunkCountsById: {},
    })).toBe(false)
  })

  it('triggers when docChunkCountsById has a count even if ragStatus is not "indexed"', () => {
    expect(shouldReloadChunks({
      ...base,
      ragStatus: null,
      docChunkCountsById: { 'doc-1': 30 },
    })).toBe(true)
  })

  it('does NOT trigger when activeDocumentId is null', () => {
    expect(shouldReloadChunks({ ...base, activeDocumentId: null })).toBe(false)
  })

  it('does NOT trigger when activeDocumentId is empty string', () => {
    expect(shouldReloadChunks({ ...base, activeDocumentId: '' })).toBe(false)
  })

  it('counts chunks from multiple pages correctly', () => {
    // 2 pages with 2 chunks each = 4 total → chunkCount > 0 → no reload
    expect(shouldReloadChunks({
      ...base,
      extractedPages: [
        { pageNum: 1, chunks: [{ text: 'a' }, { text: 'b' }] },
        { pageNum: 2, chunks: [{ text: 'c' }, { text: 'd' }] },
      ],
    })).toBe(false)
  })

  it('treats pages with undefined chunks as 0 via nullish coalescing', () => {
    // Page has no chunks property → treated as 0 → chunkCount stays 0 → should reload
    expect(shouldReloadChunks({
      ...base,
      extractedPages: [{ pageNum: 1 }], // no chunks key
    })).toBe(true)
  })
})

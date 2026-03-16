/**
 * Unit tests for src/utils/parseCitations.js
 * Covers the functions that were modified in this session:
 *   buildEvidenceBlock  — now uses windowText when present
 *   parseCitations      — extracts [n] markers
 *   tokeniseMessage     — splits text into segments + citation numbers
 *   distanceToScore     — converts vector distance to 0-100 score
 */

import { describe, it, expect } from 'vitest'
import {
  buildEvidenceBlock,
  parseCitations,
  tokeniseMessage,
  distanceToScore,
} from '../utils/parseCitations.js'

// ── buildEvidenceBlock ──────────────────────────────────────────────────────

describe('buildEvidenceBlock', () => {
  it('returns empty ragContext and empty chunkMap for zero chunks', () => {
    const { ragContext, chunkMap } = buildEvidenceBlock([])
    expect(ragContext).toBe('')
    expect(chunkMap.size).toBe(0)
  })

  it('uses chunk.text when windowText is absent', () => {
    const chunks = [
      { page_num: 1, text: 'Plain text sentence.' },
    ]
    const { ragContext, chunkMap } = buildEvidenceBlock(chunks)
    expect(ragContext).toContain('Plain text sentence.')
    expect(chunkMap.get(1).text).toBe('Plain text sentence.')
  })

  it('uses chunk.windowText in the evidence block when present', () => {
    const chunks = [
      {
        page_num: 2,
        text: 'Core sentence.',
        windowText: 'Preceding sentence. Core sentence. Following sentence.',
      },
    ]
    const { ragContext } = buildEvidenceBlock(chunks)
    // windowText should appear instead of bare text
    expect(ragContext).toContain('Preceding sentence. Core sentence. Following sentence.')
    expect(ragContext).not.toContain('Core sentence.\n')
  })

  it('numbers chunks starting at 1', () => {
    const chunks = [
      { page_num: 1, text: 'Alpha' },
      { page_num: 2, text: 'Beta' },
      { page_num: 3, text: 'Gamma' },
    ]
    const { chunkMap } = buildEvidenceBlock(chunks)
    expect(chunkMap.get(1).text).toBe('Alpha')
    expect(chunkMap.get(2).text).toBe('Beta')
    expect(chunkMap.get(3).text).toBe('Gamma')
    expect(chunkMap.has(4)).toBe(false)
  })

  it('includes provenance prefix when doc_id + docLabels provided', () => {
    const chunks = [{ page_num: 5, text: 'Evidence text.', doc_id: 'doc-42' }]
    const docLabels = new Map([['doc-42', 'Contract.pdf']])
    const { ragContext } = buildEvidenceBlock(chunks, { docLabels })
    expect(ragContext).toContain('[Contract.pdf]')
  })

  it('uses raw doc_id as prefix when no docLabels supplied', () => {
    const chunks = [{ page_num: 5, text: 'Evidence text.', doc_id: 'doc-42' }]
    const { ragContext } = buildEvidenceBlock(chunks)
    expect(ragContext).toContain('[doc-42]')
  })

  it('includes the page number in the evidence block', () => {
    const chunks = [{ page_num: 7, text: 'Some passage.' }]
    const { ragContext } = buildEvidenceBlock(chunks)
    expect(ragContext).toContain('Page 7:')
  })
})

// ── parseCitations ──────────────────────────────────────────────────────────

describe('parseCitations', () => {
  const makeChunkMap = (nums) =>
    new Map(nums.map(n => [n, { page_num: n, text: `chunk ${n}` }]))

  it('returns empty map for text with no citation markers', () => {
    const cited = parseCitations('No markers here.', makeChunkMap([1, 2]))
    expect(cited.size).toBe(0)
  })

  it('extracts a single citation marker', () => {
    const cited = parseCitations('See [1] for details.', makeChunkMap([1, 2, 3]))
    expect(cited.size).toBe(1)
    expect(cited.get(1).text).toBe('chunk 1')
  })

  it('extracts multiple distinct citation markers', () => {
    const cited = parseCitations('Cf. [2] and [3].', makeChunkMap([1, 2, 3]))
    expect(cited.size).toBe(2)
    expect(cited.has(2)).toBe(true)
    expect(cited.has(3)).toBe(true)
  })

  it('deduplicates repeated markers', () => {
    const cited = parseCitations('[1] first mention. [1] again.', makeChunkMap([1, 2]))
    expect(cited.size).toBe(1)
  })

  it('ignores markers not present in chunkMap', () => {
    const cited = parseCitations('Referenced [99] here.', makeChunkMap([1, 2]))
    expect(cited.size).toBe(0)
  })

  it('returns the correct chunk objects', () => {
    const map = makeChunkMap([1, 2])
    const cited = parseCitations('[1] and [2] cited.', map)
    expect(cited.get(1)).toEqual(map.get(1))
    expect(cited.get(2)).toEqual(map.get(2))
  })
})

// ── tokeniseMessage ─────────────────────────────────────────────────────────

describe('tokeniseMessage', () => {
  it('returns single string segment when no markers present', () => {
    expect(tokeniseMessage('Hello world')).toEqual(['Hello world'])
  })

  it('splits around a single marker', () => {
    expect(tokeniseMessage('See [1] here.')).toEqual(['See ', 1, ' here.'])
  })

  it('splits around multiple markers', () => {
    expect(tokeniseMessage('[1] and [2] end')).toEqual([1, ' and ', 2, ' end'])
  })

  it('handles adjacent markers', () => {
    expect(tokeniseMessage('[1][2]')).toEqual([1, 2])
  })

  it('returns integer citation numbers, not strings', () => {
    const parts = tokeniseMessage('[42] text')
    expect(typeof parts[0]).toBe('number')
    expect(parts[0]).toBe(42)
  })

  it('handles text that starts and ends with a marker', () => {
    expect(tokeniseMessage('[1] middle [2]')).toEqual([1, ' middle ', 2])
  })

  it('returns empty array for empty string', () => {
    expect(tokeniseMessage('')).toEqual([])
  })
})

// ── distanceToScore ─────────────────────────────────────────────────────────

describe('distanceToScore', () => {
  it('returns 100 for distance 0 (perfect match)', () => {
    expect(distanceToScore(0)).toBe(100)
  })

  it('returns 0 for very large distance', () => {
    expect(distanceToScore(10)).toBe(0)
  })

  it('returns a value in [0, 100] for typical cosine distances', () => {
    // Typical normalized embedding distances are in [0, 2]
    for (const d of [0, 0.2, 0.5, 0.8, 1.0, 1.4, 1.9]) {
      const score = distanceToScore(d)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })

  it('returns an integer', () => {
    expect(Number.isInteger(distanceToScore(0.5))).toBe(true)
  })

  it('is monotonically decreasing: larger distance → lower score', () => {
    expect(distanceToScore(0.1)).toBeGreaterThan(distanceToScore(0.5))
    expect(distanceToScore(0.5)).toBeGreaterThan(distanceToScore(1.0))
  })
})

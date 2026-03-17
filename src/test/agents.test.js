/**
 * Unit tests for the AGENTS marketplace array defined in PDFApp.jsx (Phase 21).
 *
 * Since AGENTS is not exported, we replicate it here.  Any structural change to
 * the array in PDFApp.jsx must be reflected in the copy below.
 *
 * Tests cover:
 *   - Required fields are present on every agent entry
 *   - agent IDs are unique
 *   - color values are valid 6-digit hex strings
 *   - string fields are non-empty
 *   - icon field is a non-empty string (emoji or text)
 *   - defaultTask is a meaningful prompt (> 20 chars)
 */

import { describe, it, expect } from 'vitest'

// ── Replica of PDFApp.jsx AGENTS array ──────────────────────────────────────

const AGENTS = [
  { id: 'case-summarizer',   icon: '📋', color: '#2563eb', name: 'Case Summarizer',      tagline: 'Structured brief from all case documents',    defaultTask: 'Summarise all documents in this case into a structured legal brief with key facts, issues, and arguments.' },
  { id: 'contract-reviewer', icon: '📝', color: '#059669', name: 'Contract Reviewer',    tagline: 'Red flags and liability clause scanner',      defaultTask: 'Review all contracts for liability clauses, red flags, unusual terms, and missing standard provisions.' },
  { id: 'evidence-analyzer', icon: '🔍', color: '#d97706', name: 'Evidence Analyzer',    tagline: 'Timeline builder from exhibits and statements', defaultTask: 'Build a chronological timeline of events from exhibits, witness statements, and supporting documents.' },
  { id: 'due-diligence',     icon: '✅', color: '#7c3aed', name: 'Due Diligence Agent',  tagline: 'Comprehensive cross-document risk review',     defaultTask: 'Conduct a comprehensive due diligence review across all case documents and flag material risks.' },
  { id: 'legal-research',    icon: '⚖️', color: '#dc2626', name: 'Legal Research',       tagline: 'Statutes, precedents, and citations',          defaultTask: 'Identify all statutory references, case citations, and legal precedents mentioned in the documents.' },
]

// ── Required fields ──────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['id', 'icon', 'color', 'name', 'tagline', 'defaultTask']

describe('AGENTS array — structure', () => {
  it('contains at least one agent', () => {
    expect(AGENTS.length).toBeGreaterThanOrEqual(1)
  })

  it('every agent has all required fields', () => {
    for (const agent of AGENTS) {
      for (const field of REQUIRED_FIELDS) {
        expect(agent, `agent "${agent.id}" missing field "${field}"`).toHaveProperty(field)
      }
    }
  })

  it('agent IDs are unique', () => {
    const ids = AGENTS.map(a => a.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('agent IDs are non-empty strings', () => {
    for (const agent of AGENTS) {
      expect(typeof agent.id).toBe('string')
      expect(agent.id.length).toBeGreaterThan(0)
    }
  })

  it('agent names are non-empty strings', () => {
    for (const agent of AGENTS) {
      expect(typeof agent.name).toBe('string')
      expect(agent.name.length).toBeGreaterThan(0)
    }
  })

  it('taglines are non-empty strings', () => {
    for (const agent of AGENTS) {
      expect(typeof agent.tagline).toBe('string')
      expect(agent.tagline.length).toBeGreaterThan(0)
    }
  })

  it('icons are non-empty strings', () => {
    for (const agent of AGENTS) {
      expect(typeof agent.icon).toBe('string')
      expect(agent.icon.length).toBeGreaterThan(0)
    }
  })

  it('defaultTask is a meaningful prompt (> 20 chars)', () => {
    for (const agent of AGENTS) {
      expect(typeof agent.defaultTask).toBe('string')
      expect(agent.defaultTask.length).toBeGreaterThan(20)
    }
  })
})

// ── Color validation ──────────────────────────────────────────────────────────

describe('AGENTS array — color values', () => {
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

  it('all colors are valid 6-digit hex strings', () => {
    for (const agent of AGENTS) {
      expect(agent.color, `agent "${agent.id}" has invalid color "${agent.color}"`).toMatch(HEX_COLOR_RE)
    }
  })

  it('colors are unique across agents (no duplicate brand colors)', () => {
    const colors = AGENTS.map(a => a.color.toLowerCase())
    const unique = new Set(colors)
    expect(unique.size).toBe(colors.length)
  })
})

// ── ID format ────────────────────────────────────────────────────────────────

describe('AGENTS array — ID format', () => {
  it('agent IDs use only lowercase letters, digits, and hyphens (kebab-case)', () => {
    const KEBAB_RE = /^[a-z0-9-]+$/
    for (const agent of AGENTS) {
      expect(agent.id, `agent ID "${agent.id}" is not kebab-case`).toMatch(KEBAB_RE)
    }
  })

  it('agent IDs do not start or end with a hyphen', () => {
    for (const agent of AGENTS) {
      expect(agent.id).not.toMatch(/^-/)
      expect(agent.id).not.toMatch(/-$/)
    }
  })
})

// ── Named agents present ─────────────────────────────────────────────────────

describe('AGENTS array — expected agents present', () => {
  const agentIds = AGENTS.map(a => a.id)

  it('includes case-summarizer', () => expect(agentIds).toContain('case-summarizer'))
  it('includes contract-reviewer', () => expect(agentIds).toContain('contract-reviewer'))
  it('includes evidence-analyzer', () => expect(agentIds).toContain('evidence-analyzer'))
  it('includes due-diligence', () => expect(agentIds).toContain('due-diligence'))
  it('includes legal-research', () => expect(agentIds).toContain('legal-research'))
})

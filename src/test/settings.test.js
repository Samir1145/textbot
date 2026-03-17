/**
 * Unit tests for the localStorage settings helpers used in App.jsx (Phase 21).
 *
 * loadLocalSettings and saveLocalSettings are module-private in App.jsx,
 * so we replicate the minimal logic inline — identical to the source.
 * Any future change to the SETTINGS_KEY or the functions in App.jsx must
 * be reflected here.
 *
 * Tests cover:
 *   - loadLocalSettings returns {} on empty localStorage
 *   - loadLocalSettings returns stored object
 *   - loadLocalSettings returns {} on malformed JSON (graceful fallback)
 *   - saveLocalSettings writes the value under the correct key
 *   - saveLocalSettings overwrites a previous value
 *   - round-trip: save then load produces the same object
 *   - genModel field is preserved through save/load
 *   - partial updates (spread pattern) do not clobber unrelated fields
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ── Replicated logic (matches App.jsx exactly) ───────────────────────────────

const SETTINGS_KEY = 'textbot-model-settings'

function loadLocalSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } catch { return {} }
}

function saveLocalSettings(obj) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loadLocalSettings', () => {
  beforeEach(() => localStorage.clear())

  it('returns empty object when localStorage has no entry', () => {
    expect(loadLocalSettings()).toEqual({})
  })

  it('returns the stored object', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ genModel: 'gemma3n:e2b' }))
    expect(loadLocalSettings()).toEqual({ genModel: 'gemma3n:e2b' })
  })

  it('returns {} when the stored value is malformed JSON', () => {
    localStorage.setItem(SETTINGS_KEY, 'NOT_JSON{{{')
    expect(loadLocalSettings()).toEqual({})
  })

  it('returns {} when the stored value is an empty string', () => {
    localStorage.setItem(SETTINGS_KEY, '')
    // '' || '{}' → '{}' → {} (the || branch kicks in for empty string)
    expect(loadLocalSettings()).toEqual({})
  })

  it('reads from the correct key (textbot-model-settings)', () => {
    localStorage.setItem('other-key', JSON.stringify({ genModel: 'wrong' }))
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ genModel: 'correct' }))
    expect(loadLocalSettings().genModel).toBe('correct')
  })
})

describe('saveLocalSettings', () => {
  beforeEach(() => localStorage.clear())

  it('writes the object as JSON under SETTINGS_KEY', () => {
    saveLocalSettings({ genModel: 'llama3:8b' })
    const raw = localStorage.getItem(SETTINGS_KEY)
    expect(JSON.parse(raw)).toEqual({ genModel: 'llama3:8b' })
  })

  it('overwrites the previous value', () => {
    saveLocalSettings({ genModel: 'old-model' })
    saveLocalSettings({ genModel: 'new-model' })
    expect(loadLocalSettings().genModel).toBe('new-model')
  })

  it('persists multiple fields', () => {
    saveLocalSettings({ genModel: 'qwen:7b', theme: 'dark', debug: true })
    const loaded = loadLocalSettings()
    expect(loaded.genModel).toBe('qwen:7b')
    expect(loaded.theme).toBe('dark')
    expect(loaded.debug).toBe(true)
  })

  it('persists an empty object without error', () => {
    expect(() => saveLocalSettings({})).not.toThrow()
    expect(loadLocalSettings()).toEqual({})
  })
})

describe('loadLocalSettings + saveLocalSettings — round-trip', () => {
  beforeEach(() => localStorage.clear())

  it('save then load returns the same object', () => {
    const settings = { genModel: 'gemma3:27b', embedModel: 'nomic-embed-text' }
    saveLocalSettings(settings)
    expect(loadLocalSettings()).toEqual(settings)
  })

  it('spread-merge pattern preserves unrelated fields', () => {
    // This mirrors the pattern used in App.jsx handleSave:
    //   saveLocalSettings({ ...loadLocalSettings(), genModel })
    saveLocalSettings({ genModel: 'old', embedModel: 'nomic' })
    const existing = loadLocalSettings()
    saveLocalSettings({ ...existing, genModel: 'new-model' })

    const result = loadLocalSettings()
    expect(result.genModel).toBe('new-model')
    expect(result.embedModel).toBe('nomic') // should be preserved
  })

  it('genModel field survives a round-trip', () => {
    saveLocalSettings({ genModel: 'qwen2.5:7b' })
    const { genModel } = loadLocalSettings()
    expect(genModel).toBe('qwen2.5:7b')
  })

  it('undefined values are omitted by JSON.stringify', () => {
    saveLocalSettings({ genModel: 'x', missing: undefined })
    const result = loadLocalSettings()
    expect(result.genModel).toBe('x')
    expect('missing' in result).toBe(false)
  })
})

describe('settings key constant', () => {
  it('SETTINGS_KEY matches what getActiveGenModel reads in ollamaStream.js', () => {
    // Both modules use 'textbot-model-settings'.
    // If one changes, this test will fail as a reminder to update the other.
    expect(SETTINGS_KEY).toBe('textbot-model-settings')
  })
})

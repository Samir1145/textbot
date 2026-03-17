/**
 * Unit tests for src/utils/ollamaStream.js
 *
 * Covers:
 *   - getActiveGenModel() — localStorage override vs backend.model fallback
 *   - LLM_BACKEND_NAME / LLM_MODEL_NAME exports
 *   - streamOllamaChat — mocked fetch, streaming behaviour
 *   - callOllama — mocked fetch, non-streaming path
 *   - checkLlmHealth — ping endpoint selection per backend
 *
 * NOTE: VITE_LLM_BACKEND defaults to 'ollama' in test environment (import.meta.env
 * is empty unless overridden), so all tests assume the ollama backend.
 *
 * getActiveGenModel is NOT exported from ollamaStream.js — it is used internally
 * by streamOllamaChat and callOllama as the default model parameter. We test it
 * indirectly: when localStorage carries a genModel override, streamOllamaChat
 * should use that model in the request body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { streamOllamaChat, callOllama, checkLlmHealth, LLM_BACKEND_NAME, LLM_MODEL_NAME } from '../utils/ollamaStream.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFetchStub(lines, status = 200) {
  const encoder = new TextEncoder()
  const chunks = lines.map(l => encoder.encode(l + '\n'))
  let idx = 0
  const reader = {
    read: vi.fn(async () => {
      if (idx >= chunks.length) return { done: true, value: undefined }
      return { done: false, value: chunks[idx++] }
    }),
  }
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    body: { getReader: () => reader },
    json: vi.fn().mockResolvedValue({}),
  })
}

function makeNdjsonLine(content) {
  return JSON.stringify({ message: { content } })
}

// ─── LLM_BACKEND_NAME / LLM_MODEL_NAME ────────────────────────────────────

describe('LLM_BACKEND_NAME and LLM_MODEL_NAME', () => {
  it('LLM_BACKEND_NAME is a non-empty string', () => {
    expect(typeof LLM_BACKEND_NAME).toBe('string')
    expect(LLM_BACKEND_NAME.length).toBeGreaterThan(0)
  })

  it('LLM_MODEL_NAME is a non-empty string', () => {
    expect(typeof LLM_MODEL_NAME).toBe('string')
    expect(LLM_MODEL_NAME.length).toBeGreaterThan(0)
  })

  it('LLM_BACKEND_NAME defaults to "ollama" in test environment', () => {
    // import.meta.env.VITE_LLM_BACKEND is undefined in vitest → 'ollama'
    expect(LLM_BACKEND_NAME).toBe('ollama')
  })
})

// ─── getActiveGenModel (tested indirectly via streamOllamaChat) ─────────────

describe('getActiveGenModel — localStorage override', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('uses localStorage genModel when set', async () => {
    localStorage.setItem('textbot-model-settings', JSON.stringify({ genModel: 'custom-model:7b' }))

    const stub = makeFetchStub([makeNdjsonLine('hello')])
    vi.stubGlobal('fetch', stub)

    await streamOllamaChat({ messages: [{ role: 'user', content: 'hi' }], onChunk: () => {} })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.model).toBe('custom-model:7b')
  })

  it('falls back to backend.model when localStorage has no genModel', async () => {
    localStorage.setItem('textbot-model-settings', JSON.stringify({}))

    const stub = makeFetchStub([makeNdjsonLine('hi')])
    vi.stubGlobal('fetch', stub)

    await streamOllamaChat({ messages: [{ role: 'user', content: 'hi' }], onChunk: () => {} })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.model).toBe(LLM_MODEL_NAME)
  })

  it('falls back to backend.model when localStorage contains malformed JSON', async () => {
    localStorage.setItem('textbot-model-settings', 'NOT_JSON{{{')

    const stub = makeFetchStub([makeNdjsonLine('hi')])
    vi.stubGlobal('fetch', stub)

    // Should not throw
    await streamOllamaChat({ messages: [{ role: 'user', content: 'hi' }], onChunk: () => {} })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.model).toBe(LLM_MODEL_NAME)
  })

  it('falls back when localStorage is empty', async () => {
    // localStorage.clear() already called in beforeEach
    const stub = makeFetchStub([makeNdjsonLine('hi')])
    vi.stubGlobal('fetch', stub)

    await streamOllamaChat({ messages: [{ role: 'user', content: 'hi' }], onChunk: () => {} })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.model).toBe(LLM_MODEL_NAME)
  })

  it('model override from localStorage is passed through callOllama too', async () => {
    localStorage.setItem('textbot-model-settings', JSON.stringify({ genModel: 'override-model' }))

    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ message: { content: 'response' } }),
    })
    vi.stubGlobal('fetch', stub)

    await callOllama({ messages: [{ role: 'user', content: 'hi' }] })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.model).toBe('override-model')
  })
})

// ─── streamOllamaChat ────────────────────────────────────────────────────────

describe('streamOllamaChat', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns accumulated text from streamed chunks', async () => {
    const stub = makeFetchStub([
      makeNdjsonLine('Hello'),
      makeNdjsonLine(', '),
      makeNdjsonLine('world'),
    ])
    vi.stubGlobal('fetch', stub)

    const result = await streamOllamaChat({
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: () => {},
    })
    expect(result).toBe('Hello, world')
  })

  it('calls onChunk on every token with accumulated text so far', async () => {
    const stub = makeFetchStub([makeNdjsonLine('A'), makeNdjsonLine('B'), makeNdjsonLine('C')])
    vi.stubGlobal('fetch', stub)

    const calls = []
    await streamOllamaChat({
      messages: [],
      onChunk: (text) => calls.push(text),
    })

    expect(calls).toEqual(['A', 'AB', 'ABC'])
  })

  it('throws when the server returns an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(
      streamOllamaChat({ messages: [], onChunk: () => {} })
    ).rejects.toThrow('LLM returned 500')
  })

  it('sends stream: true in the request body', async () => {
    const stub = makeFetchStub([makeNdjsonLine('x')])
    vi.stubGlobal('fetch', stub)

    await streamOllamaChat({ messages: [], onChunk: () => {} })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.stream).toBe(true)
  })

  it('uses explicit model override when provided', async () => {
    const stub = makeFetchStub([makeNdjsonLine('x')])
    vi.stubGlobal('fetch', stub)

    await streamOllamaChat({ messages: [], model: 'explicit-model', onChunk: () => {} })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.model).toBe('explicit-model')
  })

  it('ignores empty / null content lines in NDJSON stream', async () => {
    // Lines with no content field should be silently skipped
    const stub = makeFetchStub([
      '{"message": {"role": "assistant"}}', // no content key
      makeNdjsonLine('valid'),
    ])
    vi.stubGlobal('fetch', stub)

    const result = await streamOllamaChat({ messages: [], onChunk: () => {} })
    expect(result).toBe('valid')
  })
})

// ─── callOllama ─────────────────────────────────────────────────────────────

describe('callOllama', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns the response content string on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ message: { content: 'Answer text' } }),
    }))

    const result = await callOllama({ messages: [{ role: 'user', content: 'q' }] })
    expect(result).toBe('Answer text')
  })

  it('returns null when the server returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const result = await callOllama({ messages: [] })
    expect(result).toBeNull()
  })

  it('returns null when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await callOllama({ messages: [] })
    expect(result).toBeNull()
  })

  it('sends stream: false in the request body', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ message: { content: 'x' } }),
    })
    vi.stubGlobal('fetch', stub)

    await callOllama({ messages: [] })

    const body = JSON.parse(stub.mock.calls[0][1].body)
    expect(body.stream).toBe(false)
  })

  it('returns null when response JSON lacks message.content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ something: 'else' }),
    }))
    const result = await callOllama({ messages: [] })
    expect(result).toBeNull()
  })
})

// ─── checkLlmHealth ─────────────────────────────────────────────────────────

describe('checkLlmHealth', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns { ok: true } when ping succeeds with status < 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
    const result = await checkLlmHealth()
    expect(result).toEqual({ ok: true })
  })

  it('returns { ok: false } when ping returns status >= 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }))
    const result = await checkLlmHealth()
    expect(result).toEqual({ ok: false })
  })

  it('returns { ok: false, error: ... } when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await checkLlmHealth()
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('pings the ollama tags endpoint for ollama backend', async () => {
    const stub = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', stub)
    await checkLlmHealth()
    const url = stub.mock.calls[0][0]
    expect(url).toContain('/api/ollama/api/tags')
  })
})

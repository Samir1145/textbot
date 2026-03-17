/**
 * LLM API helpers — supports Ollama and Llamafile backends.
 *
 * Backend is selected via VITE_LLM_BACKEND env var (default: 'ollama').
 *   ollama    → POST /api/ollama/api/chat          NDJSON streaming
 *   llamafile → POST /api/llamafile/v1/chat/completions  OpenAI SSE streaming
 *
 * To use llamafile: add VITE_LLM_BACKEND=llamafile to a .env.local file,
 * and run llamafiler with a chat model:
 *   ./llamafile/llamafiler -m ./llamafile/<chat-model>.gguf
 */

const LLM_BACKEND = (import.meta.env.VITE_LLM_BACKEND || 'ollama').toLowerCase()

const BACKENDS = {
  ollama: {
    url:   '/api/ollama/api/chat',
    model: import.meta.env.VITE_OLLAMA_MODEL || 'gemma3n:e2b',
    headers: {
      'Content-Type':  'application/json',
      ...(import.meta.env.VITE_OLLAMA_API_KEY
        ? { 'Authorization': `Bearer ${import.meta.env.VITE_OLLAMA_API_KEY}` }
        : {}),
    },
    buildBody: (model, messages, stream) =>
      JSON.stringify({ model, messages, stream }),
    /** Parse a single NDJSON line → content string or null */
    parseLine: (line) => {
      try { return JSON.parse(line).message?.content ?? null } catch { return null }
    },
    buildBodyNonStream: (model, messages) =>
      JSON.stringify({ model, messages, stream: false }),
    parseNonStream: (json) => json.message?.content ?? null,
  },
  llamafile: {
    url:   '/api/llamafile/v1/chat/completions',
    model: import.meta.env.VITE_LLAMAFILE_MODEL || 'model.gguf',
    headers: { 'Content-Type': 'application/json' },
    buildBody: (model, messages, stream) =>
      JSON.stringify({ model, messages, stream }),
    /** Parse a single SSE data line → content string or null */
    parseLine: (line) => {
      if (!line.startsWith('data: ')) return null
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return null
      try { return JSON.parse(payload).choices?.[0]?.delta?.content ?? null } catch { return null }
    },
    buildBodyNonStream: (model, messages) =>
      JSON.stringify({ model, messages, stream: false }),
    parseNonStream: (json) => json.choices?.[0]?.message?.content ?? null,
  },
}

const backend = BACKENDS[LLM_BACKEND] ?? BACKENDS.ollama

/** Exported so the connectivity banner knows which backend/model is active. */
export const LLM_BACKEND_NAME = LLM_BACKEND
export const LLM_MODEL_NAME   = backend.model

/** Returns the active generative model — localStorage override takes priority. */
function getActiveGenModel() {
  try {
    const s = JSON.parse(localStorage.getItem('textbot-model-settings') || '{}')
    return s.genModel || backend.model
  } catch { return backend.model }
}

/**
 * Lightweight ping — does NOT send a full chat request.
 * Returns { ok: bool, error?: string }
 */
export async function checkLlmHealth() {
  const pingUrl = LLM_BACKEND === 'llamafile'
    ? '/api/llamafile/v1/models'
    : '/api/ollama/api/tags'
  try {
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(3000) })
    return { ok: res.status < 500 }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Stream a chat response.
 * Calls onChunk(accumulatedText) on every token received.
 * Returns the final accumulated string.
 */
export async function streamOllamaChat({ messages, model = getActiveGenModel(), signal, onChunk }) {
  const res = await fetch(backend.url, {
    method: 'POST',
    headers: backend.headers,
    signal,
    body: backend.buildBody(model, messages, true),
  })
  if (!res.ok) throw new Error(`LLM returned ${res.status}`)

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let accumulated = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value, { stream: true }).split('\n').filter(Boolean)) {
      const content = backend.parseLine(line)
      if (content) {
        accumulated += content
        onChunk?.(accumulated)
      }
    }
  }
  return accumulated
}

/**
 * Single-shot (non-streaming) call.
 * Returns the response content string, or null on failure.
 */
export async function callOllama({ messages, model = getActiveGenModel(), signal } = {}) {
  try {
    const res = await fetch(backend.url, {
      method: 'POST',
      headers: backend.headers,
      signal,
      body: backend.buildBodyNonStream(model, messages),
    })
    if (!res.ok) return null
    return backend.parseNonStream(await res.json())
  } catch {
    return null
  }
}

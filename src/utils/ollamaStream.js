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
      'Authorization': 'Bearer 68d73d3a870148f6818d364c549c2bc3._C2su8V3eWzsWN5F7Zk27DGt',
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

/**
 * Stream a chat response.
 * Calls onChunk(accumulatedText) on every token received.
 * Returns the final accumulated string.
 */
export async function streamOllamaChat({ messages, model = backend.model, signal, onChunk }) {
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
export async function callOllama({ messages, model = backend.model, signal } = {}) {
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

/**
 * Shared Ollama API helpers.
 * All Ollama calls in the app should go through these to keep auth, model,
 * and streaming logic in one place.
 */

const OLLAMA_URL   = '/api/ollama/api/chat'
const OLLAMA_MODEL = 'gemma3n:e2b'
const OLLAMA_AUTH  = 'Bearer 68d73d3a870148f6818d364c549c2bc3._C2su8V3eWzsWN5F7Zk27DGt'

const OLLAMA_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': OLLAMA_AUTH,
}

/**
 * Stream a chat response from Ollama.
 * Calls onChunk(accumulatedText) on every token received.
 * Returns the final accumulated string.
 */
export async function streamOllamaChat({ messages, model = OLLAMA_MODEL, signal, onChunk }) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: OLLAMA_HEADERS,
    signal,
    body: JSON.stringify({ model, messages, stream: true }),
  })
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`)

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let accumulated = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value, { stream: true }).split('\n').filter(Boolean)) {
      try {
        const json = JSON.parse(line)
        // qwen3 models emit thinking tokens before real content — skip lines
        // that only have a `thinking` field and no actual `content`.
        const content = json.message?.content
        if (content) {
          accumulated += content
          onChunk?.(accumulated)
        }
      } catch { /* partial JSON line */ }
    }
  }
  return accumulated
}

/**
 * Single-shot (non-streaming) Ollama call.
 * Returns the response content string, or null on failure.
 */
export async function callOllama({ messages, model = OLLAMA_MODEL, signal } = {}) {
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: OLLAMA_HEADERS,
      signal,
      body: JSON.stringify({ model, messages, stream: false }),
    })
    if (!res.ok) return null
    const { message } = await res.json()
    return message?.content ?? null
  } catch {
    return null
  }
}

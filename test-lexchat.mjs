/**
 * LexChat / RAG tests
 *
 * Requires: Ollama running with a chat model loaded.
 * Skipped automatically if Ollama is unreachable.
 *
 * A. Chat input and send button are present
 * B. Sending a question produces a response
 * C. Response contains at least one source citation
 * D. Clicking a citation activates the highlight in the PDF
 * E. Follow-up suggestion chips appear after response
 * F. Chat history persists after page reload
 */

import { openCase, uploadPDF, extractAndIndex, makeTextPDF, makeAssert, runTest, BASE } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

// ── Check Ollama ──────────────────────────────────────────────────────────────
async function ollamaAvailable() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) }).catch(() => null)
    if (!res?.ok) return false
    const data = await res.json()
    return Array.isArray(data.models) && data.models.length > 0
  } catch { return false }
}

if (!(await ollamaAvailable())) {
  console.log('SKIP — Ollama not running or no models loaded.')
  process.exit(0)
}

await runTest('Test A–F — LexChat / RAG', async (page) => {
  await openCase(page, 'LexChat-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-chat.pdf', [
    'The indemnification clause requires Party B to cover all legal costs.',
    'Dispute resolution shall proceed via binding arbitration in Hong Kong.',
    'Governing law is the law of the Hong Kong Special Administrative Region.',
  ]))
  await extractAndIndex(page, 1)
  await page.waitForTimeout(1000)

  // A — chat input and send button
  const chatInput = await page.$('.pdfapp-chat-input')
  const sendBtn = await page.$('.pdfapp-chat-send')
  check(!!chatInput, 'chat input present')
  check(!!sendBtn, 'chat send button present')

  // B — send question and wait for response
  await chatInput.fill('What does the contract say about dispute resolution?')
  await sendBtn.click()

  // Wait for response (stream starts, stops when done — send button goes back to normal)
  try {
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('.pdfapp-chat-send')
        const msgs = document.querySelectorAll('.pdfapp-chat-bubble')
        // Assistant message appeared and send button is not in stop mode
        return msgs.length >= 2 && !btn?.classList.contains('pdfapp-chat-send--stop')
      },
      { timeout: 60000 }
    )
    ok('response received from LLM')
  } catch {
    fail('response timed out after 60s')
    return
  }

  const bubbles = await page.$$('.pdfapp-chat-bubble')
  check(bubbles.length >= 2, `${bubbles.length} chat bubbles (user + assistant)`)

  // C — citation present
  const citations = await page.$$('.pdfapp-source-item')
  check(citations.length > 0, `${citations.length} citation(s) in response`)

  // D — clicking citation shows highlight
  if (citations.length > 0) {
    await citations[0].click()
    await page.waitForTimeout(800)
    const highlight = await page.$('.pdfapp-highlight-rect')
    check(!!highlight, 'clicking citation renders highlight rect in PDF')
  }

  // E — suggestion chips
  const chips = await page.$$('.pdfapp-suggestion-chip')
  check(chips.length > 0, `${chips.length} follow-up suggestion chip(s)`)

  // F — reload and check chat history persists
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 })
  const reopenBtn = await page.$('.cal-sb-open-btn')
  if (reopenBtn) { await reopenBtn.click(); await page.waitForTimeout(1500) }

  const bubblesAfterReload = await page.$$('.pdfapp-chat-bubble')
  check(bubblesAfterReload.length >= 2, `chat history persisted after reload: ${bubblesAfterReload.length} bubble(s)`)
})

process.exit(summary())

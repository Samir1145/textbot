/**
 * TextBot test runner — runs all test scripts and reports results.
 *
 * Usage:
 *   node run-tests.mjs                    # run all tests
 *   node run-tests.mjs --only chunks      # run tests whose name matches "chunks"
 *   node run-tests.mjs --skip llm         # skip tests whose name matches "llm"
 *   node run-tests.mjs --base http://...  # override base URL
 *
 * Each test file exits with code 0 (pass) or 1 (fail).
 * Tests marked [LLM] are skipped unless --llm flag is passed.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Test registry ─────────────────────────────────────────────────────────────
const TESTS = [
  // Core infrastructure
  { file: 'smoke-test.mjs',          name: 'smoke',           tags: [] },

  // PDF rendering
  { file: 'test-pdf-render.mjs',     name: 'pdf-render',      tags: [] },

  // Chunk panel
  { file: 'test-chunks.mjs',         name: 'chunks',          tags: [] },
  { file: 'test-chunk-filter.mjs',   name: 'chunk-filter',    tags: [] },
  { file: 'test-chunk-note.mjs',     name: 'chunk-note',      tags: [] },
  { file: 'test-chunk-pdf-link.mjs', name: 'chunk-pdf-link',  tags: [] },
  { file: 'test-chunk-semantic.mjs', name: 'chunk-semantic',  tags: ['llm'] },

  // Highlights / bbox
  { file: 'test-highlights.mjs',     name: 'highlights',      tags: [] },
  { file: 'test-stage1-bbox.mjs',    name: 'bbox-stage1',     tags: [] },
  { file: 'test-stage2-inspect.mjs', name: 'bbox-stage2',     tags: [] },
  { file: 'test-stage3-bbox.mjs',    name: 'bbox-stage3',     tags: [] },
  { file: 'test-stage4-bbox.mjs',    name: 'bbox-stage4',     tags: [] },

  // Notes & evidence
  { file: 'test-notes.mjs',          name: 'notes',           tags: [] },
  { file: 'test-evidence-tab.mjs',   name: 'evidence',        tags: [] },

  // LexChat
  { file: 'test-lexchat.mjs',        name: 'lexchat',         tags: ['llm'] },

  // Multi-doc & session
  { file: 'test-multi-doc.mjs',      name: 'multi-doc',       tags: [] },
  { file: 'test-session-cache.mjs',  name: 'session-cache',   tags: [] },

  // Layout & UX
  { file: 'test-panel-resize.mjs',   name: 'panel-resize',    tags: [] },
  { file: 'test-theme.mjs',          name: 'theme',           tags: [] },
  { file: 'test-agent-tab.mjs',      name: 'agent-tab',       tags: [] }, // legacy — kept for reference

  // Aide tab + soul/memory system
  { file: 'test-aide-tab.mjs',        name: 'aide-tab',        tags: [] },
  { file: 'test-aide-soul-api.mjs',   name: 'aide-soul-api',   tags: [] },
  { file: 'test-aide-soul-ui.mjs',    name: 'aide-soul-ui',    tags: [] },
  { file: 'test-aide-memory-ui.mjs',  name: 'aide-memory-ui',  tags: [] },
  { file: 'test-aide-autoresearch.mjs', name: 'aide-autoresearch', tags: [] },

  // Folder sidebar + Notes tree
  { file: 'test-folder-sidebar.mjs',  name: 'folder-sidebar',  tags: [] },

  // System features
  { file: 'test-ocr.mjs',            name: 'ocr',             tags: [] },
  { file: 'test-case-mgmt.mjs',      name: 'case-mgmt',       tags: [] },
]

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const onlyPattern  = args[args.indexOf('--only') + 1]  || null
const skipPattern  = args[args.indexOf('--skip') + 1]  || null
const baseUrl      = args[args.indexOf('--base') + 1]  || null
const includeLLM   = args.includes('--llm')

// ── Filter tests ──────────────────────────────────────────────────────────────
const testsToRun = TESTS.filter(t => {
  const path = join(__dir, t.file)
  if (!existsSync(path)) return false
  if (onlyPattern && !t.name.includes(onlyPattern)) return false
  if (skipPattern && t.name.includes(skipPattern)) return false
  if (t.tags.includes('llm') && !includeLLM) return false
  return true
})

const skipped = TESTS.filter(t => {
  if (!existsSync(join(__dir, t.file))) return false
  if (t.tags.includes('llm') && !includeLLM) return true
  if (onlyPattern && !t.name.includes(onlyPattern)) return true
  if (skipPattern && t.name.includes(skipPattern)) return true
  return false
})

// ── Runner ────────────────────────────────────────────────────────────────────
async function runTest(test) {
  const path = join(__dir, test.file)
  const env = { ...process.env }
  if (baseUrl) env.BASE_URL = baseUrl

  return new Promise(resolve => {
    const start = Date.now()
    const proc = spawn('node', [path], { env, stdio: 'pipe' })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d; process.stdout.write(d) })
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(d) })
    proc.on('close', code => {
      resolve({ name: test.name, code, elapsed: Date.now() - start, stdout, stderr })
    })
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`)
console.log(` TextBot Test Suite`)
console.log(` Running: ${testsToRun.length} tests   Skipped: ${skipped.length}`)
if (!includeLLM) console.log(' (LLM tests skipped — pass --llm to include)')
console.log(`${'═'.repeat(50)}\n`)

const results = []
for (const test of testsToRun) {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(` ${test.name}`)
  console.log(`${'─'.repeat(50)}`)
  const result = await runTest(test)
  results.push(result)
}

// ── Summary ───────────────────────────────────────────────────────────────────
const passed  = results.filter(r => r.code === 0)
const failed  = results.filter(r => r.code !== 0)

console.log(`\n${'═'.repeat(50)}`)
console.log(` RESULTS`)
console.log(`${'═'.repeat(50)}`)

for (const r of results) {
  const icon = r.code === 0 ? '✓' : '✗'
  const time = (r.elapsed / 1000).toFixed(1) + 's'
  console.log(` ${icon} ${r.name.padEnd(20)} ${time}`)
}

if (skipped.length) {
  console.log(`\n Skipped (${skipped.length}): ${skipped.map(t => t.name).join(', ')}`)
}

console.log(`\n ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed.length > 0 ? 1 : 0)

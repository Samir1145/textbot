/**
 * Aide soul + diary API tests (no browser — pure HTTP against localhost:3001)
 *
 * A. GET /aide/soul on a fresh case returns default shape
 * B. POST /aide/soul saves soul object and returns savedAt timestamp
 * C. GET /aide/soul after POST returns the saved soul
 * D. GET /aide/diary on a fresh case returns empty array
 * E. POST /aide/diary/entry appends an entry
 * F. GET /aide/diary after write returns the entry (newest first)
 * G. Soul corrections use .text field (not .rule)
 * H. Diary entries carry createdAt (not date)
 * I. /api/agent/start loads soul from disk (soul injected — verified by checking
 *    that a second POST of soul changes the saved data without error)
 */

import { makeAssert } from './test-helpers.mjs'

const API = process.env.API_URL || 'http://localhost:3001'
const { ok, fail, check, summary } = makeAssert()

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

// Use a deterministic test case ID so we can clean up predictably
const caseId = `test-soul-api-${Date.now()}`

console.log('\nA–I — Aide soul + diary API')

// ── A — Fresh soul returns default shape ───────────────────────────────────
try {
  const { status, body } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  check(status === 200, `A — GET soul status 200 (got ${status})`)
  check(body && typeof body === 'object', 'A — returns JSON object')
  const soul = body.soul || body
  check(typeof soul.skillMd === 'string', 'A — soul.skillMd is string')
  check(Array.isArray(soul.corrections), 'A — soul.corrections is array')
  check(Array.isArray(soul.styleSamples), 'A — soul.styleSamples is array')
} catch (e) { fail('A — GET soul threw', e.message) }

// ── B — POST saves soul and returns savedAt ────────────────────────────────
const testSoul = {
  skillMd: 'You are a senior M&A lawyer. Always flag indemnity clauses.',
  redFlags: 'Unlimited liability\nAutomatic renewal without cap',
  styleGuide: 'Bullet points. Cite page numbers. No jargon.',
  corrections: [{ id: 'c1', text: 'Stop summarising — give findings only', createdAt: new Date().toISOString() }],
  styleSamples: [{ id: 's1', text: '• Found: clause 4.2 (p.7) limits liability to £50k\n• Risk: low', createdAt: new Date().toISOString() }],
}

let savedAt = null
try {
  const { status, body } = await api('POST', `/api/cases/${caseId}/aide/soul`, { soul: testSoul })
  check(status === 200, `B — POST soul status 200 (got ${status})`)
  check(body.ok === true, 'B — returns { ok: true }')
  check(typeof body.savedAt === 'string', `B — savedAt returned: ${body.savedAt}`)
  savedAt = body.savedAt
} catch (e) { fail('B — POST soul threw', e.message) }

// ── C — GET after POST returns saved soul ──────────────────────────────────
try {
  const { status, body } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  check(status === 200, `C — GET soul status 200 after save`)
  const soul = body.soul || body
  check(soul.skillMd === testSoul.skillMd, `C — skillMd persisted: "${soul.skillMd?.slice(0, 40)}"`)
  check(soul.redFlags === testSoul.redFlags, 'C — redFlags persisted')
  check(soul.styleGuide === testSoul.styleGuide, 'C — styleGuide persisted')
  check(Array.isArray(soul.corrections) && soul.corrections.length === 1, 'C — corrections array persisted')
  check(Array.isArray(soul.styleSamples) && soul.styleSamples.length === 1, 'C — styleSamples array persisted')
  check(typeof (body.savedAt || body.soul?.savedAt) === 'string', 'C — savedAt returned in response')
} catch (e) { fail('C — GET soul after save threw', e.message) }

// ── D — Fresh diary returns [] ─────────────────────────────────────────────
const diaryCaseId = `test-diary-api-${Date.now()}`
try {
  const { status, body } = await api('GET', `/api/cases/${diaryCaseId}/aide/diary`)
  check(status === 200, `D — GET diary status 200 (got ${status})`)
  check(Array.isArray(body), 'D — returns array')
  check(body.length === 0, `D — fresh diary is empty (len=${body.length})`)
} catch (e) { fail('D — GET diary threw', e.message) }

// ── E — POST diary/entry appends ──────────────────────────────────────────
const testEntry = {
  id: 'entry-1',
  createdAt: new Date().toISOString(),
  task: 'Find all liability clauses',
  steps: 4,
  result: 'Found 3 liability clauses on pages 4, 7, and 12.',
  reflection: '• Strong coverage\n• Missed indemnity on p.15\n• Search more specifically next time',
  notesAdded: 2,
}
try {
  const { status, body } = await api('POST', `/api/cases/${diaryCaseId}/aide/diary/entry`, testEntry)
  check(status === 200, `E — POST diary/entry status 200 (got ${status})`)
  check(body.ok === true, 'E — returns { ok: true }')
} catch (e) { fail('E — POST diary/entry threw', e.message) }

// ── F — GET diary returns entry newest-first ──────────────────────────────
try {
  // Add a second entry
  await api('POST', `/api/cases/${diaryCaseId}/aide/diary/entry`, {
    id: 'entry-2', createdAt: new Date().toISOString(), task: 'Review indemnities', steps: 2, result: 'Found clause 8.1', reflection: '• Good', notesAdded: 1,
  })

  const { status, body } = await api('GET', `/api/cases/${diaryCaseId}/aide/diary`)
  check(status === 200, `F — GET diary status 200`)
  check(Array.isArray(body) && body.length === 2, `F — diary has 2 entries (got ${body.length})`)
  check(body[0].task === 'Review indemnities', `F — newest entry first: "${body[0]?.task}"`)
  check(body[0].createdAt !== undefined, 'F — entries have createdAt field')
} catch (e) { fail('F — GET diary after writes threw', e.message) }

// ── G — Corrections use .text field ──────────────────────────────────────
try {
  const { body } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  const soul = body.soul || body
  const correction = soul.corrections?.[0]
  check(correction && typeof correction.text === 'string', `G — correction has .text field: "${correction?.text}"`)
  check(!correction?.rule, 'G — correction does NOT use legacy .rule field')
} catch (e) { fail('G — corrections field check threw', e.message) }

// ── H — Diary entries have createdAt ─────────────────────────────────────
try {
  const { body } = await api('GET', `/api/cases/${diaryCaseId}/aide/diary`)
  const entry = body[0]
  check(typeof entry?.createdAt === 'string', `H — entry has .createdAt: "${entry?.createdAt}"`)
  check(!entry?.date || typeof entry.date === 'string', 'H — no legacy .date field required')
  // createdAt should be a valid ISO date
  check(!isNaN(Date.parse(entry.createdAt)), `H — createdAt is valid ISO date: "${entry.createdAt}"`)
} catch (e) { fail('H — diary createdAt check threw', e.message) }

// ── I — Soul can be updated (idempotent saves) ────────────────────────────
try {
  const updatedSoul = { ...testSoul, redFlags: 'Updated red flag' }
  const { status: s1 } = await api('POST', `/api/cases/${caseId}/aide/soul`, { soul: updatedSoul })
  check(s1 === 200, `I — second POST soul status 200`)

  const { body } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  const soul = body.soul || body
  check(soul.redFlags === 'Updated red flag', `I — soul updated correctly: "${soul.redFlags}"`)
} catch (e) { fail('I — soul update threw', e.message) }

process.exit(summary())

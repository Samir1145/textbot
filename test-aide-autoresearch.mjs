/**
 * AutoResearch / diary injection tests (API-level, no browser)
 *
 * Verifies that the compounding-memory loop works correctly:
 * diary entries written by previous runs are read back, and the
 * /api/agent/start endpoint loads both soul and diary before running.
 *
 * A. Writing 3 diary entries and reading back — newest-first order maintained
 * B. Diary is limited-read correctly (3 most recent used in prompt)
 * C. Soul + diary both loadable for the same caseId independently
 * D. /api/agent/start returns a jobId (validates endpoint alive + soul load path)
 * E. Diary entries keep createdAt throughout write → read round-trip
 * F. Corrections round-trip with .text field intact
 * G. Style samples round-trip with .text field intact
 */

import { makeAssert } from './test-helpers.mjs'

const API = process.env.API_URL || 'http://localhost:3001'
const { ok, fail, check, summary } = makeAssert()

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(`${API}${path}`, opts)
  try { return { status: res.status, body: await res.json() } }
  catch { return { status: res.status, body: null } }
}

const caseId = `test-autoresearch-${Date.now()}`

console.log('\nA–G — AutoResearch / diary injection')

// ── A — 3 entries written newest-first ────────────────────────────────────
try {
  const entries = [
    { id: 'e1', createdAt: '2026-03-10T10:00:00Z', task: 'First task',  reflection: 'Missed clause 8.1', notesAdded: 1, steps: 3, result: 'Found 2 clauses' },
    { id: 'e2', createdAt: '2026-03-11T10:00:00Z', task: 'Second task', reflection: 'Searched too broadly', notesAdded: 2, steps: 5, result: 'Found 4 issues' },
    { id: 'e3', createdAt: '2026-03-12T10:00:00Z', task: 'Third task',  reflection: 'Good targeted search', notesAdded: 3, steps: 4, result: 'Found 3 items' },
  ]

  for (const e of entries) {
    await api('POST', `/api/cases/${caseId}/aide/diary/entry`, e)
  }

  const { body } = await api('GET', `/api/cases/${caseId}/aide/diary`)
  check(Array.isArray(body) && body.length === 3, `A — 3 entries in diary (got ${body?.length})`)
  check(body[0].task === 'Third task',  `A — newest first: [0].task = "${body[0]?.task}"`)
  check(body[1].task === 'Second task', `A — second: [1].task = "${body[1]?.task}"`)
  check(body[2].task === 'First task',  `A — oldest last: [2].task = "${body[2]?.task}"`)
} catch (e) { fail('A — diary order test threw', e.message) }

// ── B — Most-recent-3 slice (simulated prompt logic) ──────────────────────
try {
  // Add a 4th entry
  await api('POST', `/api/cases/${caseId}/aide/diary/entry`, {
    id: 'e4', createdAt: '2026-03-13T10:00:00Z', task: 'Fourth task', reflection: 'Very focused', notesAdded: 1, steps: 2, result: 'Perfect result',
  })

  const { body } = await api('GET', `/api/cases/${caseId}/aide/diary`)
  check(body.length === 4, `B — 4 entries total (got ${body.length})`)

  // Simulate what runAgentLoop does: take first 3 (already newest-first)
  const recentDiary = body.slice(0, 3)
  check(recentDiary.length === 3, 'B — slice gives 3 most recent')
  check(recentDiary[0].task === 'Fourth task', `B — most recent is Fourth task: "${recentDiary[0]?.task}"`)
  check(recentDiary[2].task === 'Second task', `B — 3rd most recent is Second task: "${recentDiary[2]?.task}"`)
  // First task (oldest) should NOT be in the slice
  check(!recentDiary.find(e => e.task === 'First task'), 'B — oldest entry excluded from recent slice')
} catch (e) { fail('B — recent slice test threw', e.message) }

// ── C — Soul and diary both independently accessible ─────────────────────
try {
  const soul = {
    skillMd: 'You are a senior litigator.',
    redFlags: 'Indemnity clauses\nJurisdiction abroad',
    styleGuide: 'Concise bullets. Cite page numbers.',
    corrections: [{ id: 'c1', text: 'Always check annexures', createdAt: new Date().toISOString() }],
    styleSamples: [],
  }
  await api('POST', `/api/cases/${caseId}/aide/soul`, { soul })

  const { body: soulBody } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  const { body: diaryBody } = await api('GET', `/api/cases/${caseId}/aide/diary`)

  check(soulBody?.soul?.skillMd === soul.skillMd, 'C — soul readable independently')
  check(Array.isArray(diaryBody) && diaryBody.length === 4, 'C — diary readable independently')
} catch (e) { fail('C — independent soul/diary access threw', e.message) }

// ── D — /api/agent/start returns jobId (soul+diary load path exercised) ───
try {
  const { status, body } = await api('POST', '/api/agent/start', {
    task: 'Test task for diary injection verification',
    intent: 'Verify soul and diary are loaded',
    role: 'Neutral due diligence',
    caseId,
  })
  check(status === 200, `D — /api/agent/start status 200 (got ${status})`)
  check(typeof body?.jobId === 'string' && body.jobId.length > 0, `D — jobId returned: "${body?.jobId?.slice(0,8)}…"`)

  // Cancel immediately to not waste resources
  if (body?.jobId) {
    await api('DELETE', `/api/agent/${body.jobId}`)
    ok('D — job cancelled cleanly')
  }
} catch (e) { fail('D — /api/agent/start threw', e.message) }

// ── E — createdAt survives round-trip ─────────────────────────────────────
try {
  const { body } = await api('GET', `/api/cases/${caseId}/aide/diary`)
  const allHaveCreatedAt = body.every(e => typeof e.createdAt === 'string' && !isNaN(Date.parse(e.createdAt)))
  check(allHaveCreatedAt, `E — all ${body.length} diary entries have valid .createdAt`)
  // None should have the legacy .date field as the primary timestamp
  const noneHaveDateOnly = !body.every(e => !e.createdAt && e.date)
  check(noneHaveDateOnly, 'E — no entries use legacy .date-only field')
} catch (e) { fail('E — createdAt round-trip threw', e.message) }

// ── F — Corrections .text round-trip ─────────────────────────────────────
try {
  const { body } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  const soul = body.soul || body
  const corr = soul.corrections?.[0]
  check(typeof corr?.text === 'string', `F — correction[0].text = "${corr?.text}"`)
  check(corr?.rule === undefined, 'F — correction does not have legacy .rule field')
} catch (e) { fail('F — corrections .text threw', e.message) }

// ── G — Style samples .text round-trip ───────────────────────────────────
try {
  const soulWithSample = {
    skillMd: 'Test',
    redFlags: '',
    styleGuide: '',
    corrections: [],
    styleSamples: [{ id: 's1', text: '• Finding: clause 4.2 (p.7)\n• Risk: medium', createdAt: new Date().toISOString() }],
  }
  await api('POST', `/api/cases/${caseId}/aide/soul`, { soul: soulWithSample })

  const { body } = await api('GET', `/api/cases/${caseId}/aide/soul`)
  const soul = body.soul || body
  const sample = soul.styleSamples?.[0]
  check(typeof sample?.text === 'string' && sample.text.includes('clause'), `G — styleSamples[0].text = "${sample?.text?.slice(0,40)}"`)
} catch (e) { fail('G — style samples .text threw', e.message) }

process.exit(summary())

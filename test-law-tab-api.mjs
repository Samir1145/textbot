/**
 * Caselaw API tests (no browser — pure HTTP against localhost:3001)
 *
 * A. GET /api/caselaw/status returns valid shape
 * B. GET /api/caselaw/status available field is a boolean
 * C. POST /api/caselaw/search with empty query returns 400
 * D. POST /api/caselaw/search with no corpus returns results array (may be empty)
 * E. POST /api/caselaw/search with filters object accepted (no 500)
 * F. GET /api/admin/caselaw/versions returns status-like object
 * G. POST /api/admin/caselaw/upload without filename returns 400
 * H. POST /api/admin/caselaw/upload with non-.db filename returns 400
 * I. POST /api/admin/caselaw/swap without filename body returns 400
 * J. POST /api/admin/caselaw/swap with unknown filename returns 404
 */

import { makeAssert } from './test-helpers.mjs'

const API = process.env.API_URL || 'http://localhost:3001'
const { ok, fail, check, summary } = makeAssert()

async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers }
  const fetchOpts = { method, headers }
  if (body !== undefined) fetchOpts.body = JSON.stringify(body)
  const res = await fetch(`${API}${path}`, fetchOpts)
  let json
  try { json = await res.json() } catch { json = null }
  return { status: res.status, body: json }
}

console.log('\nA–J — Caselaw API')

// ── A — GET /api/caselaw/status returns valid shape ────────────────────────
try {
  const { status, body } = await api('GET', '/api/caselaw/status')
  check(status === 200, `A — GET /api/caselaw/status returns 200 (got ${status})`)
  check(body !== null && typeof body === 'object', 'A — response is JSON object')
  check('available' in body, 'A — response has "available" field')
} catch (e) { fail('A — GET /api/caselaw/status threw', e.message) }

// ── B — available is boolean ───────────────────────────────────────────────
try {
  const { body } = await api('GET', '/api/caselaw/status')
  check(typeof body.available === 'boolean', `B — available is boolean (got ${typeof body.available})`)
  if (body.available) {
    check(typeof body.rows === 'number',  'B — rows is number when available')
    check(typeof body.model === 'string', 'B — model is string when available')
  } else {
    check(typeof body.message === 'string', 'B — message is string when unavailable')
  }
} catch (e) { fail('B — status shape check threw', e.message) }

// ── C — POST search with empty query returns 400 ──────────────────────────
try {
  const { status, body } = await api('POST', '/api/caselaw/search', { query: '' })
  check(status === 400, `C — empty query returns 400 (got ${status})`)
  check(body?.error?.length > 0, 'C — error message present')
} catch (e) { fail('C — empty query test threw', e.message) }

// ── D — POST search with valid query returns results array ─────────────────
try {
  const { status, body } = await api('POST', '/api/caselaw/search', { query: 'negligence duty of care', k: 3 })
  check(status === 200, `D — valid search returns 200 (got ${status})`)
  check(Array.isArray(body?.results), `D — response.results is array`)
} catch (e) { fail('D — valid search threw', e.message) }

// ── E — POST search with all filters accepted (no 500) ────────────────────
try {
  const { status } = await api('POST', '/api/caselaw/search', {
    query: 'contract breach',
    k: 5,
    filters: { court: 'UKSC', jurisdiction: 'England & Wales', yearFrom: 2015, yearTo: 2024 },
  })
  check(status !== 500, `E — search with filters does not 500 (got ${status})`)
  check(status === 200, `E — search with filters returns 200 (got ${status})`)
} catch (e) { fail('E — filtered search threw', e.message) }

// ── F — GET /api/admin/caselaw/versions returns object with available field ─
try {
  const { status, body } = await api('GET', '/api/admin/caselaw/versions')
  check(status === 200, `F — GET /api/admin/caselaw/versions returns 200 (got ${status})`)
  check(typeof body === 'object' && body !== null, 'F — response is object')
  check('available' in body, 'F — response has "available" field (returns getCaselawStatus)')
} catch (e) { fail('F — GET /api/admin/caselaw/versions threw', e.message) }

// ── G — POST upload without ?filename returns 400 ─────────────────────────
try {
  const res = await fetch(`${API}/api/admin/caselaw/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('fake'),
  })
  const body = await res.json().catch(() => null)
  check(res.status === 400, `G — upload without filename returns 400 (got ${res.status})`)
  check(body?.error?.length > 0, 'G — error message present')
} catch (e) { fail('G — upload without filename threw', e.message) }

// ── H — POST upload with non-.db filename returns 400 ─────────────────────
try {
  const res = await fetch(`${API}/api/admin/caselaw/upload?filename=caselaw.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('fake'),
  })
  const body = await res.json().catch(() => null)
  check(res.status === 400, `H — non-.db filename returns 400 (got ${res.status})`)
} catch (e) { fail('H — non-.db filename test threw', e.message) }

// ── I — POST /api/admin/caselaw/swap without body returns 400 ─────────────
try {
  const { status, body } = await api('POST', '/api/admin/caselaw/swap', {})
  check(status === 400, `I — swap without filename returns 400 (got ${status})`)
  check(body?.error?.length > 0, 'I — error message present')
} catch (e) { fail('I — swap without filename threw', e.message) }

// ── J — POST /api/admin/caselaw/swap with unknown file returns 404 ─────────
try {
  const { status, body } = await api('POST', '/api/admin/caselaw/swap', { filename: 'nonexistent-20991231.db' })
  check(status === 404, `J — swap with unknown file returns 404 (got ${status})`)
  check(body?.error?.length > 0, 'J — error message present')
} catch (e) { fail('J — swap unknown file threw', e.message) }

// ── Summary ───────────────────────────────────────────────────────────────
const failCount = summary()
process.exit(failCount > 0 ? 1 : 0)

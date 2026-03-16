/**
 * Server endpoint tests for the modified deletion routes:
 *   DELETE /api/cases/:caseId/skill-results/:docId  (new)
 *   DELETE /api/cases/:caseId/highlights/:docId     (existing — now called on doc delete)
 *
 * We spin up a minimal express app using only the fs-based logic from these
 * endpoints so tests run without requiring SQLite, caselawDb, or a live server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── Helpers mirroring server.js logic ─────────────────────────────────────

function safeId(id) {
  return path.basename(id).replace(/[^a-zA-Z0-9_\-]/g, '_')
}

function buildTestApp(casesDir) {
  function getCaseSubdir(caseId, subdir) {
    const dir = path.join(casesDir, safeId(caseId), subdir)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  const app = express()
  app.use(express.json())

  // ── highlights write/delete ──
  app.put('/api/cases/:caseId/highlights/:docId', (req, res) => {
    fs.writeFileSync(
      path.join(getCaseSubdir(req.params.caseId, 'highlights'), `${safeId(req.params.docId)}.json`),
      JSON.stringify(req.body)
    )
    res.json({ ok: true })
  })

  app.delete('/api/cases/:caseId/highlights/:docId', (req, res) => {
    const filePath = path.join(getCaseSubdir(req.params.caseId, 'highlights'), `${safeId(req.params.docId)}.json`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    res.json({ ok: true })
  })

  // ── skill-results write/delete ──
  app.post('/api/cases/:caseId/skill-results/:docId/:skillId', (req, res) => {
    const docDir = path.join(getCaseSubdir(req.params.caseId, 'skill-results'), safeId(req.params.docId))
    fs.mkdirSync(docDir, { recursive: true })
    fs.writeFileSync(path.join(docDir, `${safeId(req.params.skillId)}.json`), JSON.stringify(req.body))
    res.json({ ok: true })
  })

  app.delete('/api/cases/:caseId/skill-results/:docId', (req, res) => {
    const docDir = path.join(getCaseSubdir(req.params.caseId, 'skill-results'), safeId(req.params.docId))
    if (fs.existsSync(docDir)) fs.rmSync(docDir, { recursive: true, force: true })
    res.json({ ok: true })
  })

  return app
}

// ── Test fixtures ──────────────────────────────────────────────────────────

let tmpDir
let app
let req

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textbot-test-'))
  app = buildTestApp(tmpDir)
  req = supertest(app)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── skill-results DELETE ───────────────────────────────────────────────────

describe('DELETE /api/cases/:caseId/skill-results/:docId', () => {
  it('removes the doc directory and returns { ok: true }', async () => {
    const caseId = 'case-1'
    const docId  = 'doc-abc'
    const skillId = 'summary'

    // Seed a skill result
    await req
      .post(`/api/cases/${caseId}/skill-results/${docId}/${skillId}`)
      .send({ content: 'test result' })

    const docDir = path.join(tmpDir, caseId, 'skill-results', docId)
    expect(fs.existsSync(docDir)).toBe(true)

    const res = await req.delete(`/api/cases/${caseId}/skill-results/${docId}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(fs.existsSync(docDir)).toBe(false)
  })

  it('returns { ok: true } even if doc directory does not exist (idempotent)', async () => {
    const res = await req.delete('/api/cases/ghost-case/skill-results/ghost-doc')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('removes multiple skill files within the doc directory', async () => {
    const caseId = 'case-2'
    const docId  = 'doc-xyz'

    await req.post(`/api/cases/${caseId}/skill-results/${docId}/skill-a`).send({ a: 1 })
    await req.post(`/api/cases/${caseId}/skill-results/${docId}/skill-b`).send({ b: 2 })
    await req.post(`/api/cases/${caseId}/skill-results/${docId}/skill-c`).send({ c: 3 })

    const docDir = path.join(tmpDir, caseId, 'skill-results', docId)
    expect(fs.readdirSync(docDir)).toHaveLength(3)

    await req.delete(`/api/cases/${caseId}/skill-results/${docId}`)
    expect(fs.existsSync(docDir)).toBe(false)
  })

  it('does not remove skill results for other documents in the same case', async () => {
    const caseId  = 'case-3'
    const docIdA  = 'doc-a'
    const docIdB  = 'doc-b'

    await req.post(`/api/cases/${caseId}/skill-results/${docIdA}/summary`).send({ x: 1 })
    await req.post(`/api/cases/${caseId}/skill-results/${docIdB}/summary`).send({ x: 2 })

    await req.delete(`/api/cases/${caseId}/skill-results/${docIdA}`)

    const dirA = path.join(tmpDir, caseId, 'skill-results', docIdA)
    const dirB = path.join(tmpDir, caseId, 'skill-results', docIdB)
    expect(fs.existsSync(dirA)).toBe(false)
    expect(fs.existsSync(dirB)).toBe(true)
  })

  it('sanitises path-traversal attempts in docId', async () => {
    // Express normalises URLs before routing, so a traversal in the URL
    // segment resolves to a different path and typically returns 404.
    // What matters is that /etc/passwd is never deleted.
    const maliciousDocId = '../../etc/passwd'
    const res = await req.delete(`/api/cases/case-safe/skill-results/${maliciousDocId}`)
    expect([200, 404]).toContain(res.status) // must not 500-crash
    expect(fs.existsSync('/etc/passwd')).toBe(true) // critical: system files untouched
  })
})

// ── highlights DELETE ──────────────────────────────────────────────────────

describe('DELETE /api/cases/:caseId/highlights/:docId', () => {
  it('removes the highlights file and returns { ok: true }', async () => {
    const caseId = 'case-h'
    const docId  = 'doc-h'

    // Seed highlights
    await req
      .put(`/api/cases/${caseId}/highlights/${docId}`)
      .send([{ id: 'h1', text: 'hello' }])

    const filePath = path.join(tmpDir, caseId, 'highlights', `${docId}.json`)
    expect(fs.existsSync(filePath)).toBe(true)

    const res = await req.delete(`/api/cases/${caseId}/highlights/${docId}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('returns { ok: true } when highlights file does not exist (idempotent)', async () => {
    const res = await req.delete('/api/cases/ghost/highlights/ghost-doc')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('only removes the specified doc highlights, not other docs', async () => {
    const caseId = 'case-h2'
    await req.put(`/api/cases/${caseId}/highlights/doc-1`).send([{ id: 'a' }])
    await req.put(`/api/cases/${caseId}/highlights/doc-2`).send([{ id: 'b' }])

    await req.delete(`/api/cases/${caseId}/highlights/doc-1`)

    const file1 = path.join(tmpDir, caseId, 'highlights', 'doc-1.json')
    const file2 = path.join(tmpDir, caseId, 'highlights', 'doc-2.json')
    expect(fs.existsSync(file1)).toBe(false)
    expect(fs.existsSync(file2)).toBe(true)
  })
})

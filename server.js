import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { createHash, randomUUID } from 'crypto'
import { searchCaselaw, getCaselawStatus, swapCaselawDb, fileSha256, INCOMING_DIR as CASELAW_INCOMING } from './caselawDb.js'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')

const CASES_DIR = path.join(DATA_DIR, 'cases')
fs.mkdirSync(CASES_DIR, { recursive: true })

function getCaseSubdir(caseId, subdir) {
  const dir = path.join(CASES_DIR, safeId(caseId), subdir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const app = express()
app.use(express.json({ limit: '10mb' }))

// Sanitize ID param to prevent path traversal
function safeId(id) {
    return path.basename(id).replace(/[^a-zA-Z0-9_\-]/g, '_')
}

// ── Metadata stores (items / recent / trash) ──

const ALLOWED_STORES = new Set(['items', 'recent', 'trash'])

app.get('/api/storage/:store', (req, res) => {
    const { store } = req.params
    if (!ALLOWED_STORES.has(store)) return res.status(400).json({ error: 'Invalid store' })
    const filePath = path.join(DATA_DIR, `${store}.json`)
    if (!fs.existsSync(filePath)) return res.json([])
    try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
    catch { res.json([]) }
})

app.post('/api/storage/:store', (req, res) => {
    const { store } = req.params
    if (!ALLOWED_STORES.has(store)) return res.status(400).json({ error: 'Invalid store' })
    fs.writeFileSync(path.join(DATA_DIR, `${store}.json`), JSON.stringify(req.body))
    res.json({ ok: true })
})

// ── Case-scoped Summaries ──

app.get('/api/cases/:caseId/summaries/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'summaries'), `${safeId(req.params.docId)}.json`)
  if (!fs.existsSync(filePath)) return res.json(null)
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.json(null) }
})

app.post('/api/cases/:caseId/summaries/:docId', (req, res) => {
  fs.writeFileSync(
    path.join(getCaseSubdir(req.params.caseId, 'summaries'), `${safeId(req.params.docId)}.json`),
    JSON.stringify(req.body)
  )
  res.json({ ok: true })
})

app.delete('/api/cases/:caseId/summaries/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'summaries'), `${safeId(req.params.docId)}.json`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  res.json({ ok: true })
})

// ── Case-scoped Extractions ──

app.get('/api/cases/:caseId/extractions/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'extractions'), `${safeId(req.params.docId)}.json`)
  if (!fs.existsSync(filePath)) return res.json(null)
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.json(null) }
})

app.post('/api/cases/:caseId/extractions/:docId', (req, res) => {
  fs.writeFileSync(
    path.join(getCaseSubdir(req.params.caseId, 'extractions'), `${safeId(req.params.docId)}.json`),
    JSON.stringify(req.body)
  )
  res.json({ ok: true })
})

app.delete('/api/cases/:caseId/extractions/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'extractions'), `${safeId(req.params.docId)}.json`)
  try { fs.unlinkSync(filePath) } catch { /* already gone */ }
  res.json({ ok: true })
})

app.delete('/api/extractions/:docId', (req, res) => {
  const filePath = path.join(DATA_DIR, 'extractions', `${safeId(req.params.docId)}.json`)
  try { fs.unlinkSync(filePath) } catch { /* already gone */ }
  res.json({ ok: true })
})

// ── Case-scoped Chat History ──

app.get('/api/cases/:caseId/chat/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'chat'), `${safeId(req.params.docId)}.json`)
  if (!fs.existsSync(filePath)) return res.json([])
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.json([]) }
})

app.post('/api/cases/:caseId/chat/:docId', (req, res) => {
  fs.writeFileSync(
    path.join(getCaseSubdir(req.params.caseId, 'chat'), `${safeId(req.params.docId)}.json`),
    JSON.stringify(req.body)
  )
  res.json({ ok: true })
})

app.delete('/api/cases/:caseId/chat/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'chat'), `${safeId(req.params.docId)}.json`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  res.json({ ok: true })
})

// ── Case-scoped Skill Results ──

app.get('/api/cases/:caseId/skill-results/:docId', (req, res) => {
  const docDir = path.join(getCaseSubdir(req.params.caseId, 'skill-results'), safeId(req.params.docId))
  if (!fs.existsSync(docDir)) return res.json([])
  const skillIds = fs.readdirSync(docDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
  res.json(skillIds)
})

app.get('/api/cases/:caseId/skill-results/:docId/:skillId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'skill-results'), safeId(req.params.docId), `${safeId(req.params.skillId)}.json`)
  if (!fs.existsSync(filePath)) return res.status(404).json(null)
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.status(500).json({ error: 'Corrupted skill result file' }) }
})

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

// ── Case-scoped Blobs ──

app.get('/api/cases/:caseId/blobs/:docId', (req, res) => {
  const blobsDir = getCaseSubdir(req.params.caseId, 'blobs')
  const id = safeId(req.params.docId)
  const filePath = path.join(blobsDir, id)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
  const metaPath = path.join(blobsDir, `${id}.meta`)
  let name = id
  if (fs.existsSync(metaPath)) {
    try { name = JSON.parse(fs.readFileSync(metaPath, 'utf8')).name || id } catch { /* use id */ }
  }
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.setHeader('Content-Type', 'application/pdf')
  res.sendFile(filePath)
})

app.put('/api/cases/:caseId/blobs/:docId', express.raw({ type: 'application/octet-stream', limit: '500mb' }), (req, res) => {
  const blobsDir = getCaseSubdir(req.params.caseId, 'blobs')
  const id = safeId(req.params.docId)
  fs.writeFileSync(path.join(blobsDir, id), req.body)
  if (req.query.name) {
    // Strip control characters and path separators before storing in Content-Disposition
    const safeName = String(req.query.name).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 255)
    fs.writeFileSync(path.join(blobsDir, `${id}.meta`), JSON.stringify({ name: safeName }))
  }
  res.json({ ok: true })
})

app.delete('/api/cases/:caseId/blobs/:docId', (req, res) => {
  const blobsDir = getCaseSubdir(req.params.caseId, 'blobs')
  const id = safeId(req.params.docId)
  const filePath = path.join(blobsDir, id)
  const metaPath = path.join(blobsDir, `${id}.meta`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath)
  res.json({ ok: true })
})

// ── Case-scoped PDF Notes ──

app.get('/api/cases/:caseId/notes/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'notes'), `${safeId(req.params.docId)}.json`)
  if (!fs.existsSync(filePath)) return res.json([])
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.json([]) }
})

app.post('/api/cases/:caseId/notes/:docId', (req, res) => {
  fs.writeFileSync(
    path.join(getCaseSubdir(req.params.caseId, 'notes'), `${safeId(req.params.docId)}.json`),
    JSON.stringify(req.body)
  )
  res.json({ ok: true })
})

app.delete('/api/cases/:caseId/notes/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'notes'), `${safeId(req.params.docId)}.json`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  res.json({ ok: true })
})

// Aggregate all notes for every document in a case — { [docId]: NoteObject[] }
app.get('/api/cases/:caseId/all-notes', (req, res) => {
  const notesDir = getCaseSubdir(req.params.caseId, 'notes')
  const files = fs.existsSync(notesDir)
    ? fs.readdirSync(notesDir).filter(f => f.endsWith('.json'))
    : []
  const result = {}
  for (const f of files) {
    const docId = f.replace('.json', '')
    try { result[docId] = JSON.parse(fs.readFileSync(path.join(notesDir, f), 'utf8')) }
    catch { result[docId] = [] }
  }
  res.json(result)
})

// ── Case-scoped Highlights ──

app.get('/api/cases/:caseId/highlights/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'highlights'), `${safeId(req.params.docId)}.json`)
  if (!fs.existsSync(filePath)) return res.json([])
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.json([]) }
})

app.post('/api/cases/:caseId/highlights/:docId', (req, res) => {
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

// Aggregate all highlights for every document in a case — { [docId]: HighlightObject[] }
app.get('/api/cases/:caseId/all-highlights', (req, res) => {
  const highlightsDir = getCaseSubdir(req.params.caseId, 'highlights')
  const files = fs.existsSync(highlightsDir)
    ? fs.readdirSync(highlightsDir).filter(f => f.endsWith('.json'))
    : []
  const result = {}
  for (const f of files) {
    const docId = f.replace('.json', '')
    try { result[docId] = JSON.parse(fs.readFileSync(path.join(highlightsDir, f), 'utf8')) }
    catch { result[docId] = [] }
  }
  res.json(result)
})

// ── Aide Soul & Diary ────────────────────────────────────────────────────

const SOUL_DEFAULT = { soul: { skillMd: '', redFlags: '', styleGuide: '', corrections: [], styleSamples: [] }, savedAt: null }
app.get('/api/cases/:caseId/aide/soul', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'aide'), 'soul.json')
  if (!fs.existsSync(filePath)) return res.json(SOUL_DEFAULT)
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (data.soul) return res.json(data)
    const { savedAt, ...soul } = data
    res.json({ soul, savedAt: savedAt || null })
  } catch { res.json(SOUL_DEFAULT) }
})

app.post('/api/cases/:caseId/aide/soul', express.json(), (req, res) => {
  const savedAt = new Date().toISOString()
  fs.writeFileSync(
    path.join(getCaseSubdir(req.params.caseId, 'aide'), 'soul.json'),
    JSON.stringify({ soul: req.body.soul || req.body, savedAt })
  )
  res.json({ ok: true, savedAt })
})

app.get('/api/cases/:caseId/aide/diary', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'aide'), 'diary.json')
  if (!fs.existsSync(filePath)) return res.json([])
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
  catch { res.json([]) }
})

app.post('/api/cases/:caseId/aide/diary/entry', express.json(), (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'aide'), 'diary.json')
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : []
  fs.writeFileSync(filePath, JSON.stringify([req.body, ...existing]))  // newest first
  res.json({ ok: true })
})

// ── Caselaw DB ────────────────────────────────────────────────────────────────

// GET /api/caselaw/status — health + version info
app.get('/api/caselaw/status', (req, res) => {
    res.json(getCaselawStatus())
})

// POST /api/caselaw/search — semantic search against the caselaw corpus
app.post('/api/caselaw/search', express.json(), async (req, res) => {
    const { query, k = 5, filters = {} } = req.body
    if (!query?.trim()) return res.status(400).json({ error: 'query is required' })

    const status = getCaselawStatus()
    if (!status.available) return res.json({ results: [], message: status.message })

    try {
        const vec     = await embed(query)
        const results = searchCaselaw(vec, Math.min(k, 20), filters)
        res.json({ results, query })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// POST /api/admin/caselaw/swap — promote a validated incoming .db to active
// Body: { filename: 'caselaw-20260322.db', checksum?: 'sha256hex', meta?: { version, model } }
app.post('/api/admin/caselaw/swap', express.json(), async (req, res) => {
    const { filename, checksum, meta = {} } = req.body ?? {}
    if (!filename) return res.status(400).json({ error: 'filename is required' })

    // Sanitise — only allow files from the incoming directory
    const safeName = path.basename(filename)
    if (!safeName.endsWith('.db')) return res.status(400).json({ error: 'filename must end with .db' })

    const incomingPath = path.join(CASELAW_INCOMING, safeName)
    if (!fs.existsSync(incomingPath)) {
        return res.status(404).json({ error: `File not found in incoming/: ${safeName}` })
    }

    // Optional checksum verification
    if (checksum) {
        const actual = fileSha256(incomingPath)
        if (actual !== checksum) {
            return res.status(400).json({ error: `Checksum mismatch. Expected ${checksum}, got ${actual}` })
        }
    }

    const result = await swapCaselawDb(incomingPath, meta)
    res.json(result)
})

// POST /api/admin/caselaw/upload — upload a .db file directly (for smaller corpora)
// Streams the body straight to incoming/, then optionally auto-swaps.
app.post('/api/admin/caselaw/upload',
    express.raw({ type: 'application/octet-stream', limit: '2gb' }),
    async (req, res) => {
        const filename = req.query.filename
        if (!filename?.endsWith('.db')) {
            return res.status(400).json({ error: '?filename=caselaw-YYYYMMDD.db is required' })
        }
        const safeName = path.basename(filename)
        const destPath = path.join(CASELAW_INCOMING, safeName)
        try {
            fs.writeFileSync(destPath, req.body)
            const autoSwap = req.query.autoSwap === 'true'
            if (autoSwap) {
                const result = await swapCaselawDb(destPath, {})
                return res.json({ uploaded: safeName, swap: result })
            }
            res.json({ ok: true, uploaded: safeName, size: req.body.length,
                       next: `POST /api/admin/caselaw/swap with { filename: "${safeName}" }` })
        } catch (err) {
            res.status(500).json({ error: err.message })
        }
    }
)

// GET /api/admin/caselaw/versions — list all versioned backup files
app.get('/api/admin/caselaw/versions', (req, res) => {
    const status = getCaselawStatus()
    res.json(status)
})

// ── Case Delete (cascade) ──

app.delete('/api/cases/:caseId', (req, res) => {
  const caseDir = path.join(CASES_DIR, safeId(req.params.caseId))
  if (fs.existsSync(caseDir)) fs.rmSync(caseDir, { recursive: true, force: true })
  // Close and delete the per-case RAG DB file
  try {
    const key = safeId(req.params.caseId)
    if (_ragDbs.has(key)) {
      _ragDbs.get(key).db.close()
      _ragDbs.delete(key)
    }
    const ragDbPath = path.join(DATA_DIR, `rag-${key}.db`)
    if (fs.existsSync(ragDbPath)) fs.unlinkSync(ragDbPath)
  } catch { /* rag db may not exist yet */ }
  res.json({ ok: true })
})

// ── Health check ──────────────────────────────────────────────────────────
// Lightweight ping — does NOT call embed(); just checks if the service port is up.
app.get('/api/health', async (req, res) => {
    const embedPingUrl = (process.env.EMBED_BACKEND || 'ollama').toLowerCase() === 'llamafile'
        ? `http://localhost:${process.env.LLAMAFILE_PORT || 8080}/health`
        : 'http://localhost:11434/'   // Ollama root returns "Ollama is running"
    let embedOk = false
    let embedError = null
    try {
        const r = await fetch(embedPingUrl, { signal: AbortSignal.timeout(2500) })
        embedOk = r.status < 500
    } catch (err) {
        embedError = err.code === 'ECONNREFUSED' ? 'not running' : err.message
    }
    res.json({
        embed: {
            backend: (process.env.EMBED_BACKEND || 'ollama').toLowerCase(),
            model:   process.env.OLLAMA_EMBED_MODEL || process.env.LLAMAFILE_EMBED_MODEL || 'nomic-embed-text',
            ok:      embedOk,
            error:   embedError,
        },
    })
})

// ── RAG (Local vector search via sqlite-vec) ──────────────────────────────

const RAG_DB_PATH = path.join(DATA_DIR, 'rag.db')

// ── Embed backend config ──────────────────────────────────────────────────
// Set EMBED_BACKEND=llamafile in env to use llamafiler instead of Ollama.
//   Ollama:    http://localhost:11434  model=nomic-embed-text:latest (768-dim, 8192 ctx)
//   Llamafile: http://localhost:8080   model=all-MiniLM-L6-v2.F16.gguf
//              (run: ./llamafile/llamafiler -m ./llamafile/all-MiniLM-L6-v2.F16.gguf --embedding)
const EMBED_BACKEND = (process.env.EMBED_BACKEND || 'ollama').toLowerCase()

const EMBED_CONFIG = {
    ollama: {
        api:   'http://localhost:11434/api/embeddings',
        model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest',
        async call(text) {
            const res = await fetch(this.api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt: text }),
            })
            if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`)
            const { embedding } = await res.json()
            return embedding
        },
    },
    llamafile: {
        api:   `http://localhost:${process.env.LLAMAFILE_PORT || 8080}/v1/embeddings`,
        model: process.env.LLAMAFILE_EMBED_MODEL || 'all-MiniLM-L6-v2.F16.gguf',
        async call(text) {
            const res = await fetch(this.api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, input: text }),
            })
            if (!res.ok) throw new Error(`Llamafile embed ${res.status}: ${await res.text()}`)
            const { data } = await res.json()
            return data[0].embedding
        },
    },
}

const _embedBackend = EMBED_CONFIG[EMBED_BACKEND] ?? EMBED_CONFIG.ollama
const EMBED_MODEL   = _embedBackend.model

console.log(`[RAG] embed backend: ${EMBED_BACKEND} — model: ${EMBED_MODEL}`)

const _ragDbs = new Map()   // key → { db, dim }  (one DB per case)
let _embedDim = null        // shared — same embed model across all DBs

async function embed(text) {
    return _embedBackend.call(text)
}

function toBlob(floats) {
    return Buffer.from(new Float32Array(floats).buffer)
}

// Open the RAG DB for read/write without requiring the embed model to be running.
// Used for delete/prune operations that need no embeddings.
// Returns null if the DB file does not exist yet (nothing to delete).
function openRagDbDirect(caseId = 'default') {
    const key = caseId === 'default' ? 'default' : safeId(caseId)
    if (_ragDbs.has(key)) return _ragDbs.get(key).db
    const dbPath = key === 'default'
        ? RAG_DB_PATH
        : path.join(DATA_DIR, `rag-${key}.db`)
    if (!fs.existsSync(dbPath)) return null
    const db = new Database(dbPath)
    sqliteVec.load(db)
    return db
}

// Lazy-init: one SQLite DB per case so KNN is always case-isolated.
// caseId='default' → rag.db (solo mode + shared format categories)
// caseId='SomeCase' → rag-somecaseid.db (KNN confined to this case)
async function getRagDb(caseId = 'default') {
    const key = caseId === 'default' ? 'default' : safeId(caseId)
    if (_ragDbs.has(key)) return _ragDbs.get(key)

    if (!_embedDim) _embedDim = (await embed('init')).length
    const dim = _embedDim

    const dbPath = key === 'default'
        ? RAG_DB_PATH
        : path.join(DATA_DIR, `rag-${key}.db`)

    const db = new Database(dbPath)
    sqliteVec.load(db)

    // Settings table
    db.exec(`CREATE TABLE IF NOT EXISTS rag_meta (key TEXT PRIMARY KEY, value TEXT)`)
    const stored = db.prepare("SELECT value FROM rag_meta WHERE key='dim'").get()

    if (stored && parseInt(stored.value) !== dim) {
        // Model changed — drop stale vector tables
        db.exec('DROP TABLE IF EXISTS vec_chunks; DROP TABLE IF EXISTS vec_cats')
        db.exec('DELETE FROM doc_chunks; DELETE FROM format_cats')
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS doc_chunks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id     TEXT    NOT NULL,
            case_id    TEXT    NOT NULL DEFAULT 'default',
            page_num   INTEGER NOT NULL,
            chunk_idx  INTEGER NOT NULL DEFAULT 0,
            text       TEXT    NOT NULL,
            bbox       TEXT,
            UNIQUE(doc_id, case_id, page_num, chunk_idx)
        );
        CREATE TABLE IF NOT EXISTS format_cats (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            description TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
            USING vec0(id INTEGER PRIMARY KEY, embedding float[${dim}]);
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_cats
            USING vec0(id INTEGER PRIMARY KEY, embedding float[${dim}]);
    `)

    // Migration: add case_id column if not present (pre-v2 DBs)
    try { db.exec("ALTER TABLE doc_chunks ADD COLUMN case_id TEXT NOT NULL DEFAULT 'default'") } catch { /* already exists */ }

    // Migration v2: add chunk_idx + bbox columns and relax unique constraint
    const hasChunkIdx = db.prepare("SELECT 1 FROM pragma_table_info('doc_chunks') WHERE name='chunk_idx'").get()
    if (!hasChunkIdx) {
        db.exec(`
            ALTER TABLE doc_chunks RENAME TO doc_chunks_old;
            CREATE TABLE doc_chunks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id     TEXT    NOT NULL,
                case_id    TEXT    NOT NULL DEFAULT 'default',
                page_num   INTEGER NOT NULL,
                chunk_idx  INTEGER NOT NULL DEFAULT 0,
                text       TEXT    NOT NULL,
                bbox       TEXT,
                UNIQUE(doc_id, case_id, page_num, chunk_idx)
            );
            INSERT OR IGNORE INTO doc_chunks (id, doc_id, case_id, page_num, chunk_idx, text)
                SELECT id, doc_id, case_id, page_num, 0, text FROM doc_chunks_old;
            DROP TABLE doc_chunks_old;
        `)
    }

    // Migration v3: add chunk_hash column for incremental indexing
    try { db.exec("ALTER TABLE doc_chunks ADD COLUMN chunk_hash TEXT") } catch { /* already exists */ }

    // Embedding cache: avoids re-calling Ollama for chunks whose text hasn't changed
    db.exec(`CREATE TABLE IF NOT EXISTS embed_cache (hash TEXT PRIMARY KEY, embedding BLOB)`)

    db.prepare("INSERT OR REPLACE INTO rag_meta VALUES ('dim',   ?)").run(String(dim))
    db.prepare("INSERT OR REPLACE INTO rag_meta VALUES ('model', ?)").run(EMBED_MODEL)

    const result = { db, dim }
    _ragDbs.set(key, result)
    return result
}

// Embed with cache — skips Ollama call if text hash is already in embed_cache
async function embedCached(text, db) {
    const hash = createHash('sha256').update(text).digest('hex')
    const cached = db.prepare('SELECT embedding FROM embed_cache WHERE hash = ?').get(hash)
    if (cached) {
        const floats = Array.from(new Float32Array(cached.embedding.buffer))
        return { floats, hash, cached: true }
    }
    const floats = await embed(text)
    db.prepare('INSERT OR REPLACE INTO embed_cache (hash, embedding) VALUES (?, ?)').run(hash, toBlob(floats))
    return { floats, hash, cached: false }
}

// DELETE /api/rag/clear-doc/:docId  — remove all chunks for a doc (call before re-indexing)
app.delete('/api/rag/clear-doc/:docId', (req, res) => {
    const { caseId = 'default' } = req.query
    const safeDocId = safeId(req.params.docId)
    try {
        const db = openRagDbDirect(caseId)
        if (!db) return res.json({ ok: true, deleted: 0 }) // DB not yet created — nothing to clear
        const rows = db.prepare('SELECT id FROM doc_chunks WHERE doc_id = ?').all(safeDocId)
        for (const row of rows) {
            db.prepare('DELETE FROM vec_chunks WHERE id = ?').run(BigInt(row.id))
        }
        db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(safeDocId)
        res.json({ ok: true, deleted: rows.length })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// POST /api/rag/index-doc  — embed + store a batch of paragraph chunks for a document
// chunks: [{ pageNum, chunkIdx, text, bbox }]
// Skips Ollama call when text hash matches embed_cache (incremental indexing).
app.post('/api/rag/index-doc', async (req, res) => {
    try {
        const { docId, chunks, caseId = 'default' } = req.body
        if (!docId || !Array.isArray(chunks)) return res.status(400).json({ error: 'Missing docId or chunks' })

        const { db } = await getRagDb(caseId)
        const safeDocId = safeId(docId)
        const safeCaseId = safeId(caseId)
        let indexed = 0
        let skipped = 0

        for (const { pageNum, chunkIdx, text, bbox } of chunks) {
            if (!text?.trim()) continue
            const bboxJson = bbox ? JSON.stringify(bbox) : null
            const ci = chunkIdx ?? indexed

            // Check if this chunk already exists with the same text hash
            const existing = db.prepare(
                'SELECT id, chunk_hash FROM doc_chunks WHERE doc_id = ? AND case_id = ? AND page_num = ? AND chunk_idx = ?'
            ).get(safeDocId, safeCaseId, pageNum, ci)

            const { floats, hash } = await embedCached(text, db)

            if (existing) {
                if (existing.chunk_hash === hash) {
                    // Unchanged — update bbox if needed but skip re-embedding
                    db.prepare('UPDATE doc_chunks SET bbox = ? WHERE id = ?').run(bboxJson, existing.id)
                    skipped++
                    continue
                }
                // Text changed — replace vec entry
                db.prepare('DELETE FROM vec_chunks WHERE id = ?').run(BigInt(existing.id))
                db.prepare('UPDATE doc_chunks SET text = ?, bbox = ?, chunk_hash = ? WHERE id = ?')
                    .run(text, bboxJson, hash, existing.id)
                db.prepare('INSERT INTO vec_chunks (id, embedding) VALUES (?, ?)').run(BigInt(existing.id), toBlob(floats))
            } else {
                const { lastInsertRowid: chunkId } = db.prepare(
                    'INSERT INTO doc_chunks (doc_id, case_id, page_num, chunk_idx, text, bbox, chunk_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).run(safeDocId, safeCaseId, pageNum, ci, text, bboxJson, hash)
                db.prepare('INSERT INTO vec_chunks (id, embedding) VALUES (?, ?)').run(BigInt(chunkId), toBlob(floats))
            }
            indexed++
        }
        res.json({ ok: true, indexed, skipped })
    } catch (err) {
        console.error('[RAG] index-doc error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

// POST /api/rag/prune-doc  — remove chunks that are no longer present (incremental indexing cleanup)
// body: { docId, caseId, keep: [{pageNum, chunkIdx}] }
app.post('/api/rag/prune-doc', (req, res) => {
    try {
        const { docId, caseId = 'default', keep } = req.body
        if (!docId || !Array.isArray(keep)) return res.status(400).json({ error: 'Missing docId or keep' })

        const db = openRagDbDirect(caseId)
        if (!db) return res.json({ ok: true, pruned: 0 })
        const safeDocId = safeId(docId)

        // Per-case DB: filter by doc_id only
        const existing = db.prepare(
            'SELECT id, page_num, chunk_idx FROM doc_chunks WHERE doc_id = ?'
        ).all(safeDocId)

        const keepSet = new Set(keep.map(k => `${k.pageNum}:${k.chunkIdx}`))
        const toDelete = existing.filter(r => !keepSet.has(`${r.page_num}:${r.chunk_idx}`))

        for (const row of toDelete) {
            db.prepare('DELETE FROM vec_chunks WHERE id = ?').run(BigInt(row.id))
            db.prepare('DELETE FROM doc_chunks WHERE id = ?').run(row.id)
        }
        res.json({ ok: true, pruned: toDelete.length })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// GET /api/rag/doc-status/:docId  — how many chunks are indexed for a doc
app.get('/api/rag/doc-status/:docId', async (req, res) => {
    try {
        const { caseId = 'default' } = req.query
        const { db } = await getRagDb(caseId)
        // Per-case DB: filter by doc_id only
        const row = db.prepare(
            'SELECT COUNT(*) as n FROM doc_chunks WHERE doc_id = ?'
        ).get(safeId(req.params.docId))
        res.json({ indexed: row.n > 0, chunks: row.n })
    } catch (err) {
        res.json({ indexed: false, chunks: 0 })
    }
})

// Keyword overlap score — TF-style, normalized by sqrt(doc_len) to penalize long chunks less
function keywordScore(query, text) {
    const qTokens = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 2))
    if (!qTokens.size) return 0
    const tWords = text.toLowerCase().split(/\W+/)
    const hits = tWords.filter(t => qTokens.has(t)).length
    return hits / (Math.sqrt(tWords.length) || 1)
}

// Combined re-ranking: 60% vector similarity + 40% keyword overlap
function rerank(chunks, distMap, query, k) {
    const maxDist = Math.max(...chunks.map(c => distMap.get(c.id)), 1e-6)
    return chunks
        .map(c => ({
            ...c,
            _score: 0.6 * (1 - distMap.get(c.id) / maxDist) + 0.4 * keywordScore(query, c.text),
            distance: distMap.get(c.id),
        }))
        .sort((a, b) => b._score - a._score)
        .slice(0, k)
        .map(({ _score, ...c }) => c)
}

// POST /api/rag/search  — semantic search within a document
app.post('/api/rag/search', async (req, res) => {
    try {
        const { docId, query, k = 5, caseId = 'default', windowSize = 0 } = req.body
        const { db } = await getRagDb(caseId)
        const emb = await embed(query)

        // KNN within this case's DB, then filter by doc_id
        const topK = Math.min(k * 20, 200)
        const knnRows = db.prepare(
            'SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance'
        ).all(toBlob(emb), topK)

        if (!knnRows.length) return res.json([])

        // vec_chunks returns BigInt ids — convert to Number for cross-table lookups
        const distMap = new Map(knnRows.map(r => [Number(r.id), r.distance]))
        const ids = knnRows.map(r => Number(r.id))
        const placeholders = ids.map(() => '?').join(',')

        const chunks = db.prepare(
            `SELECT id, page_num, chunk_idx, text, bbox FROM doc_chunks WHERE doc_id = ? AND id IN (${placeholders})`
        ).all(safeId(docId), ...ids)

        const results = rerank(chunks, distMap, query, k).map(c => ({
            ...c,
            bbox: c.bbox ? JSON.parse(c.bbox) : null,
        }))

        // Sentence-window expansion: fetch ±windowSize neighboring chunks and attach as
        // windowText. The LLM uses windowText for context; bbox/text stay sentence-tight.
        if (windowSize > 0) {
            const safeDocId = safeId(docId)
            const safeCaseId = safeId(caseId)
            for (const chunk of results) {
                const lo = Math.max(0, chunk.chunk_idx - windowSize)
                const hi = chunk.chunk_idx + windowSize
                const neighbors = db.prepare(
                    'SELECT text FROM doc_chunks WHERE doc_id = ? AND case_id = ? AND chunk_idx BETWEEN ? AND ? ORDER BY chunk_idx'
                ).all(safeDocId, safeCaseId, lo, hi)
                chunk.windowText = neighbors.map(n => n.text).join(' ')
            }
        }

        res.json(results)
    } catch (err) {
        console.error('[RAG] search error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

// POST /api/rag/search-case  — semantic search across all docs in a case
// Uses the per-case DB so KNN is already confined to this case (no case_id filter needed)
app.post('/api/rag/search-case', async (req, res) => {
    try {
        const { caseId, query, k = 5 } = req.body
        if (!caseId || !query) return res.status(400).json({ error: 'Missing caseId or query' })
        const { db } = await getRagDb(caseId)
        const emb = await embed(query)

        const topK = Math.min(k * 20, 200)
        const knnRows = db.prepare(
            'SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance'
        ).all(toBlob(emb), topK)

        if (!knnRows.length) return res.json([])

        const distMap = new Map(knnRows.map(r => [Number(r.id), r.distance]))
        const ids = knnRows.map(r => Number(r.id))
        const placeholders = ids.map(() => '?').join(',')

        // All rows in this DB belong to the case — select all matching ids with doc_id for provenance
        const chunks = db.prepare(
            `SELECT id, doc_id, page_num, chunk_idx, text, bbox FROM doc_chunks WHERE id IN (${placeholders})`
        ).all(...ids)

        res.json(rerank(chunks, distMap, query, k).map(c => ({
            ...c,
            bbox: c.bbox ? JSON.parse(c.bbox) : null,
        })))
    } catch (err) {
        console.error('[RAG] search-case error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

// POST /api/rag/init-categories  — index format categories (skips already-indexed)
// Uses a hash of the full categories list stored in rag_meta to short-circuit the
// entire loop when nothing has changed — avoids per-row SELECT on every index run.
app.post('/api/rag/init-categories', async (req, res) => {
    try {
        const { categories } = req.body   // [{name, description}]
        if (!Array.isArray(categories)) return res.status(400).json({ error: 'Missing categories' })

        const { db } = await getRagDb()

        // Fast path: if the categories list hash matches the stored hash, nothing to do.
        const catHash = createHash('sha256')
            .update(categories.map(c => `${c.name}::${c.description}`).join('|'))
            .digest('hex')
        const stored = db.prepare("SELECT value FROM rag_meta WHERE key = 'categories_hash'").get()
        if (stored?.value === catHash) {
            return res.json({ ok: true, indexed: 0, cached: true })
        }

        let indexed = 0
        for (const { name, description } of categories) {
            const existing = db.prepare('SELECT id FROM format_cats WHERE name = ?').get(name)
            if (existing) continue

            try {
                const emb = await embed(`${name}: ${description}`)
                const { lastInsertRowid: catId } = db.prepare(
                    'INSERT OR IGNORE INTO format_cats (name, description) VALUES (?, ?)'
                ).run(name, description)
                if (catId) {
                    db.prepare('INSERT INTO vec_cats (id, embedding) VALUES (?, ?)').run(BigInt(catId), toBlob(emb))
                    indexed++
                }
            } catch (err) {
                console.warn('[RAG] skipping category embed:', name, err.message)
            }
        }

        // Store the hash so subsequent calls with the same categories are instant.
        db.prepare("INSERT OR REPLACE INTO rag_meta VALUES ('categories_hash', ?)").run(catHash)
        res.json({ ok: true, indexed })
    } catch (err) {
        console.error('[RAG] init-categories error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

// POST /api/rag/suggest-formats  — top-K format categories for a query
app.post('/api/rag/suggest-formats', async (req, res) => {
    try {
        const { query, k = 5 } = req.body
        const { db } = await getRagDb()

        const catTotal = db.prepare('SELECT COUNT(*) as n FROM format_cats').get().n
        if (catTotal === 0) return res.status(503).json({ error: 'Categories not indexed yet' })

        const emb = await embed(query)
        const knnCats = db.prepare(
            'SELECT id, distance FROM vec_cats WHERE embedding MATCH ? AND k = ? ORDER BY distance'
        ).all(toBlob(emb), k)

        if (!knnCats.length) return res.json([])

        const distMap = new Map(knnCats.map(c => [Number(c.id), c.distance]))
        const ids = knnCats.map(c => Number(c.id))
        const placeholders = ids.map(() => '?').join(',')

        const cats = db.prepare(
            `SELECT id, name, description FROM format_cats WHERE id IN (${placeholders})`
        ).all(...ids)

        cats.sort((a, b) => distMap.get(a.id) - distMap.get(b.id))
        res.json(cats.map(c => ({ name: c.name, description: c.description, distance: distMap.get(c.id) })))
    } catch (err) {
        console.error('[RAG] suggest-formats error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

// ── Agent (ReAct loop) ────────────────────────────────────────────────────

const agentJobs = new Map()   // jobId → { status, steps, clients, result, error, cancelled }

function agentBroadcast(clients, data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`
    for (const res of clients) { try { res.write(msg) } catch {} }
}

const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'search_case',
            description: 'Search all documents in the case for relevant text. Use this for broad queries across all documents.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    k:     { type: 'number', description: 'Number of results (default 5)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_doc',
            description: 'Search a specific document by ID for relevant text.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    docId: { type: 'string', description: 'The document ID to search' },
                    k:     { type: 'number', description: 'Number of results (default 5)' },
                },
                required: ['query', 'docId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_caselaw',
            description: 'Search the offline case law database to verify a citation or find relevant precedents. Use this when the user mentions a case name, citation, or asks to verify legal authority. Returns matching cases with citation, court, year, and a snippet of the holding.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Case name, citation, or legal concept to search for' },
                    k:     { type: 'number', description: 'Number of results (default 3)' },
                    court: { type: 'string', description: 'Optional: filter by court name (e.g. "UKSC", "EWCA", "HK CFA")' },
                    yearFrom: { type: 'number', description: 'Optional: earliest year' },
                    yearTo:   { type: 'number', description: 'Optional: latest year' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_note',
            description: 'Save an important finding as a note. Use this to record key discoveries so the lawyer can review them.',
            parameters: {
                type: 'object',
                properties: {
                    docId:   { type: 'string', description: 'Document ID this note relates to' },
                    pageNum: { type: 'number', description: 'Page number (use 1 if unknown)' },
                    text:    { type: 'string', description: 'The note text to save' },
                },
                required: ['docId', 'text'],
            },
        },
    },
]

async function agentExecuteTool(name, args, caseId) {
    if (name === 'search_case') {
        const { query, k = 5 } = args
        const { db } = await getRagDb(caseId)
        const emb = await embed(query)
        const topK = Math.min(k * 20, 200)
        const knnRows = db.prepare(
            'SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance'
        ).all(toBlob(emb), topK)
        if (!knnRows.length) return []
        const distMap = new Map(knnRows.map(r => [Number(r.id), r.distance]))
        const ids = knnRows.map(r => Number(r.id))
        const placeholders = ids.map(() => '?').join(',')
        const chunks = db.prepare(
            `SELECT id, doc_id, page_num, chunk_idx, text FROM doc_chunks WHERE id IN (${placeholders})`
        ).all(...ids)
        return rerank(chunks, distMap, query, k).map(c => ({
            docId: c.doc_id, pageNum: c.page_num, text: c.text.slice(0, 400),
        }))
    }

    if (name === 'search_doc') {
        const { query, docId, k = 5 } = args
        const { db } = await getRagDb(caseId)
        const emb = await embed(query)
        const topK = Math.min(k * 20, 200)
        const knnRows = db.prepare(
            'SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance'
        ).all(toBlob(emb), topK)
        if (!knnRows.length) return []
        const distMap = new Map(knnRows.map(r => [Number(r.id), r.distance]))
        const ids = knnRows.map(r => Number(r.id))
        const placeholders = ids.map(() => '?').join(',')
        const chunks = db.prepare(
            `SELECT id, page_num, chunk_idx, text FROM doc_chunks WHERE doc_id = ? AND id IN (${placeholders})`
        ).all(safeId(docId), ...ids)
        return rerank(chunks, distMap, query, k).map(c => ({
            docId, pageNum: c.page_num, text: c.text.slice(0, 400),
        }))
    }

    if (name === 'search_caselaw') {
        const { query, k = 3, court, yearFrom, yearTo } = args
        const status = getCaselawStatus()
        if (!status.available) return { error: 'Case law database not available. Ask the administrator to import the corpus.' }
        try {
            const vec     = await embed(query)
            const filters = {}
            if (court)    filters.court    = court
            if (yearFrom) filters.yearFrom = yearFrom
            if (yearTo)   filters.yearTo   = yearTo
            const results = searchCaselaw(vec, Math.min(k, 10), filters)
            if (!results.length) return { results: [], message: 'No matching case law found for this query.' }
            return results.map(r => ({
                citation:     r.citation,
                court:        r.court,
                year:         r.year,
                jurisdiction: r.jurisdiction,
                snippet:      r.text.slice(0, 300),
                score:        r.score,
            }))
        } catch (err) {
            return { error: `Caselaw search failed: ${err.message}` }
        }
    }

    if (name === 'add_note') {
        const { docId, pageNum = 1, text } = args
        const notesDir = getCaseSubdir(caseId, 'notes')
        const filePath = path.join(notesDir, `${safeId(docId)}.json`)
        const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : []
        const note = { id: `agent-${Date.now()}`, pageNum, text, createdAt: new Date().toISOString(), source: 'agent' }
        existing.push(note)
        fs.writeFileSync(filePath, JSON.stringify(existing))
        return { ok: true, noteId: note.id }
    }

    return { error: `Unknown tool: ${name}` }
}

async function runAgentLoop({ jobId, task, intent, role, caseId, soul = {}, diary = [] }) {
    const job = agentJobs.get(jobId)

    // Last 3 diary entries — most recent first, injected as compounding memory
    const recentDiary = [...diary].reverse().slice(0, 3)

    const systemPrompt = [
        soul?.skillMd?.trim() || 'You are a professional document analyst with access to tools that search case documents.',
        soul?.redFlags?.trim()    ? `\n## Standing Checklist — Always Apply\n${soul.redFlags}` : '',
        soul?.styleGuide?.trim()  ? `\n## Your Writing Style\n${soul.styleGuide}` : '',
        soul?.styleSamples?.length
            ? `\n## Example Outputs (match this style)\n${soul.styleSamples.map(s => s.text).filter(Boolean).join('\n\n---\n\n')}`
            : '',
        soul?.corrections?.length
            ? `\n## Corrections — Things To Stop Doing\n${soul.corrections.map(c => `- ${c.text || c.rule || c}`).join('\n')}`
            : '',
        recentDiary.length
            ? `\n## What You Learned in Previous Sessions\n${recentDiary.map((e, i) => {
                const dateStr = e.createdAt || e.date
                const label = dateStr ? new Date(dateStr).toLocaleDateString() : 'recent'
                const parts = [`### Session ${recentDiary.length - i} (${label})`]
                if (e.task?.trim())       parts.push(`Task: ${e.task.trim()}`)
                if (e.reflection?.trim()) parts.push(`Reflection: ${e.reflection.trim()}`)
                return parts.join('\n')
              }).filter(Boolean).join('\n\n')}`
            : '',
        intent ? `\n## Your Goal for This Task\n${intent}` : '',
        role   ? `\nActing as: ${role}` : '',
        '\n## Instructions',
        '- Use search_case to search broadly across all case documents.',
        '- Use search_doc to search a specific document by ID.',
        '- Use search_caselaw to verify a case citation or find legal precedent — always verify citations mentioned in documents.',
        '- Use add_note to save important findings as you discover them.',
        '- Only cite text you have directly retrieved via tools.',
        '- When search results are weak, rephrase and search again.',
        '- Apply everything you have learned from previous sessions.',
        '- After gathering evidence, give a clear final answer with citations (doc ID, page number, and case citation where relevant).',
        '- Stop after 15 tool calls maximum.',
    ].filter(Boolean).join('\n')

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: task },
    ]

    let stepCount = 0
    const MAX_STEPS = 15

    while (stepCount < MAX_STEPS) {
        if (job.cancelled) return

        let response
        try {
            const res = await fetch('http://localhost:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'qwen2.5:7b', messages, tools: AGENT_TOOLS, stream: false }),
            })
            if (!res.ok) throw new Error(`Ollama ${res.status}`)
            response = await res.json()
        } catch (err) {
            const step = { type: 'error', content: `LLM error: ${err.message}` }
            job.steps.push(step)
            agentBroadcast(job.clients, step)
            job.status = 'error'; job.error = err.message
            agentBroadcast(job.clients, { type: 'status', status: 'error' })
            return
        }

        const msg = response.message

        // No tool calls → LLM is done
        if (!msg.tool_calls?.length) {
            const step = { type: 'done', content: msg.content }
            job.steps.push(step)
            agentBroadcast(job.clients, step)
            job.result = msg.content
            job.status = 'done'
            agentBroadcast(job.clients, { type: 'status', status: 'done', result: msg.content })

            // ── Reflexion: self-critique ──
            let reflection = ''
            if (!job.cancelled && msg.content) {
                try {
                    const rRes = await fetch('http://localhost:11434/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'qwen2.5:7b',
                            messages: [
                                { role: 'system', content: 'Review your work briefly and honestly.' },
                                { role: 'user', content: `Task: ${task}\n\nYour analysis:\n${msg.content}\n\nIn 3 concise bullets:\n• What was most valuable in this analysis?\n• What might you have missed or could improve?\n• What would you do differently next time?` },
                            ],
                            stream: false,
                        }),
                    })
                    if (rRes.ok) reflection = (await rRes.json()).message?.content?.trim() || ''
                } catch {}
                if (reflection) {
                    const reflStep = { type: 'reflection', content: reflection }
                    job.steps.push(reflStep)
                    agentBroadcast(job.clients, reflStep)
                }
            }

            // ── Write session diary entry ──
            try {
                const notesAdded = job.steps.filter(s => s.type === 'tool_call' && s.tool === 'add_note').length
                const entry = {
                    id: randomUUID(),
                    createdAt: new Date().toISOString(),
                    task,
                    steps: stepCount,
                    result: msg.content,
                    reflection,
                    notesAdded,
                }
                const diaryPath = path.join(getCaseSubdir(caseId, 'aide'), 'diary.json')
                const existing = fs.existsSync(diaryPath) ? JSON.parse(fs.readFileSync(diaryPath, 'utf8')) : []
                const updated = [entry, ...existing]   // newest first
                fs.writeFileSync(diaryPath, JSON.stringify(updated))
                agentBroadcast(job.clients, { type: 'diary_entry', entry })
            } catch {}

            return
        }

        // Add assistant turn to message history
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })

        // Execute each tool call
        for (const call of msg.tool_calls) {
            if (job.cancelled) return

            const toolName = call.function.name
            let toolArgs
            try {
                toolArgs = typeof call.function.arguments === 'string'
                    ? JSON.parse(call.function.arguments)
                    : call.function.arguments
            } catch {
                toolArgs = {}
            }

            const callStep = { type: 'tool_call', tool: toolName, args: toolArgs }
            job.steps.push(callStep)
            agentBroadcast(job.clients, callStep)

            let result
            try {
                result = await agentExecuteTool(toolName, toolArgs, caseId)
            } catch (toolErr) {
                result = { error: toolErr.message }
                const errStep = { type: 'error', content: `Tool "${toolName}" failed: ${toolErr.message}` }
                job.steps.push(errStep)
                agentBroadcast(job.clients, errStep)
            }

            const resultStep = { type: 'tool_result', tool: toolName, result }
            job.steps.push(resultStep)
            agentBroadcast(job.clients, resultStep)

            messages.push({ role: 'tool', content: JSON.stringify(result) })
        }

        stepCount++
    }

    // Max steps reached
    const step = { type: 'done', content: 'Maximum steps reached. Review the findings above.' }
    job.steps.push(step)
    agentBroadcast(job.clients, step)
    job.status = 'done'
    agentBroadcast(job.clients, { type: 'status', status: 'done' })
}

// POST /api/agent/start
app.post('/api/agent/start', express.json(), async (req, res) => {
    const { task, intent, role, caseId } = req.body
    if (!task?.trim()) return res.status(400).json({ error: 'task is required' })
    if (!caseId)       return res.status(400).json({ error: 'caseId is required' })

    // Load soul and recent diary entries from disk
    let soul = { skillMd: '', redFlags: '', styleGuide: '', corrections: [], styleSamples: [] }
    let diary = []
    try {
        const soulPath = path.join(getCaseSubdir(caseId, 'aide'), 'soul.json')
        if (fs.existsSync(soulPath)) {
            const raw = JSON.parse(fs.readFileSync(soulPath, 'utf8'))
            soul = raw.soul || raw
        }
    } catch {}
    try {
        const diaryPath = path.join(getCaseSubdir(caseId, 'aide'), 'diary.json')
        if (fs.existsSync(diaryPath)) diary = JSON.parse(fs.readFileSync(diaryPath, 'utf8'))
    } catch {}

    const jobId = randomUUID()
    agentJobs.set(jobId, { status: 'running', steps: [], clients: new Set(), result: null, error: null, cancelled: false })

    runAgentLoop({ jobId, task, intent, role, caseId, soul, diary }).catch(err => {
        const job = agentJobs.get(jobId)
        if (job) { job.status = 'error'; job.error = err.message; agentBroadcast(job.clients, { type: 'error', content: err.message }) }
    })

    // Auto-cleanup after 30 minutes
    setTimeout(() => agentJobs.delete(jobId), 30 * 60 * 1000)

    res.json({ jobId })
})

// GET /api/agent/:jobId/stream  — SSE live step feed
app.get('/api/agent/:jobId/stream', (req, res) => {
    const job = agentJobs.get(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Job not found' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // Replay existing steps for reconnects
    for (const step of job.steps) res.write(`data: ${JSON.stringify(step)}\n\n`)

    if (job.status !== 'running') {
        res.write(`data: ${JSON.stringify({ type: 'status', status: job.status, result: job.result })}\n\n`)
        return res.end()
    }

    job.clients.add(res)
    req.on('close', () => job.clients.delete(res))
})

// DELETE /api/agent/:jobId  — cancel
app.delete('/api/agent/:jobId', (req, res) => {
    const job = agentJobs.get(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Not found' })
    job.cancelled = true
    job.status = 'cancelled'
    agentBroadcast(job.clients, { type: 'status', status: 'cancelled' })
    res.json({ ok: true })
})

// Global error handler — converts multer/express errors to JSON responses
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    res.status(status).json({ error: err.message || 'Unexpected error' })
})

app.listen(3001, () => console.log('Storage server running on http://localhost:3001'))

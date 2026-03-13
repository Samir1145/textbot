import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { createHash } from 'crypto'

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
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
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
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
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
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
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
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
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
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
})

app.post('/api/cases/:caseId/skill-results/:docId/:skillId', (req, res) => {
  const docDir = path.join(getCaseSubdir(req.params.caseId, 'skill-results'), safeId(req.params.docId))
  fs.mkdirSync(docDir, { recursive: true })
  fs.writeFileSync(path.join(docDir, `${safeId(req.params.skillId)}.json`), JSON.stringify(req.body))
  res.json({ ok: true })
})

// ── Case-scoped Blobs ──

app.get('/api/cases/:caseId/blobs/:docId', (req, res) => {
  const blobsDir = getCaseSubdir(req.params.caseId, 'blobs')
  const id = safeId(req.params.docId)
  const filePath = path.join(blobsDir, id)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
  const metaPath = path.join(blobsDir, `${id}.meta`)
  const name = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8')).name
    : id
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.setHeader('Content-Type', 'application/pdf')
  res.sendFile(filePath)
})

app.put('/api/cases/:caseId/blobs/:docId', express.raw({ type: 'application/octet-stream', limit: '500mb' }), (req, res) => {
  const blobsDir = getCaseSubdir(req.params.caseId, 'blobs')
  const id = safeId(req.params.docId)
  fs.writeFileSync(path.join(blobsDir, id), req.body)
  if (req.query.name) {
    fs.writeFileSync(path.join(blobsDir, `${id}.meta`), JSON.stringify({ name: req.query.name }))
  }
  res.json({ ok: true })
})

// ── Case-scoped PDF Notes ──

app.get('/api/cases/:caseId/notes/:docId', (req, res) => {
  const filePath = path.join(getCaseSubdir(req.params.caseId, 'notes'), `${safeId(req.params.docId)}.json`)
  if (!fs.existsSync(filePath)) return res.json([])
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
})

app.post('/api/cases/:caseId/notes/:docId', (req, res) => {
  fs.writeFileSync(
    path.join(getCaseSubdir(req.params.caseId, 'notes'), `${safeId(req.params.docId)}.json`),
    JSON.stringify(req.body)
  )
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

// ── RAG (Local vector search via sqlite-vec) ──────────────────────────────

const RAG_DB_PATH = path.join(DATA_DIR, 'rag.db')
const EMBED_MODEL = 'embeddinggemma:latest'
const EMBED_API  = 'http://localhost:11434/api/embeddings'

const _ragDbs = new Map()   // key → { db, dim }  (one DB per case)
let _embedDim = null        // shared — same embed model across all DBs

async function embed(text) {
    const res = await fetch(EMBED_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`)
    const { embedding } = await res.json()
    return embedding // float[]
}

function toBlob(floats) {
    return Buffer.from(new Float32Array(floats).buffer)
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
app.delete('/api/rag/clear-doc/:docId', async (req, res) => {
    const { caseId = 'default' } = req.query
    const safeDocId = safeId(req.params.docId)
    try {
        const { db } = await getRagDb(caseId)
        // In a per-case DB every row belongs to this case, so filter by doc_id only
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
app.post('/api/rag/prune-doc', async (req, res) => {
    try {
        const { docId, caseId = 'default', keep } = req.body
        if (!docId || !Array.isArray(keep)) return res.status(400).json({ error: 'Missing docId or keep' })

        const { db } = await getRagDb(caseId)
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
        const { docId, query, k = 5, caseId = 'default' } = req.body
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

        res.json(rerank(chunks, distMap, query, k).map(c => ({
            ...c,
            bbox: c.bbox ? JSON.parse(c.bbox) : null,
        })))
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

            const emb = await embed(`${name}: ${description}`)
            const { lastInsertRowid: catId } = db.prepare(
                'INSERT OR IGNORE INTO format_cats (name, description) VALUES (?, ?)'
            ).run(name, description)
            if (catId) {
                db.prepare('INSERT INTO vec_cats (id, embedding) VALUES (?, ?)').run(BigInt(catId), toBlob(emb))
                indexed++
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

// Global error handler — converts multer/express errors to JSON responses
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    res.status(status).json({ error: err.message || 'Unexpected error' })
})

app.listen(3001, () => console.log('Storage server running on http://localhost:3001'))

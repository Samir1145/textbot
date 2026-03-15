#!/usr/bin/env node
/**
 * import-caselaw.mjs — One-time import of a 3rd party caselaw corpus.
 *
 * Usage:
 *   node import-caselaw.mjs --input caselaw.jsonl
 *   node import-caselaw.mjs --input caselaw.jsonl --re-embed   (if no vectors in file)
 *   node import-caselaw.mjs --input caselaw.jsonl --output /tmp/caselaw-custom.db
 *   node import-caselaw.mjs --activate                          (promote latest incoming to active)
 *
 * Expected JSONL format (one JSON object per line):
 *   { "id": "ewca-2020-1", "citation": "Smith v Jones [2020] EWCA Civ 1",
 *     "text": "Holding: ...", "court": "EWCA", "year": 2020,
 *     "jurisdiction": "England & Wales",
 *     "vector": [0.123, -0.456, ...]  }   ← optional if --re-embed
 *
 * If --re-embed is passed, vectors are generated locally via Ollama nomic-embed-text.
 * Otherwise, vectors must be present in the JSONL file.
 *
 * Output is written to data/caselaw/incoming/caselaw-YYYYMMDD.db by default.
 * Use POST /api/admin/caselaw/swap to promote it to active.
 */

import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const require    = createRequire(import.meta.url)
const Database   = require('better-sqlite3')
const sqliteVec  = require('sqlite-vec')

const __dirname  = path.dirname(fileURLToPath(import.meta.url))

// ── Args ──────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2)
const inputPath = args[args.indexOf('--input') + 1]   || null
const customOut = args[args.indexOf('--output') + 1]  || null
const reEmbed   = args.includes('--re-embed')
const activateOnly = args.includes('--activate')

const OLLAMA_API = process.env.OLLAMA_URL  || 'http://localhost:11434/api/embeddings'
const EMBED_MODEL= process.env.EMBED_MODEL || 'nomic-embed-text'
const BATCH_SIZE = 50   // re-embed batch size (Ollama calls)

const INCOMING_DIR = path.join(__dirname, 'data', 'caselaw', 'incoming')
fs.mkdirSync(INCOMING_DIR, { recursive: true })

// ── Activate-only mode ────────────────────────────────────────────────────────
if (activateOnly) {
    const { swapCaselawDb } = await import('./caselawDb.js')
    const files = fs.readdirSync(INCOMING_DIR).filter(f => f.endsWith('.db')).sort().reverse()
    if (!files.length) { console.error('No .db files in incoming/'); process.exit(1) }
    const latest = path.join(INCOMING_DIR, files[0])
    console.log(`Activating: ${files[0]}`)
    const result = await swapCaselawDb(latest)
    console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
    process.exit(result.ok ? 0 : 1)
}

// ── Input validation ──────────────────────────────────────────────────────────
if (!inputPath) {
    console.error('Usage: node import-caselaw.mjs --input <file.jsonl> [--re-embed] [--output <out.db>]')
    process.exit(1)
}
if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`)
    process.exit(1)
}

// ── Output path ───────────────────────────────────────────────────────────────
const datestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const outPath   = customOut ?? path.join(INCOMING_DIR, `caselaw-${datestamp}.db`)

if (fs.existsSync(outPath)) {
    console.warn(`Output exists, overwriting: ${outPath}`)
    fs.unlinkSync(outPath)
}

// ── Create DB ─────────────────────────────────────────────────────────────────
console.log(`Creating: ${outPath}`)
const db = new Database(outPath)
sqliteVec.load(db)

// Detect embedding dimension from first line with a vector
let dim = null

// Schema — created after we know the dimension
function ensureSchema(detectedDim) {
    if (dim === detectedDim) return
    dim = detectedDim
    db.exec(`
        CREATE TABLE IF NOT EXISTS caselaw_entries (
            id           TEXT PRIMARY KEY,
            citation     TEXT NOT NULL,
            text         TEXT NOT NULL,
            court        TEXT,
            year         INTEGER,
            jurisdiction TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS caselaw_vecs
            USING vec0(embedding float[${dim}]);
    `)
    console.log(`Schema created (dim=${dim})`)
}

// ── Embed helper ──────────────────────────────────────────────────────────────
async function embedText(text) {
    const res = await fetch(OLLAMA_API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embed error ${res.status}`)
    const { embedding } = await res.json()
    return embedding
}

// ── Insert prepared statements (created lazily after schema) ──────────────────
let stmtEntry, stmtVec, txInsert

function prepareStatements() {
    stmtEntry = db.prepare(`
        INSERT OR REPLACE INTO caselaw_entries (id, citation, text, court, year, jurisdiction)
        VALUES (@id, @citation, @text, @court, @year, @jurisdiction)
    `)
    stmtVec   = db.prepare(`INSERT INTO caselaw_vecs (embedding) VALUES (?)`)
    txInsert  = db.transaction((rows) => {
        for (const { entry, vec } of rows) {
            stmtEntry.run(entry)
            stmtVec.run(Buffer.from(new Float32Array(vec).buffer))
        }
    })
}

// ── Stream JSONL ──────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: fs.createReadStream(inputPath), crlfDelay: Infinity })

let lineNum   = 0
let imported  = 0
let skipped   = 0
let batch     = []        // { entry, text } for re-embed batches
let batchVecs = []        // { entry, vec } ready to insert

async function flushBatch() {
    if (!batch.length) return
    // Re-embed all texts in this batch
    const embedPromises = batch.map(b => embedText(b.text).catch(() => null))
    const vecs = await Promise.all(embedPromises)
    for (let i = 0; i < batch.length; i++) {
        if (!vecs[i]) { skipped++; continue }
        if (!dim) { ensureSchema(vecs[i].length); prepareStatements() }
        batchVecs.push({ entry: batch[i].entry, vec: vecs[i] })
    }
    if (batchVecs.length >= 200) {
        txInsert(batchVecs)
        imported += batchVecs.length
        batchVecs = []
        process.stdout.write(`\r  imported ${imported}…`)
    }
    batch = []
}

for await (const line of rl) {
    lineNum++
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let obj
    try { obj = JSON.parse(trimmed) }
    catch { console.warn(`  Line ${lineNum}: invalid JSON — skipped`); skipped++; continue }

    const entry = {
        id:           String(obj.id ?? crypto.randomUUID()),
        citation:     String(obj.citation ?? obj.title ?? ''),
        text:         String(obj.text ?? obj.holding ?? obj.content ?? ''),
        court:        obj.court         ?? null,
        year:         obj.year          ?? null,
        jurisdiction: obj.jurisdiction  ?? null,
    }

    if (!entry.citation || !entry.text) { skipped++; continue }

    if (reEmbed) {
        // Buffer for batch re-embedding
        batch.push({ entry, text: entry.text.slice(0, 8192) })
        if (batch.length >= BATCH_SIZE) await flushBatch()
    } else {
        // Use pre-computed vector from the JSONL
        const vec = obj.vector ?? obj.embedding ?? obj.vec
        if (!Array.isArray(vec) || !vec.length) {
            console.warn(`  Line ${lineNum}: no vector — use --re-embed or fix the JSONL`); skipped++; continue
        }
        if (!dim) { ensureSchema(vec.length); prepareStatements() }
        if (vec.length !== dim) { skipped++; continue }
        batchVecs.push({ entry, vec })
        if (batchVecs.length >= 500) {
            txInsert(batchVecs)
            imported += batchVecs.length
            batchVecs = []
            process.stdout.write(`\r  imported ${imported}…`)
        }
    }
}

// Flush remainders
if (reEmbed) await flushBatch()
if (batchVecs.length) {
    txInsert(batchVecs)
    imported += batchVecs.length
}

db.exec('ANALYZE')   // update query planner stats
db.close()

console.log(`\n\n✓ Done — ${imported} entries imported, ${skipped} skipped`)
console.log(`  Output: ${outPath}`)
console.log(`\nTo activate: POST /api/admin/caselaw/swap`)
console.log(`          or: node import-caselaw.mjs --activate`)

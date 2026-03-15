/**
 * caselawDb.js — Isolated, read-only caselaw vector database
 *
 * Architecture:
 *   data/caselaw/
 *     caselaw.db          ← active database (symlink or real file)
 *     manifest.json       ← version metadata
 *     versions/
 *       caselaw-YYYYMMDD.db   ← versioned files (kept for 3 weeks)
 *     incoming/           ← staging area for new imports
 *
 * The active connection is always READ-ONLY. The caselaw corpus is
 * completely isolated from case RAG databases — different file, different
 * connection, different module. There is no shared connection or ATTACH.
 *
 * Expected schema (what the 3rd party must ship or what import-caselaw.mjs creates):
 *   CREATE TABLE caselaw_entries (
 *     id           TEXT PRIMARY KEY,
 *     citation     TEXT NOT NULL,    -- "Smith v Jones [2020] EWCA Civ 1"
 *     text         TEXT NOT NULL,    -- holding / snippet
 *     court        TEXT,             -- "UKSC", "EWCA", "EWHC", "HK CFA", etc.
 *     year         INTEGER,
 *     jurisdiction TEXT              -- "England & Wales", "Hong Kong", etc.
 *   );
 *   CREATE VIRTUAL TABLE caselaw_vecs USING vec0(
 *     embedding float[768]           -- nomic-embed-text dimensions
 *   );
 *   -- rowid of caselaw_vecs matches rowid of caselaw_entries (1-based insert order)
 */

import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const require = createRequire(import.meta.url)
const Database  = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const CASELAW_DIR       = path.join(__dirname, 'data', 'caselaw')
const VERSIONS_DIR      = path.join(CASELAW_DIR, 'versions')
const INCOMING_DIR      = path.join(CASELAW_DIR, 'incoming')
const ACTIVE_PATH       = path.join(CASELAW_DIR, 'caselaw.db')
const MANIFEST_PATH     = path.join(CASELAW_DIR, 'manifest.json')

const MAX_BACKUP_WEEKS  = 3      // keep last N versioned files
const MIN_ROW_RATIO     = 0.70   // new db must have ≥70% of current row count
const EXPECTED_DIM      = 768    // nomic-embed-text embedding dimension

// Ensure directories exist on module load
fs.mkdirSync(VERSIONS_DIR, { recursive: true })
fs.mkdirSync(INCOMING_DIR, { recursive: true })

// ── Connection state ──────────────────────────────────────────────────────────

let _db      = null   // current read-only connection
let _dim     = null   // detected embedding dimension
let _ready   = false  // true once active db loaded and validated

function _openDb(dbPath) {
    const db = new Database(dbPath, { readonly: true })
    sqliteVec.load(db)
    return db
}

/**
 * Lazily open the active caselaw.db.
 * Returns null (with a warning) if no db exists yet — callers must handle this.
 */
export function getCaselawDb() {
    if (_db) return _db
    if (!fs.existsSync(ACTIVE_PATH)) return null
    try {
        _db    = _openDb(ACTIVE_PATH)
        _ready = true
        console.log('[CASELAW] opened active db:', ACTIVE_PATH)
    } catch (err) {
        console.error('[CASELAW] failed to open active db:', err.message)
        _db = null
    }
    return _db
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Semantic search against the caselaw corpus.
 * @param {number[]} queryVec  — pre-computed embedding (from embed())
 * @param {number}   k         — number of results to return
 * @param {object}   filters   — optional { court, jurisdiction, yearFrom, yearTo }
 * @returns {Array<{ id, citation, text, court, year, jurisdiction, score }>}
 */
export function searchCaselaw(queryVec, k = 5, filters = {}) {
    const db = getCaselawDb()
    if (!db) return []

    try {
        const blob = Buffer.from(new Float32Array(queryVec).buffer)
        const topK = Math.min(k * 10, 100)   // over-fetch then filter

        // ANN search in vec table
        const knnRows = db.prepare(
            'SELECT rowid, distance FROM caselaw_vecs WHERE embedding MATCH ? AND k = ? ORDER BY distance'
        ).all(blob, topK)

        if (!knnRows.length) return []

        const distMap = new Map(knnRows.map(r => [Number(r.rowid), r.distance]))
        const ids     = knnRows.map(r => Number(r.rowid))
        const placeholders = ids.map(() => '?').join(',')

        // Fetch metadata for matched rows
        let rows = db.prepare(
            `SELECT rowid, id, citation, text, court, year, jurisdiction
             FROM caselaw_entries
             WHERE rowid IN (${placeholders})`
        ).all(...ids)

        // Apply optional filters
        if (filters.court)        rows = rows.filter(r => r.court?.toLowerCase().includes(filters.court.toLowerCase()))
        if (filters.jurisdiction) rows = rows.filter(r => r.jurisdiction?.toLowerCase().includes(filters.jurisdiction.toLowerCase()))
        if (filters.yearFrom)     rows = rows.filter(r => r.year >= filters.yearFrom)
        if (filters.yearTo)       rows = rows.filter(r => r.year <= filters.yearTo)

        // Sort by distance and slice to k
        return rows
            .sort((a, b) => (distMap.get(a.rowid) ?? 1) - (distMap.get(b.rowid) ?? 1))
            .slice(0, k)
            .map(r => ({
                id:           r.id,
                citation:     r.citation,
                text:         r.text?.slice(0, 600) ?? '',
                court:        r.court ?? '',
                year:         r.year  ?? null,
                jurisdiction: r.jurisdiction ?? '',
                score:        +(1 - (distMap.get(r.rowid) ?? 1)).toFixed(4),
            }))
    } catch (err) {
        console.error('[CASELAW] search error:', err.message)
        return []
    }
}

// ── Status ────────────────────────────────────────────────────────────────────

export function getCaselawStatus() {
    const db = getCaselawDb()
    const manifest = _readManifest()

    if (!db) {
        return { available: false, message: 'No caselaw database loaded. Drop a .db file into data/caselaw/incoming/ and run the swap.' }
    }

    try {
        const { count } = db.prepare('SELECT count(*) as count FROM caselaw_entries').get()
        const versions  = _listVersions()
        return {
            available:    true,
            rows:         count,
            embeddingDim: manifest.embeddingDim ?? EXPECTED_DIM,
            model:        manifest.model        ?? 'nomic-embed-text',
            version:      manifest.version      ?? 'unknown',
            lastSwapped:  manifest.lastSwapped  ?? null,
            activeFile:   path.basename(fs.realpathSync(ACTIVE_PATH).replace(/\\/g, '/')),
            backups:      versions.filter(v => !v.endsWith(path.basename(fs.realpathSync(ACTIVE_PATH)))),
        }
    } catch (err) {
        return { available: false, message: err.message }
    }
}

// ── Swap (weekly update) ──────────────────────────────────────────────────────

/**
 * Validate, back up, and promote a new caselaw .db file to active.
 *
 * @param {string} incomingPath — absolute path to the new .db file
 * @param {object} meta         — { version, model, embeddingDim } from the provider
 * @returns {{ ok: boolean, message: string, rows?: number }}
 */
export async function swapCaselawDb(incomingPath, meta = {}) {
    // ── 1. Validate ──────────────────────────────────────────────────────────
    const validation = _validate(incomingPath)
    if (!validation.ok) {
        return { ok: false, message: `Validation failed: ${validation.reason}` }
    }

    const currentRows = _currentRowCount()

    // Row count sanity: new db must have ≥70% of existing rows
    if (currentRows > 0 && validation.rows < currentRows * MIN_ROW_RATIO) {
        return {
            ok: false,
            message: `Row count too low: new db has ${validation.rows} rows but current has ${currentRows}. Expected ≥${Math.round(currentRows * MIN_ROW_RATIO)}.`,
        }
    }

    // ── 2. Version the incoming file ─────────────────────────────────────────
    const datestamp  = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const versionName = `caselaw-${datestamp}.db`
    const versionPath = path.join(VERSIONS_DIR, versionName)

    // Copy (don't move) incoming file to versions/ so incoming/ stays clean
    fs.copyFileSync(incomingPath, versionPath)

    // ── 3. Close current connection before swap ───────────────────────────────
    if (_db) {
        try { _db.close() } catch { /* ignore */ }
        _db    = null
        _ready = false
    }

    // ── 4. Atomic swap — replace active.db with symlink to new version ────────
    try {
        if (fs.existsSync(ACTIVE_PATH)) fs.unlinkSync(ACTIVE_PATH)
        fs.symlinkSync(versionPath, ACTIVE_PATH)
    } catch (symlinkErr) {
        // Symlinks may fail on some Windows setups — fall back to copy
        try { fs.copyFileSync(versionPath, ACTIVE_PATH) }
        catch (copyErr) {
            return { ok: false, message: `Swap failed: ${copyErr.message}` }
        }
    }

    // ── 5. Re-open connection on new file ─────────────────────────────────────
    try {
        _db    = _openDb(ACTIVE_PATH)
        _ready = true
    } catch (openErr) {
        return { ok: false, message: `Opened new db but got error: ${openErr.message}` }
    }

    // ── 6. Write manifest ─────────────────────────────────────────────────────
    const manifest = {
        version:      meta.version      ?? versionName,
        model:        meta.model        ?? 'nomic-embed-text',
        embeddingDim: meta.embeddingDim ?? validation.dim,
        rows:         validation.rows,
        lastSwapped:  new Date().toISOString(),
        activeFile:   versionName,
    }
    _writeManifest(manifest)

    // ── 7. Purge old backups beyond MAX_BACKUP_WEEKS ──────────────────────────
    _purgeOldVersions(versionName)

    console.log(`[CASELAW] swapped to ${versionName} — ${validation.rows} entries`)
    return { ok: true, message: `Activated ${versionName}`, rows: validation.rows }
}

// ── Validation ────────────────────────────────────────────────────────────────

function _validate(dbPath) {
    if (!fs.existsSync(dbPath)) {
        return { ok: false, reason: `File not found: ${dbPath}` }
    }

    let db
    try {
        db = _openDb(dbPath)
    } catch (err) {
        return { ok: false, reason: `Cannot open db: ${err.message}` }
    }

    try {
        // 1. Required tables present
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='shadow'").all().map(r => r.name)
        if (!tables.includes('caselaw_entries')) {
            return { ok: false, reason: 'Missing table: caselaw_entries' }
        }
        // caselaw_vecs shows as shadow tables in vec0; check the virtual table itself
        const vtables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='shadow' OR type='virtual'").all().map(r => r.name)
        const hasVecs = vtables.some(n => n.startsWith('caselaw_vecs'))
        if (!hasVecs) {
            return { ok: false, reason: 'Missing virtual table: caselaw_vecs' }
        }

        // 2. Row count
        const { count } = db.prepare('SELECT count(*) as count FROM caselaw_entries').get()
        if (count === 0) {
            return { ok: false, reason: 'caselaw_entries table is empty' }
        }

        // 3. Embedding dimension
        const vecRow = db.prepare('SELECT vec_to_json(embedding) as v FROM caselaw_vecs LIMIT 1').get()
        const dim = vecRow ? JSON.parse(vecRow.v).length : null
        if (!dim) {
            return { ok: false, reason: 'Cannot determine embedding dimension' }
        }

        // 4. Live ANN search — confirm queries work
        const testVec  = Buffer.from(new Float32Array(dim).fill(0.01).buffer)
        const testRows = db.prepare('SELECT rowid, distance FROM caselaw_vecs WHERE embedding MATCH ? AND k = 3').all(testVec)
        if (!testRows.length) {
            return { ok: false, reason: 'ANN search returned no results on test query' }
        }

        return { ok: true, rows: count, dim }
    } catch (err) {
        return { ok: false, reason: `Validation query failed: ${err.message}` }
    } finally {
        try { db.close() } catch { /* ignore */ }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _currentRowCount() {
    const db = getCaselawDb()
    if (!db) return 0
    try { return db.prepare('SELECT count(*) as count FROM caselaw_entries').get()?.count ?? 0 }
    catch { return 0 }
}

function _listVersions() {
    try {
        return fs.readdirSync(VERSIONS_DIR)
            .filter(f => f.startsWith('caselaw-') && f.endsWith('.db'))
            .sort()
            .reverse()   // newest first
    } catch { return [] }
}

function _purgeOldVersions(keepFile) {
    const versions = _listVersions()
    if (versions.length <= MAX_BACKUP_WEEKS) return
    const toDelete = versions.slice(MAX_BACKUP_WEEKS)
    for (const f of toDelete) {
        if (f === keepFile) continue   // never delete the one we just activated
        try {
            fs.unlinkSync(path.join(VERSIONS_DIR, f))
            console.log('[CASELAW] purged old version:', f)
        } catch (err) {
            console.warn('[CASELAW] could not purge:', f, err.message)
        }
    }
}

function _readManifest() {
    try {
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    } catch { return {} }
}

function _writeManifest(data) {
    try { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2)) }
    catch (err) { console.error('[CASELAW] manifest write error:', err.message) }
}

// ── File integrity helper (optional, used by admin endpoint) ─────────────────

export function fileSha256(filePath) {
    const hash = createHash('sha256')
    hash.update(fs.readFileSync(filePath))
    return hash.digest('hex')
}

export { INCOMING_DIR, CASELAW_DIR, VERSIONS_DIR }

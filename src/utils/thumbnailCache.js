/**
 * IndexedDB cache for PDF thumbnail images.
 * Thumbnails are stored as JPEG blobs keyed by "docId:pageNum".
 * Entries expire after MAX_AGE_MS (7 days).
 */

const DB_NAME  = 'textbot-thumbs-v1'
const STORE    = 'thumbnails'
const MAX_AGE  = 7 * 24 * 60 * 60 * 1000 // 7 days in ms

let _db = null

async function getDb() {
  if (_db) return _db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = e => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess  = e => { _db = e.target.result; resolve(_db) }
    req.onerror    = e => reject(e.target.error)
  })
}

/** Returns a Blob for the cached thumbnail, or null if missing/expired. */
export async function getCachedThumb(docId, pageNum) {
  try {
    const db = await getDb()
    return new Promise(resolve => {
      const tx  = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(`${docId}:${pageNum}`)
      req.onsuccess = e => {
        const entry = e.target.result
        if (!entry || Date.now() - entry.ts > MAX_AGE) return resolve(null)
        resolve(entry.blob)
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

/** Store a thumbnail Blob in IDB. */
export async function setCachedThumb(docId, pageNum, blob) {
  try {
    const db = await getDb()
    return new Promise(resolve => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ key: `${docId}:${pageNum}`, blob, ts: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror    = () => resolve()
    })
  } catch { /* silent — cache failure never breaks the UI */ }
}

/** Delete all cached thumbnails for a document (call on doc delete/re-upload). */
export async function clearCachedThumbs(docId) {
  try {
    const db = await getDb()
    return new Promise(resolve => {
      const tx    = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req   = store.openCursor()
      req.onsuccess = e => {
        const cursor = e.target.result
        if (!cursor) return
        if (String(cursor.key).startsWith(`${docId}:`)) cursor.delete()
        cursor.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror    = () => resolve()
    })
  } catch { /* silent */ }
}

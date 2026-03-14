/**
 * Off-main-thread PDF renderer — ImageBitmap edition.
 *
 * Protocol:
 *   IN  { type: 'init',   pdfData: ArrayBuffer, scale?: number }
 *   OUT { type: 'ready',  numPages: number, dims: { [pageNum]: {w,h} } }
 *   OUT { type: 'dims-update', dims: { [pageNum]: {w,h} } }
 *
 *   IN  { type: 'render', pageNum: number, dpr: number }
 *   OUT { type: 'rendered', pageNum: number, bitmap: ImageBitmap }  ← transferable
 *
 *   IN  { type: 'cancel', pageNum: number }   ← drop from queue if not yet started
 *
 *   OUT { type: 'error', error: string }
 *   OUT { type: 'page-error', pageNum: number, error: string }
 *
 * Key design change vs the previous OffscreenCanvas-transfer approach:
 *   • The worker owns a single reusable OffscreenCanvas.
 *   • After rendering it calls transferToImageBitmap() and posts the bitmap back.
 *   • The main thread draws it onto its own <canvas> with ctx.drawImage().
 *   • Main thread keeps full control of every <canvas> element — can repaint
 *     at any time, no "stuck grey" state possible.
 *   • A simple FIFO queue with deduplication + cancel prevents runaway growth.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

// ── document.fonts shim ───────────────────────────────────────────────────
// pdfjs calls document.fonts.add(fontFace) during render. In a Web Worker,
// document is undefined, so every glyph falls back to .notdef. Wire up the
// spec-equivalent self.fonts (FontFaceSet) instead.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { fonts: self.fonts }
}

// ── Worker-safe canvas / filter factories ────────────────────────────────
class WorkerCanvasFactory {
  constructor() {}
  create(width, height) {
    const canvas = new OffscreenCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(canvasAndCtx, width, height) {
    canvasAndCtx.canvas.width  = width
    canvasAndCtx.canvas.height = height
  }
  destroy(canvasAndCtx) {
    canvasAndCtx.canvas.width  = 0
    canvasAndCtx.canvas.height = 0
    canvasAndCtx.canvas  = null
    canvasAndCtx.context = null
  }
}

class WorkerFilterFactory {
  addFilter()         { return 'none' }
  addAlphaFilter()    { return 'none' }
  addLuminosityFilter() { return 'none' }
  addHCMFilter()      { return 'none' }
  destroy()           {}
}

// ── State ─────────────────────────────────────────────────────────────────
let RENDER_SCALE = 1.25
let pdf          = null
let renderCanvas = null   // single reusable OffscreenCanvas

// Render queue: [{ pageNum, dpr }, ...]
let queue     = []
let busy      = false

// ── Queue processor ───────────────────────────────────────────────────────
async function drain() {
  if (busy || queue.length === 0 || !pdf) return
  busy = true
  const { pageNum, dpr } = queue.shift()
  try {
    const page     = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: RENDER_SCALE * dpr })
    const w = Math.floor(viewport.width)
    const h = Math.floor(viewport.height)

    if (!renderCanvas) renderCanvas = new OffscreenCanvas(w, h)
    renderCanvas.width  = w
    renderCanvas.height = h

    const ctx = renderCanvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    page.cleanup()

    // Transfer bitmap to main thread — zero-copy, no canvas ownership transfer
    const bitmap = renderCanvas.transferToImageBitmap()
    self.postMessage({ type: 'rendered', pageNum, bitmap }, [bitmap])
  } catch (err) {
    self.postMessage({ type: 'page-error', pageNum, error: err?.message ?? String(err) })
  }
  busy = false
  drain()   // process next item
}

// ── Message handler ───────────────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  try {
    // ── init ────────────────────────────────────────────────────────────
    if (data.type === 'init') {
      if (data.scale) RENDER_SCALE = data.scale
      // Reset queue on (re-)init
      queue = []
      busy  = false

      pdf = await getDocument({
        data: data.pdfData,
        CanvasFactory:  WorkerCanvasFactory,
        FilterFactory:  WorkerFilterFactory,
        standardFontDataUrl: '/standard_fonts/',
        cMapUrl:         '/cmaps/',
        cMapPacked:      true,
        useWorkerFetch:  false,
      }).promise

      const numPages = pdf.numPages
      const page1    = await pdf.getPage(1)
      const vp1      = page1.getViewport({ scale: RENDER_SCALE })
      const defaultW = Math.floor(vp1.width)
      const defaultH = Math.floor(vp1.height)
      page1.cleanup()

      const dims = {}
      for (let i = 1; i <= numPages; i++) dims[i] = { w: defaultW, h: defaultH }
      self.postMessage({ type: 'ready', numPages, dims })

      // Background: detect non-uniform page sizes
      const updates = {}
      for (let i = 2; i <= numPages; i++) {
        const page = await pdf.getPage(i)
        const vp   = page.getViewport({ scale: RENDER_SCALE })
        const w    = Math.floor(vp.width)
        const h    = Math.floor(vp.height)
        page.cleanup()
        if (w !== defaultW || h !== defaultH) updates[i] = { w, h }
      }
      if (Object.keys(updates).length > 0) {
        self.postMessage({ type: 'dims-update', dims: updates })
      }
      return
    }

    // ── render ──────────────────────────────────────────────────────────
    if (data.type === 'render' && pdf) {
      const { pageNum, dpr } = data
      // Deduplicate: skip if already in queue
      if (!queue.some(r => r.pageNum === pageNum)) {
        queue.push({ pageNum, dpr })
      }
      drain()
      return
    }

    // ── cancel ──────────────────────────────────────────────────────────
    if (data.type === 'cancel') {
      // Remove from pending queue (can't cancel the currently running render
      // without pdf.js renderTask tracking — acceptable; it finishes quickly)
      queue = queue.filter(r => r.pageNum !== data.pageNum)
      return
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err?.message ?? String(err) })
  }
}

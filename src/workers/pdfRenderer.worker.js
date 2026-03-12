/**
 * Off-main-thread PDF renderer.
 *
 * Protocol:
 *   IN  { type: 'init',   pdfData: ArrayBuffer, scale?: number }
 *   OUT { type: 'ready',  numPages: number, dims: { [pageNum]: {w,h} } }
 *   OUT { type: 'dims-update', dims: { [pageNum]: {w,h} } }
 *
 *   IN  { type: 'render', pageNum: number, canvas: OffscreenCanvas, dpr: number }
 *   OUT { type: 'rendered', pageNum: number }
 *
 *   OUT { type: 'error', error: string }
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

// ── document.fonts shim ───────────────────────────────────────────────────
// pdfjs calls document.fonts.add(fontFace) during page.render() to register
// embedded font programs. In a Web Worker, document is undefined, so every
// glyph falls back to .notdef (the solid boxes). WorkerGlobalScope exposes
// self.fonts (FontFaceSet) which is spec-equivalent — wire it up.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { fonts: self.fonts }
}

// ── Worker-safe factories (document is undefined in Web Workers) ──────────

/**
 * Replaces DOMCanvasFactory. pdfjs uses this to create temporary scratch
 * canvases for transparency groups / compositing. In a worker we use
 * OffscreenCanvas instead of document.createElement('canvas').
 */
class WorkerCanvasFactory {
  // pdfjs instantiates this class as: new CanvasFactory({ ownerDocument, enableHWA })
  // We ignore ownerDocument entirely.
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

/**
 * Replaces DOMFilterFactory. The DOM version creates SVG filter elements and
 * CSS style elements — none of which are available in a worker. We use a
 * no-op implementation (same pattern as NodeFilterFactory inside pdfjs).
 */
class WorkerFilterFactory {
  addFilter() { return 'none' }
  addAlphaFilter() { return 'none' }
  addLuminosityFilter() { return 'none' }
  addHCMFilter() { return 'none' }
  destroy() {}
}

// ─────────────────────────────────────────────────────────────────────────────

let RENDER_SCALE = 1.25
let pdf = null

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      if (data.scale) RENDER_SCALE = data.scale

      pdf = await getDocument({
        data: data.pdfData,
        // Worker-safe factories — avoids "Cannot read properties of undefined
        // (reading 'createElement')" thrown by DOMCanvasFactory / DOMFilterFactory
        CanvasFactory: WorkerCanvasFactory,
        FilterFactory: WorkerFilterFactory,
        // Font resources served from /public/
        standardFontDataUrl: '/standard_fonts/',
        cMapUrl: '/cmaps/',
        cMapPacked: true,
        // Don't let pdfjs check document.baseURI for worker-fetch eligibility
        useWorkerFetch: false,
      }).promise

      const numPages = pdf.numPages

      // Get page-1 dims and broadcast immediately — don't wait for all pages
      const page1 = await pdf.getPage(1)
      const vp1   = page1.getViewport({ scale: RENDER_SCALE })
      const defaultW = Math.floor(vp1.width)
      const defaultH = Math.floor(vp1.height)
      page1.cleanup()

      const dims = {}
      for (let i = 1; i <= numPages; i++) dims[i] = { w: defaultW, h: defaultH }

      self.postMessage({ type: 'ready', numPages, dims })

      // Background: scan remaining pages for non-uniform sizes
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

    if (data.type === 'render' && pdf) {
      const { pageNum, canvas, dpr } = data
      const page     = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale: RENDER_SCALE * dpr })

      canvas.width  = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)

      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      page.cleanup()

      self.postMessage({ type: 'rendered', pageNum })
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err?.message ?? String(err) })
  }
}

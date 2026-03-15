/**
 * Panel resize tests
 *
 * A. Chunk panel drag handle is present
 * B. Dragging handle upward increases panel height
 * C. Dragging handle downward decreases panel height
 * D. Body height adjusts proportionally
 * E. Panel respects a minimum height (header still visible)
 */

import { openCase, uploadPDF, clickExtract, waitForChunks, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–E — Chunk panel drag resize', async (page) => {
  await openCase(page, 'Resize-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-resize.pdf'))
  await clickExtract(page)
  await waitForChunks(page, 1)

  // A — drag handle exists
  const handle = await page.$('.pdfapp-extracted-drag')
  check(!!handle, 'drag handle present')
  if (!handle) return

  // Measure initial panel height
  const panel = await page.$('.pdfapp-extracted-panel')
  const initialHeight = await panel.evaluate(el => el.getBoundingClientRect().height)
  ok(`initial panel height: ${initialHeight.toFixed(0)}px`)

  const handleBox = await handle.boundingBox()

  // B — drag upward (increases panel height)
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 80, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)

  const heightAfterUp = await panel.evaluate(el => el.getBoundingClientRect().height)
  check(heightAfterUp > initialHeight, `dragging up increases height: ${initialHeight.toFixed(0)} → ${heightAfterUp.toFixed(0)}px`)

  // D — body height adjusts
  const bodyHeight = await page.$eval('.pdfapp-chunks-body', el => el.getBoundingClientRect().height)
  check(bodyHeight > 40, `chunks body height after resize: ${bodyHeight.toFixed(0)}px`)

  // C — drag downward (decreases panel height)
  const handleBox2 = await handle.boundingBox()
  await page.mouse.move(handleBox2.x + handleBox2.width / 2, handleBox2.y + handleBox2.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox2.x + handleBox2.width / 2, handleBox2.y + 60, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)

  const heightAfterDown = await panel.evaluate(el => el.getBoundingClientRect().height)
  check(heightAfterDown < heightAfterUp, `dragging down decreases height: ${heightAfterUp.toFixed(0)} → ${heightAfterDown.toFixed(0)}px`)

  // E — header always visible (minimum height respected)
  const header = await page.$('.pdfapp-extracted-header')
  const headerBox = await header?.boundingBox()
  check(!!headerBox && headerBox.height > 0, `header remains visible after resize (h=${headerBox?.height?.toFixed(0)}px)`)

  // Drag way down to test minimum
  const handleBox3 = await handle.boundingBox()
  await page.mouse.move(handleBox3.x + handleBox3.width / 2, handleBox3.y + handleBox3.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox3.x + handleBox3.width / 2, handleBox3.y + 500, { steps: 20 })
  await page.mouse.up()
  await page.waitForTimeout(200)

  const heightAtMin = await panel.evaluate(el => el.getBoundingClientRect().height)
  // Header (32px) should always be visible — panel should not collapse below 32px
  const headerStillVisible = await page.$eval('.pdfapp-extracted-header', el => el.getBoundingClientRect().height > 0)
  check(headerStillVisible, `header still visible at minimum height (panel=${heightAtMin.toFixed(0)}px)`)
})

process.exit(summary())

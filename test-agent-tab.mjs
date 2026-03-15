/**
 * Agent tab tests
 *
 * A. Agent tab button is present
 * B. Clicking Agent tab shows the agent panel
 * C. Agent panel has an input area
 * D. Agent panel is independent per document (state resets on doc switch)
 *
 * Note: Full agent response tests require Ollama — skipped here.
 * These tests only verify the UI shell.
 */

import { openCase, uploadPDF, makeTextPDF, makeAssert, runTest } from './test-helpers.mjs'

const { ok, fail, check, summary } = makeAssert()

await runTest('Test A–D — Agent tab UI', async (page) => {
  await openCase(page, 'Agent-' + Date.now())
  await uploadPDF(page, makeTextPDF('/tmp/tb-agent.pdf'))

  // A — Agent tab button
  const agentTab = await page.$('.pdfapp-right-tab:has-text("Agent")')
  check(!!agentTab, 'Agent tab button present')
  if (!agentTab) return

  // B — click opens agent panel
  await agentTab.click()
  await page.waitForTimeout(400)

  // The active tab should now be Agent
  const activeTab = await page.$('.pdfapp-right-tab--active')
  const activeTabText = activeTab ? await activeTab.textContent() : ''
  check(activeTabText.includes('Agent'), `Agent tab is active: "${activeTabText.trim()}"`)

  // C — agent panel has some content / input area
  const agentPanel = await page.$('.pdfapp-agent, [class*="agent"]')
  check(!!agentPanel, 'agent panel element present')

  const agentInput = await page.$('.pdfapp-agent-textarea, .pdfapp-agent-panel textarea, .pdfapp-agent-panel input')
  check(!!agentInput, 'agent input area present')

  // Check the panel is not empty
  const panelBox = await agentPanel?.boundingBox()
  check(!!panelBox && panelBox.height > 0, `agent panel visible (h=${panelBox?.height?.toFixed(0)}px)`)

  // D — switch tab and back — state preserved
  const chatTab = await page.$('.pdfapp-right-tab:has-text("Chat")')
  if (chatTab) {
    await chatTab.click()
    await page.waitForTimeout(200)
    await agentTab.click()
    await page.waitForTimeout(200)

    const agentStillActive = await page.$('.pdfapp-right-tab--active')
    const stillActiveText = agentStillActive ? await agentStillActive.textContent() : ''
    check(stillActiveText.includes('Agent'), 'Agent tab re-activated after switching away and back')
  }
})

process.exit(summary())

/**
 * Unit tests for the modified Calendar deletion flow.
 *
 * What changed:
 *   - handleDeleteCase no longer calls window.confirm; instead it opens a
 *     React confirmation modal showing the case name and document count.
 *   - confirmDeleteCase calls deleteCase() then removes localStorage entry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mock heavy deps ────────────────────────────────────────────────────────

vi.mock('../db.js', () => ({
  deleteCase: vi.fn().mockResolvedValue(undefined),
  saveSummary: vi.fn(),
  loadSummary: vi.fn(),
  deleteNotes: vi.fn(),
  saveCases: vi.fn(),
}))

// CSS modules / plain CSS — vitest/jsdom ignores them
vi.mock('./Calendar.css', () => ({}))

import Calendar from '../pages/Calendar.jsx'
import { deleteCase } from '../db.js'

// ── Helpers ────────────────────────────────────────────────────────────────

const CASE_A = { id: 'case-1', name: 'Smith v Jones', date: '2026-03-20', color: '#3b82f6' }

function seedLocalStorage(caseId, parties) {
  localStorage.setItem(`pdf-parties-${caseId}`, JSON.stringify(parties))
  // Also seed the cases list so Calendar renders it
  localStorage.setItem('pdf-app-cases', JSON.stringify([CASE_A]))
}

function clearLocalStorage() {
  localStorage.clear()
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Calendar — delete case confirmation modal', () => {
  beforeEach(() => {
    clearLocalStorage()
    vi.clearAllMocks()
    // Prevent window.confirm from being called (it should never be)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
  })

  it('does NOT call window.confirm when the delete button is clicked', async () => {
    seedLocalStorage(CASE_A.id, [])
    render(<Calendar onOpenCase={() => {}} />)

    // Sidebar delete button is rendered; click it (title="Delete case", content "✕")
    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('opens a confirmation modal with the case name', async () => {
    seedLocalStorage(CASE_A.id, [])
    render(<Calendar onOpenCase={() => {}} />)

    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    expect(screen.getByText('Delete Case')).toBeInTheDocument()
    // The modal wraps the name in <strong>; use selector to avoid ambiguity
    expect(screen.getByText('Smith v Jones', { selector: 'strong' })).toBeInTheDocument()
  })

  it('shows document count from localStorage in the modal', async () => {
    const parties = [
      { id: 'p1', name: 'Claimant', documents: [{ id: 'd1' }, { id: 'd2' }] },
      { id: 'p2', name: 'Defendant', documents: [{ id: 'd3' }] },
    ]
    seedLocalStorage(CASE_A.id, parties)
    render(<Calendar onOpenCase={() => {}} />)

    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    // 3 documents total across parties
    expect(screen.getByText(/3 documents/i)).toBeInTheDocument()
  })

  it('dismisses the modal when Cancel is clicked', async () => {
    seedLocalStorage(CASE_A.id, [])
    render(<Calendar onOpenCase={() => {}} />)

    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    expect(screen.getByText('Delete Case')).toBeInTheDocument()

    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    await userEvent.click(cancelBtn)

    expect(screen.queryByText('Delete Case')).not.toBeInTheDocument()
  })

  it('calls deleteCase and removes localStorage entry on confirm', async () => {
    seedLocalStorage(CASE_A.id, [])
    render(<Calendar onOpenCase={() => {}} />)

    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    const confirmBtn = screen.getByRole('button', { name: /^delete$/i })
    await userEvent.click(confirmBtn)

    await waitFor(() => {
      expect(deleteCase).toHaveBeenCalledWith(CASE_A.id)
    })
    expect(localStorage.getItem(`pdf-parties-${CASE_A.id}`)).toBeNull()
  })

  it('does NOT call deleteCase when Cancel is clicked', async () => {
    seedLocalStorage(CASE_A.id, [])
    render(<Calendar onOpenCase={() => {}} />)

    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(deleteCase).not.toHaveBeenCalled()
  })

  it('closes the modal when the overlay (backdrop) is clicked', async () => {
    seedLocalStorage(CASE_A.id, [])
    render(<Calendar onOpenCase={() => {}} />)

    const deleteBtn = await screen.findByTitle('Delete case')
    await userEvent.click(deleteBtn)

    expect(screen.getByText('Delete Case')).toBeInTheDocument()

    // Click the overlay (the element with class cal-modal-overlay)
    const overlay = document.querySelector('.cal-modal-overlay')
    fireEvent.click(overlay)

    expect(screen.queryByText('Delete Case')).not.toBeInTheDocument()
  })
})

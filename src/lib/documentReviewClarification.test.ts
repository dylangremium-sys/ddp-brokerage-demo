import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DOCUMENT_REVIEW_DECISIONS } from '../types'
import type { DocumentReviewStatus } from '../types'

/**
 * Migration 65 — the reasoned non-decision.
 *
 * WHAT THESE PIN, and why each one was reachable before the fix:
 *
 *   · 'awaiting_clarification' exists at all. Production's CHECK admitted
 *     exactly pending|accepted|rejected, so an administrator who could
 *     responsibly neither accept nor reject had no way to say they had looked.
 *   · A decision carries a reason. There was no review-note column anywhere in
 *     the schema, so no reason could be stored even if one were typed.
 *   · A blank reason is refused — including a tab- or newline-only one. The
 *     first draft of migration 65 used btrim(), which strips SPACES ONLY, and
 *     the migration harness caught a document reaching awaiting_clarification
 *     with E'\t\n' as its justification. That is why the test below is explicit
 *     about non-space whitespace rather than just testing ''.
 *   · The history is read from its own table. Before 65 there was none: the
 *     only trigger on farmer_documents wrote to no audit table at all.
 *
 * The DATABASE is the enforcement for all of it — see
 * 65_DOCUMENT_REVIEW_CLARIFICATION_VERIFY.sql, which proves each property on a
 * production-shaped schema with migration 64's live trigger in place. These
 * tests pin the client half: that it sends what the database expects, and that
 * it does not pretend to be the thing standing guard.
 */

const updateSpy = vi.fn<(table: string, patch: Record<string, unknown>) => void>()
const selectSpy = vi.fn<(table: string) => void>()

let reviewRows: Record<string, unknown>[] = []
let reviewError: { message: string } | null = null

vi.mock('./supabase', () => {
  const builder = (table: string) => ({
    select: () => {
      selectSpy(table)
      return {
        // farmer_document_reviews reads filter then order.
        eq: () => ({
          order: () => Promise.resolve({ data: reviewRows, error: reviewError }),
        }),
        order: () => Promise.resolve({ data: [], error: null }),
      }
    },
    update: (patch: Record<string, unknown>) => {
      updateSpy(table, patch)
      return { eq: () => Promise.resolve({ error: null }) }
    },
  })
  return { supabase: { from: builder }, isSupabaseConfigured: true }
})

const { setDocumentReviewStatus, loadDocumentReviewEvents } = await import('./db')

const DOC = 'c0f19f0e-a69a-4c3e-b3fe-0eed9af80eaa'
const ACTOR = '5f3a1c72-8f2b-4f2e-9a71-0c6c2a1f9b44'

beforeEach(() => {
  updateSpy.mockClear()
  selectSpy.mockClear()
  reviewRows = []
  reviewError = null
})

describe('awaiting_clarification is a first-class review outcome', () => {
  it('is one of the three decisions, and pending is not', () => {
    // 'pending' is the absence of a decision, not a kind of one. It is the only
    // state the database leaves unattributed, deliberately.
    expect(DOCUMENT_REVIEW_DECISIONS).toContain('awaiting_clarification')
    expect(DOCUMENT_REVIEW_DECISIONS).toContain('accepted')
    expect(DOCUMENT_REVIEW_DECISIONS).toContain('rejected')
    expect(DOCUMENT_REVIEW_DECISIONS).not.toContain('pending' as DocumentReviewStatus)
  })

  it('is recorded with its reason and without a client-chosen reviewer', async () => {
    const note =
      'Laboratory report reviewed. The submitted evidence does not establish a defensible ' +
      'association between this report and a specific inventory batch.'
    await setDocumentReviewStatus(DOC, 'awaiting_clarification', note)

    const [table, patch] = updateSpy.mock.calls[0]
    expect(table).toBe('farmer_documents')
    expect(patch).toEqual({ review_status: 'awaiting_clarification', review_note: note })
    expect(patch).not.toHaveProperty('reviewed_by')
    expect(patch).not.toHaveProperty('reviewed_at')
  })

  it('is never described as accepted, verified or buyer-ready anywhere in the patch', async () => {
    await setDocumentReviewStatus(DOC, 'awaiting_clarification', 'batch association unresolved')
    const serialised = JSON.stringify(updateSpy.mock.calls[0][1]).toLowerCase()
    for (const forbidden of ['verified', 'compliant', 'approved', 'export', 'buyer']) {
      expect(serialised).not.toContain(forbidden)
    }
  })
})

describe('every decision must carry a reason', () => {
  it.each(DOCUMENT_REVIEW_DECISIONS)('refuses a blank note for %s', async (status) => {
    await expect(setDocumentReviewStatus(DOC, status, '')).rejects.toThrow(/review note/i)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
    ['mixed non-space whitespace', '\t\n\r  '],
  ])('refuses a note that is only %s', async (_label, note) => {
    // The tab and newline cases are the ones a trim()-based check lets through.
    // The database had exactly this bug until the harness failed on it.
    await expect(setDocumentReviewStatus(DOC, 'accepted', note)).rejects.toThrow(/whitespace/i)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('requires a reason for returning a document to the queue', async () => {
    // The transition that was unattributed and unreasoned before migration 65.
    // Erasing a decision is itself a decision.
    await expect(setDocumentReviewStatus(DOC, 'pending', '  ')).rejects.toThrow()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('trims the stored note but keeps its content', async () => {
    await setDocumentReviewStatus(DOC, 'rejected', '  the seal does not match  ')
    expect(updateSpy.mock.calls[0][1]).toEqual({
      review_status: 'rejected',
      review_note: 'the seal does not match',
    })
  })
})

describe('the review history is read from its own append-only table', () => {
  it('reads farmer_document_reviews, not farmer_documents', async () => {
    await loadDocumentReviewEvents(DOC)
    expect(selectSpy).toHaveBeenCalledWith('farmer_document_reviews')
  })

  it('maps a transition to the event a reviewer can be held to', async () => {
    reviewRows = [{
      id: 'e1b1b0f6-2a3d-4a5b-9c8d-1e2f3a4b5c6d',
      farmer_document_id: DOC,
      previous_status: 'pending',
      new_status: 'awaiting_clarification',
      review_note: 'batch association unresolved',
      reviewed_by: ACTOR,
      reviewed_at: '2026-08-08T12:00:00Z',
    }]
    const [event] = await loadDocumentReviewEvents(DOC)
    expect(event).toEqual({
      id: 'e1b1b0f6-2a3d-4a5b-9c8d-1e2f3a4b5c6d',
      documentId: DOC,
      previousStatus: 'pending',
      newStatus: 'awaiting_clarification',
      reviewNote: 'batch association unresolved',
      reviewedBy: ACTOR,
      reviewedAt: '2026-08-08T12:00:00Z',
    })
  })

  it('throws on a read failure rather than returning an empty history', async () => {
    // "No decision has ever been recorded" and "we could not read the record"
    // are different claims. On an audit trail, reporting the second as the
    // first is the failure that matters.
    reviewError = { message: 'permission denied' }
    reviewRows = []
    await expect(loadDocumentReviewEvents(DOC)).rejects.toThrow(/permission denied/)
  })

  it('refuses a document id that is not a UUID before touching the database', async () => {
    await expect(loadDocumentReviewEvents('not-a-uuid')).rejects.toThrow(/UUID/)
    expect(selectSpy).not.toHaveBeenCalled()
  })
})

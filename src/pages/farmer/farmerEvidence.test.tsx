// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { FarmerDocument } from '../../types'

/**
 * Migration 65 gave an administrator a way to ask a farmer a question about a
 * certificate. These tests pin the half that makes that worth doing: the farmer
 * being shown the question.
 *
 * WHAT EACH TEST PROTECTS, since none of it is visible in a type:
 *
 *   · The note is the payload. A clarification with its reason omitted is a
 *     status change nobody can act on — the farmer learns something is wrong and
 *     not what. The database refuses a decision without a note, so a decided
 *     document rendering no reason can only be a display defect.
 *
 *   · A failed read must not render as an empty list. This is the same defect
 *     class as farmerStockLoadFailure.test.tsx: a farmer who checks this screen
 *     and is told there is nothing waiting, while DDP is in fact waiting on
 *     them, is worse off than one shown an error. Asserted in both directions,
 *     because claiming a failure whenever a farm genuinely has no documents
 *     would be equally wrong.
 *
 *   · The reviewer's UUID must never reach the screen. It is an internal
 *     identifier, meaningless to a farmer, and attribution is load-bearing on
 *     the administrator's side — not the counterparty's.
 *
 *   · The digest must not be dressed up as authenticity. The page may say the
 *     stored bytes match what was sent; it must not say, or imply, that the
 *     laboratory issued the document.
 */

const loadFarmerDocuments = vi.fn<() => Promise<FarmerDocument[]>>()

vi.mock('../../lib/db', () => ({
  loadFarmerDocuments: () => loadFarmerDocuments(),
}))

const { default: FarmerEvidence } = await import('./FarmerEvidence')

/**
 * The mock is reset AFTER each test, never before, and that ordering is
 * load-bearing rather than stylistic.
 *
 * Measured on Vitest 4: with `beforeEach(() => mock.mockReset())` — or
 * `mockClear()` — a test whose implementation rejects fails with the rejection
 * reported as an unhandled error, even though the component handles it
 * correctly and renders its failure state. Clearing the mock's recorded state
 * before the call loses Vitest's tracking of that call's rejected promise.
 * Resetting afterwards keeps per-test isolation (a test that forgets to set an
 * implementation cannot silently inherit the previous one) without the false
 * failure. Verified both ways before settling on this form.
 */
afterEach(cleanup)
afterEach(() => loadFarmerDocuments.mockReset())

const REVIEWER_UUID = '4f5a1d2e-8b3c-4d5e-9f60-112233445566'

function doc(over: Partial<FarmerDocument> = {}): FarmerDocument {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    documentType: 'coa',
    fileName: 'RP-E2602-0197.pdf',
    reviewStatus: 'pending',
    uploadedAt: '2026-08-08T09:00:00.000Z',
    ...over,
  }
}

function renderEvidence() {
  return render(<FarmerEvidence lang="en" onGoMyStock={vi.fn()} />)
}

describe('the clarification a reviewer wrote reaches the farmer', () => {
  it('shows the note verbatim, not a summary of it', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({
        reviewStatus: 'awaiting_clarification',
        reviewNote: 'five reports share batch number F4-122025 across different strains',
        reviewedAt: '2026-08-08T10:00:00.000Z',
        reviewedBy: REVIEWER_UUID,
      }),
    ])
    renderEvidence()
    await waitFor(() =>
      expect(
        screen.queryByText(/five reports share batch number F4-122025 across different strains/iu),
      ).not.toBeNull(),
    )
  })

  it('does not present a clarification as a rejection', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({ reviewStatus: 'awaiting_clarification', reviewNote: 'batch association unresolved' }),
    ])
    renderEvidence()
    await waitFor(() => expect(screen.queryByText(/needs clarification/iu)).not.toBeNull())
    expect(screen.queryByText(/not accepted/iu)).toBeNull()
  })

  it('tells the farmer DDP is waiting on them when it is', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({ reviewStatus: 'awaiting_clarification', reviewNote: 'unresolved' }),
    ])
    renderEvidence()
    await waitFor(() => expect(screen.queryByText(/waiting on you/iu)).not.toBeNull())
  })

  it('does not claim DDP is waiting when every document is accepted', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({ reviewStatus: 'accepted', reviewNote: 'certificate matches the batch' }),
    ])
    renderEvidence()
    await waitFor(() => expect(screen.queryByText(/Accepted/iu)).not.toBeNull())
    expect(screen.queryByText(/waiting on you/iu)).toBeNull()
  })

  it('never renders the reviewer UUID', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({
        reviewStatus: 'accepted',
        reviewNote: 'seal and report number both check out',
        reviewedBy: REVIEWER_UUID,
        reviewedAt: '2026-08-08T10:00:00.000Z',
      }),
    ])
    const { container } = renderEvidence()
    await waitFor(() => expect(screen.queryByText(/seal and report number both check out/iu)).not.toBeNull())
    expect(container.textContent).not.toContain(REVIEWER_UUID)
  })
})

describe('an empty list means two different things', () => {
  it('says nothing was uploaded when nothing was', async () => {
    loadFarmerDocuments.mockResolvedValue([])
    renderEvidence()
    await waitFor(() =>
      expect(screen.queryByText(/have not uploaded any documents/iu)).not.toBeNull(),
    )
    expect(screen.queryByText(/could not be loaded/iu)).toBeNull()
  })

  it('says the read failed when it did, and does NOT claim the farmer uploaded nothing', async () => {
    loadFarmerDocuments.mockImplementation(async () => { throw new Error('permission denied') })
    renderEvidence()
    await waitFor(() => expect(screen.queryByText(/could not be loaded/iu)).not.toBeNull())
    expect(screen.queryByText(/have not uploaded any documents/iu)).toBeNull()
  })

  it('announces a failed read to assistive technology', async () => {
    loadFarmerDocuments.mockImplementation(async () => { throw new Error('permission denied') })
    renderEvidence()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull())
  })
})

describe('the digest claim boundary', () => {
  it('says the fingerprint proves receipt, and explicitly not issuance', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({ sha256Hex: '7d1f6e75f9b32823633590f743f49306d9ebf77885ca294827212616f6c37939' }),
    ])
    const { container } = renderEvidence()
    await waitFor(() => expect(screen.queryByText(/File fingerprint/iu)).not.toBeNull())
    expect(container.textContent).toMatch(/does not confirm the laboratory issued it/iu)
  })

  it('does not describe an uploaded but unreviewed document as approved', async () => {
    loadFarmerDocuments.mockResolvedValue([doc({ reviewStatus: 'pending' })])
    const { container } = renderEvidence()
    await waitFor(() => expect(screen.queryByText(/With DDP for review/iu)).not.toBeNull())
    expect(container.textContent).not.toMatch(/\bapproved\b/iu)
    expect(container.textContent).toMatch(/Nobody has reviewed it yet/iu)
  })
})

describe('attention order', () => {
  it('puts a document DDP is waiting on above one already accepted', async () => {
    loadFarmerDocuments.mockResolvedValue([
      doc({
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        fileName: 'accepted.pdf',
        reviewStatus: 'accepted',
        reviewNote: 'seal and report number both check out',
        uploadedAt: '2026-08-08T12:00:00.000Z',
      }),
      doc({
        id: 'bbbbbbbb-1111-2222-3333-444444444444',
        fileName: 'needs-clarification.pdf',
        reviewStatus: 'awaiting_clarification',
        reviewNote: 'batch association unresolved',
        uploadedAt: '2026-08-08T09:00:00.000Z',
      }),
    ])
    const { container } = renderEvidence()
    await waitFor(() => expect(screen.queryByText(/needs-clarification\.pdf/iu)).not.toBeNull())
    const text = container.textContent ?? ''
    // Newer, but requires nothing — so it must not outrank the open question.
    expect(text.indexOf('needs-clarification.pdf')).toBeLessThan(text.indexOf('accepted.pdf'))
  })
})

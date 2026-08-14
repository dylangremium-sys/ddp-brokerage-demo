// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import type { FarmerDocument } from '../../types'

/**
 * The evidence gate, as WIRED — not as computed.
 *
 * WHY THIS FILE EXISTS. `evidenceGate.test.ts` proves the gate's logic: given
 * opened/reason/recording, what should be allowed. Nothing proved the screen
 * asks it the right questions or honours the answer. The only suite that did —
 * documentReviewGateWiring.test.tsx — renders DDPDocumentReview, which has not
 * been routed since the Organic rebuild. It has been passing against a page no
 * operator can open, on the control the chain of custody rests on.
 *
 * That is the failure this codebase keeps finding in itself: a check that
 * enumerates the wrong thing reads exactly like a check that passes.
 *
 * WHAT IS ASSERTED HERE is the wiring and nothing else — that opening is
 * RECORDED rather than merely clicked, that a failed signature does not unlock a
 * decision, that neither Accept nor Reject is the easy one, and that the reason
 * the reviewer typed is the reason that reaches the write. The database enforces
 * all of it again by trigger; these buttons explain the refusal before the round
 * trip, and this file is about whether the explanation is true.
 */

const loadFarmerDocuments = vi.fn<() => Promise<FarmerDocument[]>>()
const getCoaSignedUrl = vi.fn<(path: string) => Promise<string | null>>()
const setDocumentReviewStatus = vi.fn<(id: string, status: string, reason: string) => Promise<void>>()
const loadDocumentReviewEvents = vi.fn<() => Promise<never[]>>()
const recordDocumentOpen = vi.fn<(id: string, sha: string | null) => Promise<void>>()
const loadMyDocumentOpens = vi.fn<() => Promise<Set<string>>>()
const createReviewRequest = vi.fn<() => Promise<void>>()
const setDocumentReportFields = vi.fn<() => Promise<void>>()

vi.mock('../../lib/db', () => ({
  loadFarmerDocuments: () => loadFarmerDocuments(),
  getCoaSignedUrl: (path: string) => getCoaSignedUrl(path),
  setDocumentReviewStatus: (id: string, status: string, reason: string) =>
    setDocumentReviewStatus(id, status, reason),
  loadDocumentReviewEvents: () => loadDocumentReviewEvents(),
  recordDocumentOpen: (id: string, sha: string | null) => recordDocumentOpen(id, sha),
  loadMyDocumentOpens: () => loadMyDocumentOpens(),
  createReviewRequest: () => createReviewRequest(),
  setDocumentReportFields: () => setDocumentReportFields(),
}))

vi.mock('../../lib/reviewerDirectory', () => ({
  loadReviewerDirectory: () => Promise.resolve({}),
  reviewerLabel: (id: string) => id,
  reviewerRole: () => null,
}))

const { default: DDPEvidenceReview } = await import('./DDPEvidenceReview')

afterEach(cleanup)
/*
 * NOT vi.restoreAllMocks() here.
 *
 * A decision bumps a reload token, which re-runs the mount effect and calls
 * loadMyDocumentOpens a second time. restoreAllMocks strips the implementations
 * set in beforeEach, so that second call returned undefined and the component
 * called .then() on it — two tests failing inside React's commit phase, for a
 * reason that had nothing to do with the gate. Only spies need restoring, and
 * this suite creates none.
 */
afterEach(() => {
  loadFarmerDocuments.mockReset()
  getCoaSignedUrl.mockReset()
  setDocumentReviewStatus.mockReset()
  loadDocumentReviewEvents.mockReset()
  recordDocumentOpen.mockReset()
  loadMyDocumentOpens.mockReset()
  createReviewRequest.mockReset()
  setDocumentReportFields.mockReset()
})

/**
 * Defaults are set AFTER the reset above, not before it — a mock reset between
 * a call and its rejection loses the tracking of that rejection and reports it
 * as an unhandled error. Same ordering note as the suite this replaces.
 */
beforeEach(() => {
  loadDocumentReviewEvents.mockResolvedValue([])
  // A Set, not an array — the component calls .has() on it.
  loadMyDocumentOpens.mockResolvedValue(new Set<string>())
  // These four resolve with nothing. The empty call still INSTALLS an
  // implementation — which is the whole point of this block, per the note above.
  recordDocumentOpen.mockResolvedValue()
  createReviewRequest.mockResolvedValue()
  setDocumentReportFields.mockResolvedValue()
  setDocumentReviewStatus.mockResolvedValue()
  getCoaSignedUrl.mockResolvedValue('https://example.test/signed.pdf')
})

function doc(over: Partial<FarmerDocument> = {}): FarmerDocument {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    documentType: 'coa',
    fileName: 'RP-E2602-0197.pdf',
    storagePath: 'coa/11111111/RP-E2602-0197.pdf',
    reviewStatus: 'pending',
    uploadedAt: '2026-08-08T09:00:00.000Z',
    ...over,
  }
}

/** A reason the gate accepts: more than 9 characters and not one repeated. */
const GOOD_REASON = 'Checked the lab reference against the certificate.'

/*
 * These four are declared BEFORE renderReady, which calls accept().
 *
 * They are `const` arrows, so they sit in the temporal dead zone until this
 * point in module evaluation. renderReady is only ever called from inside an
 * it(), long after the module has finished evaluating, so the old order was
 * safe — but it read as use-before-definition to anything checking statically,
 * and it would become a real ReferenceError the moment anyone called
 * renderReady at the top level. Cheaper to keep the order honest.
 */
const accept = () => screen.getByRole('button', { name: /^(Accept|Recording…)$/u }) as HTMLButtonElement
const reject = () => screen.getByRole('button', { name: /^(Reject|Recording…)$/u }) as HTMLButtonElement
const openBtn = () => screen.getByRole('button', { name: /Open (and read the document|the document again)/ })
const reasonBox = () => screen.getByLabelText(/reason for your decision/i)

async function renderReady(rows: FarmerDocument[] = [doc()]) {
  loadFarmerDocuments.mockResolvedValue(rows)
  const view = render(<DDPEvidenceReview />)
  await waitFor(() => expect(accept()).toBeTruthy())
  return view
}

const type = (text: string) => fireEvent.change(reasonBox(), { target: { value: text } })

/**
 * Wait for the reload a decision triggers.
 *
 * decide() bumps a reload token once the write resolves, which re-runs the
 * mount effect and calls loadMyDocumentOpens a second time. Asserting on the
 * write and returning immediately let the test finish first — afterEach reset
 * the mocks, the pending effect then ran against a mock with no implementation,
 * and the component called .then() on undefined. The failure surfaced inside
 * React's commit phase and pointed at a line with nothing to do with the gate.
 *
 * So the test waits for the reload it caused, rather than leaving it to land
 * after the mocks are gone.
 */
const settle = () => waitFor(() => expect(loadMyDocumentOpens.mock.calls.length).toBeGreaterThan(1))

describe('the gate refuses a decision until both conditions are met', () => {
  it('starts with Accept and Reject disabled', async () => {
    await renderReady()
    expect(accept().disabled).toBe(true)
    expect(reject().disabled).toBe(true)
  })

  it('stays shut when a reason is written but the document was never opened', async () => {
    await renderReady()
    type(GOOD_REASON)
    expect(accept().disabled).toBe(true)
    expect(reject().disabled).toBe(true)
  })

  it('stays shut when the document is opened but no reason is written', async () => {
    await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())
    expect(accept().disabled).toBe(true)
    expect(reject().disabled).toBe(true)
  })

  it('opens only when the document has been read AND a reason written', async () => {
    await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())
    type(GOOD_REASON)
    await waitFor(() => expect(accept().disabled).toBe(false))
    expect(reject().disabled).toBe(false)
  })

  /**
   * "More than 9 characters and not one character repeated" is the database's
   * own test, in evidence_reason_is_substantive. A reason that satisfies the
   * screen but not the trigger would present a live button the write then
   * refuses — the exact asymmetry the gate exists to prevent.
   */
  it('does not accept a reason of no substance', async () => {
    await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())

    type('ok')
    expect(accept().disabled).toBe(true)

    type('aaaaaaaaaaaaaaaa')
    expect(accept().disabled).toBe(true)
  })
})

describe('opening is recorded, not merely clicked', () => {
  it('writes the open against the document and its digest', async () => {
    await renderReady([doc({ sha256Hex: 'a'.repeat(64) })])
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      'a'.repeat(64),
    ))
  })

  /**
   * The open is recorded only after the signed URL resolves. A signing failure
   * that still unlocked the decision would let a reviewer decide on a document
   * they demonstrably could not have read — and migration 66 would refuse the
   * write anyway, after the click.
   */
  it('records nothing, and unlocks nothing, when the file cannot be signed', async () => {
    getCoaSignedUrl.mockResolvedValue(null)
    await renderReady()

    fireEvent.click(openBtn())
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    expect(recordDocumentOpen).not.toHaveBeenCalled()
    type(GOOD_REASON)
    expect(accept().disabled).toBe(true)
  })
})

describe('neither decision is the easy one', () => {
  /**
   * The screen this replaced put five equal-weight buttons in a row with Accept
   * the only filled one, which made the fastest click the irreversible one.
   * Accept and Reject are siblings here and must stay that way.
   */
  it('gives Accept and Reject the same enabled state at every step', async () => {
    await renderReady()
    expect(accept().disabled).toBe(reject().disabled)

    type(GOOD_REASON)
    expect(accept().disabled).toBe(reject().disabled)

    fireEvent.click(openBtn())
    await waitFor(() => expect(accept().disabled).toBe(false))
    expect(accept().disabled).toBe(reject().disabled)
  })

  it('does not mark one of them as the page\'s primary action', async () => {
    await renderReady()
    expect(accept().className).not.toMatch(/btn-primary/)
    expect(reject().className).not.toMatch(/btn-primary/)
  })
})

describe('the decision that is written is the one the reviewer made', () => {
  it('sends the reviewer\'s own words, not a summary of them', async () => {
    await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())
    type(GOOD_REASON)
    await waitFor(() => expect(accept().disabled).toBe(false))

    fireEvent.click(accept())
    await waitFor(() => expect(setDocumentReviewStatus).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      'accepted',
      GOOD_REASON,
    ))
    await settle()
  })

  it('records a rejection against the same reason', async () => {
    await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())
    type(GOOD_REASON)
    await waitFor(() => expect(reject().disabled).toBe(false))

    fireEvent.click(reject())
    await waitFor(() => expect(setDocumentReviewStatus).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      'rejected',
      GOOD_REASON,
    ))
    await settle()
  })

  /**
   * The gate is re-checked at the moment of the click, not only at render. A
   * decision cannot be smuggled through by a state change between the two.
   */
  it('refuses to write when the reason has been emptied since it unlocked', async () => {
    await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())
    type(GOOD_REASON)
    await waitFor(() => expect(accept().disabled).toBe(false))

    type('')
    fireEvent.click(accept())
    expect(setDocumentReviewStatus).not.toHaveBeenCalled()
  })
})

describe('what the screen refuses to claim', () => {
  /**
   * The prototype showed "Opened · page 1 of 4 read". A PDF in a frame reports
   * nothing about pages read, so that number could only have been invented — on
   * the screen that constitutes chain of custody. Standing rule 10.
   */
  it('never reports reading progress', async () => {
    const { container } = await renderReady()
    fireEvent.click(openBtn())
    await waitFor(() => expect(recordDocumentOpen).toHaveBeenCalled())
    expect(container.textContent).not.toMatch(/page \d+ of \d+/i)
    expect(container.textContent).not.toMatch(/\bread\b.*\d+%/i)
  })

  it('does not call a fingerprint a proof of authenticity', async () => {
    const { container } = await renderReady()
    expect(container.textContent).not.toMatch(/\bgenuine\b|\bauthentic\b/i)
  })
})

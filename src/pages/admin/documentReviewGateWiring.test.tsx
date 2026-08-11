// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { FarmerDocument } from '../../types'

/**
 * The read-first gate, tested where it actually has to hold: on the buttons.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM documentReviewGate.test.ts. That file
 * proves the rule is correct. It proves nothing about whether the rule is
 * reached. This repository has already shipped a correct fix that sat
 * unreachable behind a dropped argument for eight days, green the whole time,
 * and TypeScript could not see it. So the gate is asserted here through the DOM:
 * find the Accept button, and check it is dead until the document has been
 * opened and a reason typed.
 *
 * What each test protects:
 *
 *   · A reason alone must not unlock a decision. That was the state before this
 *     change — the reason gate existed, the read gate did not, and the fastest
 *     click on the page was still the irreversible one.
 *
 *   · Opening the document must actually unlock it. A gate that never opens is
 *     an outage, and the specific way this could fail is subtle: `window.open`
 *     called with `noopener` returns null by specification, so any
 *     implementation that treats the return value as success would leave every
 *     decision button permanently disabled.
 *
 *   · A failure to produce a signed URL must NOT unlock it. Clicking Open and
 *     getting an error is not reading the document.
 *
 *   · Accept and Reject must be equally weighted. The audit finding was that
 *     Accept was the only filled button among ghosts.
 */

const loadFarmerDocuments = vi.fn<() => Promise<FarmerDocument[]>>()
const getCoaSignedUrl = vi.fn<(path: string) => Promise<string | null>>()
const setDocumentReviewStatus = vi.fn<() => Promise<void>>()
const loadDocumentReviewEvents = vi.fn<() => Promise<never[]>>()

vi.mock('../../lib/db', () => ({
  loadFarmerDocuments: () => loadFarmerDocuments(),
  getCoaSignedUrl: (path: string) => getCoaSignedUrl(path),
  setDocumentReviewStatus: () => setDocumentReviewStatus(),
  loadDocumentReviewEvents: () => loadDocumentReviewEvents(),
}))

const { default: DDPDocumentReview } = await import('./DDPDocumentReview')

// Reset AFTER each test, never before — see the note in farmerEvidence.test.tsx.
// On Vitest 4, clearing a mock before a call whose promise rejects loses the
// tracking of that rejection and reports it as an unhandled error.
afterEach(cleanup)
// Spies are restored here rather than at the end of each test body. An
// assertion that fails before an inline `mockRestore()` would leak the spy into
// the next test — observed while checking these tests fail against the
// pre-change component, where one failure cascaded into a second, unrelated
// one.
afterEach(() => vi.restoreAllMocks())
afterEach(() => {
  loadFarmerDocuments.mockReset()
  getCoaSignedUrl.mockReset()
  setDocumentReviewStatus.mockReset()
  loadDocumentReviewEvents.mockReset()
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

async function renderReady(rows: FarmerDocument[] = [doc()]) {
  loadFarmerDocuments.mockResolvedValue(rows)
  render(<DDPDocumentReview />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy())
}

const accept = () => screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement
const reject = () => screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement
const reason = () => screen.getByLabelText(/reason for your decision/i)

/** Returns null exactly as the specification requires when `noopener` is set. */
const spyOnWindowOpen = () => vi.spyOn(window, 'open').mockReturnValue(null)

describe('a decision cannot be recorded from a standing start', () => {
  it('disables Accept and Reject before anything has been done', async () => {
    await renderReady()
    expect(accept().disabled).toBe(true)
    expect(reject().disabled).toBe(true)
    expect(screen.getByText(/open and read the document before deciding/i)).toBeTruthy()
  })

  it('keeps them disabled when a reason is typed but the document is unopened', async () => {
    // This is the exact state the change closes: the old screen would have
    // enabled Accept here.
    await renderReady()
    fireEvent.change(reason(), { target: { value: 'Cannabinoid figures match the batch record.' } })
    expect(accept().disabled).toBe(true)
    expect(reject().disabled).toBe(true)
    expect(screen.getByText(/open and read the document before deciding/i)).toBeTruthy()
  })

  it('keeps them disabled when the document is opened but no reason is written', async () => {
    getCoaSignedUrl.mockResolvedValue('https://example.invalid/signed')
    const open = spyOnWindowOpen()
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: /^open document$/i }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    expect(accept().disabled).toBe(true)
    expect(screen.getByText(/cannot be recorded without a reason/i)).toBeTruthy()
  })
})

describe('opening the document unlocks the decision', () => {
  it('enables Accept and Reject once opened AND reasoned', async () => {
    getCoaSignedUrl.mockResolvedValue('https://example.invalid/signed')
    // Returns null exactly as the specification requires for `noopener`. An
    // implementation that treated this as failure would never open the gate —
    // which is why this test does not assert on the return value at all, only
    // that the gate opened afterwards.
    spyOnWindowOpen()
    await renderReady()

    fireEvent.change(reason(), { target: { value: 'Cannabinoid figures match the batch record.' } })
    expect(accept().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^open document$/i }))
    await waitFor(() => expect(accept().disabled).toBe(false))
    expect(reject().disabled).toBe(false)
    expect(screen.getByText(/permanent record/i)).toBeTruthy()
  })

  it('does not unlock when the signed URL could not be produced', async () => {
    // Clicking Open and being handed an error is not reading the document.
    getCoaSignedUrl.mockResolvedValue(null)
    const open = spyOnWindowOpen()
    await renderReady()
    fireEvent.change(reason(), { target: { value: 'Cannabinoid figures match the batch record.' } })
    fireEvent.click(screen.getByRole('button', { name: /^open document$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(open).not.toHaveBeenCalled()
    expect(accept().disabled).toBe(true)
  })
})

describe('an entry with no stored file is decidable on its reason alone', () => {
  it('does not impose a read condition it cannot satisfy', async () => {
    // There is nothing to open, so requiring it would strand the entry forever.
    await renderReady([doc({ storagePath: undefined })])
    expect(accept().disabled).toBe(true)
    fireEvent.change(reason(), { target: { value: 'No file was ever uploaded against this entry.' } })
    await waitFor(() => expect(accept().disabled).toBe(false))
    expect(screen.getByText(/no stored file/i)).toBeTruthy()
  })
})

describe('a shut gate is visible, not merely unclickable', () => {
  it('fades the gated controls while they are disabled', async () => {
    // `.btn` carries no `:disabled` rule in this stylesheet, so without an
    // explicit treatment a disabled Accept renders identically to a live one.
    // Caught by looking at the rendered screen, not by any assertion here —
    // which is why there is now an assertion here.
    getCoaSignedUrl.mockResolvedValue('https://example.invalid/signed')
    spyOnWindowOpen()
    await renderReady()
    expect(accept().disabled).toBe(true)
    expect(accept().style.opacity).toBe('0.45')
    expect(accept().style.cursor).toBe('not-allowed')

    fireEvent.change(reason(), { target: { value: 'Cannabinoid figures match the batch record.' } })
    fireEvent.click(screen.getByRole('button', { name: /^open document$/i }))
    await waitFor(() => expect(accept().disabled).toBe(false))
    // Live again: no fade left behind.
    expect(accept().style.opacity).toBe('')
  })
})

describe('Accept and Reject carry equal weight', () => {
  it('does not style Accept as the only filled button', async () => {
    await renderReady()
    // btn-approve / btn-reject are the established pair on the other two review
    // screens: same size, same prominence, different meaning. The finding was
    // that this screen alone made Accept primary among ghosts.
    expect(accept().className).toContain('btn-approve')
    expect(reject().className).toContain('btn-reject')
    expect(accept().className).not.toContain('btn-primary')
  })
})

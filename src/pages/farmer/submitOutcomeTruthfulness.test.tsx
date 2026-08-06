// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import FarmerSubmitInventory from './FarmerSubmitInventory'
import type { FarmProfile } from '../../types'

/**
 * P1 / W1.3 — a rejected submission rendered the success screen.
 *
 * The mechanism was a type-level erasure, not a missing check. App.tsx's
 * handler returned Promise<boolean> correctly and commitMutation reported the
 * failure correctly, but the `onSubmit` prop was typed `void | Promise<void>`,
 * so the boolean died at the component boundary — somewhere `tsc -b` cannot see
 * a loss. `setSubmitted(true)` then ran unconditionally, and the farmer was
 * shown a red error banner and a full-page green tick at the same time.
 *
 * That is why fifty-nine rejected inserts produced no bug report: the failure
 * was loud in the database and silent on the screen.
 *
 * This renders the real component rather than asserting on source text. Source
 * assertions cannot distinguish "the code says `if (committed)`" from "the
 * screen actually stays put", and a third of this repository's src tests are
 * source assertions.
 */

const FARM: FarmProfile = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  tradingName: 'Green Valley',
  primaryContact: 'Somchai',
  province: 'Chiang Mai',
} as FarmProfile

const SUCCESS_EN = /Submitted for Review/i
const SUCCESS_TH = /ส่งเรียบร้อยแล้ว/

function renderForm(onSubmit: (...args: never[]) => Promise<boolean>) {
  return render(
    <FarmerSubmitInventory
      lang="en"
      farms={[FARM]}
      onSubmit={onSubmit as never}
      onBack={() => {}}
    />,
  )
}

/**
 * Fill the one field the form refuses to submit without, then press Submit.
 *
 * The submit button is disabled until `strainName` is non-blank, and the click
 * handler returns early on the same condition — so a test that skips this step
 * would assert nothing at all while appearing to pass.
 */
async function submitForm() {
  // Matched on the full placeholder: /Purple Gelato/ alone also matches the
  // COA sample-name field, whose placeholder falls back to the same words.
  fireEvent.change(screen.getByPlaceholderText(/Purple Gelato, Dried Flower A/i), {
    target: { value: 'Sativa Gold' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Submit for Review/i }))
}

// This repo's vitest has no global setup file, so Testing Library's automatic
// cleanup does not run. Without this the second render finds two of every
// field and each query throws.
afterEach(cleanup)

describe('a rejected submission must not look like a successful one', () => {
  it('does NOT show the success screen when the write is rejected', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false)
    const { container } = renderForm(onSubmit)

    await submitForm()
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())

    expect(screen.queryByText(SUCCESS_EN)).toBeNull()
    expect(screen.queryByText(SUCCESS_TH)).toBeNull()
    // The form must still be on screen, with the farmer's input recoverable.
    expect(container.querySelector('form')).not.toBeNull()
  })

  it('DOES show the success screen when the write commits', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    const { container } = renderForm(onSubmit)

    await submitForm()
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())

    // Without this the first test would pass against a form that can never
    // succeed at all — the counterfactual that makes the assertion meaningful.
    await waitFor(() => expect(screen.queryByText(SUCCESS_EN)).not.toBeNull())
    expect(container.querySelector('form')).toBeNull()
  })

  it('does not show the success screen while the write is still in flight', async () => {
    let settle: (v: boolean) => void = () => {}
    const onSubmit = vi.fn().mockReturnValue(new Promise<boolean>((r) => { settle = r }))
    renderForm(onSubmit)

    await submitForm()
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())

    expect(screen.queryByText(SUCCESS_EN)).toBeNull()
    settle(true)
    await waitFor(() => expect(screen.queryByText(SUCCESS_EN)).not.toBeNull())
  })
})

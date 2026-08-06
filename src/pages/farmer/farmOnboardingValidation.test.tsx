// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FarmerOnboarding from './FarmerOnboarding'

/**
 * P1 / W10.1 — the farm onboarding wizard submitted anything at all.
 *
 * `handleFinalSubmit` ran no checks, and `public.farms` has ZERO CHECK
 * constraints and three NOT NULL columns in production, so a farm could be
 * created with no name and no way to contact it, and nothing anywhere refused.
 *
 * These drive the real component. The two things that matter are that a bad
 * submission is REFUSED, and — just as important — that saving a draft is still
 * ALLOWED. An onboarding form that blocks a farmer from stopping half way is a
 * worse outcome than one that validates nothing.
 */

afterEach(cleanup)

/**
 * This repo's jsdom does not provide a working localStorage, and the wizard
 * loads its draft on mount. An in-memory one keeps the test about validation
 * rather than about the environment.
 */
beforeEach(() => {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, String(v)) },
      removeItem: (k: string) => { data.delete(k) },
      clear: () => { data.clear() },
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() { return data.size },
    },
  })
})

const REVIEW_STEP = 9

function renderWizard(onSubmit = vi.fn()) {
  const result = render(
    <FarmerOnboarding lang="en" currentProfile={null} onSubmit={onSubmit} onBack={vi.fn()} />,
  )
  return { onSubmit, ...result }
}

/** Click "Next" until the review step, which is where submitting happens. */
function goToReviewStep() {
  for (let i = 1; i < REVIEW_STEP; i++) {
    const next = screen.queryByRole('button', { name: /next/iu })
    if (!next) break
    fireEvent.click(next)
  }
}

const submitButton = () =>
  screen.queryByRole('button', { name: /submit|send to ddp|finish/iu })

describe('the wizard refuses an unusable farm record', () => {
  it('does not submit an entirely empty form', () => {
    const { onSubmit } = renderWizard()
    goToReviewStep()

    const submit = submitButton()
    expect(submit, 'no submit control found on the review step').not.toBeNull()
    fireEvent.click(submit!)

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('tells the farmer what is wrong, and which step to fix it on', () => {
    renderWizard()
    goToReviewStep()
    fireEvent.click(submitButton()!)

    expect(screen.queryByRole('alert')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/required/iu)
    // A nine-step form has to say where, not just what.
    expect(screen.getByRole('alert').textContent).toMatch(/go to step \d/iu)
  })

  it('never blocks moving between steps — only the final submit', () => {
    renderWizard()
    // Step 1 is empty and invalid, yet Next must still work; otherwise a
    // farmer cannot reach the later steps at all.
    const next = screen.getByRole('button', { name: /next/iu })
    fireEvent.click(next)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never blocks saving a draft', () => {
    renderWizard()
    const save = screen.queryByRole('button', { name: /save|progress/iu })
    expect(save, 'no draft-save control found').not.toBeNull()
    fireEvent.click(save!)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

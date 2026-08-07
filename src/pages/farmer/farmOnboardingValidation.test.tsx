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

/** The Field component nests its input inside a <label>, so labels are queryable. */
function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function next() {
  const button = screen.queryByRole('button', { name: /next/iu })
  if (!button) throw new Error('no Next control')
  fireEvent.click(button)
}

/**
 * Fills everything the validator requires, plus a THC/CBD pair that sums past
 * 100 — so the draft is submittable but carries exactly one warning.
 */
function fillMinimumValidProfile() {
  fill(/trading name/iu, 'Green Valley Farm')
  fill(/province/iu, 'Chiang Mai')
  next()
  fill(/primary contact/iu, 'Somchai')
  fill(/email/iu, 'somchai@example.com')
  next(); next(); next()
  fill(/typical THC/iu, '70')
  fill(/typical CBD/iu, '45')
}

const submitButton = () =>
  screen.queryByRole('button', { name: /submit|send to ddp|finish/iu })

function clickSubmit() {
  const submit = submitButton()
  if (!submit) throw new Error('no submit control found on the review step')
  fireEvent.click(submit)
}

describe('the wizard refuses an unusable farm record', () => {
  it('does not submit an entirely empty form', () => {
    const { onSubmit } = renderWizard()
    goToReviewStep()

    const submit = submitButton()
    if (!submit) throw new Error('no submit control found on the review step')
    fireEvent.click(submit)

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('tells the farmer what is wrong, and which step to fix it on', () => {
    renderWizard()
    goToReviewStep()
    clickSubmit()

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
    if (!save) throw new Error('no draft-save control found')
    fireEvent.click(save)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a warning must actually be seen', () => {
  it('does not submit a warning-only profile on the first press', () => {
    // Previously the save succeeded and the app navigated to farmer-status in
    // the same click, so "please double-check" rendered and vanished at once.
    const { onSubmit } = renderWizard()
    fillMinimumValidProfile()
    goToReviewStep()

    clickSubmit()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/double-check/iu)
  })

  it('submits on the second press, once the farmer has seen it', () => {
    const { onSubmit } = renderWizard()
    fillMinimumValidProfile()
    goToReviewStep()

    clickSubmit()
    clickSubmit()

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

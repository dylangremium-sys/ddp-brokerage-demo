// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import FarmerOnboarding from './FarmerOnboarding'
import { T } from '../../translations'

/**
 * Walks a farm through all nine steps of the redesigned wizard.
 *
 * WHY THIS EXISTS. The restyle in this change moved every step into a form
 * panel beside a navigation rail. Nothing about the fields or the save logic
 * changed — but "nothing changed" is a claim, and the screen sits behind
 * authentication, so it cannot be opened in a browser from here. The existing
 * onboarding tests cover validation and submission; none of them checks that
 * each of the nine steps still renders anything at all.
 *
 * A step that silently renders empty is the exact failure this layout could
 * introduce and no other test would notice: the wizard would still advance,
 * still save, still submit, and a farm would simply never be asked for a third
 * of its details.
 */

afterEach(cleanup)

/** jsdom here has no working localStorage, and the wizard loads a draft on mount. */
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

const TOTAL_STEPS = 9

/**
 * Step 9 is "Ready to Submit?" — a review of what was entered, ending in the
 * submit button. It asks for nothing, so it correctly has no inputs, and the
 * "does this step ask anything" check runs over steps 1–8. Step 9 gets its own
 * expectation below: it must offer exactly one submit control.
 */
const REVIEW_STEP = 9
const QUESTION_STEPS = TOTAL_STEPS - 1

function renderWizard() {
  return render(
    <FarmerOnboarding lang="en" currentProfile={null} onSubmit={vi.fn()} onBack={vi.fn()} />,
  )
}

/** The controls a farmer can actually answer with, inside the form panel. */
function answerableControls(container: HTMLElement): number {
  const panel = container.querySelector('.ob-panel')
  if (!panel) throw new Error('form panel missing')
  return panel.querySelectorAll('input, select, textarea, .ob-seg-opt').length
}

function railButtons(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('.ob-stage')] as HTMLElement[]
}

describe('every one of the nine steps still asks the farm something', () => {
  it('renders answerable controls on each step, walking forward with Next', () => {
    const { container } = renderWizard()
    const empty: number[] = []

    for (let step = 1; step <= QUESTION_STEPS; step++) {
      if (answerableControls(container) === 0) empty.push(step)
      const next = screen.queryByRole('button', { name: /next/iu })
      if (!next) break
      fireEvent.click(next)
    }

    expect(empty, `steps rendering no controls at all: ${empty.join(', ')}`).toEqual([])
  })

  it('reaches every step through the rail, not only through Next', () => {
    const { container } = renderWizard()
    const rail = railButtons(container)
    expect(rail).toHaveLength(TOTAL_STEPS)

    const empty: number[] = []
    for (let i = 0; i < QUESTION_STEPS; i++) {
      fireEvent.click(railButtons(container)[i])
      if (answerableControls(container) === 0) empty.push(i + 1)
    }
    expect(empty, `steps unreachable or empty via the rail: ${empty.join(', ')}`).toEqual([])
  })

  it('ends on a review step that offers the submission', () => {
    const { container } = renderWizard()
    fireEvent.click(railButtons(container)[REVIEW_STEP - 1])
    expect(answerableControls(container)).toBe(0)
    expect(screen.queryAllByRole('button', { name: /submit|send to ddp|finish/iu })).toHaveLength(1)
  })

  it('marks exactly one rail entry as the current step', () => {
    const { container } = renderWizard()
    fireEvent.click(railButtons(container)[4])
    const current = container.querySelectorAll('[aria-current="step"]')
    expect(current).toHaveLength(1)
    expect(current[0].className).toContain('is-current')
  })
})

describe('the rail does not impersonate the submit button', () => {
  // Step 9 is titled "Ready to Submit?". A rail entry announcing that title
  // would be a second control that a screen reader reads as the submit action.
  it('gives rail entries navigational accessible names', () => {
    const { container } = renderWizard()
    for (const [i, btn] of railButtons(container).entries()) {
      expect(btn.getAttribute('aria-label')).toBe(`Go to step ${i + 1}`)
    }
  })

  it('leaves exactly one control matching /submit|send to ddp|finish/', () => {
    const { container } = renderWizard()
    fireEvent.click(railButtons(container)[TOTAL_STEPS - 1])
    const matches = screen.queryAllByRole('button', { name: /submit|send to ddp|finish/iu })
    expect(matches).toHaveLength(1)
  })
})

describe('farm type is answerable, and never a dash', () => {
  it('offers every farm type as a pressable option', () => {
    const { container } = renderWizard()
    const seg = container.querySelector('.ob-seg')
    expect(seg, 'farm type segmented control missing').not.toBeNull()
    const opts = within(seg as HTMLElement).getAllByRole('button')
    expect(opts.map(o => o.textContent)).toEqual(['Indoor', 'Greenhouse', 'Outdoor', 'Mixed'])
  })

  it('records the choice, and shows it as pressed', () => {
    const { container } = renderWizard()
    const seg = container.querySelector('.ob-seg') as HTMLElement
    const greenhouse = within(seg).getByRole('button', { name: 'Greenhouse' })

    expect(greenhouse.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(greenhouse)
    expect(greenhouse.getAttribute('aria-pressed')).toBe('true')
    expect(greenhouse.className).toContain('is-active')
  })

  it('never offers an em dash as a farm type', () => {
    // The <select> this replaced carried an empty option rendering as "—",
    // which reads as a kind of farm rather than as "not answered".
    const { container } = renderWizard()
    const seg = container.querySelector('.ob-seg') as HTMLElement
    for (const opt of within(seg).getAllByRole('button')) {
      expect(opt.textContent?.trim()).not.toBe('—')
    }
  })
})

describe('a farmer can still leave, skip and go back', () => {
  it('keeps every exit the wizard had', () => {
    renderWizard()
    const t = T.en
    for (const label of [t.continueLater, t.skipForNow, t.saveProgress, t.btnNext]) {
      expect(
        screen.queryByRole('button', { name: new RegExp(escapeRegExp(label), 'iu') }),
        `"${label}" is no longer offered on step 1`,
      ).not.toBeNull()
    }
  })

  it('advances on Skip, and comes back on Back', () => {
    const { container } = renderWizard()
    const currentStep = () =>
      railButtons(container).findIndex(b => b.getAttribute('aria-current') === 'step') + 1

    expect(currentStep()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(escapeRegExp(T.en.skipForNow), 'iu') }))
    expect(currentStep()).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(escapeRegExp(T.en.btnBack), 'iu') }))
    expect(currentStep()).toBe(1)
  })
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

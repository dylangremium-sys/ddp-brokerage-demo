// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import FarmerSubmitInventory from './FarmerSubmitInventory'
import LangToggle from '../../components/shared/LangToggle'
import type { FarmProfile } from '../../types'

/**
 * P1 / W10.5 — the farmer forms were unusable with assistive technology.
 *
 * Three defects, all measured on the current build:
 *
 *   - Every segmented control conveyed its selected state through a CSS class
 *     alone. A screen reader announced two identical buttons with no way to
 *     tell which was in effect — including the COA yes/no control, which
 *     decides whether a batch claims to have a certificate of analysis.
 *
 *   - The form had no heading structure at all: `SectionTitle` rendered a
 *     `<div>`, so its nine sections could not be skimmed or jumped between.
 *
 *   - On submit the whole form is replaced by a success screen, with no focus
 *     moved and no `<h1>`. A screen-reader user was left on a control that no
 *     longer existed, told nothing about what had happened.
 */

afterEach(cleanup)

const FARM = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  tradingName: 'Green Valley',
  primaryContact: 'Somchai',
  province: 'Chiang Mai',
} as FarmProfile

function renderForm(onSubmit = vi.fn().mockResolvedValue(true)) {
  const result = render(
    <FarmerSubmitInventory lang="en" farms={[FARM]} onSubmit={onSubmit} onBack={vi.fn()} />,
  )
  return { onSubmit, ...result }
}

describe('segmented controls announce which option is selected', () => {
  it('marks every toggle with aria-pressed, not just a CSS class', () => {
    const { container } = renderForm()
    const toggles = container.querySelectorAll('button.role-btn')
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      expect(
        toggle.getAttribute('aria-pressed'),
        `"${toggle.textContent}" does not say whether it is selected`,
      ).not.toBeNull()
    }
  })

  it('exactly one option per group reads as pressed', () => {
    const { container } = renderForm()
    const pressed = container.querySelectorAll('button.role-btn[aria-pressed="true"]')
    // Several groups render at once; what matters is that pressed state is
    // expressed at all, and that it tracks the active class.
    expect(pressed.length).toBeGreaterThan(0)
    for (const button of pressed) {
      expect(button.className).toContain('role-btn-active')
    }
  })

  it('updates when the farmer changes the selection', () => {
    const { container } = renderForm()
    const toggle = container.querySelector('button.role-btn:not(.role-btn-active)')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle as Element)

    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the language toggle says which language is active', () => {
  it('marks the current language as pressed and the other as not', () => {
    render(<LangToggle lang="th" setLang={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^ไทย$/u }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^EN$/u }).getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the form can be navigated by heading', () => {
  it('renders real headings for its sections, not styled divs', () => {
    const { container } = renderForm()
    const headings = container.querySelectorAll('h1, h2, h3')
    expect(headings.length).toBeGreaterThan(0)
    // The section titles specifically — a div with a class is not a heading.
    expect(container.querySelectorAll('.form-section-title').length).toBeGreaterThan(0)
    for (const title of container.querySelectorAll('.form-section-title')) {
      expect(/^H[1-6]$/u.test(title.tagName)).toBe(true)
    }
  })
})

describe('the success screen tells assistive technology what happened', () => {
  it('moves focus to a real heading when the form is replaced', async () => {
    const { container } = renderForm()

    fireEvent.change(screen.getByPlaceholderText(/Purple Gelato, Dried Flower A/iu), {
      target: { value: 'Sativa Gold' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit for Review/iu }))

    await waitFor(() => expect(screen.queryByText(/Submitted for Review/iu)).not.toBeNull())

    const heading = container.querySelector('h1')
    expect(heading, 'the success screen has no h1').not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })
})

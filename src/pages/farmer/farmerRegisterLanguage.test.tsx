// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FarmerRegister from './FarmerRegister'

/**
 * P1 / W10.3 — the QR-code landing page had no way to reach Thai.
 *
 * `/farmer` resolves to `farmer-register`, which is a PUBLIC page, so the
 * navbar — the only place the language toggle rendered — is not drawn on it at
 * all. A Thai farm scanning the QR code on a leaflet arrived at an English form
 * with no control to change it, while the deployed bundle carried 498 Thai keys.
 *
 * This renders the real page and asserts a farmer can get to Thai from it, and
 * that the page actually redraws in Thai when they do. Asserting on source text
 * could not tell the difference between a toggle that exists and a toggle that
 * works.
 */

afterEach(cleanup)

const TH_HEADING = /สมัครเป็นผู้จัดหาสินค้า/u
const EN_HEADING = /Join as a Supplier/iu

describe('the QR landing page can reach Thai', () => {
  // Exact matches. The form separately captures the farmer's preferred CONTACT
  // language with buttons reading 'ภาษาไทย' / 'English' — a different control
  // for a different purpose, and a substring match hits both.
  const UI_THAI = { name: /^ไทย$/u }
  const UI_ENGLISH = { name: /^EN$/u }

  it('renders a language control at all', () => {
    render(<FarmerRegister lang="en" setLang={vi.fn()} onComplete={vi.fn()} />)
    expect(screen.getByRole('button', UI_THAI)).toBeTruthy()
    expect(screen.getByRole('button', UI_ENGLISH)).toBeTruthy()
  })

  it('asks for Thai when the Thai control is pressed', () => {
    const setLang = vi.fn()
    render(<FarmerRegister lang="en" setLang={setLang} onComplete={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', UI_THAI))

    expect(setLang).toHaveBeenCalledWith('th')
  })

  it('actually renders in Thai when told to', () => {
    // The counterfactual for the test above: a toggle that reports the choice
    // but changes nothing would still pass it.
    render(<FarmerRegister lang="th" setLang={vi.fn()} onComplete={vi.fn()} />)
    expect(screen.queryByText(TH_HEADING)).not.toBeNull()
    expect(screen.queryByText(EN_HEADING)).toBeNull()
  })

  it('renders in English when told to', () => {
    render(<FarmerRegister lang="en" setLang={vi.fn()} onComplete={vi.fn()} />)
    expect(screen.queryByText(EN_HEADING)).not.toBeNull()
    expect(screen.queryByText(TH_HEADING)).toBeNull()
  })
})

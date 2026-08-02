// @vitest-environment jsdom
//
// This notice is the only thing standing between an operator and believing that
// a clearance held in localStorage is a durable, attributable record. Both of
// its failure directions are bad and both are invisible to a source regex:
//
//   - not rendering when it should  → browser-only state passes as a real record
//   - rendering when it should not  → in demo mode localStorage IS the store, so
//                                     the warning is noise that teaches people to
//                                     ignore it where it actually matters
//
// It is also unusually dense in singular/plural ternaries — six of them in one
// sentence — which is exactly the kind of thing that reads fine in a diff and
// renders as "1 risk status overrides on this page exists" in front of a user.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import BrowserOnlyProvenanceNotice from './BrowserOnlyProvenanceNotice'

afterEach(cleanup)

const SUBJECT = 'risk status overrides'

describe('BrowserOnlyProvenanceNotice — when it must stay silent', () => {
  it('renders nothing at a count of zero', () => {
    const { container } = render(
      <BrowserOnlyProvenanceNotice count={0} subject={SUBJECT} supabaseConfigured />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a negative count', () => {
    const { container } = render(
      <BrowserOnlyProvenanceNotice count={-1} subject={SUBJECT} supabaseConfigured />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing in demo mode, where local storage IS the store', () => {
    const { container } = render(
      <BrowserOnlyProvenanceNotice count={3} subject={SUBJECT} supabaseConfigured={false} />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('BrowserOnlyProvenanceNotice — what it says when it speaks', () => {
  it('states all three consequences: no audit record, no approver, not visible to others', () => {
    render(<BrowserOnlyProvenanceNotice count={2} subject={SUBJECT} supabaseConfigured />)
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toMatch(/only in this browser/u)
    expect(text).toMatch(/no\s+server-side audit record/u)
    expect(text).toMatch(/no recorded approver/u)
    expect(text).toMatch(/not visible\s+to other admins/u)
    expect(text).toMatch(/Signing out clears/u)
  })

  it('reads as correct English in the singular', () => {
    render(<BrowserOnlyProvenanceNotice count={1} subject={SUBJECT} supabaseConfigured />)
    const text = (screen.getByRole('status').textContent ?? '').replace(/\s+/gu, ' ')
    expect(text).toContain('One risk status override on this page exists only in this browser.')
    expect(text).toContain('It has no server-side audit record')
    expect(text).toContain('it is not visible to other admins')
    expect(text).toContain('Signing out clears it.')
    // The plural forms must not leak into the singular sentence.
    expect(text).not.toMatch(/\bThey have\b|\bthey are\b|clears them/u)
  })

  it('reads as correct English in the plural', () => {
    render(<BrowserOnlyProvenanceNotice count={4} subject={SUBJECT} supabaseConfigured />)
    const text = (screen.getByRole('status').textContent ?? '').replace(/\s+/gu, ' ')
    expect(text).toContain('4 risk status overrides on this page exist only in this browser.')
    expect(text).toContain('They have no server-side audit record')
    expect(text).toContain('they are not visible to other admins')
    expect(text).toContain('Signing out clears them.')
    expect(text).not.toMatch(/\bIt has\b|\bit is\b|clears it\./u)
  })

  it('depluralises only the trailing s of the subject', () => {
    render(<BrowserOnlyProvenanceNotice count={1} subject="requirement status overrides" supabaseConfigured />)
    const text = (screen.getByRole('status').textContent ?? '').replace(/\s+/gu, ' ')
    expect(text).toContain('One requirement status override on this page')
  })

  it('is announced to assistive technology as a status, not silently', () => {
    render(<BrowserOnlyProvenanceNotice count={1} subject={SUBJECT} supabaseConfigured />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('never describes the override as approved, recorded or durable', () => {
    render(<BrowserOnlyProvenanceNotice count={2} subject={SUBJECT} supabaseConfigured />)
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).not.toMatch(/\bapproved\b|\bdurable\b|\bsaved to the server\b|\bpermanent\b/iu)
  })
})

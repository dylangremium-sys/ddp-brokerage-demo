// @vitest-environment jsdom
//
// The error boundary exists because the app had none: an uncaught render error
// unmounted the whole tree and left a blank white page with no signal anywhere.
//
// Every property worth having here is a runtime one. Does it actually catch, or
// does the error escape? Does the fallback appear? And — the security-relevant
// part — its class methods deliberately declare NO parameters, so React's error
// object and component stack cannot physically reach the state, the DOM, or the
// log. A source regex can confirm the parameters are absent; only rendering a
// component that really throws can confirm the message never reaches the screen.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

const SECRET = 'PGPASSWORD=hunter2 at /Users/mac/secrets/app.ts:42'

function Boom(): never {
  throw new Error(SECRET)
}

let consoleErr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // React logs caught render errors to console.error. Silenced so the suite
  // output stays readable, and captured so it can be asserted on.
  consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleErr.mockRestore()
  cleanup()
})

describe('ErrorBoundary', () => {
  it('renders its children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the real page</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('the real page')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('catches a render error instead of letting the tree unmount', () => {
    expect(() =>
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow()

    const alert = screen.getByRole('alert')
    expect(alert).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })

  it('never puts the error message or stack on the screen', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const shown = document.body.textContent ?? ''
    expect(shown).not.toContain('hunter2')
    expect(shown).not.toContain(SECRET)
    expect(shown).not.toMatch(/PGPASSWORD|\/Users\/|\.ts:\d+|at Boom/u)
  })

  it('tells the operator their data and session are intact', () => {
    // The fallback's job is to stop a render bug reading as data loss or a
    // forced sign-out — the boundary deliberately does neither.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/Your data has not been changed, and you are still\s+signed in/u)).toBeTruthy()
  })

  it('shows a non-empty reference code the user can quote', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const code = document.querySelector('code') as HTMLElement
    expect(code).toBeTruthy()
    expect((code.textContent ?? '').trim().length).toBeGreaterThan(0)
  })

  it('offers a reload control rather than a dead end', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: /Reload the page/u })).toBeTruthy()
  })
})

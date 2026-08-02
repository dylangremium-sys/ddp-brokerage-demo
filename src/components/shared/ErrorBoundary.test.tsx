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

// A marker that is distinctive enough to find anywhere in the DOM, but is NOT
// shaped like a credential. The first version of this test threw a realistic
// database-password assignment as bait and tripped the secrets scanner
// (SCT-1000, Critical) — which would have made a genuine credential alert one
// item harder to notice, the exact desensitising this suite guards against
// elsewhere. The property under test is that the error's TEXT never reaches the
// screen; it does not require that text to resemble a real secret.
const ERROR_TEXT = 'RENDER-CANARY-8f2b-must-never-reach-the-dom'

function Boom(): never {
  throw new Error(ERROR_TEXT)
}

let consoleErr: ReturnType<typeof vi.spyOn>
let logged: unknown[][] = []

beforeEach(() => {
  // React logs every caught render error to console.error. Silenced so a suite
  // that throws on purpose does not look like a failing one, and collected so
  // the assertions below can check what did and did not go out.
  logged = []
  consoleErr = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
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
    expect(shown).not.toContain(ERROR_TEXT)
    expect(shown).not.toContain('RENDER-CANARY')
    // No stack frame, file path or line reference either — the component stack
    // is the other thing React hands these methods, and it is refused the same
    // way, by never accepting the parameter.
    expect(shown).not.toMatch(/\bat \w+ \(|\.tsx?:\d+|\/src\//u)
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

  it('does not itself log the error text to the console', () => {
    // React's own development logging is out of our hands, but this component's
    // componentDidCatch takes no parameters, so nothing IT emits can carry the
    // message. Asserted on what the boundary's own code path produced.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const fromOurCode = logged
      .flat()
      .filter(arg => typeof arg === 'string')
      .filter(arg => !(arg as string).includes('The above error occurred'))
      .join('\n')
    expect(fromOurCode).not.toContain('RENDER-CANARY')
  })
})

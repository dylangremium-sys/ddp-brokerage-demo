import { describe, expect, it } from 'vitest'
import { shouldInterceptAnchorClick, type AnchorClickLike } from './anchorNavigation'

/**
 * REGRESSION GUARD.
 *
 * The corporate pages, the landing footer and the supplier CTA are all real
 * anchors that the SPA intercepts. The first version intercepted every click
 * unconditionally, which meant Cmd-click and Ctrl-click — "open in a new tab" —
 * navigated the current tab instead. The visitor lost the page they were on and
 * did not get the tab they asked for.
 *
 * It could not be caught by anything already here: the link still worked, the
 * DOM still rendered, nothing threw. Only an assertion about the DECISION
 * catches it, which is why the decision is a pure function.
 */

const plainClick: AnchorClickLike = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  currentTarget: { target: '' },
}

describe('an ordinary click is handled in-app', () => {
  it('intercepts a plain primary-button click', () => {
    expect(shouldInterceptAnchorClick(plainClick)).toBe(true)
  })

  it('intercepts a keyboard activation, which reports no button', () => {
    // Enter on a focused link produces a click with no meaningful `button`.
    // Treating a missing button as non-primary would break keyboard navigation
    // — an accessibility regression hiding inside a routing fix.
    expect(shouldInterceptAnchorClick({ ...plainClick, button: undefined })).toBe(true)
  })

  it('intercepts when currentTarget carries no target attribute', () => {
    expect(shouldInterceptAnchorClick({ ...plainClick, currentTarget: null })).toBe(true)
    expect(shouldInterceptAnchorClick({ ...plainClick, currentTarget: { target: '_self' } })).toBe(true)
  })
})

describe('the browser keeps the gestures that are its own', () => {
  it.each([
    ['Cmd-click — open in a new tab (macOS)', { metaKey: true }],
    ['Ctrl-click — open in a new tab (Windows/Linux)', { ctrlKey: true }],
    ['Shift-click — open in a new window', { shiftKey: true }],
    ['Alt-click — download the target', { altKey: true }],
  ])('does not intercept %s', (_label, modifier) => {
    expect(shouldInterceptAnchorClick({ ...plainClick, ...modifier })).toBe(false)
  })

  it('does not intercept a middle-button click', () => {
    // Most browsers deliver this as `auxclick` rather than `click`, but the
    // ones that do report it here must not have it swallowed.
    expect(shouldInterceptAnchorClick({ ...plainClick, button: 1 })).toBe(false)
  })

  it('does not intercept a right-button click', () => {
    expect(shouldInterceptAnchorClick({ ...plainClick, button: 2 })).toBe(false)
  })

  it('does not intercept an anchor asking for another browsing context', () => {
    expect(shouldInterceptAnchorClick({ ...plainClick, currentTarget: { target: '_blank' } })).toBe(false)
    expect(shouldInterceptAnchorClick({ ...plainClick, currentTarget: { target: 'reports' } })).toBe(false)
  })

  it('does not act on an event another handler already claimed', () => {
    expect(shouldInterceptAnchorClick({ ...plainClick, defaultPrevented: true })).toBe(false)
  })

  it('refuses a modified click even on the primary button', () => {
    // The combination that actually shipped broken: primary button, Cmd held.
    expect(shouldInterceptAnchorClick({ ...plainClick, button: 0, metaKey: true })).toBe(false)
  })
})

describe('every intercepting anchor in the codebase uses the guard', () => {
  /**
   * The property is about what the components WIRE, which a unit test on a
   * value cannot see — the same reason navigationGuard.test.ts scans App.tsx.
   *
   * An unguarded `preventDefault()` inside an anchor's onClick is exactly the
   * defect this file exists for, and adding one is a two-word edit in a file
   * nobody re-reads. This fails if one reappears.
   */
  const SOURCES = import.meta.glob(
    ['../components/public/*.tsx', '../pages/public/*.tsx'],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>

  /**
   * The rule is about NAVIGATION, not about preventDefault in general.
   *
   * The landing page also has fragment anchors (href="#process") whose handlers
   * call preventDefault to smooth-scroll. Those are correct as they are: there
   * is no cross-document navigation to preserve, and the first version of this
   * scan flagged them, which would have pushed a pointless guard into
   * scroll-only code.
   *
   * So the trigger is a handler that both suppresses the default AND routes the
   * application somewhere. That is exactly the combination that steals a
   * Cmd-click.
   */
  const ROUTES_THE_APP = /\b(onNavigate|goTo|onSupplierSignup|onSecureLogin|onForgotPassword|onBackToLogin)\s*\(/

  const navigatingHandlersIn = (source: string) =>
    [...source.matchAll(/onClick=\{([\s\S]*?)\}\s*\n/g)]
      .map((match) => match[1])
      .filter((handler) => handler.includes('preventDefault') && ROUTES_THE_APP.test(handler))

  it('finds the public components to scan', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(5)
  })

  /**
   * Non-vacuity. A scan that matches nothing passes forever and proves nothing
   * — and this one is a regex over source text, so it can stop matching from a
   * whitespace change alone. Assert it still finds the handlers it is meant to
   * be policing, rather than breaking a tracked file to watch it fail.
   */
  it('actually finds navigating anchors, so the scan is not vacuous', () => {
    const total = Object.values(SOURCES).reduce((sum, src) => sum + navigatingHandlersIn(src).length, 0)
    expect(
      total,
      'the source scan matched no navigating click handlers at all — the regex has ' +
        'drifted from the source and the guard below is passing on an empty set.',
    ).toBeGreaterThanOrEqual(3)
  })

  it.each(Object.entries(SOURCES))('%s guards every navigating anchor', (path, source) => {
    const handlers = [...source.matchAll(/onClick=\{([\s\S]*?)\}\s*\n/g)].map((match) => match[1])

    const navigating = handlers.filter(
      (handler) => handler.includes('preventDefault') && ROUTES_THE_APP.test(handler),
    )

    for (const handler of navigating) {
      expect(
        handler.replace(/\s+/g, ' ').trim(),
        `${path}: a handler suppresses the default click AND navigates, without ` +
          'shouldInterceptAnchorClick() — so Cmd/Ctrl-click cannot open it in a new tab.',
      ).toMatch(/shouldInterceptAnchorClick/)
    }
  })
})

// Navigation guard — including the regression that made supplier onboarding
// unreachable in production.
//
// The bug: PUBLIC_PAGES omitted 'farmer-register', so every signed-out visitor
// who clicked "Supplier signup" was bounced back to login. It shipped because
// nothing could catch it — no type error, no lint error, no failing render. The
// invariant test at the bottom is the durable guard: it walks the navigation
// targets the PUBLIC surfaces actually offer and asserts each one is reachable
// while signed out.

import { describe, it, expect } from 'vitest'
import {
  PUBLIC_PAGES,
  FARMER_PAGES,
  isReachableWhileSignedOut,
  resolveNavigationTarget,
  type NavigationContext,
} from './navigationGuard'
import type { Page } from '../types'

const SIGNED_OUT: NavigationContext = { isDemo: false, isSignedIn: false, isAdminRole: false }
const FARMER: NavigationContext = { isDemo: false, isSignedIn: true, isAdminRole: false }
const ADMIN: NavigationContext = { isDemo: false, isSignedIn: true, isAdminRole: true }
const DEMO: NavigationContext = { isDemo: true, isSignedIn: false, isAdminRole: false }

describe('signed-out visitor', () => {
  it.each(PUBLIC_PAGES)('reaches the public page %s', (page) => {
    expect(resolveNavigationTarget(page, SIGNED_OUT)).toBe(page)
  })

  it('REGRESSION: reaches farmer-register — the supplier access request', () => {
    // This is the exact assertion that would have caught the production bug.
    // With 'farmer-register' missing from PUBLIC_PAGES this returned 'login',
    // and the "Supplier signup" button was a silent no-op for every visitor.
    expect(resolveNavigationTarget('farmer-register', SIGNED_OUT)).toBe('farmer-register')
    expect(isReachableWhileSignedOut('farmer-register')).toBe(true)
  })

  it.each([
    'farmer-dashboard', 'farmer-onboarding', 'farmer-my-stock',
    'ddp-overview', 'ddp-compliance-watchtower',
  ] as Page[])('is redirected to login from the private page %s', (page) => {
    expect(resolveNavigationTarget(page, SIGNED_OUT)).toBe('login')
  })
})

describe('signed-in farmer', () => {
  it('reaches their own dashboard', () => {
    expect(resolveNavigationTarget('farmer-dashboard', FARMER)).toBe('farmer-dashboard')
  })

  it('is not steered away from farmer pages', () => {
    for (const page of FARMER_PAGES) {
      expect(resolveNavigationTarget(page, FARMER)).toBe(page)
    }
  })
})

describe('signed-in admin', () => {
  it('is steered away from operational farmer pages', () => {
    expect(resolveNavigationTarget('farmer-dashboard', ADMIN)).toBe('ddp-overview')
    expect(resolveNavigationTarget('farmer-my-stock', ADMIN)).toBe('ddp-overview')
  })

  it('can still view the public pages', () => {
    // Public pages are exempt from the admin redirect, so an admin can look at
    // the landing page and the auth screens without being bounced.
    for (const page of PUBLIC_PAGES) {
      expect(resolveNavigationTarget(page, ADMIN)).toBe(page)
    }
  })

  it('reaches their own admin pages', () => {
    expect(resolveNavigationTarget('ddp-compliance-watchtower', ADMIN)).toBe('ddp-compliance-watchtower')
  })
})

describe('demo mode', () => {
  it('bypasses every guard', () => {
    for (const page of ['farmer-dashboard', 'ddp-overview', 'farmer-register'] as Page[]) {
      expect(resolveNavigationTarget(page, DEMO)).toBe(page)
    }
  })
})

describe('INVARIANT: every navigation target offered to a signed-out visitor is reachable', () => {
  // The durable guard. Rather than listing pages by hand — which is exactly how
  // farmer-register was missed — this reads the affordances the PUBLIC surfaces
  // actually wire up and asserts each destination survives the guard.
  //
  // Source-text scanning is used elsewhere in this repo for the same reason: the
  // property is about what the code WIRES, which a unit test on a value cannot see.
  // App.tsx's own source, imported raw — vite/client typed, no node:fs. Same
  // approach the connector-runtime contract test uses.
  const RAW = import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const APP_SOURCE = Object.values(RAW)[0] ?? ''

  /** goTo('x') targets passed as props to the landing and login pages. */
  function publicSurfaceTargets(): Page[] {
    const targets = new Set<Page>()
    // e.g.  onSupplierSignup={() => goTo('farmer-register')}
    for (const match of APP_SOURCE.matchAll(/on(?:SecureLogin|SupplierSignup|Complete)=\{\(\)\s*=>\s*goTo\('([a-z-]+)'\)\}/g)) {
      targets.add(match[1] as Page)
    }
    return [...targets]
  }

  it('finds the public navigation affordances in App.tsx', () => {
    const targets = publicSurfaceTargets()
    // If this fails the regex has drifted from the source and the invariant
    // below would silently pass on an empty set — fail loudly instead.
    expect(targets.length).toBeGreaterThanOrEqual(2)
    expect(targets).toContain('farmer-register')
  })

  it.each(publicSurfaceTargets())(
    'a signed-out visitor can actually reach %s',
    (page) => {
      expect(
        isReachableWhileSignedOut(page),
        `"${page}" is linked from a public surface but is not in PUBLIC_PAGES, so the ` +
          `link is a silent no-op for every signed-out visitor — the exact defect that ` +
          `made supplier onboarding unreachable in production.`,
      ).toBe(true)
    },
  )
})

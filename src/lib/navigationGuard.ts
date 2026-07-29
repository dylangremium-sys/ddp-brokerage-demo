// ─── Navigation guard (pure) ────────────────────────────────────────────────
//
// Extracted from App.tsx's goTo() so the routing decision can be tested.
//
// WHY THIS EXISTS
//   PUBLIC_PAGES omitted 'farmer-register', and the guard bounces any non-public
//   page to login for a signed-out caller. So every visitor who clicked
//   "Supplier signup" — from the landing header and from the login card — was
//   silently redirected back to the login screen. The supplier onboarding entry
//   point was unreachable in production for everyone, and nothing caught it:
//   it is not a type error, not a lint error, and there is no rendering bug to
//   assert on. It only appeared by clicking through the running site.
//
//   The decision is pure logic, so it does not need a DOM to test. Vitest runs
//   `environment: 'node'` in this repo and there is deliberately no jsdom or
//   testing-library; extracting the function keeps it that way while making the
//   whole class of bug catchable in the existing suite.
//
// The rules are unchanged from the original inline implementation:
//   1. Demo mode bypasses every guard.
//   2. A signed-out caller may only reach a PUBLIC page; anything else -> login.
//   3. An admin is redirected away from farmer-only pages -> ddp-overview.

import type { Page } from '../types'

/**
 * Pages a signed-out visitor may reach.
 *
 * INVARIANT: every page an unauthenticated surface links to MUST appear here,
 * or that link becomes a silent no-op. navigationGuard.test.ts enforces this
 * against the affordances the landing and login pages actually offer.
 */
export const PUBLIC_PAGES: Page[] = ['landing', 'login', 'farmer-register']

/** Farmer-scoped pages. An admin is steered away from the operational ones. */
export const FARMER_PAGES: Page[] = [
  'landing', 'login', 'farmer-register',
  'farmer-dashboard', 'farmer-onboarding', 'farmer-advanced-profile',
  'farmer-my-stock', 'farmer-stock-form', 'farmer-requests', 'farmer-status',
]

export interface NavigationContext {
  /** Demo mode has no backend and no real identity; guards do not apply. */
  isDemo: boolean
  isSignedIn: boolean
  isAdminRole: boolean
}

/**
 * Where a navigation request actually lands.
 *
 * Returns the requested page, or the page the caller is redirected to. Pure —
 * no state, no side effects — so App.tsx keeps ownership of setPage/scroll.
 */
export function resolveNavigationTarget(requested: Page, ctx: NavigationContext): Page {
  if (ctx.isDemo) return requested

  // A signed-out caller may only reach a public page.
  if (!ctx.isSignedIn && !PUBLIC_PAGES.includes(requested)) return 'login'

  // An admin has no farmer dashboard; steer them to their own overview. Public
  // pages are exempt so an admin can still view the landing and auth screens.
  if (ctx.isAdminRole && FARMER_PAGES.includes(requested) && !PUBLIC_PAGES.includes(requested)) {
    return 'ddp-overview'
  }

  return requested
}

/** True when a signed-out visitor can actually reach `page`. */
export function isReachableWhileSignedOut(page: Page): boolean {
  return resolveNavigationTarget(page, { isDemo: false, isSignedIn: false, isAdminRole: false }) === page
}

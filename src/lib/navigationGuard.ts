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
 * The public pages that are NOT the landing page: the cream-themed auth cards.
 *
 * Kept separate because the landing page owns its own chrome and background,
 * while these four share the `public-auth-shell` treatment. App.tsx derives its
 * shell/navbar decisions from these lists rather than from a hand-written
 * `page !== 'x' && page !== 'y' && …` chain — that chain is how a new page ends
 * up silently rendered inside the wrong shell.
 */
export const PUBLIC_AUTH_PAGES: Page[] = [
  'login', 'farmer-register', 'set-password', 'forgot-password',
]

/**
 * The public corporate pages: company information, contact details and the two
 * legal notices.
 *
 * Kept OUT of PUBLIC_AUTH_PAGES on purpose. That list is not "the public pages"
 * — it is the set that gets the cream `public-auth-shell` card treatment and
 * the `public-auth-page` body class. A corporate page is a document, not an
 * auth card: it draws its own full-width shell. Adding them to the auth list
 * would have rendered a privacy policy inside a login-sized card.
 *
 * These are the only pages other than the landing page approved for public
 * search indexing; lib/publicPageMetadata.ts is the register that says so.
 */
export const PUBLIC_CORPORATE_PAGES: Page[] = ['about', 'contact', 'privacy', 'terms', 'governance', 'de-buyer', 'cs-buyer', 'th-supplier', 'regulatory-hub', 'regulatory-entry']

/**
 * Pages a signed-out visitor may reach.
 *
 * INVARIANT: every page an unauthenticated surface links to MUST appear here,
 * or that link becomes a silent no-op. navigationGuard.test.ts enforces this
 * against the affordances the landing and login pages actually offer.
 *
 * 'set-password' and 'forgot-password' are public by necessity: the users who
 * need them are precisely the ones who cannot sign in. set-password does still
 * require a session — but it is the invite/recovery link that grants it, not a
 * prior login, so the navigation guard must not demand one.
 */
export const PUBLIC_PAGES: Page[] = ['landing', ...PUBLIC_AUTH_PAGES, ...PUBLIC_CORPORATE_PAGES]

/** Farmer-scoped pages. An admin is steered away from the operational ones. */
export const FARMER_PAGES: Page[] = [
  ...PUBLIC_PAGES,
  'farmer-dashboard', 'farmer-onboarding', 'farmer-advanced-profile',
  'farmer-my-stock', 'farmer-stock-form', 'farmer-requests', 'farmer-status',
  'farmer-evidence',
]

/**
 * Buyer-scoped pages.
 *
 * A buyer sees the public surfaces and their own dashboard, and nothing else.
 * They must never reach a farmer or admin page: the farmer screens carry other
 * farms' identities, and the admin screens carry review decisions and internal
 * notes. RLS is the real boundary — this list keeps the client from asking.
 */
export const BUYER_PAGES: Page[] = [...PUBLIC_PAGES, 'buyer-dashboard']

/**
 * The DDP console. Every page here requires an admin.
 *
 * MOVED HERE FROM App.tsx, where it was a module constant used only to paint
 * AccessDenied. The guard needs the same list to answer the converse question —
 * may a non-admin be ROUTED here — and two copies of "which pages are the
 * console" would be a drift waiting to happen, on the list that decides who
 * sees what.
 */
export const DDP_PAGES: Page[] = [
  'ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review',
  'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence',
  'ddp-risk-register', 'ddp-compliance-watchtower', 'ddp-operations-desk',
  'ddp-access-requests', 'ddp-buyer-provisioning', 'ddp-document-review',
]

export interface NavigationContext {
  /** Demo mode has no backend and no real identity; guards do not apply. */
  isDemo: boolean
  isSignedIn: boolean
  isAdminRole: boolean
  /**
   * Optional so existing callers keep working. Absent means "not a buyer",
   * which is the safe default: the buyer rules below only ever RESTRICT.
   */
  isBuyerRole?: boolean
  /**
   * Optional, and it does NOT decide whether a console page is refused — only
   * where the refused caller is sent. Absent means "not known to be a farmer",
   * which lands them on the public landing page rather than a farmer screen
   * they may have no business on. The refusal itself never depends on it.
   */
  isFarmerRole?: boolean
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

  // A buyer may reach their own surface and the public ones, nothing else.
  // Checked BEFORE the admin rule: a buyer is not an admin, and leaving this
  // until later would let a buyer request an admin page and be returned it.
  if (ctx.isBuyerRole) {
    return BUYER_PAGES.includes(requested) ? requested : 'buyer-dashboard'
  }

  // Conversely, nobody but a buyer lands on the buyer surface. An admin has
  // their own buyer PREVIEW for seeing what a buyer would see; sending them to
  // the real one would show them a surface scoped to an identity they do not
  // hold.
  if (requested === 'buyer-dashboard') {
    return ctx.isAdminRole ? 'ddp-overview' : 'farmer-dashboard'
  }

  // An admin has no farmer dashboard; steer them to their own overview. Public
  // pages are exempt so an admin can still view the landing and auth screens.
  if (ctx.isAdminRole && FARMER_PAGES.includes(requested) && !PUBLIC_PAGES.includes(requested)) {
    return 'ddp-overview'
  }

  /*
   * AND THE CONVERSE: a non-admin has no console.
   *
   * This rule was missing, and its absence was asymmetric in the dangerous
   * direction — the guard steered admins away from farmer pages but handed a
   * signed-in farmer any console page they asked for. Nothing was exposed:
   * App.tsx paints AccessDenied for DDP_PAGES without isAdminRole, and RLS
   * refuses the reads behind it. But a guard that returns a page it does not
   * mean to grant is one layer pretending to be two, and it reads as though the
   * routing were the control.
   *
   * Found while giving the console addresses — a test asserting "a farmer is
   * not handed an admin screen" failed, and the honest fix was to make the
   * assertion true rather than to weaken it.
   *
   * Public pages are exempt for the same reason as above: a farmer may still
   * read the landing page and the auth screens.
   */
  if (!ctx.isAdminRole && DDP_PAGES.includes(requested) && !PUBLIC_PAGES.includes(requested)) {
    return ctx.isFarmerRole ? 'farmer-status' : 'landing'
  }

  return requested
}

/** True when a signed-out visitor can actually reach `page`. */
export function isReachableWhileSignedOut(page: Page): boolean {
  return resolveNavigationTarget(page, { isDemo: false, isSignedIn: false, isAdminRole: false }) === page
}

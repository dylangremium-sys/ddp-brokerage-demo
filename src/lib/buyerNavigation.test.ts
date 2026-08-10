import { describe, it, expect } from 'vitest'
import { resolveNavigationTarget, BUYER_PAGES, FARMER_PAGES, PUBLIC_PAGES } from './navigationGuard'
import { resolvePostLoginDecision } from './postLoginRouting'
import type { Page } from '../types'
import type { UserProfile } from '../services/auth'

/**
 * W3.1 — a buyer could not sign in, and the reason was a missing switch case.
 *
 * Production has admitted `buyer` as a value of `profiles.role` since migration
 * 39 — verified against the live CHECK — and carries `organisations` and
 * `organisation_memberships`. But `UserRole` omitted it and
 * `resolvePostLoginDecision` had no case for it, so a real buyer account fell
 * through to `default:` and was signed straight back out on every attempt. The
 * substrate was built and the door was locked from the inside.
 *
 * The guard rules are security-relevant, so this asserts the whole matrix
 * rather than the happy path: a buyer must not reach farmer or admin surfaces
 * (which carry other farms' identities, review decisions and internal notes),
 * and nobody but a buyer should land on the buyer surface.
 *
 * RLS remains the real boundary. This keeps the client from asking.
 */

const buyer = { id: 'b', email: 'b@x.co', displayName: 'Buyer', role: 'buyer' } as UserProfile

const ctx = (over: Partial<Parameters<typeof resolveNavigationTarget>[1]> = {}) => ({
  isDemo: false, isSignedIn: true, isAdminRole: false, isBuyerRole: false, ...over,
})

const AS_BUYER = ctx({ isBuyerRole: true })
const AS_ADMIN = ctx({ isAdminRole: true })
const AS_FARMER = ctx()

describe('a buyer can now sign in at all', () => {
  it('routes a buyer to their own surface instead of denying them', () => {
    expect(resolvePostLoginDecision(buyer)).toEqual({ kind: 'route', page: 'buyer-dashboard' })
  })

  it('still denies every role that is not an operator', () => {
    // The fix must not have widened the default case into a catch-all.
    expect(resolvePostLoginDecision({ ...buyer, role: 'pending' } as UserProfile))
      .toEqual({ kind: 'denied', reason: 'pending-approval' })
    expect(resolvePostLoginDecision({ ...buyer, role: 'nonsense' } as unknown as UserProfile))
      .toEqual({ kind: 'denied', reason: 'unresolved-role' })
    expect(resolvePostLoginDecision(null)).toEqual({ kind: 'denied', reason: 'unresolved-role' })
  })

  it('leaves the existing roles routed exactly where they were', () => {
    expect(resolvePostLoginDecision({ ...buyer, role: 'ddp_admin' } as UserProfile))
      .toEqual({ kind: 'route', page: 'ddp-overview' })
    expect(resolvePostLoginDecision({ ...buyer, role: 'farmer' } as UserProfile))
      .toEqual({ kind: 'route', page: 'farmer-dashboard' })
  })
})

describe('a buyer reaches their own surface and the public ones', () => {
  it.each(BUYER_PAGES)('allows %s', (page) => {
    expect(resolveNavigationTarget(page, AS_BUYER)).toBe(page)
  })

  const operational = FARMER_PAGES.filter((p) => !PUBLIC_PAGES.includes(p))

  it.each(operational)('sends a buyer away from the farmer page %s', (page) => {
    expect(resolveNavigationTarget(page, AS_BUYER)).toBe('buyer-dashboard')
  })

  // 'ddp-buyer-provisioning' is the page that CREATES buyers. A buyer reaching
  // it would be the shortest path from one buyer account to any number of them.
  it.each(['ddp-overview', 'ddp-inventory-dashboard', 'ddp-access-requests', 'ddp-buyer-provisioning'] as Page[])(
    'sends a buyer away from the admin page %s', (page) => {
      expect(resolveNavigationTarget(page, AS_BUYER)).toBe('buyer-dashboard')
    })
})

describe('nobody but a buyer lands on the buyer surface', () => {
  it('sends an admin to their own overview', () => {
    // An admin has a buyer PREVIEW for seeing what a buyer would see. The real
    // surface is scoped to an identity they do not hold.
    expect(resolveNavigationTarget('buyer-dashboard', AS_ADMIN)).toBe('ddp-overview')
  })

  it('sends a farmer to their own dashboard', () => {
    expect(resolveNavigationTarget('buyer-dashboard', AS_FARMER)).toBe('farmer-dashboard')
  })

  it('sends a signed-out visitor to login', () => {
    expect(resolveNavigationTarget('buyer-dashboard', ctx({ isSignedIn: false }))).toBe('login')
  })
})

describe('the change did not loosen anything that was already tight', () => {
  it('still steers an admin away from operational farmer pages', () => {
    expect(resolveNavigationTarget('farmer-my-stock', AS_ADMIN)).toBe('ddp-overview')
  })

  it('still refuses a signed-out visitor any non-public page', () => {
    expect(resolveNavigationTarget('farmer-my-stock', ctx({ isSignedIn: false }))).toBe('login')
  })

  it('treats a missing isBuyerRole as "not a buyer", not as a buyer', () => {
    // The field is optional so existing callers keep compiling. Defaulting the
    // other way would hand every caller that omits it a buyer's restrictions.
    expect(resolveNavigationTarget('farmer-my-stock', { isDemo: false, isSignedIn: true, isAdminRole: false }))
      .toBe('farmer-my-stock')
  })

  it('leaves demo mode unguarded, as before', () => {
    expect(resolveNavigationTarget('buyer-dashboard', ctx({ isDemo: true, isBuyerRole: false })))
      .toBe('buyer-dashboard')
  })
})

describe('the buyer surface is not a back door', () => {
  it('exposes no page a buyer should not have', () => {
    const leaked = BUYER_PAGES.filter((p) => !PUBLIC_PAGES.includes(p) && p !== 'buyer-dashboard')
    expect(leaked, 'BUYER_PAGES has grown beyond the buyer surface').toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { ReviewRequest } from '../types'
import {
  reviewRequestScopeKey,
  reviewRequestScopeChanged,
  scopeReviewRequestsToFarmer,
  type ReviewRequestScope,
} from './reviewRequestScope'

function req(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: 'r1',
    requestType: 'general',
    message: 'Please add a COA.',
    status: 'open',
    createdBy: 'DDP Admin',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A representative admin-wide list: batch-linked and farm-level requests. */
const ADMIN_WIDE: ReviewRequest[] = [
  req({ id: 'a1', stockItemId: 'batch-A' }),
  req({ id: 'a2', stockItemId: 'batch-B' }),
  req({ id: 'a3', farmProfileId: 'farm-X' }),
  req({ id: 'a4', stockItemId: 'batch-C', farmProfileId: 'farm-Y' }),
]

describe('reviewRequestScopeKey', () => {
  it('is null when signed out', () => {
    expect(reviewRequestScopeKey(null)).toBeNull()
    expect(reviewRequestScopeKey(undefined)).toBeNull()
  })

  it('encodes both identity and role — either changing yields a different key', () => {
    const admin = reviewRequestScopeKey({ id: 'u1', role: 'ddp_admin' })
    const sameUserFarmer = reviewRequestScopeKey({ id: 'u1', role: 'farmer' })
    const otherFarmer = reviewRequestScopeKey({ id: 'u2', role: 'farmer' })
    expect(admin).not.toBe(sameUserFarmer) // role change
    expect(sameUserFarmer).not.toBe(otherFarmer) // identity change
    // Stable for the same identity+role (e.g. a token refresh).
    expect(reviewRequestScopeKey({ id: 'u1', role: 'ddp_admin' })).toBe(admin)
  })
})

describe('reviewRequestScopeChanged', () => {
  it('signals a clear on sign-out and on either role or identity change', () => {
    const admin = reviewRequestScopeKey({ id: 'u1', role: 'ddp_admin' })
    const farmer = reviewRequestScopeKey({ id: 'u1', role: 'farmer' })
    expect(reviewRequestScopeChanged(admin, null)).toBe(true) // sign-out
    expect(reviewRequestScopeChanged(admin, farmer)).toBe(true) // admin → farmer
    expect(reviewRequestScopeChanged(farmer, admin)).toBe(true) // farmer → admin
    expect(reviewRequestScopeChanged(null, admin)).toBe(true) // first sign-in
  })

  it('does NOT signal a clear for a repeat event with the same key (token refresh)', () => {
    const key = reviewRequestScopeKey({ id: 'u1', role: 'farmer' })
    expect(reviewRequestScopeChanged(key, key)).toBe(false)
  })
})

describe('scopeReviewRequestsToFarmer — fail-closed farmer projection', () => {
  it('returns [] while the farmer scope is unknown (loading), never admin data', () => {
    expect(scopeReviewRequestsToFarmer(ADMIN_WIDE, null)).toEqual([])
  })

  it('admin → farmer with ZERO scoped requests: no admin request remains visible', () => {
    const emptyScope: ReviewRequestScope = { farmIds: new Set(), itemIds: new Set() }
    expect(scopeReviewRequestsToFarmer(ADMIN_WIDE, emptyScope)).toEqual([])
  })

  it('admin → farmer with scoped requests: only the farmer-owned rows survive', () => {
    // Farmer owns batch-B and farm-X; the rest of the admin-wide list is unrelated.
    const scope: ReviewRequestScope = { farmIds: new Set(['farm-X']), itemIds: new Set(['batch-B']) }
    const scoped = scopeReviewRequestsToFarmer(ADMIN_WIDE, scope)
    expect(scoped.map(r => r.id).sort()).toEqual(['a2', 'a3'])
    // Unrelated admin-visible requests disappear.
    expect(scoped.some(r => r.id === 'a1' || r.id === 'a4')).toBe(false)
  })

  it('matches a request by its batch OR its farm', () => {
    const byBatch: ReviewRequestScope = { farmIds: new Set(), itemIds: new Set(['batch-C']) }
    expect(scopeReviewRequestsToFarmer(ADMIN_WIDE, byBatch).map(r => r.id)).toEqual(['a4'])
    const byFarm: ReviewRequestScope = { farmIds: new Set(['farm-Y']), itemIds: new Set() }
    expect(scopeReviewRequestsToFarmer(ADMIN_WIDE, byFarm).map(r => r.id)).toEqual(['a4'])
  })

  it('a failed farmer load (empty scope) is fail-closed, not a pass-through', () => {
    // The App sets an empty scope on farmer load failure; the projection must
    // then expose nothing, even though the shared array may still hold rows.
    const failScope: ReviewRequestScope = { farmIds: new Set(), itemIds: new Set() }
    expect(scopeReviewRequestsToFarmer(ADMIN_WIDE, failScope)).toEqual([])
  })
})

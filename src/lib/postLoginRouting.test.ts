import { describe, it, expect } from 'vitest'
import { resolvePostLoginDecision } from './postLoginRouting'
import type { UserProfile } from '../services/auth'

const baseProfile: UserProfile = {
  id: 'user-1',
  email: 'operator@example.com',
  displayName: 'Operator',
  role: 'farmer',
}

describe('resolvePostLoginDecision', () => {
  it('routes a ddp_admin to the existing DDP/admin overview', () => {
    expect(resolvePostLoginDecision({ ...baseProfile, role: 'ddp_admin' })).toEqual({
      kind: 'route',
      page: 'ddp-overview',
    })
  })

  it('routes a farmer to the existing farmer dashboard', () => {
    expect(resolvePostLoginDecision({ ...baseProfile, role: 'farmer' })).toEqual({
      kind: 'route',
      page: 'farmer-dashboard',
    })
  })

  it('fails closed when the profile could not be resolved (null)', () => {
    expect(resolvePostLoginDecision(null)).toEqual({
      kind: 'denied',
      reason: 'unresolved-role',
    })
  })

  it('fails closed for an unknown / unexpected role', () => {
    const unknownRole = { ...baseProfile, role: 'buyer' as unknown as UserProfile['role'] }
    expect(resolvePostLoginDecision(unknownRole)).toEqual({
      kind: 'denied',
      reason: 'unresolved-role',
    })
  })
})

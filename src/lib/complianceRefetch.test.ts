import { describe, it, expect } from 'vitest'
import { complianceRefetchStarted } from './complianceRefetch'

const profileA = { id: 'u1' } // identity matters, not shape
const profileAToken2 = { id: 'u1' } // same user, new object (token refresh)

describe('complianceRefetchStarted', () => {
  it('is true on the first entry (nothing reflected yet) — mark loading', () => {
    expect(complianceRefetchStarted(null, { profile: profileA, page: 'ddp-operations-desk' })).toBe(true)
  })

  it('is false when the same profile object and page are already reflected — no churn', () => {
    const t = { profile: profileA, page: 'ddp-operations-desk' }
    expect(complianceRefetchStarted(t, { profile: profileA, page: 'ddp-operations-desk' })).toBe(false)
  })

  it('is true when the page changed (e.g. returning to the desk after leaving)', () => {
    // Leaving clears the trigger to null; but even a direct page change flips it.
    expect(complianceRefetchStarted(
      { profile: profileA, page: 'ddp-inventory' },
      { profile: profileA, page: 'ddp-operations-desk' },
    )).toBe(true)
  })

  it('is true when the profile identity changed (token refresh — new object, same user)', () => {
    expect(complianceRefetchStarted(
      { profile: profileA, page: 'ddp-operations-desk' },
      { profile: profileAToken2, page: 'ddp-operations-desk' },
    )).toBe(true)
  })
})

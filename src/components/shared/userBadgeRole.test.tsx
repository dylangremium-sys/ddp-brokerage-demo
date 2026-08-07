// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import UserBadge from './UserBadge'
import type { UserProfile, UserRole } from '../../services/auth'

/**
 * W3.1 follow-up — the badge called every non-admin a farmer.
 *
 * `profile.role === 'ddp_admin' ? 'Admin' : 'Farmer'` was correct only while
 * exactly two roles could reach a surface that renders it. The moment `buyer`
 * became routable, a buyer signing in would have been shown a **"Farmer"** chip
 * on their own account page — the product asserting something untrue about who
 * someone is, on the one screen where they are looking at their own identity.
 *
 * Caught in review of the W3.1 pull request, not by a test, which is the point
 * of the exhaustive lookup that replaced it: adding a role is now a compile
 * error in UserBadge rather than a silent inheritance of the fallback.
 */

afterEach(cleanup)

const profileWith = (role: UserRole): UserProfile =>
  ({ id: 'u', email: 'u@x.co', displayName: 'Somchai', role }) as UserProfile

describe('the chip names the role the account actually has', () => {
  it.each([
    ['ddp_admin', 'Admin'],
    ['farmer', 'Farmer'],
    ['buyer', 'Buyer'],
    ['pending', 'Pending'],
  ] as const)('renders %s as "%s"', (role, label) => {
    render(<UserBadge profile={profileWith(role)} onSignOut={vi.fn()} />)
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('never calls a buyer a farmer', () => {
    // The exact misrepresentation this replaces.
    render(<UserBadge profile={profileWith('buyer')} onSignOut={vi.fn()} />)
    expect(screen.queryByText('Farmer')).toBeNull()
  })

  it('gives each role its own chip style, not a shared one', () => {
    const { container } = render(<UserBadge profile={profileWith('buyer')} onSignOut={vi.fn()} />)
    const chip = container.querySelector('.user-role-chip')
    expect(chip?.className).toContain('chip-buyer')
    expect(chip?.className).not.toContain('chip-farmer')
  })

  it('still shows the account name alongside the role', () => {
    render(<UserBadge profile={profileWith('buyer')} onSignOut={vi.fn()} />)
    expect(screen.getByText('Somchai')).toBeTruthy()
  })
})

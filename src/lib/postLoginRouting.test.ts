import { describe, it, expect } from 'vitest'
import {
  resolvePostLoginDecision,
  resolveBootstrap,
  nextBootstrapRouting,
  resolveAuthResolutionAction,
} from './postLoginRouting'
import type { UserProfile } from '../services/auth'
import type { Page } from '../types'

const PUBLIC_PAGES: Page[] = ['landing', 'login']

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

  it('denies a pending account (self-registered, not yet DDP-provisioned)', () => {
    expect(resolvePostLoginDecision({ ...baseProfile, role: 'pending' })).toEqual({
      kind: 'denied',
      reason: 'pending-approval',
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

// ─── Auth bootstrap on (re)load — the session-restoration routing fix ─────────
//
// A page reload resets in-memory page state to the public landing while the
// Supabase session is restored asynchronously. resolveBootstrap maps the restored
// profile to the SAME role destination a fresh login uses, so a signed-in operator
// who hard-refreshes is not stranded on the public landing.
describe('resolveBootstrap (restored-session routing)', () => {
  it('no session (null profile) → unauthenticated, no route (stays on the public page)', () => {
    // Test 1 + 6 + 7: no session, and a failed/absent profile, resolve to
    // unauthenticated — never to a dashboard.
    expect(resolveBootstrap(null)).toEqual({ state: 'unauthenticated' })
  })

  it('restored admin session → routed to the admin overview', () => {
    expect(resolveBootstrap({ ...baseProfile, role: 'ddp_admin' })).toEqual({
      state: 'authenticated',
      page: 'ddp-overview',
    })
  })

  it('restored farmer session → routed to the farmer dashboard', () => {
    expect(resolveBootstrap({ ...baseProfile, role: 'farmer' })).toEqual({
      state: 'authenticated',
      page: 'farmer-dashboard',
    })
  })

  it('restored session with an unresolved role → fail closed (no dashboard)', () => {
    // 'pending' is not a routable operator role in this repo; like any unknown
    // role it must not be dropped into admin or farmer UI.
    const pending = { ...baseProfile, role: 'pending' as unknown as UserProfile['role'] }
    expect(resolveBootstrap(pending)).toEqual({ state: 'authenticated-unresolved' })
  })

  it('an authenticated bootstrap never resolves to a public page (no landing flash)', () => {
    // Test 5: a valid restored role always routes INTO the app, never back to a
    // public page — so the resolved state can never render the landing.
    for (const role of ['ddp_admin', 'farmer'] as const) {
      const boot = resolveBootstrap({ ...baseProfile, role })
      expect(boot.state).toBe('authenticated')
      if (boot.state === 'authenticated') {
        expect(PUBLIC_PAGES).not.toContain(boot.page)
      }
    }
  })
})

describe('nextBootstrapRouting (route-once gate)', () => {
  it('routes a restored admin on the first resolution', () => {
    expect(nextBootstrapRouting(false, { ...baseProfile, role: 'ddp_admin' }))
      .toEqual({ routed: true, routeTo: 'ddp-overview' })
  })

  it('routes a restored farmer on the first resolution', () => {
    expect(nextBootstrapRouting(false, { ...baseProfile, role: 'farmer' }))
      .toEqual({ routed: true, routeTo: 'farmer-dashboard' })
  })

  it('does not route when there is no session (first resolution, null profile)', () => {
    // Test 6: routing waits for a resolved profile; a null profile never routes.
    expect(nextBootstrapRouting(false, null)).toEqual({ routed: true, routeTo: null })
  })

  it('does not route an unresolved role (fail closed)', () => {
    const pending = { ...baseProfile, role: 'pending' as unknown as UserProfile['role'] }
    expect(nextBootstrapRouting(false, pending)).toEqual({ routed: true, routeTo: null })
  })

  it('a second/duplicate auth event does not re-route (route stability)', () => {
    // Tests 9 + 10: once bootstrap has routed, later events (token refresh,
    // StrictMode duplicate init) must NOT navigate again — even for a valid role.
    expect(nextBootstrapRouting(true, { ...baseProfile, role: 'ddp_admin' }))
      .toEqual({ routed: true, routeTo: null })
    expect(nextBootstrapRouting(true, { ...baseProfile, role: 'farmer' }))
      .toEqual({ routed: true, routeTo: null })
    expect(nextBootstrapRouting(true, null)).toEqual({ routed: true, routeTo: null })
  })

  it('marks bootstrap as routed even when it did not navigate (so it runs once)', () => {
    // A null-profile first resolution still consumes the one-shot, so a later
    // token-refresh event cannot trigger a late bootstrap route.
    const first = nextBootstrapRouting(false, null)
    expect(first.routed).toBe(true)
    expect(nextBootstrapRouting(first.routed, { ...baseProfile, role: 'ddp_admin' }))
      .toEqual({ routed: true, routeTo: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveAuthResolutionAction — the whole auth-subscription response, including
// the suppression that makes supplier onboarding completable.
//
// THE DEFECT THIS ENCODES
//   An invite / password-recovery link grants a REAL session. Bootstrap routing
//   therefore resolved the invited supplier's role and sent them to the farmer
//   dashboard — past the only screen in the app that can give their account a
//   password. They looked signed in, worked normally, and were locked out
//   permanently the moment the transient session expired. For an account still
//   at role 'pending' it was worse: the revoke branch signed them out mid-flow,
//   destroying the session auth.updateUser needs.
describe('resolveAuthResolutionAction', () => {
  const FARMER = { ...baseProfile, role: 'farmer' as const }
  const ADMIN = { ...baseProfile, role: 'ddp_admin' as const }
  const PENDING = { ...baseProfile, role: 'pending' as const }

  describe('while the set-password flow is pending', () => {
    it('does NOT route an invited farmer to their dashboard', () => {
      // The core regression. Without the suppression this returns
      // { kind: 'route', page: 'farmer-dashboard' } and the supplier never sees
      // the set-password screen.
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: FARMER, passwordSetupPending: true }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
    })

    it('does NOT route an invited admin either', () => {
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: ADMIN, passwordSetupPending: true }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
    })

    it('does NOT revoke a pending account mid-flow', () => {
      // Revoking here destroys the session the password update runs on, so the
      // user is bounced to a dead end with their account still password-less.
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: PENDING, passwordSetupPending: true }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
    })

    it('consumes the one-shot, so a late auth event cannot route afterwards', () => {
      const first = resolveAuthResolutionAction({
        alreadyRouted: false, profile: FARMER, passwordSetupPending: true,
      })
      expect(first.routed).toBe(true)
      // Flow finished: the redirect is cleared, the app has routed by role. A
      // token refresh arriving now must not navigate again.
      expect(
        resolveAuthResolutionAction({ alreadyRouted: first.routed, profile: ADMIN, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
    })
  })

  describe('ordinary resolutions are unchanged', () => {
    it('routes a restored farmer', () => {
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: FARMER, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'route', page: 'farmer-dashboard' } })
    })

    it('routes a restored admin', () => {
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: ADMIN, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'route', page: 'ddp-overview' } })
    })

    it('revokes a restored pending session (fail closed)', () => {
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: PENDING, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'revoke-session' } })
    })

    it('does nothing when there is no session', () => {
      expect(
        resolveAuthResolutionAction({ alreadyRouted: false, profile: null, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
    })

    it('never revokes a working session on a later event', () => {
      // A token refresh for an already-resolved operator re-fires the
      // subscription with alreadyRouted true.
      expect(
        resolveAuthResolutionAction({ alreadyRouted: true, profile: PENDING, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
      expect(
        resolveAuthResolutionAction({ alreadyRouted: true, profile: ADMIN, passwordSetupPending: false }),
      ).toEqual({ routed: true, action: { kind: 'none' } })
    })
  })
})

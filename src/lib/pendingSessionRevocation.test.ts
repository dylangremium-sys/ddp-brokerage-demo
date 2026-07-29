import { describe, expect, it } from 'vitest'
import { resolvePostLoginDecision, resolveBootstrap, nextBootstrapRouting } from './postLoginRouting'
import type { UserProfile } from '../services/auth'

/**
 * F10 — a restored 'pending' session must be revoked, not merely un-routed.
 *
 * A fresh login by a pending account is denied AND its session revoked
 * (handleLoginSuccess's fail-closed branch). Before this fix, a page RELOAD of
 * that same account restored the session intact: bootstrap correctly declined
 * to route, but the session survived and isSignedIn became true. Nothing was
 * reachable through it (no nav renders, DDP pages fail closed, RLS denies the
 * reads) — this is defence in depth, closing an asymmetry between two entry
 * paths that disagreed about the same condition.
 *
 * This repo's vitest environment is 'node' and the include glob covers only
 * `src/**‍/*.test.ts` — there is no jsdom and .tsx is never rendered under
 * test. The App wiring is therefore asserted against source text via
 * `import.meta.glob(..., '?raw')`, the existing convention here (see
 * operationsDeskRouting.test.ts). The routing policy itself is exercised
 * behaviourally against the real exported functions below.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

/** The auth-subscription callback body — from the subscribe call to the effect's return. */
function subscriptionBlock(): string {
  const start = APP_SRC.indexOf('subscribeToAuthChanges((profile)')
  const end = APP_SRC.indexOf('return unsubscribe', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return APP_SRC.slice(start, end)
}

const UNRESOLVED_GUARD = "resolveBootstrap(profile).state === 'authenticated-unresolved'"

/** The fail-closed branch: from the unresolved-role guard to its closing brace. */
function revocationBranch(): string {
  const block = subscriptionBlock()
  const guardIdx = block.indexOf(UNRESOLVED_GUARD)
  expect(guardIdx).toBeGreaterThan(-1)
  const branch = block.slice(guardIdx)
  // The branch body ends at the first brace at the subscription's own indent.
  const close = branch.indexOf('\n      }')
  expect(close).toBeGreaterThan(-1)
  return branch.slice(0, close)
}

describe('pending session revocation — source fixture', () => {
  it('loads the App source under assertion', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
  })
})

describe('pending session revocation — bootstrap path revokes on authenticated-unresolved', () => {
  it('revokes the session inside the unresolved-role branch, not elsewhere in the subscription', () => {
    const branch = revocationBranch()
    expect(branch).toContain('void signOut()')
    // Fail closed in memory too, matching handleLoginSuccess.
    expect(branch).toContain('setCurrentProfile(null)')
    // The ONLY signOut in the whole subscription is the one inside this branch —
    // no unconditional revocation that could sign out a working session.
    const block = subscriptionBlock()
    expect((block.match(/signOut\(\)/g) ?? []).length).toBe(1)
  })

  it('revokes only when routing declined — the branch is the else of the route branch', () => {
    const block = subscriptionBlock()
    // The route branch (setPage) and the revocation branch are mutually
    // exclusive arms of one conditional: an account that routes never revokes.
    expect(block).toContain(`} else if (isFirstResolution && profile && ${UNRESOLVED_GUARD})`)
  })

  it('never revokes a session with no profile (unauthenticated stays a no-op)', () => {
    // The branch requires a truthy profile, so callback(null) — sign-out or a
    // missing profiles row — cannot recurse into another signOut.
    expect(subscriptionBlock()).toContain(`isFirstResolution && profile && ${UNRESOLVED_GUARD}`)
  })
})

describe('pending session revocation — token-refresh path is NOT revoked', () => {
  it('gates revocation on the first resolution, captured BEFORE the routing reducer marks it consumed', () => {
    const block = subscriptionBlock()
    const capture = block.indexOf('const isFirstResolution = !didBootstrapRoute.current')
    const reducer = block.indexOf('nextBootstrapRouting(didBootstrapRoute.current, profile)')
    const guard = block.indexOf(UNRESOLVED_GUARD)
    expect(capture).toBeGreaterThan(-1)
    // Captured before nextBootstrapRouting's result overwrites the ref, and the
    // guard sits after both — so a TOKEN_REFRESHED re-fire for an
    // already-resolved user (ref already true) can never reach signOut.
    expect(capture).toBeLessThan(reducer)
    expect(guard).toBeGreaterThan(reducer)
    expect(block).toContain('isFirstResolution &&')
  })
})

describe('pending session revocation — didBootstrapRoute once-only guard intact', () => {
  it('the ref is still initialised false and assigned exactly once, from the reducer', () => {
    expect(APP_SRC).toContain('const didBootstrapRoute = useRef(false)')
    const block = subscriptionBlock()
    // Exactly one write, and it is the reducer's result — the revocation branch
    // reads the captured boolean, never writes or clears the ref, so a restored
    // session is still routed at most once and later auth events cannot yank
    // the operator off a page they navigated to.
    const writes = block.match(/didBootstrapRoute\.current\s*=/g) ?? []
    expect(writes.length).toBe(1)
    expect(block).toContain('didBootstrapRoute.current = routing.routed')
    expect(revocationBranch()).not.toContain('didBootstrapRoute.current =')
  })
})

describe('pending session revocation — routing policy (behavioural)', () => {
  const pending = { role: 'pending' } as UserProfile
  const admin = { role: 'ddp_admin' } as UserProfile
  const farmer = { role: 'farmer' } as UserProfile

  it('resolves a pending profile to authenticated-unresolved — the condition the revocation is scoped to', () => {
    expect(resolveBootstrap(pending)).toEqual({ state: 'authenticated-unresolved' })
  })

  it('resolves an unknown role to authenticated-unresolved (fail closed beyond pending)', () => {
    expect(resolveBootstrap({ role: 'auditor' } as unknown as UserProfile))
      .toEqual({ state: 'authenticated-unresolved' })
  })

  it('resolves no profile to unauthenticated — never the revocation condition', () => {
    expect(resolveBootstrap(null)).toEqual({ state: 'unauthenticated' })
  })

  it('still resolves operator roles to their pages (revocation cannot apply to them)', () => {
    expect(resolveBootstrap(admin)).toEqual({ state: 'authenticated', page: 'ddp-overview' })
    expect(resolveBootstrap(farmer)).toEqual({ state: 'authenticated', page: 'farmer-dashboard' })
  })

  it('nextBootstrapRouting never routes a pending profile, first resolution or later', () => {
    expect(nextBootstrapRouting(false, pending)).toEqual({ routed: true, routeTo: null })
    expect(nextBootstrapRouting(true, pending)).toEqual({ routed: true, routeTo: null })
  })

  it('nextBootstrapRouting keeps the once-only property for resolved roles', () => {
    // First resolution routes; any later event returns null so the page the
    // operator navigated to is never overwritten.
    expect(nextBootstrapRouting(false, admin)).toEqual({ routed: true, routeTo: 'ddp-overview' })
    expect(nextBootstrapRouting(true, admin)).toEqual({ routed: true, routeTo: null })
  })

  it('the fresh-login policy still denies pending with its own reason (asymmetry closed, policy unchanged)', () => {
    expect(resolvePostLoginDecision(pending)).toEqual({ kind: 'denied', reason: 'pending-approval' })
  })
})

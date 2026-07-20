import type { Page } from '../types'
import type { UserProfile } from '../services/auth'

/**
 * Where a just-authenticated user should be routed, resolved purely from their
 * profile role. Kept as a standalone, side-effect-free function so the routing
 * policy can be unit-tested without React or Supabase.
 *
 * Fails closed: any session whose profile is missing or whose role is not a
 * known operator role is denied, so an authenticated-but-roleless user can never
 * be dropped into a farmer or admin dashboard.
 *
 * A 'pending' account (a self-registered or admin-invited user not yet
 * provisioned by DDP) is denied with a distinct reason, so a user who signs up
 * directly against Supabase can never reach an operator dashboard until a
 * ddp_admin provisions them.
 */
export type PostLoginDecision =
  | { kind: 'route'; page: Page }
  | { kind: 'denied'; reason: 'unresolved-role' | 'pending-approval' }

export function resolvePostLoginDecision(profile: UserProfile | null): PostLoginDecision {
  switch (profile?.role) {
    case 'ddp_admin':
      return { kind: 'route', page: 'ddp-overview' }
    case 'farmer':
      return { kind: 'route', page: 'farmer-dashboard' }
    case 'pending':
      return { kind: 'denied', reason: 'pending-approval' }
    default:
      return { kind: 'denied', reason: 'unresolved-role' }
  }
}

/**
 * Outcome of the one-time auth bootstrap that runs when the app (re)loads.
 *
 * A page reload resets the in-memory page state to the public landing, but the
 * Supabase session is restored asynchronously (onAuthStateChange's INITIAL_SESSION).
 * Without this, a signed-in operator who refreshes is left on the public landing
 * even though their session is valid. Bootstrap resolves the restored session to
 * the SAME role destination a fresh login would use.
 *
 *   authenticated            → route to the role's page (admin/farmer)
 *   authenticated-unresolved → signed in but no known operator role: kept OUT of
 *                              every dashboard (fail closed), left on the public page
 *   unauthenticated          → no session: stay on the public page
 */
export type AuthBootstrap =
  | { state: 'authenticated'; page: Page }
  | { state: 'authenticated-unresolved' }
  | { state: 'unauthenticated' }

export function resolveBootstrap(profile: UserProfile | null): AuthBootstrap {
  if (!profile) return { state: 'unauthenticated' }
  const decision = resolvePostLoginDecision(profile)
  return decision.kind === 'route'
    ? { state: 'authenticated', page: decision.page }
    : { state: 'authenticated-unresolved' }
}

/**
 * The route-once gate for auth bootstrap. The auth subscription fires on every
 * auth event (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT); bootstrap
 * routing must happen ONLY on the first resolution, so a later event (e.g. a token
 * refresh while the operator is deliberately viewing the public landing, or a
 * StrictMode/duplicate init) can never overwrite the page they navigated to.
 *
 * Pure reducer: given whether bootstrap already routed and the resolved profile,
 * returns the new routed flag and the page to navigate to (or null to leave the
 * page unchanged). A null profile never routes; an unresolved role never routes.
 */
export function nextBootstrapRouting(
  alreadyRouted: boolean,
  profile: UserProfile | null,
): { routed: boolean; routeTo: Page | null } {
  if (alreadyRouted) return { routed: true, routeTo: null }
  const boot = resolveBootstrap(profile)
  return { routed: true, routeTo: boot.state === 'authenticated' ? boot.page : null }
}

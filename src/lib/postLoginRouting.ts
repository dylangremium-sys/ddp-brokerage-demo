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
    case 'buyer':
      return { kind: 'route', page: 'buyer-dashboard' }
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

/**
 * Everything the auth subscription does in response to one resolution, as a
 * single pure decision.
 *
 *   route          → navigate to this page
 *   revoke-session → sign out: authenticated but with no operator role
 *   none           → leave the app exactly where it is
 *
 * WHY THIS SUBSUMES THE TWO OLDER BRANCHES
 *   The set-password flow needs BOTH of them suppressed, and expressing that as
 *   an early return inside a React effect put the most consequential rule in the
 *   app somewhere no test could reach it. The rule is:
 *
 *     An invite or recovery session is a real session. Left to itself,
 *     bootstrap routing resolves the invited supplier's role and lands them on
 *     the farmer dashboard — past the only screen that can give their account a
 *     password. They appear signed in, work normally, and are locked out
 *     permanently once the transient session expires. And for an account still
 *     sitting at role 'pending', the revocation branch would sign them out
 *     mid-flow, destroying the very session auth.updateUser needs.
 *
 *   Suppressing both is safe: the user is held on a public auth screen, and
 *   every operator surface stays gated by its own role checks and by RLS.
 *
 * `routed` is returned true even when suppressed, so that once the password is
 * set and the flow ends, a late auth event (e.g. a token refresh arriving after
 * the app has already routed by role) cannot yank the user somewhere else.
 */
export type AuthResolutionAction =
  | { kind: 'route'; page: Page }
  | { kind: 'revoke-session' }
  | { kind: 'none' }

export interface AuthResolutionInput {
  /** Whether bootstrap routing has already run for this page load. */
  alreadyRouted: boolean
  profile: UserProfile | null
  /** True while the user is in the invite / recovery set-password flow. */
  passwordSetupPending: boolean
}

export function resolveAuthResolutionAction(
  input: AuthResolutionInput,
): { routed: boolean; action: AuthResolutionAction } {
  if (input.passwordSetupPending) return { routed: true, action: { kind: 'none' } }

  const routing = nextBootstrapRouting(input.alreadyRouted, input.profile)
  if (routing.routeTo) return { routed: routing.routed, action: { kind: 'route', page: routing.routeTo } }

  // Only on the FIRST resolution, and only for a session that really is
  // authenticated-but-roleless. A token refresh for an already-resolved
  // operator must never be able to revoke a working session.
  const isFirstResolution = !input.alreadyRouted
  const unresolved =
    Boolean(input.profile) && resolveBootstrap(input.profile).state === 'authenticated-unresolved'
  if (isFirstResolution && unresolved) return { routed: routing.routed, action: { kind: 'revoke-session' } }

  return { routed: routing.routed, action: { kind: 'none' } }
}

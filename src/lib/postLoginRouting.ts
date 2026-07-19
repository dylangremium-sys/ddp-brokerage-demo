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
 */
export type PostLoginDecision =
  | { kind: 'route'; page: Page }
  | { kind: 'denied'; reason: 'unresolved-role' }

export function resolvePostLoginDecision(profile: UserProfile | null): PostLoginDecision {
  switch (profile?.role) {
    case 'ddp_admin':
      return { kind: 'route', page: 'ddp-overview' }
    case 'farmer':
      return { kind: 'route', page: 'farmer-dashboard' }
    default:
      return { kind: 'denied', reason: 'unresolved-role' }
  }
}

/**
 * Where the public landing page's "Secure Login" control leads.
 *
 * In demo mode there is no Supabase client at all, so signIn/signUpFarmer both
 * throw 'Supabase not configured' and the sign-in form can never succeed. The
 * demo admin shell is already authorised in that mode — App derives
 * `isSignedIn` and `isAdminRole` as unconditionally true when Supabase is
 * absent — but since PR #17 replaced the landing page's entry handlers with a
 * single login route, nothing could reach it. This restores that entry.
 *
 * This is NOT an authentication bypass. It changes only which public page the
 * control opens, and only when no backend is configured: demo mode has no
 * account, no session and no server data, and every read is local fixture
 * data. Whenever Supabase IS configured this returns 'login' and the real
 * sign-in flow is untouched. `goTo` additionally refuses to route an
 * unauthenticated user to a non-public page in configured mode, so this
 * function cannot open the admin shell there even if it were called with the
 * wrong argument.
 *
 * `isDemo` must come from the application's single definition of demo mode
 * (`!isSupabaseConfigured`) — never from a URL parameter, browser storage,
 * user input, or any other client-controlled value.
 */
export function resolveSecureLoginDestination(isDemo: boolean): Page {
  return isDemo ? 'ddp-overview' : 'login'
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

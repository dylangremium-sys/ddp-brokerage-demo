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

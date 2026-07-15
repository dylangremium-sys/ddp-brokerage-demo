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

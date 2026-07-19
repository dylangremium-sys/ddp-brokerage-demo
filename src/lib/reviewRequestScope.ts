import type { ReviewRequest } from '../types'

/**
 * Cross-role isolation for the shared, App-level `reviewRequests` state.
 *
 * That state is a single array consumed by BOTH the admin Operations Desk (which
 * loads every admin-visible request) and the farmer pages (which must see only
 * their own). Without scoping, a farmer signing into the same SPA session after
 * an admin could inherit the admin-wide list. These pure helpers make the active
 * data scope explicit and fail closed, so they can be unit-tested without a DOM.
 */

export interface ReviewRequestScope {
  farmIds: Set<string>
  itemIds: Set<string>
}

/**
 * Identity+role key for the currently authenticated session. Review-request
 * state loaded under one key must never be shown under another — a change in
 * either the user id or the role invalidates it. Returns null when signed out.
 */
export function reviewRequestScopeKey(
  profile: { id: string; role: string } | null | undefined,
): string | null {
  return profile ? `${profile.id}::${profile.role}` : null
}

/**
 * True when the authenticated scope changed and any review-request state loaded
 * for the previous scope must be dropped. False for a repeat event carrying the
 * same key (e.g. a token refresh for the same user+role), so routine auth
 * churn does not trigger needless clears or refetch loops.
 */
export function reviewRequestScopeChanged(prevKey: string | null, nextKey: string | null): boolean {
  return prevKey !== nextKey
}

/**
 * Fail-closed farmer view of the shared review-request state. Returns only the
 * requests inside the farmer's own scope — matched by their inventory batch
 * (stockItemId) or their farm (farmProfileId). Returns [] while the scope is
 * still unknown (null), so admin-wide state can never reach a farmer page
 * before, during, or after the farmer's own scope loads. This is a projection,
 * not a timing guarantee: it holds regardless of what the shared array contains.
 */
export function scopeReviewRequestsToFarmer(
  requests: ReviewRequest[],
  scope: ReviewRequestScope | null,
): ReviewRequest[] {
  if (scope === null) return []
  return requests.filter(
    r =>
      (r.stockItemId != null && scope.itemIds.has(r.stockItemId)) ||
      (r.farmProfileId != null && scope.farmIds.has(r.farmProfileId)),
  )
}

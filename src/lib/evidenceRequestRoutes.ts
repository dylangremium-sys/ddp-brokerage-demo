/**
 * Evidence-request route payload contract.
 *
 * Contract of record: v1.5 §10.1. The existing application route mechanism
 * remains authoritative and NO routing library is introduced (§19.27). The app
 * routes on a `Page` string union held in `App.tsx`; this module supplies the
 * typed payload that travels alongside it, the same way `reviewFarmId` and
 * `reviewItemId` already carry entity context for Farm Review and Inventory
 * Review.
 *
 * The five canonical logical page IDs of §10.1 are:
 *   'admin-evidence-requests'        — new, defined here
 *   'admin-evidence-request-create'  — new, defined here
 *   'admin-evidence-request-detail'  — new, defined here
 *   'farmer-requests'                — PRE-EXISTING app page, not redefined here
 *   'farmer-evidence-request-detail' — new, defined here
 *
 * A route constructor returns a discriminated result rather than throwing, so a
 * malformed navigation is a visible non-success state and never a silent
 * navigation to a detail page with an empty ID.
 */

import type { EvidenceRequestTargetType, EvidenceServiceResult } from '../domain/evidenceRequests'

export const EVIDENCE_REQUEST_PAGE_IDS = [
  'admin-evidence-requests',
  'admin-evidence-request-create',
  'admin-evidence-request-detail',
  'farmer-evidence-request-detail',
] as const

export type EvidenceRequestPageId = (typeof EVIDENCE_REQUEST_PAGE_IDS)[number]

export type AdminEvidenceRequestsRoute = {
  page: 'admin-evidence-requests'
}

export type AdminEvidenceRequestCreateRoute = {
  page: 'admin-evidence-request-create'
  targetType?: EvidenceRequestTargetType
  targetId?: string
}

export type AdminEvidenceRequestDetailRoute = {
  page: 'admin-evidence-request-detail'
  requestId: string
}

export type FarmerEvidenceRequestDetailRoute = {
  page: 'farmer-evidence-request-detail'
  requestId: string
}

export type EvidenceRequestRoute =
  | AdminEvidenceRequestsRoute
  | AdminEvidenceRequestCreateRoute
  | AdminEvidenceRequestDetailRoute
  | FarmerEvidenceRequestDetailRoute

function validationError(message: string, field: string): EvidenceServiceResult<never> {
  return { ok: false, error: { code: 'VALIDATION_ERROR', message, field, retryable: false } }
}

export function adminEvidenceRequestsRoute(): AdminEvidenceRequestsRoute {
  return { page: 'admin-evidence-requests' }
}

/**
 * Contract §10.3/§10.7/§10.8. Either BOTH target fields are supplied (Farm
 * Review and Inventory Review preselect one) or NEITHER is (the create page is
 * opened blank from the administrator list). A half-specified target is a
 * programming error and is refused rather than silently dropped.
 */
export function adminEvidenceRequestCreateRoute(
  targetType?: EvidenceRequestTargetType,
  targetId?: string,
): EvidenceServiceResult<AdminEvidenceRequestCreateRoute> {
  const normalizedTargetId = targetId?.trim() ?? ''
  if ((targetType && !normalizedTargetId) || (!targetType && normalizedTargetId)) {
    return validationError(
      'Target type and target ID must be supplied together.',
      targetType ? 'targetId' : 'targetType',
    )
  }

  return {
    ok: true,
    data: {
      page: 'admin-evidence-request-create',
      ...(targetType && normalizedTargetId
        ? { targetType, targetId: normalizedTargetId }
        : {}),
    },
  }
}

export function adminEvidenceRequestDetailRoute(
  requestId: string,
): EvidenceServiceResult<AdminEvidenceRequestDetailRoute> {
  const normalizedRequestId = requestId.trim()
  if (!normalizedRequestId) return validationError('Request ID is required.', 'requestId')
  return { ok: true, data: { page: 'admin-evidence-request-detail', requestId: normalizedRequestId } }
}

export function farmerEvidenceRequestDetailRoute(
  requestId: string,
): EvidenceServiceResult<FarmerEvidenceRequestDetailRoute> {
  const normalizedRequestId = requestId.trim()
  if (!normalizedRequestId) return validationError('Request ID is required.', 'requestId')
  return { ok: true, data: { page: 'farmer-evidence-request-detail', requestId: normalizedRequestId } }
}

/**
 * Contract §9.7. Every load is scoped by
 * `authenticated_user_id + role + route + request_id/filter`. When this key
 * changes, protected data must be CLEARED before the new load — not merged, not
 * left rendered while refetching. A late response whose key no longer matches
 * the active key is discarded.
 *
 * `userId` is deliberately part of the key so that an account switch, a role
 * change and a sign-out each produce a different scope. A null user yields a
 * key that can never match a signed-in load's key.
 */
export function evidenceLoadScopeKey(input: {
  userId: string | null
  role: string | null
  route: EvidenceRequestRoute | { page: 'farmer-requests' }
  filterKey?: string
}): string {
  const { userId, role, route, filterKey } = input
  const requestId = 'requestId' in route ? route.requestId : ''
  const targetType = 'targetType' in route ? (route.targetType ?? '') : ''
  const targetId = 'targetId' in route ? (route.targetId ?? '') : ''
  return [
    userId ?? '<anonymous>',
    role ?? '<no-role>',
    route.page,
    requestId,
    targetType,
    targetId,
    filterKey ?? '',
  ].join('|')
}

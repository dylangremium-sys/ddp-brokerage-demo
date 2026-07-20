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

export function adminEvidenceRequestCreateRoute(
  targetType?: EvidenceRequestTargetType,
  targetId?: string,
): EvidenceServiceResult<AdminEvidenceRequestCreateRoute> {
  if ((targetType && !targetId) || (!targetType && targetId)) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Target type and target ID must be supplied together.',
        field: targetType ? 'targetId' : 'targetType',
        retryable: false,
      },
    }
  }

  return {
    ok: true,
    data: {
      page: 'admin-evidence-request-create',
      ...(targetType && targetId ? { targetType, targetId } : {}),
    },
  }
}

export function adminEvidenceRequestDetailRoute(
  requestId: string,
): EvidenceServiceResult<AdminEvidenceRequestDetailRoute> {
  const normalizedRequestId = requestId.trim()
  if (!normalizedRequestId) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request ID is required.',
        field: 'requestId',
        retryable: false,
      },
    }
  }

  return {
    ok: true,
    data: {
      page: 'admin-evidence-request-detail',
      requestId: normalizedRequestId,
    },
  }
}

export function farmerEvidenceRequestDetailRoute(
  requestId: string,
): EvidenceServiceResult<FarmerEvidenceRequestDetailRoute> {
  const normalizedRequestId = requestId.trim()
  if (!normalizedRequestId) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request ID is required.',
        field: 'requestId',
        retryable: false,
      },
    }
  }

  return {
    ok: true,
    data: {
      page: 'farmer-evidence-request-detail',
      requestId: normalizedRequestId,
    },
  }
}

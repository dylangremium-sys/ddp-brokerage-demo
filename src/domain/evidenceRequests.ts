export const EVIDENCE_REQUEST_STATUSES = [
  'open',
  'farmer_submitted',
  'clarification_requested',
  'resolved',
  'rejected',
  'cancelled',
] as const

export type EvidenceRequestStatus = (typeof EVIDENCE_REQUEST_STATUSES)[number]

export const EVIDENCE_REQUEST_PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const

export type EvidenceRequestPriority = (typeof EVIDENCE_REQUEST_PRIORITIES)[number]

export const EVIDENCE_REQUEST_TARGET_TYPES = [
  'farm_profile',
  'inventory_batch',
] as const

export type EvidenceRequestTargetType = (typeof EVIDENCE_REQUEST_TARGET_TYPES)[number]

export const EVIDENCE_REQUEST_CATEGORIES = [
  'farm_identity',
  'farm_license',
  'gacp_evidence',
  'gmp_evidence',
  'export_supporting_document',
  'responsible_contact',
  'coa',
  'batch_identity',
  'inventory_quantity_evidence',
  'inventory_photo',
  'inventory_video',
  'storage_evidence',
  'chain_of_custody',
  'other',
] as const

export type EvidenceRequestCategory = (typeof EVIDENCE_REQUEST_CATEGORIES)[number]

export const EVIDENCE_RESPONSE_STATES = ['draft', 'submitted'] as const
export type EvidenceResponseState = (typeof EVIDENCE_RESPONSE_STATES)[number]

export const EVIDENCE_ATTACHMENT_ORIGINS = [
  'request_upload',
  'existing_farm_document',
  'existing_inventory_document',
] as const

export type EvidenceAttachmentOrigin = (typeof EVIDENCE_ATTACHMENT_ORIGINS)[number]

export type EvidenceRequestActorRole = 'ddp_admin' | 'farmer'

export const EVIDENCE_REQUEST_TERMINAL_STATUSES = [
  'resolved',
  'rejected',
  'cancelled',
] as const satisfies readonly EvidenceRequestStatus[]

export const EVIDENCE_REQUEST_ACTIVE_STATUSES = [
  'open',
  'farmer_submitted',
  'clarification_requested',
] as const satisfies readonly EvidenceRequestStatus[]

export const EVIDENCE_REQUEST_STATUS_LABELS: Record<EvidenceRequestStatus, string> = {
  open: 'Awaiting farmer response',
  farmer_submitted: 'Submitted for review',
  clarification_requested: 'Clarification requested',
  resolved: 'Reviewed and resolved',
  rejected: 'Evidence rejected',
  cancelled: 'Cancelled',
}

export const EVIDENCE_REQUEST_CATEGORY_LABELS: Record<EvidenceRequestCategory, string> = {
  farm_identity: 'Farm identity',
  farm_license: 'Farm licence',
  gacp_evidence: 'GACP evidence',
  gmp_evidence: 'GMP evidence',
  export_supporting_document: 'Export supporting document',
  responsible_contact: 'Responsible contact',
  coa: 'COA',
  batch_identity: 'Batch identity',
  inventory_quantity_evidence: 'Inventory quantity evidence',
  inventory_photo: 'Inventory photo',
  inventory_video: 'Inventory video',
  storage_evidence: 'Storage evidence',
  chain_of_custody: 'Chain of custody',
  other: 'Other evidence',
}

const FARM_PROFILE_CATEGORIES = new Set<EvidenceRequestCategory>([
  'farm_identity',
  'farm_license',
  'gacp_evidence',
  'gmp_evidence',
  'export_supporting_document',
  'responsible_contact',
  'storage_evidence',
  'chain_of_custody',
  'other',
])

const INVENTORY_BATCH_CATEGORIES = new Set<EvidenceRequestCategory>([
  'export_supporting_document',
  'coa',
  'batch_identity',
  'inventory_quantity_evidence',
  'inventory_photo',
  'inventory_video',
  'storage_evidence',
  'chain_of_custody',
  'other',
])

export interface EvidenceRequestTargetByType {
  farm_profile: { type: 'farm_profile'; farmProfileId: string }
  inventory_batch: { type: 'inventory_batch'; inventoryBatchId: string }
}

export type EvidenceRequestTarget = EvidenceRequestTargetByType[EvidenceRequestTargetType]

export interface EvidenceRequest {
  id: string
  farmId: string
  target: EvidenceRequestTarget
  category: EvidenceRequestCategory
  title: string
  explanation: string
  priority: EvidenceRequestPriority
  dueDate: string | null
  status: EvidenceRequestStatus
  revision: number
  createdByUserId: string
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  closedAt: string | null
}

export interface EvidenceResponse {
  id: string
  requestId: string
  responseNumber: number
  state: EvidenceResponseState
  responseText: string | null
  supersedesResponseId: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
  submittedAt: string | null
}

export interface EvidenceAttachment {
  id: string
  requestId: string
  responseId: string
  origin: EvidenceAttachmentOrigin
  uploadState: 'pending_upload' | 'ready'
  originalFilename: string
  mimeType: string
  sizeBytes: number
  sha256Hex: string | null
  createdByUserId: string
  createdAt: string
  finalizedAt: string | null
}

export interface EvidenceRequestHistoryEvent {
  id: string
  requestId: string
  previousStatus: EvidenceRequestStatus | null
  nextStatus: EvidenceRequestStatus
  actorUserId: string
  actorRole: EvidenceRequestActorRole
  eventType:
    | 'request_created'
    | 'response_submitted'
    | 'clarification_requested'
    | 'request_resolved'
    | 'response_rejected'
    | 'request_cancelled'
    | 'attachment_uploaded'
    | 'existing_document_linked'
  responseId: string | null
  attachmentId: string | null
  note: string | null
  createdAt: string
}

export interface EvidenceRequestDetail {
  request: EvidenceRequest
  responses: EvidenceResponse[]
  attachments: EvidenceAttachment[]
  history: EvidenceRequestHistoryEvent[]
  targetLabel: string | null
  targetAvailable: boolean
}

export interface EvidenceRequestListItem extends EvidenceRequest {
  targetLabel: string | null
  targetAvailable: boolean
}

export type EvidenceServiceErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_TRANSITION'
  | 'CONFLICT'
  | 'TARGET_UNAVAILABLE'
  | 'UPLOAD_NOT_READY'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'STORAGE_ERROR'
  | 'DATA_UNAVAILABLE'
  | 'UNKNOWN'

export interface EvidenceServiceError {
  code: EvidenceServiceErrorCode
  message: string
  field?: string
  retryable: boolean
}

export type EvidenceServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: EvidenceServiceError }

export const EVIDENCE_TEXT_LIMITS = {
  title: { min: 3, max: 140 },
  explanation: { min: 20, max: 4_000 },
  responseText: { min: 1, max: 4_000 },
  clarificationReason: { min: 10, max: 2_000 },
  resolutionNote: { min: 10, max: 2_000 },
  rejectionReason: { min: 10, max: 2_000 },
  cancellationReason: { min: 10, max: 2_000 },
} as const

export function isEvidenceCategoryAllowedForTarget(
  category: EvidenceRequestCategory,
  targetType: EvidenceRequestTargetType,
): boolean {
  return targetType === 'farm_profile'
    ? FARM_PROFILE_CATEGORIES.has(category)
    : INVENTORY_BATCH_CATEGORIES.has(category)
}

export function categoriesForEvidenceTarget(
  targetType: EvidenceRequestTargetType,
): EvidenceRequestCategory[] {
  return EVIDENCE_REQUEST_CATEGORIES.filter(category =>
    isEvidenceCategoryAllowedForTarget(category, targetType),
  )
}

export function isTerminalEvidenceRequestStatus(status: EvidenceRequestStatus): boolean {
  return EVIDENCE_REQUEST_TERMINAL_STATUSES.includes(
    status as (typeof EVIDENCE_REQUEST_TERMINAL_STATUSES)[number],
  )
}

export function isActiveEvidenceRequestStatus(status: EvidenceRequestStatus): boolean {
  return EVIDENCE_REQUEST_ACTIVE_STATUSES.includes(
    status as (typeof EVIDENCE_REQUEST_ACTIVE_STATUSES)[number],
  )
}

export function isTrimmedLengthWithin(
  value: string,
  limits: { min: number; max: number },
): boolean {
  const length = value.trim().length
  return length >= limits.min && length <= limits.max
}

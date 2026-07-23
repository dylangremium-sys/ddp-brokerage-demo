/**
 * Canonical evidence-request domain contract.
 *
 * Contract of record: DDP EVIDENCE REQUEST & RESOLUTION WORKFLOW — BINDING
 * IMPLEMENTATION CONTRACT v1.5 (§3 terminology, §4 domain model, §5.3 text
 * limits, §9.1–§9.3 TypeScript contract).
 *
 * These constants MIRROR the database. The database is authoritative: every
 * value here also exists as a named CHECK constraint or a value helper in
 * `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql`. Client-side validation exists
 * for usability only and is never the authorization or integrity boundary
 * (contract §4.5, §8.5). Nothing in this file may invent a status, category,
 * priority or event type the migration does not already accept.
 *
 * SAFETY BOUNDARY (contract §2.3): the labels below report workflow and
 * evidence state only. No label asserts compliance, verification, approval,
 * certification or export readiness, and none may be edited to do so.
 */

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

/** Contract §4.2: the database column default is `normal`. */
export const DEFAULT_EVIDENCE_REQUEST_PRIORITY: EvidenceRequestPriority = 'normal'

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

/**
 * Contract §6.4: `upload_state` is meaningful only for `request_upload`. It is
 * NULL for both linked-document origins, which is why the union includes null.
 */
export type EvidenceAttachmentUploadState = 'pending_upload' | 'ready' | null

export type EvidenceRequestActorRole = 'ddp_admin' | 'farmer'

/**
 * Contract §6.5 canonical event types, plus `draft_ownership_transferred`
 * (§4.8 [v1.1]). Mirrors `evidence_history_event_type_check` exactly.
 */
export const EVIDENCE_HISTORY_EVENT_TYPES = [
  'request_created',
  'response_submitted',
  'clarification_requested',
  'request_resolved',
  'response_rejected',
  'request_cancelled',
  'attachment_uploaded',
  'existing_document_linked',
  'draft_ownership_transferred',
] as const

export type EvidenceHistoryEventType = (typeof EVIDENCE_HISTORY_EVENT_TYPES)[number]

/** Contract §4.7. Terminal requests are never reopened. */
export const EVIDENCE_REQUEST_TERMINAL_STATUSES = [
  'resolved',
  'rejected',
  'cancelled',
] as const satisfies readonly EvidenceRequestStatus[]

/** Contract §11.2. Exactly the statuses the Operations Desk may surface. */
export const EVIDENCE_REQUEST_ACTIVE_STATUSES = [
  'open',
  'farmer_submitted',
  'clarification_requested',
] as const satisfies readonly EvidenceRequestStatus[]

/** Contract §10.6. Statuses in which a farmer may edit a draft and submit. */
export const EVIDENCE_REQUEST_FARMER_ACTIONABLE_STATUSES = [
  'open',
  'clarification_requested',
] as const satisfies readonly EvidenceRequestStatus[]

/** Contract §3. These strings are the REQUIRED UI labels — not free copy. */
export const EVIDENCE_REQUEST_STATUS_LABELS: Record<EvidenceRequestStatus, string> = {
  open: 'Awaiting farmer response',
  farmer_submitted: 'Submitted for review',
  clarification_requested: 'Clarification requested',
  resolved: 'Reviewed and resolved',
  rejected: 'Evidence rejected',
  cancelled: 'Cancelled',
}

export const EVIDENCE_REQUEST_PRIORITY_LABELS: Record<EvidenceRequestPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export const EVIDENCE_RESPONSE_STATE_LABELS: Record<EvidenceResponseState, string> = {
  draft: 'Draft response',
  submitted: 'Submitted response',
}

export const EVIDENCE_REQUEST_TARGET_TYPE_LABELS: Record<EvidenceRequestTargetType, string> = {
  farm_profile: 'Farm profile',
  inventory_batch: 'Inventory batch',
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

/** Contract §11.4 / §10.2. The single approved wording for a lost target. */
export const TARGET_UNAVAILABLE_LABEL = 'Target unavailable — human review required'

/**
 * Contract §4.5 category-to-target matrix. Mirrors
 * `public.evidence_category_allows_target(category, target_type)`.
 */
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

/** Contract §9.2. */
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

/**
 * Contract §6.3. `createdByUserId` is immutable provenance; `draftOwnerUserId`
 * is the current edit authority while `state === 'draft'`, frozen at submission
 * (§4.8 [v1.1]).
 *
 * `draftOwnerUserId` is `string | null` because
 * `save_evidence_response_draft` omits the column from its returned projection.
 * A null therefore means "not reported by this call", never "no owner" — the
 * authoritative value always comes from a detail read. UI code must not infer
 * edit authority from a null.
 */
export interface EvidenceResponse {
  id: string
  requestId: string
  responseNumber: number
  state: EvidenceResponseState
  responseText: string | null
  supersedesResponseId: string | null
  createdByUserId: string
  draftOwnerUserId: string | null
  createdAt: string
  updatedAt: string
  submittedAt: string | null
}

/**
 * Contract §6.4, as amended by §6.9 [v1.5]:
 *
 * - `sizeBytes` is `number | null`. It is always present for `request_upload`
 *   and always absent for linked documents, because `farmer_documents` and
 *   `documents` carry no size column. The 150 MB aggregate counts uploaded
 *   bytes only.
 * - There is deliberately NO `draftOwnerUserId` here. §4.8 requires attachments
 *   to retain their original creator; edit authority is enforced through the
 *   parent RESPONSE's `draftOwnerUserId`.
 * - `removalRequestedAt` non-null marks a durable tombstone (§7.8 [v1.2]): the
 *   attachment is no longer active evidence, does not count toward the
 *   ten-attachment or 150 MB limits, and does not satisfy "response has
 *   evidence". It exists solely to authorise cleanup of a late-arriving object.
 */
export interface EvidenceAttachment {
  id: string
  requestId: string
  responseId: string
  origin: EvidenceAttachmentOrigin
  farmerDocumentId: string | null
  inventoryDocumentId: string | null
  storageBucket: string | null
  storageObjectPath: string | null
  uploadState: EvidenceAttachmentUploadState
  originalFilename: string
  mimeType: string
  sizeBytes: number | null
  sha256Hex: string | null
  createdByUserId: string
  createdAt: string
  finalizedAt: string | null
  removalRequestedAt: string | null
}

export interface EvidenceRequestHistoryEvent {
  id: string
  requestId: string
  previousStatus: EvidenceRequestStatus | null
  nextStatus: EvidenceRequestStatus
  actorUserId: string
  actorRole: EvidenceRequestActorRole
  eventType: EvidenceHistoryEventType
  responseId: string | null
  attachmentId: string | null
  note: string | null
  createdAt: string
}

/**
 * `targetAvailable === false` means the target record could not be resolved.
 * Contract §10.2/§11.4: the request STAYS VISIBLE and stays reviewable for
 * cancellation and history inspection. It is never filtered out.
 */
export interface EvidenceRequestListItem extends EvidenceRequest {
  targetLabel: string | null
  targetAvailable: boolean
}

export interface EvidenceRequestDetail {
  request: EvidenceRequest
  responses: EvidenceResponse[]
  attachments: EvidenceAttachment[]
  history: EvidenceRequestHistoryEvent[]
  targetLabel: string | null
  targetAvailable: boolean
}

/** The single draft a farmer is currently editing, with its attachments. */
export interface EvidenceResponseDraft {
  response: EvidenceResponse
  attachments: EvidenceAttachment[]
}

/** Contract §7.4 step 3: the reserved path the client must upload to. */
export interface EvidenceUploadReservation {
  attachment: EvidenceAttachment
  storageBucket: string
  storageObjectPath: string
}

/** Contract §9.3. */
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

/**
 * Contract §9.3/§9.6: a failed read is an error, NEVER an empty list. UI code
 * must not infer emptiness from a failure.
 */
export type EvidenceServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: EvidenceServiceError }

/** Contract §5.3. Whitespace-only values are invalid; lengths are trimmed. */
export const EVIDENCE_TEXT_LIMITS = {
  title: { min: 3, max: 140 },
  explanation: { min: 20, max: 4_000 },
  responseText: { min: 1, max: 4_000 },
  clarificationReason: { min: 10, max: 2_000 },
  resolutionNote: { min: 10, max: 2_000 },
  rejectionReason: { min: 10, max: 2_000 },
  cancellationReason: { min: 10, max: 2_000 },
} as const

/** Contract §6.4: maximum READY attachments per response. Tombstones excluded. */
export const EVIDENCE_MAX_READY_ATTACHMENTS_PER_RESPONSE = 10

/** Contract §6.4: maximum aggregate uploaded bytes per response (150 MB). */
export const EVIDENCE_MAX_AGGREGATE_UPLOAD_BYTES = 150 * 1024 * 1024

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
  return (EVIDENCE_REQUEST_TERMINAL_STATUSES as readonly EvidenceRequestStatus[]).includes(status)
}

export function isActiveEvidenceRequestStatus(status: EvidenceRequestStatus): boolean {
  return (EVIDENCE_REQUEST_ACTIVE_STATUSES as readonly EvidenceRequestStatus[]).includes(status)
}

/** Contract §10.6: the farmer may edit a draft only in these statuses. */
export function isFarmerActionableEvidenceRequestStatus(status: EvidenceRequestStatus): boolean {
  return (
    EVIDENCE_REQUEST_FARMER_ACTIONABLE_STATUSES as readonly EvidenceRequestStatus[]
  ).includes(status)
}

export function isTrimmedLengthWithin(
  value: string,
  limits: { min: number; max: number },
): boolean {
  const length = value.trim().length
  return length >= limits.min && length <= limits.max
}

/**
 * Contract §10.4. The administrator actions permitted in each status. Terminal
 * requests permit none. This mirrors §5.1 and is duplicated in the database:
 * a button rendered here is a convenience, never the authorization.
 */
export type AdminEvidenceAction = 'clarify' | 'resolve' | 'reject' | 'cancel'

export function adminActionsForEvidenceStatus(
  status: EvidenceRequestStatus,
): AdminEvidenceAction[] {
  switch (status) {
    case 'open':
    case 'clarification_requested':
      return ['cancel']
    case 'farmer_submitted':
      return ['clarify', 'resolve', 'reject', 'cancel']
    default:
      return []
  }
}

/**
 * Contract §3.2: overdue is a DERIVED UI condition only. It never changes
 * status, never triggers a reminder, and never applies to a terminal request.
 * `dueDate` is a calendar date (`YYYY-MM-DD`), compared date-wise, so a request
 * due today is not overdue until the day has passed.
 */
export function isEvidenceRequestOverdue(
  request: Pick<EvidenceRequest, 'dueDate' | 'status'>,
  now: Date,
): boolean {
  if (!request.dueDate) return false
  if (isTerminalEvidenceRequestStatus(request.status)) return false
  const due = Date.parse(`${request.dueDate}T00:00:00Z`)
  if (Number.isNaN(due)) return false
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return today > due
}

/**
 * Contract §6.4/§7.8: the attachments that count as this response's evidence.
 * A tombstoned request_upload is excluded even when its parent response is
 * submitted (§7.9(4)), and a pending upload is not yet evidence.
 */
export function isActiveEvidenceAttachment(attachment: EvidenceAttachment): boolean {
  if (attachment.removalRequestedAt !== null) return false
  if (attachment.origin !== 'request_upload') return true
  return attachment.uploadState === 'ready'
}

/**
 * Contract §10.6 submission requirements: response text OR at least one ready
 * attachment, and NO attachment still pending. Client-side only — the database
 * enforces the same rule in `submit_evidence_response`.
 */
export function canSubmitEvidenceResponse(draft: EvidenceResponseDraft): boolean {
  const live = draft.attachments.filter(a => a.removalRequestedAt === null)
  const hasPending = live.some(
    a => a.origin === 'request_upload' && a.uploadState === 'pending_upload',
  )
  if (hasPending) return false
  const hasText = (draft.response.responseText ?? '').trim().length > 0
  const hasEvidence = live.some(isActiveEvidenceAttachment)
  return hasText || hasEvidence
}

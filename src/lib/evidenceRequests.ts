/**
 * Evidence-request service adapter.
 *
 * Contract of record: v1.5 §9.4 (canonical service methods), §9.3 (discriminated
 * result), §9.6 (empty versus unavailable), §8.5 (browser prohibitions).
 *
 * DESIGN RULES, all load-bearing:
 *
 * 1. EVERY mutation goes through a `SECURITY DEFINER` RPC from migration 24.
 *    This module performs no INSERT, UPDATE or DELETE on a workflow table, and
 *    the database denies them anyway (§6.7, §8.2). Reads use plain SELECTs whose
 *    visibility is decided by RLS, never by filtering here (§8.5).
 * 2. NO service-role key. This module uses the shared anon client only (§8.5,
 *    §17.17).
 * 3. A failure is NEVER an empty list (§9.6, §17.14). Every read returns either
 *    `{ok: true, data}` or `{ok: false, error}`; there is no third path that
 *    yields `[]` on error.
 * 4. A missing TARGET row is not a failed load. A query that SUCCEEDS but finds
 *    no target yields `targetAvailable: false` and the request stays visible
 *    (§10.2, §11.4). A query that FAILS fails the whole read — it must not be
 *    mistaken for an absent target.
 * 5. Mutation results replace the current detail with a fresh authoritative read
 *    (§9.5). The transition RPCs return only the request row, so the detail is
 *    re-read rather than reconstructed client-side.
 */

import { supabase } from './supabase'
import type {
  EvidenceAttachment,
  EvidenceAttachmentOrigin,
  EvidenceAttachmentUploadState,
  EvidenceRequest,
  EvidenceRequestCategory,
  EvidenceRequestDetail,
  EvidenceRequestHistoryEvent,
  EvidenceRequestListItem,
  EvidenceRequestPriority,
  EvidenceRequestStatus,
  EvidenceRequestTargetType,
  EvidenceResponse,
  EvidenceResponseDraft,
  EvidenceServiceError,
  EvidenceServiceErrorCode,
  EvidenceServiceResult,
  EvidenceUploadReservation,
} from '../domain/evidenceRequests'
import { EVIDENCE_REQUEST_BUCKET } from './evidenceRequestStorage'

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * The RPCs raise the canonical §9.3 code as the exception MESSAGE (e.g.
 * `RAISE EXCEPTION 'CONFLICT'`), which PostgREST surfaces in `error.message`.
 * SQLSTATE is the fallback for constraint violations raised by triggers, which
 * carry a human-readable message instead of a code.
 */
const CANONICAL_CODES: readonly EvidenceServiceErrorCode[] = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'INVALID_TRANSITION',
  'CONFLICT',
  'TARGET_UNAVAILABLE',
  'UPLOAD_NOT_READY',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'STORAGE_ERROR',
  'DATA_UNAVAILABLE',
  'UNKNOWN',
]

const RETRYABLE: ReadonlySet<EvidenceServiceErrorCode> = new Set<EvidenceServiceErrorCode>([
  'CONFLICT',
  'STORAGE_ERROR',
  'DATA_UNAVAILABLE',
])

const MESSAGES: Record<EvidenceServiceErrorCode, string> = {
  UNAUTHENTICATED: 'You are not signed in. Sign in and try again.',
  FORBIDDEN: 'You are not authorised to perform this action.',
  NOT_FOUND: 'This request could not be found.',
  VALIDATION_ERROR: 'Some details are missing or invalid.',
  INVALID_TRANSITION: 'This action is not available for the current request status.',
  CONFLICT: 'This request changed since it was loaded. Reload and review it again.',
  TARGET_UNAVAILABLE: 'The farm profile or inventory batch for this request is unavailable.',
  UPLOAD_NOT_READY: 'An upload has not finished. Complete or remove it before submitting.',
  FILE_TYPE_NOT_ALLOWED: 'This file type is not accepted for this request category.',
  FILE_TOO_LARGE: 'This file is larger than the limit for this request category.',
  STORAGE_ERROR: 'The file could not be transferred. Try again.',
  DATA_UNAVAILABLE: 'Evidence request data could not be loaded.',
  UNKNOWN: 'Something went wrong. Try again.',
}

function makeError(
  code: EvidenceServiceErrorCode,
  message?: string,
  field?: string,
): EvidenceServiceError {
  return {
    code,
    message: message ?? MESSAGES[code],
    ...(field ? { field } : {}),
    retryable: RETRYABLE.has(code),
  }
}

function fail<T>(
  code: EvidenceServiceErrorCode,
  message?: string,
  field?: string,
): EvidenceServiceResult<T> {
  return { ok: false, error: makeError(code, message, field) }
}

/** Translates a PostgREST/Supabase error into a canonical §9.3 error. */
export function mapEvidenceError(err: unknown): EvidenceServiceError {
  const raw = err as { message?: string; code?: string } | null
  const message = raw?.message ?? ''

  for (const code of CANONICAL_CODES) {
    // Anchored so a human-readable message merely CONTAINING a word cannot be
    // mistaken for the canonical token the RPC raised.
    if (message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `)) {
      return makeError(code)
    }
  }

  switch (raw?.code) {
    case '42501': // insufficient_privilege
      return makeError('FORBIDDEN')
    case 'P0002': // no_data_found
    case 'PGRST116': // PostgREST: no rows for .single()
      return makeError('NOT_FOUND')
    case '40001': // serialization_failure
      return makeError('CONFLICT')
    case '23514': // check_violation — a trigger or CHECK refused the write
      return makeError('VALIDATION_ERROR', message || MESSAGES.VALIDATION_ERROR)
    case '23503': // foreign_key_violation
      return makeError('TARGET_UNAVAILABLE')
    case '42P01': // undefined_table — migration 24 is not applied here
      return makeError(
        'DATA_UNAVAILABLE',
        'The evidence request tables are not available in this environment.',
      )
    default:
      return makeError('UNKNOWN', message || MESSAGES.UNKNOWN)
  }
}

function failFrom<T>(err: unknown): EvidenceServiceResult<T> {
  return { ok: false, error: mapEvidenceError(err) }
}

/**
 * Contract §8.5/§9.6: with no configured backend there is no authoritative
 * source, so reads report DATA_UNAVAILABLE. They never fall back to demo rows —
 * fabricated evidence requests would be indistinguishable from real ones.
 */
function requireClient<T>(): EvidenceServiceResult<T> | null {
  if (!supabase) {
    return fail<T>(
      'DATA_UNAVAILABLE',
      'Evidence requests require a configured backend and are unavailable in this environment.',
    )
  }
  return null
}

// ─── Row mapping (snake_case database -> camelCase domain) ───────────────────

type Row = Record<string, unknown>

/**
 * `REQUEST_COLUMNS` is a runtime constant rather than a string literal, so
 * supabase-js cannot statically parse it and widens the row type. The mappers
 * below validate every field they read, so the rows are narrowed here in one
 * place instead of scattering casts through the call sites.
 */
const asRows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : [])
const asRow = (data: unknown): Row => (data ?? {}) as Row

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function mapRequest(row: Row): EvidenceRequest {
  const targetType = str(row.target_type) as EvidenceRequestTargetType
  return {
    id: str(row.id),
    farmId: str(row.farm_id),
    target:
      targetType === 'farm_profile'
        ? { type: 'farm_profile', farmProfileId: str(row.farm_profile_id) }
        : { type: 'inventory_batch', inventoryBatchId: str(row.inventory_batch_id) },
    category: str(row.category) as EvidenceRequestCategory,
    title: str(row.title),
    explanation: str(row.explanation),
    priority: str(row.priority) as EvidenceRequestPriority,
    dueDate: strOrNull(row.due_date),
    status: str(row.status) as EvidenceRequestStatus,
    revision: numOrNull(row.revision) ?? 1,
    createdByUserId: str(row.created_by_user_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    statusChangedAt: str(row.status_changed_at),
    closedAt: strOrNull(row.closed_at),
  }
}

function mapResponse(row: Row): EvidenceResponse {
  return {
    id: str(row.id),
    requestId: str(row.request_id),
    responseNumber: numOrNull(row.response_number) ?? 0,
    state: str(row.state) as EvidenceResponse['state'],
    responseText: strOrNull(row.response_text),
    supersedesResponseId: strOrNull(row.supersedes_response_id),
    createdByUserId: str(row.created_by_user_id),
    // Deliberately null when the RPC projection omits it — see the domain type.
    draftOwnerUserId: strOrNull(row.draft_owner_user_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    submittedAt: strOrNull(row.submitted_at),
  }
}

function mapAttachment(row: Row): EvidenceAttachment {
  return {
    id: str(row.id),
    requestId: str(row.request_id),
    responseId: str(row.response_id),
    origin: str(row.origin) as EvidenceAttachmentOrigin,
    farmerDocumentId: strOrNull(row.farmer_document_id),
    inventoryDocumentId: strOrNull(row.inventory_document_id),
    storageBucket: strOrNull(row.storage_bucket),
    storageObjectPath: strOrNull(row.storage_object_path),
    uploadState: strOrNull(row.upload_state) as EvidenceAttachmentUploadState,
    originalFilename: str(row.original_filename),
    mimeType: str(row.mime_type),
    sizeBytes: numOrNull(row.size_bytes),
    sha256Hex: strOrNull(row.sha256_hex),
    createdByUserId: str(row.created_by_user_id),
    createdAt: str(row.created_at),
    finalizedAt: strOrNull(row.finalized_at),
    removalRequestedAt: strOrNull(row.removal_requested_at),
  }
}

function mapHistory(row: Row): EvidenceRequestHistoryEvent {
  return {
    id: str(row.id),
    requestId: str(row.request_id),
    previousStatus: strOrNull(row.previous_status) as EvidenceRequestStatus | null,
    nextStatus: str(row.next_status) as EvidenceRequestStatus,
    actorUserId: str(row.actor_user_id),
    actorRole: str(row.actor_role) as EvidenceRequestHistoryEvent['actorRole'],
    eventType: str(row.event_type) as EvidenceRequestHistoryEvent['eventType'],
    responseId: strOrNull(row.response_id),
    attachmentId: strOrNull(row.attachment_id),
    note: strOrNull(row.note),
    createdAt: str(row.created_at),
  }
}

// ─── Target resolution ───────────────────────────────────────────────────────

/**
 * Resolves display labels for the targets of a set of requests.
 *
 * Returns `null` ONLY when a lookup genuinely FAILED, so the caller can fail the
 * whole read rather than silently reporting every target as unavailable
 * (§9.6, §17.14). A successful lookup that found no row yields an absent map
 * entry, which the caller renders as "target unavailable" while keeping the
 * request visible (§11.4).
 */
async function resolveTargetLabels(
  requests: EvidenceRequest[],
): Promise<Map<string, string> | null> {
  if (!supabase || requests.length === 0) return new Map()

  const profileIds = [
    ...new Set(
      requests
        .filter(r => r.target.type === 'farm_profile')
        .map(r => (r.target as { farmProfileId: string }).farmProfileId),
    ),
  ]
  const batchIds = [
    ...new Set(
      requests
        .filter(r => r.target.type === 'inventory_batch')
        .map(r => (r.target as { inventoryBatchId: string }).inventoryBatchId),
    ),
  ]

  const labels = new Map<string, string>()

  if (profileIds.length > 0) {
    const { data, error } = await supabase
      .from('farm_profiles')
      .select('id, farm_id, farms(trading_name, legal_business_name, farm_name)')
      .in('id', profileIds)
    if (error) return null
    for (const row of asRows(data)) {
      const farm = asRow(row.farms)
      const name =
        strOrNull(farm.trading_name) ??
        strOrNull(farm.legal_business_name) ??
        strOrNull(farm.farm_name)
      labels.set(str(row.id), name ? `Farm profile — ${name}` : 'Farm profile')
    }
  }

  if (batchIds.length > 0) {
    const { data, error } = await supabase
      .from('inventory_batches')
      .select('id, product_name, batch_number, strain')
      .in('id', batchIds)
    if (error) return null
    for (const row of asRows(data)) {
      const product = strOrNull(row.product_name) ?? strOrNull(row.strain) ?? 'Inventory batch'
      const batch = strOrNull(row.batch_number)
      labels.set(str(row.id), batch ? `${product} — batch ${batch}` : product)
    }
  }

  return labels
}

function targetIdOf(request: EvidenceRequest): string {
  return request.target.type === 'farm_profile'
    ? request.target.farmProfileId
    : request.target.inventoryBatchId
}

function toListItems(
  requests: EvidenceRequest[],
  labels: Map<string, string>,
): EvidenceRequestListItem[] {
  return requests.map(request => {
    const label = labels.get(targetIdOf(request)) ?? null
    return { ...request, targetLabel: label, targetAvailable: label !== null }
  })
}

const REQUEST_COLUMNS =
  'id, farm_id, target_type, farm_profile_id, inventory_batch_id, category, title, ' +
  'explanation, priority, due_date, status, revision, created_by_user_id, ' +
  'closed_by_user_id, created_at, updated_at, status_changed_at, closed_at'

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface AdminEvidenceRequestFilters {
  /** `active` = open|farmer_submitted|clarification_requested; `closed` = terminal. */
  scope?: 'active' | 'closed' | 'all'
  status?: EvidenceRequestStatus
  priority?: EvidenceRequestPriority
  category?: EvidenceRequestCategory
  targetType?: EvidenceRequestTargetType
}

export interface FarmerEvidenceRequestFilters {
  scope?: 'needs_response' | 'submitted' | 'closed' | 'all'
}

const ACTIVE: EvidenceRequestStatus[] = ['open', 'farmer_submitted', 'clarification_requested']
const CLOSED: EvidenceRequestStatus[] = ['resolved', 'rejected', 'cancelled']
const NEEDS_RESPONSE: EvidenceRequestStatus[] = ['open', 'clarification_requested']

/** A stable key for §9.7 scope identity. Same filters -> same key. */
export function adminFilterKey(filters: AdminEvidenceRequestFilters): string {
  return [
    filters.scope ?? 'active',
    filters.status ?? '',
    filters.priority ?? '',
    filters.category ?? '',
    filters.targetType ?? '',
  ].join(',')
}

export function farmerFilterKey(filters: FarmerEvidenceRequestFilters): string {
  return filters.scope ?? 'all'
}

// ─── Reads (§9.4) ────────────────────────────────────────────────────────────

async function listRequests(
  statuses: EvidenceRequestStatus[] | null,
  narrow: (rows: EvidenceRequest[]) => EvidenceRequest[],
): Promise<EvidenceServiceResult<EvidenceRequestListItem[]>> {
  const unavailable = requireClient<EvidenceRequestListItem[]>()
  if (unavailable) return unavailable

  try {
    let query = supabase!.from('evidence_requests').select(REQUEST_COLUMNS)
    if (statuses) query = query.in('status', statuses)
    const { data, error } = await query
      .order('status_changed_at', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) return failFrom(error)

    const requests = narrow(asRows(data).map(mapRequest))
    const labels = await resolveTargetLabels(requests)
    if (labels === null) {
      // The requests loaded but their targets could not be checked. Reporting
      // every target as unavailable would be a fabricated conclusion, so the
      // read fails and the UI shows its retryable failure state (§9.6).
      return fail('DATA_UNAVAILABLE', 'Request targets could not be loaded.')
    }
    return { ok: true, data: toListItems(requests, labels) }
  } catch (err) {
    return failFrom(err)
  }
}

export function listAdminEvidenceRequests(
  filters: AdminEvidenceRequestFilters,
): Promise<EvidenceServiceResult<EvidenceRequestListItem[]>> {
  const scope = filters.scope ?? 'active'
  const statuses =
    filters.status !== undefined
      ? [filters.status]
      : scope === 'active'
        ? ACTIVE
        : scope === 'closed'
          ? CLOSED
          : null

  return listRequests(statuses, rows =>
    rows.filter(
      r =>
        (!filters.priority || r.priority === filters.priority) &&
        (!filters.category || r.category === filters.category) &&
        (!filters.targetType || r.target.type === filters.targetType),
    ),
  )
}

/**
 * Farmer visibility is decided ENTIRELY by RLS: this query has no farm predicate
 * because adding one would imply client-side filtering is the boundary (§8.5,
 * §17.5). A farmer simply cannot select another farm's rows.
 */
export function listFarmerEvidenceRequests(
  filters: FarmerEvidenceRequestFilters,
): Promise<EvidenceServiceResult<EvidenceRequestListItem[]>> {
  const scope = filters.scope ?? 'all'
  const statuses =
    scope === 'needs_response'
      ? NEEDS_RESPONSE
      : scope === 'submitted'
        ? (['farmer_submitted'] as EvidenceRequestStatus[])
        : scope === 'closed'
          ? CLOSED
          : null

  return listRequests(statuses, rows => rows)
}

export async function getEvidenceRequest(
  requestId: string,
): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  const unavailable = requireClient<EvidenceRequestDetail>()
  if (unavailable) return unavailable

  try {
    const { data, error } = await supabase!
      .from('evidence_requests')
      .select(REQUEST_COLUMNS)
      .eq('id', requestId)
      .maybeSingle()

    if (error) return failFrom(error)
    // §8.4 non-disclosure: an unauthorised id is invisible under RLS and is
    // therefore indistinguishable from an id that does not exist.
    if (!data) return fail('NOT_FOUND')

    const request = mapRequest(asRow(data))

    const [responses, attachments, history] = await Promise.all([
      supabase!
        .from('evidence_request_responses')
        .select('*')
        .eq('request_id', requestId)
        .order('response_number', { ascending: true }),
      supabase!
        .from('evidence_request_attachments')
        .select('*')
        .eq('request_id', requestId)
        .order('created_at', { ascending: true }),
      supabase!
        .from('evidence_request_history')
        .select('*')
        .eq('request_id', requestId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
    ])

    if (responses.error) return failFrom(responses.error)
    if (attachments.error) return failFrom(attachments.error)
    if (history.error) return failFrom(history.error)

    const labels = await resolveTargetLabels([request])
    if (labels === null) return fail('DATA_UNAVAILABLE', 'The request target could not be loaded.')
    const targetLabel = labels.get(targetIdOf(request)) ?? null

    return {
      ok: true,
      data: {
        request,
        responses: asRows(responses.data).map(mapResponse),
        attachments: asRows(attachments.data).map(mapAttachment),
        history: asRows(history.data).map(mapHistory),
        targetLabel,
        targetAvailable: targetLabel !== null,
      },
    }
  } catch (err) {
    return failFrom(err)
  }
}

export async function listEvidenceRequestHistory(
  requestId: string,
): Promise<EvidenceServiceResult<EvidenceRequestHistoryEvent[]>> {
  const unavailable = requireClient<EvidenceRequestHistoryEvent[]>()
  if (unavailable) return unavailable
  try {
    const { data, error } = await supabase!
      .from('evidence_request_history')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    if (error) return failFrom(error)
    return { ok: true, data: asRows(data).map(mapHistory) }
  } catch (err) {
    return failFrom(err)
  }
}

/**
 * Contract §10.3: "Target data must load from authoritative services." The
 * create page selects a target from these rows and never from a client-typed
 * ID. Even so, the ID is not trusted: `create_evidence_request` re-derives
 * `farm_id` from the target itself (§6.2 scope validation, §19.7).
 */
export interface EvidenceTargetOption {
  id: string
  label: string
}

export async function listEvidenceTargetOptions(
  targetType: EvidenceRequestTargetType,
): Promise<EvidenceServiceResult<EvidenceTargetOption[]>> {
  const unavailable = requireClient<EvidenceTargetOption[]>()
  if (unavailable) return unavailable

  try {
    if (targetType === 'farm_profile') {
      const { data, error } = await supabase!
        .from('farm_profiles')
        .select('id, farm_id, farms(trading_name, legal_business_name, farm_name)')
        .order('id', { ascending: true })
      if (error) return failFrom(error)
      return {
        ok: true,
        data: asRows(data).map(row => {
          const farm = asRow(row.farms)
          const name =
            strOrNull(farm.trading_name) ??
            strOrNull(farm.legal_business_name) ??
            strOrNull(farm.farm_name)
          return { id: str(row.id), label: name ?? `Farm profile ${str(row.id).slice(0, 8)}` }
        }),
      }
    }

    const { data, error } = await supabase!
      .from('inventory_batches')
      .select('id, product_name, batch_number, strain')
      .order('created_at', { ascending: false })
    if (error) return failFrom(error)
    return {
      ok: true,
      data: asRows(data).map(row => {
        const product = strOrNull(row.product_name) ?? strOrNull(row.strain) ?? 'Inventory batch'
        const batch = strOrNull(row.batch_number)
        return { id: str(row.id), label: batch ? `${product} — batch ${batch}` : product }
      }),
    }
  } catch (err) {
    return failFrom(err)
  }
}

/**
 * Resolves the `farm_profiles.id` that a farm record corresponds to.
 *
 * This exists because the two are NOT the same identifier and must never be
 * conflated. In this codebase the app-level `FarmProfile.id` is a `farms.id`,
 * while an evidence request with `target_type = 'farm_profile'` targets a row in
 * the separate `farm_profiles` table. Passing a `farms.id` as the target would
 * be rejected by `fn_evidence_request_validate_scope`, so Farm Review resolves
 * the real target here before preselecting it (§10.7).
 *
 * A farm with no profile row yields NOT_FOUND rather than a fabricated target.
 */
export async function resolveFarmProfileTargetId(
  farmId: string,
): Promise<EvidenceServiceResult<string>> {
  const unavailable = requireClient<string>()
  if (unavailable) return unavailable
  try {
    const { data, error } = await supabase!
      .from('farm_profiles')
      .select('id')
      .eq('farm_id', farmId)
      .limit(1)
      .maybeSingle()
    if (error) return failFrom(error)
    if (!data) {
      return fail(
        'TARGET_UNAVAILABLE',
        'This farm has no farm profile record to request evidence against.',
      )
    }
    return { ok: true, data: str(asRow(data).id) }
  } catch (err) {
    return failFrom(err)
  }
}

/**
 * Contract §7.5: existing documents a farmer may link. Visibility is decided by
 * RLS on `farmer_documents` / `documents`; this adds no farm predicate of its
 * own, because client-side filtering is never the boundary (§8.5).
 *
 * For a `coa` request the inventory documents are additionally constrained to
 * the targeted batch — the database enforces the same rule in
 * `link_existing_evidence_document`, so this narrowing is usability, not
 * security.
 */
export interface LinkableEvidenceDocument {
  id: string
  origin: Exclude<EvidenceAttachmentOrigin, 'request_upload'>
  label: string
  documentType: string | null
}

export async function listLinkableEvidenceDocuments(input: {
  farmId: string
  category: EvidenceRequestCategory
  inventoryBatchId: string | null
}): Promise<EvidenceServiceResult<LinkableEvidenceDocument[]>> {
  const unavailable = requireClient<LinkableEvidenceDocument[]>()
  if (unavailable) return unavailable

  try {
    const farmerDocs = await supabase!
      .from('farmer_documents')
      .select('id, document_type, file_name, inventory_batch_id')
      .eq('farm_id', input.farmId)
    if (farmerDocs.error) return failFrom(farmerDocs.error)

    const inventoryDocs = await supabase!
      .from('documents')
      .select('id, document_type, file_name, inventory_batch_id')
      .eq('farm_id', input.farmId)
    if (inventoryDocs.error) return failFrom(inventoryDocs.error)

    const isCoa = input.category === 'coa'
    const out: LinkableEvidenceDocument[] = []

    for (const row of asRows(farmerDocs.data)) {
      const type = strOrNull(row.document_type)
      if (isCoa && type !== 'coa') continue
      if (isCoa && strOrNull(row.inventory_batch_id) !== input.inventoryBatchId) continue
      out.push({
        id: str(row.id),
        origin: 'existing_farm_document',
        label: strOrNull(row.file_name) ?? `Farm document ${str(row.id).slice(0, 8)}`,
        documentType: type,
      })
    }

    for (const row of asRows(inventoryDocs.data)) {
      const type = strOrNull(row.document_type)
      if (isCoa && type !== 'coa') continue
      if (isCoa && strOrNull(row.inventory_batch_id) !== input.inventoryBatchId) continue
      out.push({
        id: str(row.id),
        origin: 'existing_inventory_document',
        label: strOrNull(row.file_name) ?? `Inventory document ${str(row.id).slice(0, 8)}`,
        documentType: type,
      })
    }

    return { ok: true, data: out }
  } catch (err) {
    return failFrom(err)
  }
}

// ─── Mutations (§9.4) ────────────────────────────────────────────────────────

async function callRpc(name: string, args: Record<string, unknown>): Promise<Row> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw error
  return asRow(data)
}

/**
 * §9.5: a transition RPC returns the request row only, so the authoritative
 * detail is re-read and REPLACES prior state rather than being merged into it.
 */
async function afterTransition(
  requestId: string,
): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  return getEvidenceRequest(requestId)
}

export interface CreateEvidenceRequestInput {
  targetType: EvidenceRequestTargetType
  targetId: string
  category: EvidenceRequestCategory
  title: string
  explanation: string
  priority: EvidenceRequestPriority
  dueDate: string | null
}

export async function createEvidenceRequest(
  input: CreateEvidenceRequestInput,
): Promise<EvidenceServiceResult<EvidenceRequest>> {
  const unavailable = requireClient<EvidenceRequest>()
  if (unavailable) return unavailable
  try {
    const row = await callRpc('create_evidence_request', {
      p_target_type: input.targetType,
      p_target_id: input.targetId,
      p_category: input.category,
      p_title: input.title,
      p_explanation: input.explanation,
      p_priority: input.priority,
      p_due_date: input.dueDate,
    })
    return { ok: true, data: mapRequest(row) }
  } catch (err) {
    return failFrom(err)
  }
}

export async function getOrCreateEvidenceResponseDraft(input: {
  requestId: string
  expectedRequestRevision: number
}): Promise<EvidenceServiceResult<EvidenceResponseDraft>> {
  const unavailable = requireClient<EvidenceResponseDraft>()
  if (unavailable) return unavailable
  try {
    const row = await callRpc('get_or_create_evidence_response_draft', {
      p_request_id: input.requestId,
      p_expected_revision: input.expectedRequestRevision,
    })
    const response = mapResponse(row)
    return { ok: true, data: { response, attachments: await loadAttachments(response.id) } }
  } catch (err) {
    return failFrom(err)
  }
}

async function loadAttachments(responseId: string): Promise<EvidenceAttachment[]> {
  const { data, error } = await supabase!
    .from('evidence_request_attachments')
    .select('*')
    .eq('response_id', responseId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return asRows(data).map(mapAttachment)
}

export async function saveEvidenceResponseDraft(input: {
  requestId: string
  responseId: string
  responseText: string
}): Promise<EvidenceServiceResult<EvidenceResponseDraft>> {
  const unavailable = requireClient<EvidenceResponseDraft>()
  if (unavailable) return unavailable
  try {
    const row = await callRpc('save_evidence_response_draft', {
      p_request_id: input.requestId,
      p_response_id: input.responseId,
      p_response_text: input.responseText,
    })
    const response = mapResponse(row)
    return { ok: true, data: { response, attachments: await loadAttachments(response.id) } }
  } catch (err) {
    return failFrom(err)
  }
}

export async function reserveEvidenceAttachment(input: {
  requestId: string
  responseId: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
}): Promise<EvidenceServiceResult<EvidenceUploadReservation>> {
  const unavailable = requireClient<EvidenceUploadReservation>()
  if (unavailable) return unavailable
  try {
    const row = await callRpc('reserve_evidence_attachment', {
      p_request_id: input.requestId,
      p_response_id: input.responseId,
      p_original_filename: input.originalFilename,
      p_mime_type: input.mimeType,
      p_size_bytes: input.sizeBytes,
    })
    const attachment = mapAttachment(row)
    if (!attachment.storageObjectPath) {
      return fail('STORAGE_ERROR', 'The upload reservation did not return a storage path.')
    }
    return {
      ok: true,
      data: {
        attachment,
        storageBucket: attachment.storageBucket ?? EVIDENCE_REQUEST_BUCKET,
        storageObjectPath: attachment.storageObjectPath,
      },
    }
  } catch (err) {
    return failFrom(err)
  }
}

export async function finalizeEvidenceAttachment(input: {
  requestId: string
  responseId: string
  attachmentId: string
  sha256Hex: string
  actualSizeBytes: number
  actualMimeType: string
}): Promise<EvidenceServiceResult<EvidenceAttachment>> {
  const unavailable = requireClient<EvidenceAttachment>()
  if (unavailable) return unavailable
  try {
    const row = await callRpc('finalize_evidence_attachment', {
      p_request_id: input.requestId,
      p_response_id: input.responseId,
      p_attachment_id: input.attachmentId,
      p_sha256_hex: input.sha256Hex,
      p_actual_size_bytes: input.actualSizeBytes,
      p_actual_mime_type: input.actualMimeType,
    })
    return { ok: true, data: mapAttachment(row) }
  } catch (err) {
    return failFrom(err)
  }
}

/**
 * Contract §7.8/§6.4 controlled two-stage removal. The database cannot delete a
 * Supabase Storage object (deleting `storage.objects` in SQL orphans the file),
 * so the RPC authorises removal, this function performs the Storage DELETE under
 * the caller's own RLS, and the RPC is called again to complete it once the
 * object is gone. The attachment row survives as a durable tombstone (§7.8) —
 * that is the design, not a leak.
 */
export async function removeDraftEvidenceAttachment(input: {
  requestId: string
  responseId: string
  attachmentId: string
  storageObjectPath?: string | null
}): Promise<EvidenceServiceResult<void>> {
  const unavailable = requireClient<void>()
  if (unavailable) return unavailable
  const args = {
    p_request_id: input.requestId,
    p_response_id: input.responseId,
    p_attachment_id: input.attachmentId,
  }

  try {
    // Phase 1 marks the tombstone and reports whether an object is present.
    // `result` is 'REMOVED' (nothing present now) or 'STORAGE_DELETE_REQUIRED'.
    const first = await callRpc('remove_draft_evidence_attachment', args)
    if (strOrNull(first.result) === 'REMOVED') return { ok: true, data: undefined }

    const path = strOrNull(first.storage_object_path) ?? input.storageObjectPath ?? null
    if (!path) {
      // A linked existing document has no object; the RPC completed its unlink.
      return { ok: true, data: undefined }
    }

    const { error: storageError } = await supabase!.storage
      .from(strOrNull(first.storage_bucket) ?? EVIDENCE_REQUEST_BUCKET)
      .remove([path])
    if (storageError) return failFrom(storageError)

    // Phase 2 re-checks the object rather than trusting the Storage response.
    const second = await callRpc('remove_draft_evidence_attachment', args)
    if (strOrNull(second.result) === 'REMOVED') return { ok: true, data: undefined }

    // The object survived the delete. Reporting success here would show the
    // farmer a removed attachment the platform still holds, so this stays a
    // visible, retryable failure. The tombstone persists and authorises a
    // further attempt (§7.8).
    return fail(
      'STORAGE_ERROR',
      'The file was marked for removal but could not be deleted. Try again.',
    )
  } catch (err) {
    return failFrom(err)
  }
}

export interface LinkExistingEvidenceDocumentInput {
  requestId: string
  responseId: string
  origin: Exclude<EvidenceAttachmentOrigin, 'request_upload'>
  farmerDocumentId?: string
  inventoryDocumentId?: string
}

export async function linkExistingEvidenceDocument(
  input: LinkExistingEvidenceDocumentInput,
): Promise<EvidenceServiceResult<EvidenceAttachment>> {
  const unavailable = requireClient<EvidenceAttachment>()
  if (unavailable) return unavailable
  try {
    const row = await callRpc('link_existing_evidence_document', {
      p_request_id: input.requestId,
      p_response_id: input.responseId,
      p_origin: input.origin,
      p_farmer_document_id: input.farmerDocumentId ?? null,
      p_inventory_document_id: input.inventoryDocumentId ?? null,
    })
    return { ok: true, data: mapAttachment(row) }
  } catch (err) {
    return failFrom(err)
  }
}

export async function submitEvidenceResponse(input: {
  requestId: string
  responseId: string
  expectedRequestRevision: number
}): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  const unavailable = requireClient<EvidenceRequestDetail>()
  if (unavailable) return unavailable
  try {
    await callRpc('submit_evidence_response', {
      p_request_id: input.requestId,
      p_response_id: input.responseId,
      p_expected_revision: input.expectedRequestRevision,
    })
    return afterTransition(input.requestId)
  } catch (err) {
    return failFrom(err)
  }
}

export async function requestEvidenceClarification(input: {
  requestId: string
  reviewedResponseId: string
  reason: string
  expectedRequestRevision: number
}): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  const unavailable = requireClient<EvidenceRequestDetail>()
  if (unavailable) return unavailable
  try {
    await callRpc('request_evidence_clarification', {
      p_request_id: input.requestId,
      p_reviewed_response_id: input.reviewedResponseId,
      p_reason: input.reason,
      p_expected_revision: input.expectedRequestRevision,
    })
    return afterTransition(input.requestId)
  } catch (err) {
    return failFrom(err)
  }
}

export async function resolveEvidenceRequest(input: {
  requestId: string
  reviewedResponseId: string
  resolutionNote: string
  expectedRequestRevision: number
}): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  const unavailable = requireClient<EvidenceRequestDetail>()
  if (unavailable) return unavailable
  try {
    await callRpc('resolve_evidence_request', {
      p_request_id: input.requestId,
      p_reviewed_response_id: input.reviewedResponseId,
      p_resolution_note: input.resolutionNote,
      p_expected_revision: input.expectedRequestRevision,
    })
    return afterTransition(input.requestId)
  } catch (err) {
    return failFrom(err)
  }
}

export async function rejectEvidenceResponse(input: {
  requestId: string
  reviewedResponseId: string
  rejectionReason: string
  expectedRequestRevision: number
}): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  const unavailable = requireClient<EvidenceRequestDetail>()
  if (unavailable) return unavailable
  try {
    await callRpc('reject_evidence_response', {
      p_request_id: input.requestId,
      p_reviewed_response_id: input.reviewedResponseId,
      p_rejection_reason: input.rejectionReason,
      p_expected_revision: input.expectedRequestRevision,
    })
    return afterTransition(input.requestId)
  } catch (err) {
    return failFrom(err)
  }
}

export async function cancelEvidenceRequest(input: {
  requestId: string
  cancellationReason: string
  expectedRequestRevision: number
}): Promise<EvidenceServiceResult<EvidenceRequestDetail>> {
  const unavailable = requireClient<EvidenceRequestDetail>()
  if (unavailable) return unavailable
  try {
    await callRpc('cancel_evidence_request', {
      p_request_id: input.requestId,
      p_cancellation_reason: input.cancellationReason,
      p_expected_revision: input.expectedRequestRevision,
    })
    return afterTransition(input.requestId)
  } catch (err) {
    return failFrom(err)
  }
}

/**
 * Contract §7.4 steps 4–7. Uploads the bytes to the reserved path under storage
 * RLS, then finalizes. A failed upload leaves a `pending_upload` row which
 * `submit_evidence_response` refuses, so a failed upload can never become
 * submitted evidence (§7.4 "A failed upload must not create a submitted
 * evidence record").
 */
export async function uploadReservedEvidenceObject(input: {
  bucket: string
  path: string
  file: Blob
  contentType: string
}): Promise<EvidenceServiceResult<void>> {
  const unavailable = requireClient<void>()
  if (unavailable) return unavailable
  try {
    const { error } = await supabase!.storage
      .from(input.bucket)
      .upload(input.path, input.file, { contentType: input.contentType, upsert: false })
    if (error) return failFrom(error)
    return { ok: true, data: undefined }
  } catch (err) {
    return failFrom(err)
  }
}

/**
 * Contract §7.1/§7.6: the bucket is private, so reading an attachment requires a
 * short-lived signed URL issued under the caller's own RLS. There is no public
 * URL path and none may be added (§19.14).
 */
export async function getEvidenceAttachmentSignedUrl(input: {
  bucket: string
  path: string
  expiresInSeconds?: number
}): Promise<EvidenceServiceResult<string>> {
  const unavailable = requireClient<string>()
  if (unavailable) return unavailable
  try {
    const { data, error } = await supabase!.storage
      .from(input.bucket)
      .createSignedUrl(input.path, input.expiresInSeconds ?? 60)
    if (error) return failFrom(error)
    if (!data?.signedUrl) return fail('STORAGE_ERROR')
    return { ok: true, data: data.signedUrl }
  } catch (err) {
    return failFrom(err)
  }
}

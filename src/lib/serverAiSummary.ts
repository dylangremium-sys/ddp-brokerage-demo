import type { LegalUpdate, LegalUpdateStatus } from '../types.js'
import type { ComplianceAiSummaryProvider } from './aiComplianceProvider.js'
import {
  DEFAULT_MAX_EVIDENCE_CHARS,
  generateAiDraftSummary,
  AI_DRAFT_LABEL,
} from './complianceAiSummarisation.js'
import type { AiSummaryResultCode } from './complianceAiSummarisation.js'

// ─── Secure server-side AI draft-summary boundary — core (Phase 2I) ─────────
//
// The framework-agnostic core of the api/compliance/ai-summary.ts Vercel
// Function. It is pure aside from three injected dependencies (authenticate,
// getProfileRole, provider) so it can be exercised entirely with mocks — no
// real Supabase, AI provider, or network. It performs, in order:
//
//   1. method / content-type gate           (405 / 415)
//   2. bearer-token presence + validity      (401)
//   3. admin authorisation via the caller's  (403)
//      own profile row (role === 'ddp_admin')
//   4. strict request validation             (400 / 413)
//   5. the EXISTING guarded orchestration     (generateAiDraftSummary)
//      — request eligibility guard + wording guard, never re-implemented here
//   6. safe error mapping                      (no secrets, no stack traces)
//
// The server itself constructs the capability lock (draft only, cannot
// approve/certify/create-rule/enforce) by reconstructing a LegalUpdate and
// letting buildAiSummaryRequest/generateAiDraftSummary apply the literal
// guarantees. It never reads a role, isAdmin flag, or capability flag from the
// request body — those are ignored (and rejected as unknown fields).

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** Max characters for the whole decoded JSON body. A coarse guard complementing
 *  the per-field bounds; the api adapter also rejects oversized raw bodies. */
export const MAX_REQUEST_CHARS = 60_000
const MAX_SHORT_FIELD_CHARS = 500
const MAX_URL_CHARS = 2_048
const MAX_ID_CHARS = 200
const MAX_TIMESTAMP_CHARS = 40
const CHECKSUM_RE = /^[0-9a-f]{64}$/i

/** The only capability this endpoint offers. Anything else is rejected. */
export const SUPPORTED_CAPABILITY = 'draft_summarisation'

const PERMITTED_STATUSES: readonly LegalUpdateStatus[] = [
  'new',
  'needs_review',
  'reviewed',
  'rule_suggested',
  'sent_to_legal',
  'archived',
  'rejected',
]

const PERMITTED_FIELDS = new Set([
  'legalUpdateId',
  'sourceName',
  'sourceUrl',
  'jurisdiction',
  'itemTitle',
  'publishedAt',
  'rawEvidence',
  'provenanceChecksum',
  'status',
  'capability',
])

// ─── Request / response shapes ───────────────────────────────────────────────

export interface NormalizedRequest {
  method: string
  contentType: string | null
  authorization: string | null
  /** The raw request body: either the undecoded JSON string or an already
   *  parsed object. Core normalises both so malformed JSON is caught here. */
  body: unknown
}

export interface ParsedAiSummaryRequest {
  legalUpdateId: string
  sourceName: string
  sourceUrl: string
  jurisdiction: string
  itemTitle: string
  publishedAt: string | null
  rawEvidence: string
  provenanceChecksum: string | null
  status: LegalUpdateStatus
}

export type ValidationCode =
  | 'malformed_body'
  | 'unknown_field'
  | 'invalid_field'
  | 'invalid_url'
  | 'invalid_checksum'
  | 'invalid_capability'
  | 'invalid_status'
  | 'missing_evidence'
  | 'oversized_request'

export type RequestValidation =
  | { ok: true; value: ParsedAiSummaryRequest }
  | { ok: false; code: ValidationCode; reason: string }

export interface AiSummarySections {
  draftSummary: string
  possibleSignificance: string
  uncertainties: string
  reviewQuestions: string[]
  sourceReferences: string[]
}

/** The 200 payload. Contains only the guarded draft evidence + non-secret
 *  provenance (model name is not a secret; the API key never appears). */
export interface AiSummarySuccessBody {
  ok: true
  sections: AiSummarySections
  provenance: { provider: string; model: string; generatedAt: string }
  requiresHumanReview: true
  label: string
}

export interface AiSummaryErrorBody {
  ok: false
  error: string
  message: string
}

export interface HttpResult {
  status: number
  body: AiSummarySuccessBody | AiSummaryErrorBody
}

export interface ServerAiSummaryDeps {
  /** Verify the caller's bearer token. Returns the user id, or null if invalid. */
  authenticate: (accessToken: string) => Promise<{ userId: string } | null>
  /** Read ONLY the authenticated caller's own profile role (RLS enforced). */
  getProfileRole: (userId: string) => Promise<string | null>
  /** Server-side provider; null when no provider is configured (fail closed). */
  provider: ComplianceAiSummaryProvider | null
  maxEvidenceChars?: number
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function err(status: number, error: string, message: string): HttpResult {
  return { status, body: { ok: false, error, message } }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!match) return null
  const token = match[1].trim()
  return token.length > 0 ? token : null
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ─── Strict request validation ───────────────────────────────────────────────

/**
 * Validates the decoded request body against the minimum permitted evidence
 * fields. Rejects unknown fields, wrong types, oversized strings, invalid
 * URLs/checksums, an unsupported capability, and an unknown status value.
 * It does NOT decide eligibility (that is the reused request guard's job) — a
 * valid-but-non-'new' status passes validation and is rejected downstream as
 * unsupported_status.
 */
export function validateAiSummaryBody(raw: unknown): RequestValidation {
  let body: unknown = raw
  if (typeof body === 'string') {
    if (body.length > MAX_REQUEST_CHARS) {
      return { ok: false, code: 'oversized_request', reason: 'Request body is too large.' }
    }
    try {
      body = JSON.parse(body)
    } catch {
      return { ok: false, code: 'malformed_body', reason: 'Request body is not valid JSON.' }
    }
  }
  if (!isPlainObject(body)) {
    return { ok: false, code: 'malformed_body', reason: 'Request body must be a JSON object.' }
  }
  if (JSON.stringify(body).length > MAX_REQUEST_CHARS) {
    return { ok: false, code: 'oversized_request', reason: 'Request body is too large.' }
  }

  for (const key of Object.keys(body)) {
    if (!PERMITTED_FIELDS.has(key)) {
      return { ok: false, code: 'unknown_field', reason: `Unexpected field "${key}".` }
    }
  }

  const str = (key: string, max: number, required = true): string | null | { fail: RequestValidation } => {
    const v = body[key]
    if (v === undefined || v === null) {
      if (required) return { fail: { ok: false, code: 'invalid_field', reason: `Missing field "${key}".` } }
      return null
    }
    if (typeof v !== 'string') return { fail: { ok: false, code: 'invalid_field', reason: `Field "${key}" must be a string.` } }
    if (v.length > max) return { fail: { ok: false, code: 'invalid_field', reason: `Field "${key}" is too long.` } }
    return v
  }
  const failed = (v: unknown): v is { fail: RequestValidation } => isPlainObject(v) && 'fail' in v

  // capability lock: only the one supported value, exact match.
  if (body.capability !== SUPPORTED_CAPABILITY) {
    return { ok: false, code: 'invalid_capability', reason: 'Unsupported or missing capability.' }
  }

  const legalUpdateId = str('legalUpdateId', MAX_ID_CHARS)
  if (failed(legalUpdateId)) return legalUpdateId.fail
  const sourceName = str('sourceName', MAX_SHORT_FIELD_CHARS)
  if (failed(sourceName)) return sourceName.fail
  const sourceUrl = str('sourceUrl', MAX_URL_CHARS)
  if (failed(sourceUrl)) return sourceUrl.fail
  const jurisdiction = str('jurisdiction', MAX_SHORT_FIELD_CHARS)
  if (failed(jurisdiction)) return jurisdiction.fail
  const itemTitle = str('itemTitle', MAX_SHORT_FIELD_CHARS)
  if (failed(itemTitle)) return itemTitle.fail
  const rawEvidence = str('rawEvidence', MAX_REQUEST_CHARS)
  if (failed(rawEvidence)) return rawEvidence.fail
  const publishedAt = str('publishedAt', MAX_TIMESTAMP_CHARS, false)
  if (failed(publishedAt)) return publishedAt.fail
  const provenanceChecksum = str('provenanceChecksum', 128, false)
  if (failed(provenanceChecksum)) return provenanceChecksum.fail

  // Narrowed: every str() result above is now string | null (failures returned).
  if (!isHttpUrl(sourceUrl as string)) {
    return { ok: false, code: 'invalid_url', reason: 'sourceUrl must be a valid http(s) URL.' }
  }
  if (provenanceChecksum !== null && !CHECKSUM_RE.test(provenanceChecksum as string)) {
    return { ok: false, code: 'invalid_checksum', reason: 'provenanceChecksum must be a 64-hex string.' }
  }
  if (typeof body.status !== 'string' || !PERMITTED_STATUSES.includes(body.status as LegalUpdateStatus)) {
    return { ok: false, code: 'invalid_status', reason: 'Unknown legal-update status.' }
  }
  if ((rawEvidence as string).trim().length === 0) {
    return { ok: false, code: 'missing_evidence', reason: 'No source evidence to summarise.' }
  }

  return {
    ok: true,
    value: {
      legalUpdateId: legalUpdateId as string,
      sourceName: sourceName as string,
      sourceUrl: sourceUrl as string,
      jurisdiction: jurisdiction as string,
      itemTitle: itemTitle as string,
      publishedAt: (publishedAt as string | null) ?? null,
      rawEvidence: rawEvidence as string,
      provenanceChecksum: (provenanceChecksum as string | null) ?? null,
      status: body.status as LegalUpdateStatus,
    },
  }
}

/**
 * Reconstructs the minimal LegalUpdate the reused orchestration expects from
 * the validated evidence. Only fields buildAiSummaryRequest reads carry data;
 * the checksum round-trips through reviewerNotes so provenance is preserved.
 * The server never trusts a client capability flag — buildAiSummaryRequest
 * stamps the literal draft-only guarantees.
 */
export function reconstructLegalUpdate(req: ParsedAiSummaryRequest): LegalUpdate {
  return {
    id: req.legalUpdateId,
    sourceId: null,
    title: req.itemTitle,
    jurisdiction: req.jurisdiction,
    sourceName: req.sourceName,
    sourceUrl: req.sourceUrl,
    publishedAt: req.publishedAt,
    detectedAt: '',
    rawText: req.rawEvidence,
    summary: '',
    affectedAreas: [],
    aiRiskLevel: null,
    status: req.status,
    reviewerNotes: req.provenanceChecksum ? `Checksum: ${req.provenanceChecksum}` : '',
    createdAt: '',
    updatedAt: '',
  }
}

// ─── Error mapping (no secrets, no stack traces) ─────────────────────────────

const VALIDATION_STATUS: Record<ValidationCode, number> = {
  malformed_body: 400,
  unknown_field: 400,
  invalid_field: 400,
  invalid_url: 400,
  invalid_checksum: 400,
  invalid_capability: 400,
  invalid_status: 400,
  missing_evidence: 400,
  oversized_request: 413,
}

const RESULT_STATUS: Record<AiSummaryResultCode, number> = {
  request_in_progress: 409,
  missing_update: 400,
  provider_unconfigured: 503,
  unsupported_status: 422,
  missing_evidence: 400,
  oversized_evidence: 413,
  provider_error: 502,
  provider_timeout: 504,
  malformed_output: 502,
  empty_output: 502,
  unsafe_output: 502,
  // Source-policy denial from the shared execution gate (Cannamonitor). 403:
  // the source is not permitted for AI processing while permission is
  // unverified. The provider is never reached, and no draft is generated.
  cannamonitor_permission_unverified: 403,
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * The complete secure boundary. Every reject path returns a safe, coded body
 * with no vendor detail, stack trace, token, or secret. The provider is only
 * ever reached after method + content-type + authentication + admin
 * authorisation + strict validation all pass.
 */
export async function handleAiSummaryRequest(
  req: NormalizedRequest,
  deps: ServerAiSummaryDeps,
): Promise<HttpResult> {
  if (req.method.toUpperCase() !== 'POST') {
    return err(405, 'method_not_allowed', 'Only POST is supported.')
  }
  if (!req.contentType || !req.contentType.toLowerCase().includes('application/json')) {
    return err(415, 'unsupported_media_type', 'Content-Type must be application/json.')
  }

  const token = bearerToken(req.authorization)
  if (!token) {
    return err(401, 'unauthenticated', 'A bearer access token is required.')
  }

  let auth: { userId: string } | null
  try {
    auth = await deps.authenticate(token)
  } catch {
    return err(401, 'unauthenticated', 'The access token could not be verified.')
  }
  if (!auth) {
    return err(401, 'unauthenticated', 'Invalid or expired access token.')
  }

  let role: string | null
  try {
    role = await deps.getProfileRole(auth.userId)
  } catch {
    return err(403, 'forbidden', 'Access is restricted.')
  }
  if (role !== 'ddp_admin') {
    return err(403, 'forbidden', 'Administrator access is required.')
  }

  const validation = validateAiSummaryBody(req.body)
  if (!validation.ok) {
    return err(VALIDATION_STATUS[validation.code], validation.code, validation.reason)
  }

  const update = reconstructLegalUpdate(validation.value)
  const result = await generateAiDraftSummary(update, deps.provider, {
    requestInProgress: false,
    maxEvidenceChars: deps.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS,
  })

  if (!result.ok) {
    return err(RESULT_STATUS[result.code], result.code, result.reason)
  }

  const draft = result.draft
  const body: AiSummarySuccessBody = {
    ok: true,
    sections: {
      draftSummary: draft.draftSummary,
      possibleSignificance: draft.possibleSignificance,
      uncertainties: draft.uncertainties,
      reviewQuestions: draft.reviewQuestions,
      sourceReferences: draft.sourceReferences,
    },
    provenance: { provider: draft.providerId, model: draft.modelId, generatedAt: draft.generatedAt },
    requiresHumanReview: true,
    label: AI_DRAFT_LABEL,
  }
  return { status: 200, body }
}

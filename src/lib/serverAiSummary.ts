import type { LegalUpdate, LegalUpdateStatus } from '../types.js'
import type { ComplianceAiSummaryProvider } from './aiComplianceProvider.js'
import {
  DEFAULT_MAX_EVIDENCE_CHARS,
  generateAiDraftSummary,
  AI_DRAFT_LABEL,
} from './complianceAiSummarisation.js'
import type { AiSummaryResultCode } from './complianceAiSummarisation.js'
import {
  AI_SUMMARY_MAX_WINDOW_SECONDS,
  type AiSummaryThrottleReservation,
} from './serverAiSummaryThrottle.js'

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
  /** How many model-returned source references this server discarded as
   *  ungrounded. Carried so the browser can tell the reviewer; it cannot
   *  recompute the number, because `sections` is already filtered. */
  referenceIntegrity: { droppedReferences: number }
  requiresHumanReview: true
  label: string
}

export interface AiSummaryErrorBody {
  ok: false
  error: string
  message: string
  /** Present only on a 429. Seconds until the exceeded window frees a slot. */
  retryAfterSeconds?: number
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
  /**
   * Read the STORED legal update by id, under the caller's own RLS. Required,
   * not optional: it is the only thing that makes the evidence authoritative,
   * and an endpoint that could silently fall back to the request body would
   * reopen every gap it exists to close.
   */
  getLegalUpdate: (legalUpdateId: string) => Promise<LegalUpdate | null>
  /**
   * Atomically reserve one model call for this admin and report whether a
   * throttle window is exceeded. See src/lib/serverAiSummaryThrottle.ts.
   *
   * REQUIRED, and deliberately not optional. An optional throttle is one a
   * future dependency wiring can omit by accident, and the omission would be
   * invisible: the endpoint would keep returning 200s and simply stop having a
   * spend ceiling. Making it required means forgetting it is a type error.
   *
   * MUST THROW rather than return `{ allowed: true }` when the ledger cannot be
   * reached — the caller turns a throw into a fail-closed 503. An unreachable
   * throttle must never read as "no calls yet".
   */
  reserveAiSummarySlot: (userId: string) => Promise<AiSummaryThrottleReservation>
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
  // Optional on purpose. `legal_updates.source_url` is `TEXT NOT NULL DEFAULT ''`
  // (9_COMPLIANCE_WATCHTOWER_MVP.sql:27), so '' is the schema's own way of saying
  // "no source URL" — the ordinary shape of a manually pasted update with no
  // attribution, which complianceAiSummarisation already supports. Requiring a
  // valid URL here made every such update permanently un-summarisable: the client
  // forwards the stored '' verbatim, and the button failed 100% of the time while
  // still rendering as eligible.
  const sourceUrl = str('sourceUrl', MAX_URL_CHARS, false)
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
  //
  // A DECLARED url is still shape-checked — a caller may not pass "javascript:"
  // or a garbage string. Absent ('' or omitted) is accepted and normalised to ''.
  // This weakens nothing: the handler ignores this value entirely and reads the
  // stored row (see the comment above `deps.getLegalUpdate`), so the Cannamonitor
  // gate, the status check and the reference guard are unaffected by what is
  // declared here.
  const declaredSourceUrl = (sourceUrl as string | null) ?? ''
  if (declaredSourceUrl !== '' && !isHttpUrl(declaredSourceUrl)) {
    return { ok: false, code: 'invalid_url', reason: 'sourceUrl must be a valid http(s) URL when provided.' }
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
      sourceUrl: declaredSourceUrl,
      jurisdiction: jurisdiction as string,
      itemTitle: itemTitle as string,
      publishedAt: (publishedAt as string | null) ?? null,
      rawEvidence: rawEvidence as string,
      provenanceChecksum: (provenanceChecksum as string | null) ?? null,
      status: body.status as LegalUpdateStatus,
    },
  }
}

// `reconstructLegalUpdate` used to live here: it built a LegalUpdate out of the
// request body for the orchestration to guard. It is deliberately deleted
// rather than left unused — as long as such a function exists, the cheapest way
// to fix any future "the endpoint needs an update object" problem is to call it
// again, which silently restores caller-supplied evidence. The handler now
// reads the stored row via deps.getLegalUpdate.

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
  // Produced by the BROWSER orchestration when this endpoint returns a 4xx; the
  // server never emits it itself (a request the server rejects already carries
  // its own validation status). Mapped here only to keep the record exhaustive,
  // and to 400 so it can never be mistaken for a provider fault if that changes.
  request_invalid: 400,
  // 503, matching provider_unconfigured: the provider is reachable but this
  // deployment's AI settings are not usable, and a retry will not help.
  provider_rejected: 503,
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

  // ─── Spend ceiling ────────────────────────────────────────────────────────
  //
  // Placed HERE, and the position is a decision rather than an accident:
  //
  //   * AFTER authentication and the ddp_admin check, so an anonymous or
  //     non-admin caller cannot burn an admin's allowance — or the global
  //     ceiling — by firing requests it was never entitled to have served.
  //     A throttle in front of the auth gate would hand any stranger a denial-
  //     of-service against the whole feature.
  //   * AFTER validation, so a malformed body is a free 400. A UI bug that
  //     sends a bad payload in a loop is annoying; it should not also exhaust
  //     the reviewer's quota for the day and make the feature look broken.
  //   * BEFORE getLegalUpdate and the provider call, which are the database read
  //     and the paid model call this exists to bound.
  //
  // The reservation is consumed even when the caller is then refused. That is
  // deliberate and matches the intake path: retrying must keep consuming the
  // allowance rather than resetting it, or the limit is trivially defeated by
  // simply trying again.
  let reservation: AiSummaryThrottleReservation
  try {
    reservation = await deps.reserveAiSummarySlot(auth.userId)
  } catch {
    // The ledger could not be reached, so the call cannot be made within a known
    // bound. Fail closed. Waving it through would mean the ONE condition under
    // which spending is unbounded is also the condition nobody is watching.
    return err(
      503,
      'throttle_unavailable',
      'The service is temporarily unavailable. Please try again shortly.',
    )
  }

  if (!reservation.allowed) {
    return {
      status: 429,
      body: {
        ok: false,
        error: 'rate_limited',
        message: 'Too many AI summaries requested. Please try again later.',
        retryAfterSeconds: reservation.windowSeconds ?? AI_SUMMARY_MAX_WINDOW_SECONDS,
      },
    }
  }

  // ─── The evidence comes from the DATABASE, never from the caller ──────────
  //
  // Everything downstream — the Cannamonitor permission gate, the status
  // eligibility check, the evidence size bound, and the reference guard that
  // grounds the model's citations — reads its input from this update. While it
  // was reconstructed from the request body, every one of those checks was
  // validating a caller's submission against itself:
  //
  //   - a caller could declare a non-Cannamonitor sourceUrl while sending
  //     Cannamonitor evidence, and the gate would pass (attribution is by URL);
  //   - a caller could declare status 'new' for an already-reviewed update;
  //   - a caller could supply evidence containing whatever citation they wanted
  //     the reference guard to accept as grounded.
  //
  // The body is still validated for shape (a malformed request is still a 400)
  // but its evidence values are now ignored.
  let stored: LegalUpdate | null
  try {
    stored = await deps.getLegalUpdate(validation.value.legalUpdateId)
  } catch {
    // A read failure must not fall through to the caller's copy. Fail closed.
    return err(RESULT_STATUS.missing_update, 'missing_update', 'The legal update could not be read.')
  }
  if (!stored) {
    return err(
      RESULT_STATUS.missing_update,
      'missing_update',
      'No such legal update exists.',
    )
  }

  const result = await generateAiDraftSummary(stored, deps.provider, {
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
    referenceIntegrity: { droppedReferences: draft.droppedSourceReferences },
    requiresHumanReview: true,
    label: AI_DRAFT_LABEL,
  }
  return { status: 200, body }
}

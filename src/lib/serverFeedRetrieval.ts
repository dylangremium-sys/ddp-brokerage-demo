import type { RegulatorySource } from '../types.js'
import { normalizeConnectorHost } from './complianceSourceUrlSafety.js'
import {
  DEFAULT_RETRIEVAL_POLICY,
  type SourceRetrievalRecord,
} from './serverSourceRetrieval.js'
import {
  FEED_RETRIEVAL_MAX_WINDOW_SECONDS,
  type FeedRetrievalThrottleReservation,
} from './serverFeedRetrievalThrottle.js'

// ─── Server-side feed retrieval boundary — core ──────────────────────────────
//
// The framework-agnostic core of `api/compliance/feed-retrieve.ts`. Pure aside
// from injected dependencies, so it is exercised entirely with mocks — no real
// Supabase, no socket. It is modelled directly on serverAiSummary.ts and
// performs the same gate sequence for the same reasons:
//
//   1. method / content-type gate            (405 / 415)
//   2. bearer-token presence + validity       (401)
//   3. admin authorisation via the caller's   (403)
//      own profile row (role === 'ddp_admin')
//   4. strict request validation              (400 / 413)
//   5. spend/politeness ceiling               (429 / 503)
//   6. STORED source lookup, then retrieval
//
// WHY THIS ENDPOINT EXISTS AT ALL
// `src/lib/browserRssFetch.ts` cannot do this job, and the reason is measured
// rather than theoretical (docs/CSP_FEED_RETRIEVAL_DECISION.md): the deployed
// CSP restricts `connect-src` to 'self' and Supabase, and both registered feeds
// additionally send no `Access-Control-Allow-Origin`. So every browser-side
// feed check fails, and has always failed, regardless of the feed's behaviour.
// Widening the CSP is not the fix — administrators register feed URLs at
// runtime, and a static header cannot enumerate them. A server-side retrieval
// with a per-source allowlist can.
//
// WHY THE CALLER SENDS AN ID AND NOT A URL
// This is the same lesson the AI summariser learned the hard way in PR #102,
// applied here in advance rather than after a probe finds it. If the caller
// supplied the URL, this endpoint would be an authenticated, general-purpose
// outbound fetch primitive: the SSRF guard would still refuse private
// addresses, but an admin session could point DDP's server at any public host
// it liked and read the response. Taking a `sourceId` and reading the STORED
// `regulatory_sources` row means the set of reachable URLs is exactly the set
// an administrator has already registered and enabled — a decision made through
// the governed Source Registry, not through a request body.

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** Max characters for the whole decoded JSON body. The body carries two short
 *  fields, so this is generous by two orders of magnitude and exists only to
 *  bound a hostile payload before parsing work is done on it. */
export const MAX_REQUEST_CHARS = 4_000
const MAX_ID_CHARS = 200

/** The only capability this endpoint offers. Anything else is rejected. */
export const SUPPORTED_CAPABILITY = 'feed_retrieval'

const PERMITTED_FIELDS = new Set(['sourceId', 'capability'])

// ─── Request / response shapes ───────────────────────────────────────────────

export interface NormalizedRequest {
  method: string
  contentType: string | null
  authorization: string | null
  /** Either the undecoded JSON string or an already parsed object. */
  body: unknown
}

export type ValidationCode =
  | 'malformed_body'
  | 'unknown_field'
  | 'invalid_field'
  | 'invalid_capability'
  | 'oversized_request'

export type RequestValidation =
  | { ok: true; value: { sourceId: string } }
  | { ok: false; code: ValidationCode; reason: string }

/**
 * The retrieval outcome as returned to the browser.
 *
 * `content` is the retrieved document. It is safe to return to this caller and
 * to no other: the caller is already an authenticated `ddp_admin`, and the
 * document is public regulatory text they could fetch themselves. Nothing
 * derived from DDP's own state is included.
 */
export interface FeedRetrieveSuccessBody {
  ok: true
  retrieval: {
    status: SourceRetrievalRecord['status']
    requestedUrl: string
    finalUrl: string | null
    httpStatus: number | null
    contentType: string | null
    byteLength: number
    contentFingerprint: string | null
    retrievedAt: string
    redirectChain: string[]
    reason: string | null
    content: string | null
  }
  source: { id: string; name: string; url: string }
}

export interface FeedRetrieveErrorBody {
  ok: false
  error: string
  message: string
  /** Present only on a 429. Seconds until the exceeded window frees a slot. */
  retryAfterSeconds?: number
}

export interface HttpResult {
  status: number
  body: FeedRetrieveSuccessBody | FeedRetrieveErrorBody
}

export interface ServerFeedRetrievalDeps {
  /** Verify the caller's bearer token. Returns the user id, or null if invalid. */
  authenticate: (accessToken: string) => Promise<{ userId: string } | null>
  /** Read ONLY the authenticated caller's own profile role (RLS enforced). */
  getProfileRole: (userId: string) => Promise<string | null>
  /**
   * Read the STORED regulatory source by id, under the caller's own RLS.
   * Required, not optional: it is the only thing that makes the target URL
   * authoritative. See the header note on why the caller cannot supply a URL.
   */
  getRegulatorySource: (sourceId: string) => Promise<RegulatorySource | null>
  /**
   * Atomically reserve one retrieval for this admin.
   *
   * REQUIRED and deliberately not optional, for the reason spelled out in
   * serverAiSummary.ts: an optional throttle is one a future dependency wiring
   * can omit by accident, and the omission is invisible — the endpoint keeps
   * returning 200s and simply stops having a ceiling.
   *
   * MUST THROW rather than return `{ allowed: true }` when the ledger cannot be
   * reached. An unreachable throttle must never read as "no calls yet".
   */
  reserveFeedRetrievalSlot: (userId: string) => Promise<FeedRetrievalThrottleReservation>
  /**
   * Perform the guarded retrieval. Injected so this core never opens a socket
   * and never imports node:dns — the api adapter supplies the real retriever
   * together with a host resolver.
   */
  retrieve: (input: { url: string; allowedHosts: string[]; retrievedAt: string }) => Promise<SourceRetrievalRecord>
  /** Injected so the core stays clock-free and testable. */
  now: () => string
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

// ─── Strict request validation ───────────────────────────────────────────────

/**
 * Validates the decoded body. Rejects unknown fields, wrong types, oversized
 * strings and an unsupported capability. It does NOT decide whether the source
 * may be fetched — that depends on the stored row and is decided downstream.
 */
export function validateFeedRetrieveBody(raw: unknown): RequestValidation {
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
      // Named explicitly so a caller who sends `url` learns that this endpoint
      // does not accept one, rather than silently having it ignored.
      return { ok: false, code: 'unknown_field', reason: `Unexpected field "${key}".` }
    }
  }

  if (body.capability !== SUPPORTED_CAPABILITY) {
    return { ok: false, code: 'invalid_capability', reason: 'Unsupported or missing capability.' }
  }

  const sourceId = body.sourceId
  if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    return { ok: false, code: 'invalid_field', reason: 'Field "sourceId" must be a non-empty string.' }
  }
  if (sourceId.length > MAX_ID_CHARS) {
    return { ok: false, code: 'invalid_field', reason: 'Field "sourceId" is too long.' }
  }

  return { ok: true, value: { sourceId } }
}

// ─── Error mapping (no secrets, no stack traces) ─────────────────────────────

const VALIDATION_STATUS: Record<ValidationCode, number> = {
  malformed_body: 400,
  unknown_field: 400,
  invalid_field: 400,
  invalid_capability: 400,
  oversized_request: 413,
}

/**
 * Maps a retrieval outcome to an HTTP status.
 *
 * Every rejection is 422 rather than 502: the request was well-formed and
 * authorised, and DDP's own policy declined it. Only a genuine upstream failure
 * is a 502. Conflating the two is the recurring defect in this codebase's AI
 * client (`complianceAiSummaryClient.ts` maps every non-OK status to
 * "the provider could not complete the request"), where a policy refusal is
 * displayed to an operator as a vendor fault and the runbook's triage advice
 * sends them to the wrong place.
 */
const RETRIEVAL_STATUS: Record<SourceRetrievalRecord['status'], number> = {
  retrieved: 200,
  // DDP's own policy declined the target — the request never reached, or was
  // refused at, the upstream host.
  rejected_invalid_url: 422,
  rejected_not_https: 422,
  rejected_not_allowlisted: 422,
  rejected_private_network: 422,
  rejected_resolved_private: 422,
  rejected_disallowed_port: 422,
  rejected_redirect: 422,
  too_many_redirects: 422,
  rejected_content_type: 422,
  too_large: 422,
  // Genuine upstream faults. `http_error` covers the regulator answering with a
  // 4xx/5xx of its own — three of the six Thai sources returned 403 when
  // measured on 2026-07-28, so this is an expected steady-state outcome for
  // them, not an exceptional one.
  http_error: 502,
  fetch_failed: 502,
  timeout: 504,
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleFeedRetrieveRequest(
  req: NormalizedRequest,
  deps: ServerFeedRetrievalDeps,
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

  const validation = validateFeedRetrieveBody(req.body)
  if (!validation.ok) {
    return err(VALIDATION_STATUS[validation.code], validation.code, validation.reason)
  }

  // ─── Ceiling ──────────────────────────────────────────────────────────────
  //
  // Positioned exactly as the AI summariser's is, and for the same three
  // reasons: after auth so a stranger cannot exhaust an admin's allowance or
  // the global one; after validation so a malformed body is a free 400; before
  // the database read and the outbound fetch, which are what this bounds. The
  // reservation is consumed even when the caller is then refused — retrying
  // must keep consuming the allowance, or the limit is defeated by trying again.
  let reservation: FeedRetrievalThrottleReservation
  try {
    reservation = await deps.reserveFeedRetrievalSlot(auth.userId)
  } catch {
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
        message: 'Too many source retrievals requested. Please try again later.',
        retryAfterSeconds: reservation.windowSeconds ?? FEED_RETRIEVAL_MAX_WINDOW_SECONDS,
      },
    }
  }

  // ─── The target comes from the DATABASE, never from the caller ────────────
  let source: RegulatorySource | null
  try {
    source = await deps.getRegulatorySource(validation.value.sourceId)
  } catch {
    // A read failure must not fall through to any caller-supplied value —
    // there isn't one, and there must never come to be one. Fail closed.
    return err(404, 'unknown_source', 'The regulatory source could not be read.')
  }
  if (!source) {
    return err(404, 'unknown_source', 'No such regulatory source is registered.')
  }
  if (!source.isActive) {
    // Disabling a source in the registry is an operator instruction to stop
    // contacting that host. Honouring it only in the UI would make the toggle
    // decorative.
    return err(422, 'source_disabled', 'This regulatory source is disabled.')
  }

  // The allowlist is the source's OWN host and nothing else, rebuilt per
  // request from the stored row. Deny-by-default in the strongest available
  // form: even if a redirect chain stays on a host some other registered source
  // uses, this retrieval will not follow it.
  const host = normalizeConnectorHost(source.url)
  if (!host) {
    return err(422, 'rejected_invalid_url', 'The registered source URL is not a valid URL.')
  }

  const retrievedAt = deps.now()
  let record: SourceRetrievalRecord
  try {
    record = await deps.retrieve({ url: source.url, allowedHosts: [host], retrievedAt })
  } catch {
    return err(502, 'network_error', 'The source could not be retrieved.')
  }

  const status = RETRIEVAL_STATUS[record.status]
  if (status !== 200) {
    return err(status, record.status, record.reason ?? 'The source could not be retrieved.')
  }

  return {
    status: 200,
    body: {
      ok: true,
      retrieval: {
        status: record.status,
        requestedUrl: record.requestedUrl,
        finalUrl: record.finalUrl,
        httpStatus: record.httpStatus,
        contentType: record.contentType,
        byteLength: record.byteLength,
        contentFingerprint: record.contentFingerprint,
        retrievedAt: record.retrievedAt,
        redirectChain: record.redirectChain,
        reason: record.reason,
        content: record.content,
      },
      source: { id: source.id, name: source.name, url: source.url },
    },
  }
}

/** Re-exported so the api adapter can build a policy without importing two
 *  modules, and so the default bounds are asserted in one place. */
export { DEFAULT_RETRIEVAL_POLICY }

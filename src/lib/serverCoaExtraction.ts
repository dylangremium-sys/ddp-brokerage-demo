import {
  buildExtractions,
  crossCheckAgainstFilename,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type ExtractionRow,
  type RawExtractedReport,
} from './coaExtraction.js'

// ─── COA extraction endpoint — core ──────────────────────────────────────────
//
// The framework-agnostic core of api/compliance/coa-extract.ts, in the same
// shape as serverAiSummary.ts: pure apart from injected dependencies, so the
// whole gate order can be exercised with mocks and no network.
//
//   1. method / content-type gate        (405 / 415)
//   2. bearer token present + valid      (401)
//   3. ddp_admin only                    (403)
//   4. strict request validation         (400)
//   5. spend ceiling                     (429 / 503)
//   6. read the document under RLS       (404)
//   7. extract, validate, persist        (200)
//
// STAFF-TRIGGERED BY DESIGN (owner decision, 2026-08-03). Nothing fires on
// upload. A five-report pack is one large call, and a farmer uploading the wrong
// file six times must not cost six extractions.

export interface CoaDocument {
  id: string
  fileName: string
  /** Storage path, NOT the bytes. The server fetches them itself. */
  storagePath: string
  /** Set when this document has already been extracted — see the dedup note. */
  sha256Hex: string | null
}

export interface CoaExtractionDeps {
  authenticate: (accessToken: string) => Promise<{ userId: string } | null>
  getProfileRole: (userId: string) => Promise<string | null>
  /** Reads the document row under the CALLER's RLS. */
  getDocument: (documentId: string) => Promise<CoaDocument | null>
  /**
   * Fetches the PDF from private storage, server-side.
   *
   * THE BYTES NEVER COME FROM THE BROWSER. A client-supplied document is a
   * client-supplied claim — the same reasoning that made migration 24's evidence
   * path read the stored row rather than the request body. A caller who could
   * post their own PDF could have any numbers they liked extracted against
   * somebody else's batch.
   */
  fetchDocumentBytes: (storagePath: string) => Promise<Uint8Array>
  /** Returns one entry per report found. Several is normal — see coaExtraction. */
  extract: (pdf: Uint8Array) => Promise<RawExtractedReport[]>
  /** Atomically reserves one extraction against the spend ceiling. */
  reserveExtractionSlot: (userId: string) => Promise<{ allowed: boolean; windowSeconds?: number }>
  /** Writes the rows. Throws on failure. */
  persistExtractions: (
    documentId: string,
    rows: { reportNumber: string | null; row: ExtractionRow }[],
    recordedByUserId: string,
  ) => Promise<void>
  /** Already-extracted documents are not re-extracted. */
  countExistingExtractions: (documentId: string) => Promise<number>
  confidenceThreshold?: number
}

export interface CoaExtractRequest {
  method: string
  contentType: string | null
  authorization: string | null
  body: unknown
}

export interface CoaExtractResult {
  status: number
  body: Record<string, unknown>
}

function err(status: number, error: string, message: string, extra: Record<string, unknown> = {}): CoaExtractResult {
  return { status, body: { ok: false, error, message, ...extra } }
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const t = m?.[1]?.trim()
  return t ? t : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Accepts only `{ documentId }`. An unknown field is a rejected request, not an
 *  ignored one — same posture as the AI summary endpoint. */
export function validateCoaExtractBody(raw: unknown): { ok: true; documentId: string } | { ok: false; reason: string } {
  let body: unknown = raw
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return { ok: false, reason: 'Request body is not valid JSON.' }
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'A JSON object body is required.' }
  }
  const keys = Object.keys(body as Record<string, unknown>)
  const unknown = keys.filter((k) => k !== 'documentId')
  if (unknown.length > 0) return { ok: false, reason: `Unknown field: ${unknown[0]}` }

  const id = (body as Record<string, unknown>).documentId
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return { ok: false, reason: 'documentId must be a UUID.' }
  }
  return { ok: true, documentId: id }
}

export async function handleCoaExtractRequest(
  req: CoaExtractRequest,
  deps: CoaExtractionDeps,
): Promise<CoaExtractResult> {
  if (req.method.toUpperCase() !== 'POST') {
    return err(405, 'method_not_allowed', 'Only POST is supported.')
  }
  if (!req.contentType || !req.contentType.toLowerCase().includes('application/json')) {
    return err(415, 'unsupported_media_type', 'Content-Type must be application/json.')
  }

  const token = bearerToken(req.authorization)
  if (!token) return err(401, 'unauthenticated', 'A bearer access token is required.')

  let auth: { userId: string } | null
  try {
    auth = await deps.authenticate(token)
  } catch {
    return err(401, 'unauthenticated', 'The access token could not be verified.')
  }
  if (!auth) return err(401, 'unauthenticated', 'Invalid or expired access token.')

  let role: string | null
  try {
    role = await deps.getProfileRole(auth.userId)
  } catch {
    return err(403, 'forbidden', 'Access is restricted.')
  }
  if (role !== 'ddp_admin') return err(403, 'forbidden', 'Administrator access is required.')

  const validation = validateCoaExtractBody(req.body)
  if (!validation.ok) return err(400, 'invalid_request', validation.reason)

  // ─── Spend ceiling ────────────────────────────────────────────────────────
  //
  // AFTER the admin check, so a stranger cannot exhaust the daily allowance and
  // take the feature down for everyone. AFTER validation, so a malformed request
  // is free. BEFORE the model call, which is the thing that costs money.
  let reservation: { allowed: boolean; windowSeconds?: number }
  try {
    reservation = await deps.reserveExtractionSlot(auth.userId)
  } catch {
    // An unreachable ledger must never read as "no extractions yet" — that is the
    // one failure mode under which spending is unbounded.
    return err(503, 'throttle_unavailable', 'The service is temporarily unavailable. Please try again shortly.')
  }
  if (!reservation.allowed) {
    return err(429, 'rate_limited', 'Too many extractions requested. Please try again later.', {
      retryAfterSeconds: reservation.windowSeconds ?? 3600,
    })
  }

  let doc: CoaDocument | null
  try {
    doc = await deps.getDocument(validation.documentId)
  } catch {
    return err(404, 'document_not_found', 'The document could not be read.')
  }
  // "Does not exist" and "not yours" deliberately return the same answer.
  if (!doc) return err(404, 'document_not_found', 'No such document exists.')

  // ─── Do not pay twice for the same document ───────────────────────────────
  //
  // A cost control as much as a correctness one. Re-running would also create a
  // second set of machine rows competing with the first, which is worse than
  // useless when a reviewer is deciding what to accept.
  try {
    if ((await deps.countExistingExtractions(doc.id)) > 0) {
      return err(409, 'already_extracted', 'This document has already been extracted.')
    }
  } catch {
    return err(503, 'internal_error', 'The change could not be completed. Nothing has been altered.')
  }

  let pdf: Uint8Array
  try {
    pdf = await deps.fetchDocumentBytes(doc.storagePath)
  } catch {
    return err(502, 'document_unreadable', 'The document could not be retrieved from storage.')
  }

  let reports: RawExtractedReport[]
  try {
    reports = await deps.extract(pdf)
  } catch {
    // The exception is never inspected or returned: it is the object most likely
    // to carry the document contents or the provider's reply.
    return err(502, 'extraction_failed', 'The document could not be read. No values were recorded.')
  }
  if (!Array.isArray(reports) || reports.length === 0) {
    return err(422, 'no_reports_found', 'No laboratory report was recognised in this document.')
  }

  const extractions = buildExtractions(reports, {
    fileName: doc.fileName,
    threshold: deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  })

  const flat = extractions.flatMap((e) => e.rows.map((row) => ({ reportNumber: e.reportNumber, row })))

  try {
    await deps.persistExtractions(doc.id, flat, auth.userId)
  } catch {
    return err(503, 'internal_error', 'The extraction could not be saved. Nothing has been recorded.')
  }

  return {
    status: 200,
    body: {
      ok: true,
      // Several is normal, not an error: one PDF may hold a pack of reports.
      reportsFound: extractions.length,
      reports: extractions.map((e) => ({
        reportNumber: e.reportNumber,
        fieldsExtracted: e.rows.length,
        offeredForAcceptance: e.rows.filter((r) => r.offerForAcceptance).length,
        needsReview: e.rows.filter((r) => !r.offerForAcceptance).length,
        crossCheckWarnings: e.crossCheckWarnings,
      })),
      // Nothing here is a compliance decision. Every value is a draft until a
      // human accepts it — the same posture as the AI draft summariser.
      requiresHumanReview: true,
    },
  }
}

export { crossCheckAgainstFilename }

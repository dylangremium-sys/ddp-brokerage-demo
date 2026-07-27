// ─── COA review endpoint cores (Gate P0 — issue #77) ────────────────────────
//
// The pure, dependency-injected handlers behind api/compliance/coa-extract.ts
// and api/compliance/source-retrieve.ts. The api/ adapters are thin: they read
// server-only environment variables, wire these dependencies, and delegate.
// Everything decidable lives here so it is driven by real tests rather than by
// source-text assertions (api/ is outside the vitest include glob).
//
// Two deliberate architectural choices:
//
// 1. PDF bytes are processed ONLY here, server-side. The COA is private project
//    evidence; its bytes never reach a browser, and only extracted fields are
//    returned to the client.
//
// 2. Persistence also happens here, using a Supabase client bound to the
//    CALLER'S access token so RLS applies. If the browser persisted instead, a
//    client could POST arbitrary "extracted" values and the stored provenance
//    would be worthless. The server stores what it itself extracted.
//
// No service-role key is ever used: authorization is the caller's own admin
// role, checked against their own profile row under RLS.

import { extractPdfPages, type PdfTextExtractor } from './serverCoaPdf.js'
import { extractTnrCoa, fieldByKey, type TnrCoaExtraction } from './coaTnrAdapter.js'
import { deriveCoaFindings, type CoaFinding, type KnownCoaDocument } from './coaFindings.js'
import {
  retrieveOfficialSource,
  selectRelevantSection,
  type HostResolver,
  type SourceFetchImpl,
  type SourceRetrievalRecord,
} from './serverSourceRetrieval.js'
import { THAI_FDA_SOURCE, COA_SOURCE_POLICY, COA_RELEVANCE_TERMS } from './coaOfficialSources.js'
import {
  bindSuggestionToSource,
  composePreliminarySuggestion,
  type PersistedSourceVersion,
  type SuggestionState,
} from './coaSuggestionBinding.js'

export const COA_EXTRACT_ROUTE = 'api/compliance/coa-extract'
export const SOURCE_RETRIEVE_ROUTE = 'api/compliance/source-retrieve'

/**
 * Cap on the encoded payload.
 *
 * Set just under Vercel's ~4.5 MB request-body limit rather than at the
 * adapter's own 25 MB byte ceiling: a larger value is unreachable in practice,
 * because the platform rejects the request with an opaque error before this
 * handler ever runs. A real TNR COA is ~1.8 MB (~2.4 MB base64), so the
 * supported path has ample headroom. (Red-team finding, low severity.)
 */
export const MAX_BASE64_CHARS = 4 * 1024 * 1024

export const REQUIRED_ROLE = 'ddp_admin'

export interface NormalizedRequest {
  method: string
  contentType: string | null
  authorization: string | null
  body: unknown
}

export interface HttpResult {
  status: number
  body: unknown
}

// ─── Repository contract ─────────────────────────────────────────────────────

export interface StoredCoaDocument {
  coaDocumentId: string
  documentFingerprint: string
  reportNumber: string | null
  sampleName: string | null
}

export interface SaveExtractionInput {
  documentFingerprint: string
  sourceFilename: string
  byteLength: number
  pageCount: number
  parserVersion: string
  extractionStatus: string
  unsupportedReason: string | null
  reportNumber: string | null
  sampleName: string | null
  batchNumber: string | null
  warnings: string[]
  extractedAt: string
  fields: Array<{
    fieldKey: string
    label: string
    rawValue: string | null
    normalizedValue: string | null
    pageNumber: number | null
    extractionStatus: string
    warnings: string[]
  }>
  findings: CoaFinding[]
}

export interface SaveSourceVersionInput {
  sourceKey: string
  authority: string
  jurisdiction: string
  jurisdictionCode: string
  requestedUrl: string
  finalUrl: string | null
  retrievalStatus: string
  httpStatus: number | null
  contentType: string | null
  byteLength: number
  contentFingerprint: string | null
  redirectChain: string[]
  relevantSection: string
  sectionMatched: boolean
  matchedTerms: string[]
  failureReason: string | null
  retrievedAt: string
}

export interface SaveSuggestionInput {
  coaDocumentId: string
  sourceVersionId: string | null
  state: SuggestionState
  suggestionText: string
  reason: string | null
}

export interface AuditEventInput {
  action: string
  entityId: string
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
  reason: string | null
  evidenceVersion: string | null
  sourceVersionId: string | null
}

export interface CoaReviewRepository {
  /** Every document already on file — used for duplicate/reuse detection. */
  listKnownDocuments(): Promise<KnownCoaDocument[]>
  /** Upsert by document fingerprint; re-processing identical bytes is idempotent. */
  saveExtraction(input: SaveExtractionInput): Promise<StoredCoaDocument>
  getDocument(coaDocumentId: string): Promise<StoredCoaDocument | null>
  listFindings(coaDocumentId: string): Promise<CoaFinding[]>
  saveSourceVersion(input: SaveSourceVersionInput): Promise<PersistedSourceVersion>
  saveSuggestion(input: SaveSuggestionInput): Promise<{ suggestionId: string }>
  appendAuditEvent(input: AuditEventInput): Promise<void>
}

export interface ServerCoaReviewDeps {
  /** Verify the bearer token; returns the caller's user id or null. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>
  /** Read ONLY the caller's own profile role (RLS enforced). */
  getProfileRole(userId: string): Promise<string | null>
  /** Bound to the caller's token, so every write is RLS-checked. */
  repository: CoaReviewRepository
  pdfExtractor: PdfTextExtractor
  fetchImpl?: SourceFetchImpl
  /** Supplied server-side to enable resolved-IP SSRF checking. */
  resolveHost?: HostResolver
  /** Injected so the cores stay clock-free and deterministic under test. */
  now(): string
}

// ─── Shared request gate ─────────────────────────────────────────────────────

function error(status: number, code: string, message: string, requestId: string): HttpResult {
  return { status, body: { ok: false, error: code, message, requestId } }
}

/**
 * Method, content type, authentication and admin authorization.
 *
 * Authorization is a role read from the caller's OWN profile row under RLS —
 * never a flag taken from the request body. Returns the caller id, or the
 * HttpResult that must be returned instead.
 */
export async function gateRequest(
  request: NormalizedRequest,
  deps: ServerCoaReviewDeps,
  requestId: string,
): Promise<{ ok: true; userId: string } | { ok: false; result: HttpResult }> {
  if (request.method !== 'POST') {
    return { ok: false, result: error(405, 'method_not_allowed', 'Use POST.', requestId) }
  }

  const mediaType = (request.contentType ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return { ok: false, result: error(415, 'unsupported_media_type', 'Send application/json.', requestId) }
  }

  const header = request.authorization ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) {
    return { ok: false, result: error(401, 'unauthenticated', 'A bearer token is required.', requestId) }
  }

  let auth: { userId: string } | null
  try {
    auth = await deps.authenticate(token)
  } catch {
    auth = null
  }
  if (!auth) {
    return { ok: false, result: error(401, 'unauthenticated', 'The access token is not valid.', requestId) }
  }

  let role: string | null
  try {
    role = await deps.getProfileRole(auth.userId)
  } catch {
    role = null
  }
  if (role !== REQUIRED_ROLE) {
    // Deliberately identical to any other authorization failure: the response
    // reveals nothing about whether the account exists or what role it holds.
    return { ok: false, result: error(403, 'forbidden', 'Administrator access is required.', requestId) }
  }

  return { ok: true, userId: auth.userId }
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
}

/** Decode base64 without Node's Buffer, so this module stays isomorphic. */
export function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  try {
    const binary = atob(cleaned.replace(/\s/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

// ─── Endpoint 1: extract a supplied COA ──────────────────────────────────────

export async function handleCoaExtractRequest(
  request: NormalizedRequest,
  deps: ServerCoaReviewDeps,
  requestId: string,
): Promise<HttpResult> {
  const gate = await gateRequest(request, deps, requestId)
  if (!gate.ok) return gate.result

  const body = asRecord(request.body)
  if (!body) return error(400, 'invalid_body', 'The request body must be a JSON object.', requestId)

  const pdfBase64 = typeof body.pdfBase64 === 'string' ? body.pdfBase64 : ''
  const filename = typeof body.filename === 'string' ? body.filename.slice(0, 255) : ''

  if (!pdfBase64) return error(400, 'invalid_body', 'pdfBase64 is required.', requestId)
  if (pdfBase64.length > MAX_BASE64_CHARS) {
    return error(413, 'too_large', 'The document is too large.', requestId)
  }

  const bytes = decodeBase64(pdfBase64)
  if (!bytes) return error(400, 'invalid_body', 'pdfBase64 is not valid base64.', requestId)

  const now = deps.now()

  // ── Server-side extraction from the actual bytes ────────────────────────────
  const pdf = await extractPdfPages(bytes, deps.pdfExtractor)

  if (pdf.status !== 'ok') {
    // An unreadable document is a real, recordable outcome — but there is
    // nothing to persist as an extraction, so it is reported, not stored.
    await deps.repository
      .appendAuditEvent({
        action: 'coa_extraction_failed',
        entityId: pdf.documentFingerprint ?? 'unknown',
        beforeState: null,
        afterState: { extractionStatus: pdf.status },
        reason: pdf.message,
        evidenceVersion: null,
        sourceVersionId: null,
      })
      .catch(() => undefined)

    return {
      status: 422,
      body: {
        ok: false,
        error: 'unreadable_document',
        message: pdf.message ?? 'The document could not be read.',
        extractionStatus: pdf.status,
        documentFingerprint: pdf.documentFingerprint,
        requestId,
      },
    }
  }

  const extraction: TnrCoaExtraction = extractTnrCoa({
    pages: pdf.pages,
    documentFingerprint: pdf.documentFingerprint as string,
    extractedAt: now,
  })

  // Duplicate detection needs the documents already on file, excluding this one.
  const known = (await deps.repository.listKnownDocuments()).filter(
    (d) => d.documentFingerprint !== extraction.documentFingerprint,
  )
  const findings = deriveCoaFindings({ extraction, knownDocuments: known })

  const stored = await deps.repository.saveExtraction({
    documentFingerprint: extraction.documentFingerprint,
    sourceFilename: filename,
    byteLength: pdf.byteLength,
    pageCount: pdf.pageCount,
    parserVersion: extraction.parserVersion,
    extractionStatus: extraction.supported ? 'ok' : 'unsupported_format',
    unsupportedReason: extraction.unsupportedReason,
    reportNumber: fieldByKey(extraction, 'report_number')?.normalizedValue ?? null,
    sampleName: fieldByKey(extraction, 'sample_name')?.normalizedValue ?? null,
    batchNumber: fieldByKey(extraction, 'batch_number')?.normalizedValue ?? null,
    warnings: extraction.warnings,
    extractedAt: now,
    fields: extraction.fields.map((f) => ({
      fieldKey: f.key,
      label: f.label,
      rawValue: f.rawValue,
      normalizedValue: f.normalizedValue,
      pageNumber: f.pageNumber,
      extractionStatus: f.status,
      warnings: f.warnings,
    })),
    findings,
  })

  await deps.repository.appendAuditEvent({
    action: 'coa_document_extracted',
    entityId: stored.coaDocumentId,
    beforeState: null,
    afterState: {
      extractionStatus: extraction.supported ? 'ok' : 'unsupported_format',
      pageCount: pdf.pageCount,
      findingCount: findings.length,
    },
    reason: null,
    evidenceVersion: `${extraction.parserVersion}@${extraction.documentFingerprint}`,
    sourceVersionId: null,
  })

  return {
    status: 200,
    body: {
      ok: true,
      requestId,
      document: {
        coaDocumentId: stored.coaDocumentId,
        documentFingerprint: extraction.documentFingerprint,
        parserVersion: extraction.parserVersion,
        format: extraction.format,
        supported: extraction.supported,
        unsupportedReason: extraction.unsupportedReason,
        pageCount: pdf.pageCount,
        byteLength: pdf.byteLength,
        extractedAt: now,
        warnings: extraction.warnings,
      },
      fields: extraction.fields,
      panels: extraction.panels,
      findings,
    },
  }
}

// ─── Endpoint 2: retrieve the official source and bind a suggestion ──────────

export async function handleSourceRetrieveRequest(
  request: NormalizedRequest,
  deps: ServerCoaReviewDeps,
  requestId: string,
): Promise<HttpResult> {
  const gate = await gateRequest(request, deps, requestId)
  if (!gate.ok) return gate.result

  const body = asRecord(request.body)
  if (!body) return error(400, 'invalid_body', 'The request body must be a JSON object.', requestId)

  const coaDocumentId = typeof body.coaDocumentId === 'string' ? body.coaDocumentId : ''
  if (!coaDocumentId) return error(400, 'invalid_body', 'coaDocumentId is required.', requestId)

  const document = await deps.repository.getDocument(coaDocumentId)
  if (!document) return error(404, 'not_found', 'No such COA document.', requestId)

  const now = deps.now()

  // ── Fresh server-side retrieval through the full safety gate ──────────────
  const retrieval: SourceRetrievalRecord = await retrieveOfficialSource({
    url: THAI_FDA_SOURCE.url,
    policy: COA_SOURCE_POLICY,
    retrievedAt: now,
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
  })

  const section =
    retrieval.status === 'retrieved'
      ? selectRelevantSection(retrieval.content ?? '', COA_RELEVANCE_TERMS)
      : { section: '', matchedTerms: [], matched: false }

  const version = await deps.repository.saveSourceVersion({
    sourceKey: THAI_FDA_SOURCE.key,
    authority: THAI_FDA_SOURCE.authority,
    jurisdiction: THAI_FDA_SOURCE.jurisdiction,
    jurisdictionCode: THAI_FDA_SOURCE.jurisdictionCode,
    requestedUrl: retrieval.requestedUrl,
    finalUrl: retrieval.finalUrl,
    retrievalStatus: retrieval.status,
    httpStatus: retrieval.httpStatus,
    contentType: retrieval.contentType,
    byteLength: retrieval.byteLength,
    contentFingerprint: retrieval.contentFingerprint,
    redirectChain: retrieval.redirectChain,
    relevantSection: section.section,
    sectionMatched: section.matched,
    matchedTerms: section.matchedTerms,
    failureReason: retrieval.reason,
    retrievedAt: now,
  })

  await deps.repository.appendAuditEvent({
    action: retrieval.status === 'retrieved' ? 'coa_source_retrieved' : 'coa_source_retrieval_failed',
    entityId: coaDocumentId,
    beforeState: null,
    afterState: { retrievalStatus: retrieval.status, httpStatus: retrieval.httpStatus },
    reason: retrieval.reason,
    evidenceVersion: null,
    sourceVersionId: version.sourceVersionId,
  })

  // ── A failed retrieval yields an UNVERIFIED state and no suggestion ────────
  if (retrieval.status !== 'retrieved') {
    return {
      status: 200,
      body: {
        ok: true,
        requestId,
        sourceVersion: version,
        suggestion: null,
        suggestionState: 'not_created',
        suggestionReason:
          `The official source could not be verified (${retrieval.status}). ` +
          'No regulatory suggestion may rest on an unverified source.',
      },
    }
  }

  // ── Compose, then bind. Binding is what authorises display. ───────────────
  const findings = await deps.repository.listFindings(coaDocumentId)
  const text = composePreliminarySuggestion({
    sampleName: document.sampleName,
    reportNumber: document.reportNumber,
    findings,
    version,
  })

  const binding = bindSuggestionToSource(
    { coaDocumentId, sourceVersionId: version.sourceVersionId, text },
    [version],
  )

  const saved = await deps.repository.saveSuggestion({
    coaDocumentId,
    sourceVersionId: version.sourceVersionId,
    state: binding.state,
    suggestionText: text,
    reason: binding.reason,
  })

  await deps.repository.appendAuditEvent({
    action:
      binding.state === 'bound'
        ? 'coa_suggestion_bound'
        : binding.state === 'quarantined'
          ? 'coa_suggestion_quarantined'
          : 'coa_suggestion_rejected',
    entityId: coaDocumentId,
    beforeState: null,
    afterState: { suggestionId: saved.suggestionId, state: binding.state },
    reason: binding.reason,
    evidenceVersion: null,
    sourceVersionId: version.sourceVersionId,
  })

  return {
    status: 200,
    body: {
      ok: true,
      requestId,
      sourceVersion: version,
      suggestion: binding.suggestion,
      suggestionId: saved.suggestionId,
      suggestionState: binding.state,
      suggestionReason: binding.reason,
    },
  }
}

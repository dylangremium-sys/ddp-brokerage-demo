// ─── Browser client for the COA review flow (Gate P0 — issue #77) ───────────
//
// The Watchtower's COA tab talks to the server through this module.
//
// Division of responsibility, deliberately:
//   * EXTRACTION and SOURCE RETRIEVAL go through the server endpoints. The
//     browser never parses a PDF and never fetches a regulatory site, so what
//     is persisted is what the SERVER read — a client cannot fabricate an
//     extracted value or a source version.
//   * READS and the administrator's DECISION go directly to Supabase under the
//     caller's own session, where migration-31 RLS applies. The decision insert
//     is pinned by policy to `decided_by = auth.uid()`, so an unauthorized
//     attempt is refused by the database, not by this code.
//
// Nothing here is a simulation: there is no localStorage fallback for review
// state. When Supabase is not configured the tab reports that plainly rather
// than pretending to persist.

import { supabase, isSupabaseConfigured } from './supabase'
import { getSession } from '../services/auth'
import type { CoaExtractedField, CoaPanel } from './coaTnrAdapter'
import type { CoaFinding } from './coaFindings'

export interface CoaDocumentSummary {
  coaDocumentId: string
  documentFingerprint: string
  sourceFilename: string
  parserVersion: string
  extractionStatus: string
  unsupportedReason: string | null
  pageCount: number
  reportNumber: string | null
  sampleName: string | null
  batchNumber: string | null
  extractedAt: string
}

export interface CoaSourceVersionView {
  sourceVersionId: string
  authority: string
  jurisdiction: string
  jurisdictionCode: string
  requestedUrl: string
  finalUrl: string | null
  retrievalStatus: string
  httpStatus: number | null
  contentFingerprint: string | null
  retrievedAt: string
  relevantSection: string
  sectionMatched: boolean
  redirectChain: string[]
  failureReason: string | null
}

export interface CoaSuggestionView {
  suggestionId: string
  sourceVersionId: string | null
  state: 'bound' | 'quarantined' | 'rejected'
  suggestionText: string
  reason: string | null
  createdAt: string
}

export interface CoaDecisionView {
  decisionId: string
  decision: string
  previousState: string
  resultingState: string
  note: string
  evidenceVersion: string
  sourceVersionId: string | null
  decidedBy: string
  decidedAt: string
}

export interface CoaAuditEventView {
  action: string
  actorId: string | null
  beforeState: unknown
  afterState: unknown
  reason: string | null
  evidenceVersion: string | null
  sourceVersionId: string | null
  createdAt: string
}

export interface CoaExtractionResponse {
  document: {
    coaDocumentId: string
    documentFingerprint: string
    parserVersion: string
    format: string
    supported: boolean
    unsupportedReason: string | null
    pageCount: number
    byteLength: number
    extractedAt: string
    warnings: string[]
  }
  fields: CoaExtractedField[]
  panels: CoaPanel[]
  findings: CoaFinding[]
}

export interface CoaSourceResponse {
  sourceVersion: {
    sourceVersionId: string
    authority: string
    jurisdiction: string
    url: string
    retrievalStatus: string
    contentFingerprint: string | null
    retrievedAt: string
    section: string
  }
  suggestion: { text: string; sourceContentFingerprint: string } | null
  suggestionState: string
  suggestionReason: string | null
}

export class CoaReviewError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CoaReviewError'
  }
}

function requireClient() {
  if (!supabase || !isSupabaseConfigured) {
    throw new CoaReviewError(
      'not_configured',
      'Supabase is not configured, so COA review cannot read or store anything. ' +
        'This surface has no local simulation by design.',
    )
  }
  return supabase
}

async function authorizedFetch(route: string, payload: unknown): Promise<unknown> {
  const session = await getSession()
  const token = session?.access_token
  if (!token) throw new CoaReviewError('unauthenticated', 'Sign in as an administrator first.')

  let response: Response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new CoaReviewError('network_error', 'The request to the server failed.')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CoaReviewError('bad_response', `The server returned a non-JSON response (HTTP ${response.status}).`)
  }

  const record = (body ?? {}) as Record<string, unknown>
  if (!response.ok || record.ok !== true) {
    throw new CoaReviewError(
      typeof record.error === 'string' ? record.error : 'request_failed',
      typeof record.message === 'string' ? record.message : `The request failed (HTTP ${response.status}).`,
    )
  }
  return record
}

/** Read a File as base64 without loading it twice. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new CoaReviewError('read_failed', 'The file could not be read.'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new CoaReviewError('read_failed', 'The file could not be read.'))
        return
      }
      // Strip the data: URL prefix; the server also tolerates it.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** Send the COA to the server for extraction. The bytes never touch a parser here. */
export async function extractCoa(file: File): Promise<CoaExtractionResponse> {
  const pdfBase64 = await fileToBase64(file)
  const body = (await authorizedFetch('/api/compliance/coa-extract', {
    filename: file.name,
    pdfBase64,
  })) as Record<string, unknown>

  return {
    document: body.document as CoaExtractionResponse['document'],
    fields: (body.fields ?? []) as CoaExtractedField[],
    panels: (body.panels ?? []) as CoaPanel[],
    findings: (body.findings ?? []) as CoaFinding[],
  }
}

/** Ask the server to retrieve the official source and bind a suggestion. */
export async function retrieveOfficialSourceFor(coaDocumentId: string): Promise<CoaSourceResponse> {
  const body = (await authorizedFetch('/api/compliance/source-retrieve', {
    coaDocumentId,
  })) as Record<string, unknown>

  return {
    sourceVersion: body.sourceVersion as CoaSourceResponse['sourceVersion'],
    suggestion: (body.suggestion ?? null) as CoaSourceResponse['suggestion'],
    suggestionState: String(body.suggestionState ?? 'unknown'),
    suggestionReason: (body.suggestionReason ?? null) as string | null,
  }
}

// ─── Reads (RLS-enforced) ────────────────────────────────────────────────────

export async function listCoaDocuments(): Promise<CoaDocumentSummary[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('coa_documents')
    .select('id, document_fingerprint, source_filename, parser_version, extraction_status, unsupported_reason, page_count, report_number, sample_name, batch_number, extracted_at')
    .order('extracted_at', { ascending: false })
    .limit(50)
  if (error) throw new CoaReviewError('read_failed', error.message)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    coaDocumentId: row.id as string,
    documentFingerprint: row.document_fingerprint as string,
    sourceFilename: (row.source_filename as string) ?? '',
    parserVersion: row.parser_version as string,
    extractionStatus: row.extraction_status as string,
    unsupportedReason: (row.unsupported_reason as string | null) ?? null,
    pageCount: (row.page_count as number) ?? 0,
    reportNumber: (row.report_number as string | null) ?? null,
    sampleName: (row.sample_name as string | null) ?? null,
    batchNumber: (row.batch_number as string | null) ?? null,
    extractedAt: row.extracted_at as string,
  }))
}

export async function loadCoaFields(coaDocumentId: string): Promise<CoaExtractedField[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('coa_extracted_fields')
    .select('field_key, label, raw_value, normalized_value, page_number, extraction_status, warnings')
    .eq('coa_document_id', coaDocumentId)
  if (error) throw new CoaReviewError('read_failed', error.message)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    key: row.field_key as CoaExtractedField['key'],
    label: row.label as string,
    rawValue: (row.raw_value as string | null) ?? null,
    normalizedValue: (row.normalized_value as string | null) ?? null,
    pageNumber: (row.page_number as number | null) ?? null,
    status: row.extraction_status as CoaExtractedField['status'],
    warnings: (row.warnings as string[]) ?? [],
  }))
}

export async function loadCoaFindings(coaDocumentId: string): Promise<CoaFinding[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('coa_findings')
    .select('code, severity, title, detail, field_key, panel_key, page_number, finding_fingerprint')
    .eq('coa_document_id', coaDocumentId)
  if (error) throw new CoaReviewError('read_failed', error.message)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    code: row.code as CoaFinding['code'],
    severity: row.severity as CoaFinding['severity'],
    title: row.title as string,
    detail: (row.detail as string) ?? '',
    fieldKey: (row.field_key as CoaFinding['fieldKey']) ?? null,
    panelKey: (row.panel_key as CoaFinding['panelKey']) ?? null,
    pageNumber: (row.page_number as number | null) ?? null,
    fingerprint: row.finding_fingerprint as string,
  }))
}

export async function loadLatestSourceVersion(coaDocumentId: string): Promise<CoaSourceVersionView | null> {
  const client = requireClient()
  // The source version reached through this document's most recent suggestion,
  // falling back to the newest retrieval overall.
  const { data: suggestionRows } = await client
    .from('coa_suggestions')
    .select('source_version_id')
    .eq('coa_document_id', coaDocumentId)
    .order('created_at', { ascending: false })
    .limit(1)

  const linkedId = (suggestionRows ?? [])[0]?.source_version_id as string | undefined

  let query = client
    .from('coa_source_versions')
    .select('id, authority, jurisdiction, jurisdiction_code, requested_url, final_url, retrieval_status, http_status, content_fingerprint, retrieved_at, relevant_section, section_matched, redirect_chain, failure_reason')
    .order('retrieved_at', { ascending: false })
    .limit(1)
  if (linkedId) query = query.eq('id', linkedId)

  const { data, error } = await query
  if (error) throw new CoaReviewError('read_failed', error.message)
  const row = (data ?? [])[0] as Record<string, unknown> | undefined
  if (!row) return null

  return {
    sourceVersionId: row.id as string,
    authority: row.authority as string,
    jurisdiction: row.jurisdiction as string,
    jurisdictionCode: (row.jurisdiction_code as string) ?? '',
    requestedUrl: row.requested_url as string,
    finalUrl: (row.final_url as string | null) ?? null,
    retrievalStatus: row.retrieval_status as string,
    httpStatus: (row.http_status as number | null) ?? null,
    contentFingerprint: (row.content_fingerprint as string | null) ?? null,
    retrievedAt: row.retrieved_at as string,
    relevantSection: (row.relevant_section as string) ?? '',
    sectionMatched: Boolean(row.section_matched),
    redirectChain: (row.redirect_chain as string[]) ?? [],
    failureReason: (row.failure_reason as string | null) ?? null,
  }
}

export async function loadSuggestions(coaDocumentId: string): Promise<CoaSuggestionView[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('coa_suggestions')
    .select('id, source_version_id, state, suggestion_text, reason, created_at')
    .eq('coa_document_id', coaDocumentId)
    .order('created_at', { ascending: false })
  if (error) throw new CoaReviewError('read_failed', error.message)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    suggestionId: row.id as string,
    sourceVersionId: (row.source_version_id as string | null) ?? null,
    state: row.state as CoaSuggestionView['state'],
    suggestionText: row.suggestion_text as string,
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
  }))
}

export async function loadDecisions(coaDocumentId: string): Promise<CoaDecisionView[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('coa_decisions')
    .select('id, decision, previous_state, resulting_state, note, evidence_version, source_version_id, decided_by, decided_at')
    .eq('coa_document_id', coaDocumentId)
    .order('decided_at', { ascending: false })
  if (error) throw new CoaReviewError('read_failed', error.message)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    decisionId: row.id as string,
    decision: row.decision as string,
    previousState: row.previous_state as string,
    resultingState: row.resulting_state as string,
    note: (row.note as string) ?? '',
    evidenceVersion: row.evidence_version as string,
    sourceVersionId: (row.source_version_id as string | null) ?? null,
    decidedBy: row.decided_by as string,
    decidedAt: row.decided_at as string,
  }))
}

export async function loadAuditEvents(coaDocumentId: string): Promise<CoaAuditEventView[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_audit_log')
    .select('action, actor_id, before_state, after_state, reason, evidence_version, source_version_id, created_at')
    .eq('entity_type', 'coa')
    .eq('entity_id', coaDocumentId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw new CoaReviewError('read_failed', error.message)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    action: row.action as string,
    actorId: (row.actor_id as string | null) ?? null,
    beforeState: row.before_state,
    afterState: row.after_state,
    reason: (row.reason as string | null) ?? null,
    evidenceVersion: (row.evidence_version as string | null) ?? null,
    sourceVersionId: (row.source_version_id as string | null) ?? null,
    createdAt: row.created_at as string,
  }))
}

// ─── The administrator's decision ────────────────────────────────────────────

export const COA_DECISIONS = [
  { value: 'accepted_for_further_review', label: 'Accept for further review' },
  { value: 'information_requested', label: 'Request more information' },
  { value: 'escalated_to_legal', label: 'Escalate to legal review' },
  { value: 'on_hold', label: 'Place on hold' },
  { value: 'rejected', label: 'Reject this COA' },
] as const

export interface RecordDecisionInput {
  coaDocumentId: string
  sourceVersionId: string | null
  suggestionId: string | null
  decision: string
  previousState: string
  note: string
  evidenceVersion: string
}

/**
 * Record one administrator decision.
 *
 * `decided_by` is set to the caller's own user id, which the RLS policy also
 * requires — so this cannot be used to record a decision in someone else's
 * name, and a non-admin's insert is refused by the database.
 */
export async function recordCoaDecision(input: RecordDecisionInput): Promise<CoaDecisionView> {
  const client = requireClient()

  // One transaction via the migration-33 RPC. Previously the decision and its
  // audit event were two separate inserts, so a failure between them could
  // leave a recorded decision with no audit trail. The function pins
  // decided_by to auth.uid() and re-checks admin rights server-side, so a
  // non-admin call is still refused by the database.
  const { data, error } = await client.rpc('record_coa_decision', {
    p_coa_document_id: input.coaDocumentId,
    p_decision: input.decision,
    p_previous_state: input.previousState,
    p_note: input.note,
    p_evidence_version: input.evidenceVersion,
    p_source_version_id: input.sourceVersionId,
    p_suggestion_id: input.suggestionId,
  })

  if (error || !data) {
    throw new CoaReviewError('decision_refused', error?.message ?? 'The decision was refused.')
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>

  return {
    decisionId: row.id as string,
    decision: row.decision as string,
    previousState: row.previous_state as string,
    resultingState: row.resulting_state as string,
    note: (row.note as string) ?? '',
    evidenceVersion: row.evidence_version as string,
    sourceVersionId: (row.source_version_id as string | null) ?? null,
    decidedBy: row.decided_by as string,
    decidedAt: row.decided_at as string,
  }
}

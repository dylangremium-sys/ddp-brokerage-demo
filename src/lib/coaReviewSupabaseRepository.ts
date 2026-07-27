// ─── Supabase-backed COA review repository (Gate P0 — issue #77) ────────────
//
// Binds the CoaReviewRepository contract to the migration-31 tables.
//
// The client passed in is ALWAYS bound to the caller's access token, never to a
// service-role key, so every statement below is evaluated under RLS: an
// administrator writes as themselves, and a non-admin's writes are refused by
// the database rather than by this code.
//
// Errors are surfaced as thrown Error objects with safe messages; the endpoint
// adapters translate them into HTTP responses without echoing driver detail.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AuditEventInput,
  CoaReviewRepository,
  SaveExtractionInput,
  SaveSourceVersionInput,
  SaveSuggestionInput,
  StoredCoaDocument,
} from './serverCoaReview.js'
import type { CoaFinding } from './coaFindings.js'
import type { PersistedSourceVersion } from './coaSuggestionBinding.js'
import type { SourceRetrievalStatus } from './serverSourceRetrieval.js'

/** Row shapes, kept local so the module does not depend on generated types. */
interface DocumentRow {
  id: string
  document_fingerprint: string
  report_number: string | null
  sample_name: string | null
}

interface FindingRow {
  code: string
  severity: string
  title: string
  detail: string
  field_key: string | null
  panel_key: string | null
  page_number: number | null
  finding_fingerprint: string
}

interface SourceVersionRow {
  id: string
  authority: string
  jurisdiction: string
  requested_url: string
  final_url: string | null
  retrieval_status: string
  content_fingerprint: string | null
  retrieved_at: string
  relevant_section: string
}

function fail(operation: string, message?: string): never {
  throw new Error(`coa review repository: ${operation} failed${message ? ` (${message})` : ''}`)
}

export function createCoaReviewSupabaseRepository(
  client: SupabaseClient,
  actorId: string | null,
): CoaReviewRepository {
  return {
    async listKnownDocuments() {
      const { data, error } = await client
        .from('coa_documents')
        .select('id, document_fingerprint, report_number')
      if (error) fail('listKnownDocuments', error.message)
      return (data ?? []).map((row: { id: string; document_fingerprint: string; report_number: string | null }) => ({
        coaDocumentId: row.id,
        documentFingerprint: row.document_fingerprint,
        reportNumber: row.report_number,
      }))
    },

    async saveExtraction(input: SaveExtractionInput): Promise<StoredCoaDocument> {
      // Upsert on the byte fingerprint: re-processing identical bytes updates
      // the existing record rather than creating a second one.
      const { data, error } = await client
        .from('coa_documents')
        .upsert(
          {
            document_fingerprint: input.documentFingerprint,
            source_filename: input.sourceFilename,
            byte_length: input.byteLength,
            page_count: input.pageCount,
            parser_version: input.parserVersion,
            extraction_status: input.extractionStatus,
            unsupported_reason: input.unsupportedReason,
            report_number: input.reportNumber,
            sample_name: input.sampleName,
            batch_number: input.batchNumber,
            warnings: input.warnings,
            extracted_at: input.extractedAt,
            uploaded_by: actorId,
            updated_at: input.extractedAt,
          },
          { onConflict: 'document_fingerprint' },
        )
        .select('id, document_fingerprint, report_number, sample_name')
        .single()

      if (error || !data) fail('saveExtraction', error?.message)
      const document = data as DocumentRow

      if (input.fields.length > 0) {
        const { error: fieldsError } = await client.from('coa_extracted_fields').upsert(
          input.fields.map((field) => ({
            coa_document_id: document.id,
            field_key: field.fieldKey,
            label: field.label,
            raw_value: field.rawValue,
            normalized_value: field.normalizedValue,
            page_number: field.pageNumber,
            extraction_status: field.extractionStatus,
            warnings: field.warnings,
          })),
          { onConflict: 'coa_document_id,field_key' },
        )
        if (fieldsError) fail('saveExtraction.fields', fieldsError.message)
      }

      if (input.findings.length > 0) {
        // Idempotent by (document, fingerprint) — a retry re-derives the same
        // findings and must not duplicate them.
        const { error: findingsError } = await client.from('coa_findings').upsert(
          input.findings.map((finding) => ({
            coa_document_id: document.id,
            code: finding.code,
            severity: finding.severity,
            title: finding.title,
            detail: finding.detail,
            field_key: finding.fieldKey,
            panel_key: finding.panelKey,
            page_number: finding.pageNumber,
            finding_fingerprint: finding.fingerprint,
          })),
          { onConflict: 'coa_document_id,finding_fingerprint' },
        )
        if (findingsError) fail('saveExtraction.findings', findingsError.message)
      }

      return {
        coaDocumentId: document.id,
        documentFingerprint: document.document_fingerprint,
        reportNumber: document.report_number,
        sampleName: document.sample_name,
      }
    },

    async getDocument(coaDocumentId: string) {
      const { data, error } = await client
        .from('coa_documents')
        .select('id, document_fingerprint, report_number, sample_name')
        .eq('id', coaDocumentId)
        .maybeSingle()
      if (error) fail('getDocument', error.message)
      if (!data) return null
      const row = data as DocumentRow
      return {
        coaDocumentId: row.id,
        documentFingerprint: row.document_fingerprint,
        reportNumber: row.report_number,
        sampleName: row.sample_name,
      }
    },

    async listFindings(coaDocumentId: string): Promise<CoaFinding[]> {
      const { data, error } = await client
        .from('coa_findings')
        .select('code, severity, title, detail, field_key, panel_key, page_number, finding_fingerprint')
        .eq('coa_document_id', coaDocumentId)
      if (error) fail('listFindings', error.message)
      return (data ?? []).map((row: FindingRow) => ({
        code: row.code as CoaFinding['code'],
        severity: row.severity as CoaFinding['severity'],
        title: row.title,
        detail: row.detail,
        fieldKey: row.field_key as CoaFinding['fieldKey'],
        panelKey: row.panel_key as CoaFinding['panelKey'],
        pageNumber: row.page_number,
        fingerprint: row.finding_fingerprint,
      }))
    },

    async saveSourceVersion(input: SaveSourceVersionInput): Promise<PersistedSourceVersion> {
      const { data, error } = await client
        .from('coa_source_versions')
        .insert({
          source_key: input.sourceKey,
          authority: input.authority,
          jurisdiction: input.jurisdiction,
          jurisdiction_code: input.jurisdictionCode,
          requested_url: input.requestedUrl,
          final_url: input.finalUrl,
          retrieval_status: input.retrievalStatus,
          http_status: input.httpStatus,
          content_type: input.contentType,
          byte_length: input.byteLength,
          content_fingerprint: input.contentFingerprint,
          redirect_chain: input.redirectChain,
          relevant_section: input.relevantSection,
          section_matched: input.sectionMatched,
          matched_terms: input.matchedTerms,
          failure_reason: input.failureReason,
          retrieved_at: input.retrievedAt,
          retrieved_by: actorId,
        })
        .select('id, authority, jurisdiction, requested_url, final_url, retrieval_status, content_fingerprint, retrieved_at, relevant_section')
        .single()

      if (error || !data) fail('saveSourceVersion', error?.message)
      const row = data as SourceVersionRow

      return {
        sourceVersionId: row.id,
        authority: row.authority,
        jurisdiction: row.jurisdiction,
        url: row.final_url ?? row.requested_url,
        retrievalStatus: row.retrieval_status as SourceRetrievalStatus,
        contentFingerprint: row.content_fingerprint,
        retrievedAt: row.retrieved_at,
        section: row.relevant_section,
      }
    },

    async saveSuggestion(input: SaveSuggestionInput) {
      const { data, error } = await client
        .from('coa_suggestions')
        .insert({
          coa_document_id: input.coaDocumentId,
          source_version_id: input.sourceVersionId,
          state: input.state,
          suggestion_text: input.suggestionText,
          reason: input.reason,
          created_by: actorId,
        })
        .select('id')
        .single()

      // A refusal here is the migration-31 binding trigger doing its job.
      if (error || !data) fail('saveSuggestion', error?.message)
      return { suggestionId: (data as { id: string }).id }
    },

    async appendAuditEvent(input: AuditEventInput) {
      const { error } = await client.from('compliance_audit_log').insert({
        actor_type: 'admin',
        actor_id: actorId,
        action: input.action,
        entity_type: 'coa',
        entity_id: input.entityId,
        before_state: input.beforeState,
        after_state: input.afterState,
        reason: input.reason,
        evidence_version: input.evidenceVersion,
        source_version_id: input.sourceVersionId,
      })
      if (error) fail('appendAuditEvent', error.message)
    },
  }
}

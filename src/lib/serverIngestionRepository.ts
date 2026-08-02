import type { RegulatorySource } from '../types.js'
import type {
  CandidateLegalUpdateInput,
  CandidateLegalUpdateResult,
  CloseIngestionRunInput,
  InsertIngestionItemInput,
  OpenIngestionRunInput,
} from './complianceRepository.js'

// ─── Server-side ingestion repository ────────────────────────────────────────
//
// The five data dependencies watchtowerIngestionService needs, implemented
// against an INJECTED Supabase client instead of the browser singleton.
//
// WHY THIS EXISTS RATHER THAN REUSING complianceRepository
// Every function there calls `requireClient()`, a module-level singleton built
// from `import.meta.env.VITE_*` and carrying the signed-in user's session. In a
// Vercel Function there is no VITE_ env and no session, so those functions
// cannot run at all. The alternative — making `requireClient()` consult a
// mutable override — would put a process-global on the RLS boundary, where a
// stale override is a silent privilege change rather than a crash. An explicit
// factory cannot be left set by accident.
//
// PRIVILEGE, STATED PLAINLY
// The scheduled path runs with the service-role key and therefore BYPASSES RLS.
// That is unavoidable for an unattended job — there is no user whose row
// permissions it could inherit — so it is bounded instead of pretended away:
// this module is the only server-side writer, it touches exactly three tables
// (legal_updates, watchtower_ingestion_runs, watchtower_ingestion_items), it
// only ever INSERTs candidates in status 'new', and it never reads or writes
// any farmer, buyer, batch or profile row. Anything beyond that list is a
// widening of the scheduled job's blast radius and should be treated as such
// in review.
//
// Column mappings are copied from complianceRepository rather than shared,
// because sharing would mean exporting the row mappers and inviting the browser
// repository to grow a client parameter. The tests assert the two stay in step.

/** Minimal structural type for the Supabase client calls used here. Declared
 *  rather than imported so this module does not pull @supabase/supabase-js
 *  types into the app tsconfig for a server-only path. */
export interface IngestionDbClient {
  from(table: string): {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => { order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> }
        order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }>
      }
      order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }>
    } & Promise<{ data: unknown; error: unknown }>
    insert: (values: Record<string, unknown>) => {
      select: (columns: string) => { single: () => Promise<{ data: unknown; error: unknown }> }
    } & Promise<{ error: unknown }>
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          select: (columns: string) => { single: () => Promise<{ data: unknown; error: unknown }> }
        }
      }
    }
  }
}

interface PostgrestErrorLike {
  code?: string
  message?: string
}

/** Mirrors complianceRepository's unique-violation detection. A duplicate is a
 *  normal outcome of ingestion, not a failure, and must not fail the run. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as PostgrestErrorLike | null
  return !!e && (e.code === '23505' || /duplicate key value/i.test(e.message ?? ''))
}

function raise(context: string, error: unknown): void {
  if (error) {
    const message = (error as PostgrestErrorLike).message ?? 'unknown database error'
    throw new Error(`${context}: ${message}`)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** actor_id is a uuid column; a scheduled run has no user, and a non-uuid
 *  string here is a write error rather than a null. */
function asUuidOrNull(value: string | null): string | null {
  return value && UUID_RE.test(value) ? value : null
}

export interface ServerIngestionRepository {
  fetchActiveSources: () => Promise<RegulatorySource[]>
  fetchKnownIdentity: () => Promise<{ contentHashes: string[]; sourceExternalIds: string[] }>
  openRun: (input: OpenIngestionRunInput) => Promise<{ id: string }>
  closeRun: (id: string, input: CloseIngestionRunInput) => Promise<unknown>
  insertItem: (input: InsertIngestionItemInput) => Promise<void>
  insertCandidate: (input: CandidateLegalUpdateInput) => Promise<CandidateLegalUpdateResult>
}

export function createServerIngestionRepository(client: IngestionDbClient): ServerIngestionRepository {
  return {
    fetchActiveSources: async () => {
      const { data, error } = await client
        .from('regulatory_sources')
        .select('id, name, jurisdiction, source_type, url, is_active, tier, authority_type, category, monitoring_method, priority, created_at, updated_at')
        .eq('is_active', true)
        .order('priority', { ascending: false })
      raise('Loading active regulatory sources', error)
      const rows = (data as Record<string, unknown>[]) ?? []
      return rows.map(row => ({
        id: String(row.id),
        name: String(row.name ?? ''),
        jurisdiction: String(row.jurisdiction ?? ''),
        sourceType: String(row.source_type ?? ''),
        url: String(row.url ?? ''),
        isActive: row.is_active === true,
        tier: (row.tier ?? null) as RegulatorySource['tier'],
        authorityType: (row.authority_type ?? null) as RegulatorySource['authorityType'],
        category: (row.category ?? null) as RegulatorySource['category'],
        monitoringMethod: (row.monitoring_method ?? null) as RegulatorySource['monitoringMethod'],
        priority: (row.priority ?? null) as number | null,
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
      }))
    },

    fetchKnownIdentity: async () => {
      const { data, error } = await client
        .from('legal_updates')
        .select('source_id, content_hash, external_document_id')
      raise('Loading known legal-update identity for dedup', error)
      const rows = (data as { source_id: string | null; content_hash: string | null; external_document_id: string | null }[]) ?? []
      const contentHashes: string[] = []
      const sourceExternalIds: string[] = []
      for (const r of rows) {
        if (r.content_hash) contentHashes.push(r.content_hash)
        if (r.source_id && r.external_document_id) sourceExternalIds.push(`${r.source_id}::${r.external_document_id}`)
      }
      return { contentHashes, sourceExternalIds }
    },

    openRun: async (input) => {
      const { data, error } = await client
        .from('watchtower_ingestion_runs')
        .insert({
          source_id: input.sourceId,
          source_name_snapshot: input.sourceNameSnapshot,
          source_url_snapshot: input.sourceUrlSnapshot,
          source_tier_snapshot: input.sourceTierSnapshot,
          connector_kind: input.connectorKind,
          trigger_type: input.triggerType,
          actor_type: input.actorType,
          actor_id: asUuidOrNull(input.actorId),
          // Structural guarantee, same as the browser path: a run always opens
          // 'running'. The migration-25 CHECK forbids finished_at/failure_reason
          // on a running row.
          status: 'running',
        })
        .select('id')
        .single()
      raise('Opening ingestion run', error)
      return { id: String((data as { id: unknown }).id) }
    },

    closeRun: async (id, input) => {
      const { data, error } = await client
        .from('watchtower_ingestion_runs')
        .update({
          status: input.status,
          failure_reason: input.failureReason,
          error_detail: input.errorDetail,
          finished_at: input.finishedAt ?? new Date().toISOString(),
          items_seen: input.itemsSeen,
          items_new: input.itemsNew,
          items_duplicate: input.itemsDuplicate,
          items_unchanged: input.itemsUnchanged,
          items_failed: input.itemsFailed,
        })
        .eq('id', id)
        // The second predicate is load-bearing, not belt-and-braces: it is what
        // makes closing a run idempotent under a retried cron invocation. The
        // migration-25 trigger also forbids reopening a terminal run, so a
        // double-close is refused twice over.
        .eq('status', 'running')
        .select('id')
        .single()
      raise('Closing ingestion run', error)
      return data
    },

    insertItem: async (input) => {
      const { error } = await client.from('watchtower_ingestion_items').insert({
        run_id: input.runId,
        source_id: input.sourceId,
        item_key: input.itemKey,
        external_document_id: input.externalDocumentId,
        canonical_url: input.canonicalUrl,
        title: input.title,
        published_at: input.publishedAt,
        content_hash: input.contentHash,
        normalized_length: input.normalizedLength,
        dedup_decision: input.dedupDecision,
        dedup_matched_legal_update_id: input.dedupMatchedLegalUpdateId,
        legal_update_id: input.legalUpdateId,
        failure_reason: input.failureReason,
        error_detail: input.errorDetail,
      })
      raise('Recording ingestion item', error)
    },

    insertCandidate: async (input) => {
      const { data, error } = await client
        .from('legal_updates')
        .insert({
          source_id: input.sourceId,
          title: input.title,
          jurisdiction: input.jurisdiction,
          source_name: input.sourceName,
          source_url: input.sourceUrl,
          published_at: input.publishedAt,
          raw_text: input.rawText,
          summary: '',
          affected_areas: [],
          ai_risk_level: null,
          // Structural guarantee: a scheduled candidate can only ever be 'new'.
          // The scheduled job must not be able to produce anything a human has
          // not triaged, and this is the line that guarantees it.
          status: 'new',
          reviewer_notes: '',
          content_hash: input.contentHash,
          canonical_url: input.canonicalUrl,
          external_document_id: input.externalDocumentId,
          source_tier: input.sourceTier,
          ingestion_run_id: input.ingestionRunId,
          ingestion_item_key: input.ingestionItemKey,
        })
        .select('id')
        .single()

      if (error) {
        if (isUniqueViolation(error)) return { ok: false, duplicate: true }
        return { ok: false, error: (error as PostgrestErrorLike).message ?? 'candidate insert failed' }
      }
      // Only `id` is selected and only `id` is used downstream (to record the
      // link on the ingestion item). Selecting '*' would pull the full legal
      // text back out of the database for no reader.
      const row = data as { id: unknown }
      return {
        ok: true,
        legalUpdate: { id: String(row.id) } as CandidateLegalUpdateResult['legalUpdate'],
      }
    },
  }
}

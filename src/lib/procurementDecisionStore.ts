// ─── Procurement decision — server-authoritative store (Phase B) ────────────
//
// The procurement decision authorises the release of a buyer pack for a
// controlled-substance batch. It previously lived ONLY in the operator's browser
// (procurementControl.ts, key 'ddp_procurement_decisions'), with no actor, no
// reason, and no server row — editable from devtools and destroyed by a cache
// clear.
//
// This module makes public.procurement_decisions (17_PROCUREMENT_DECISIONS_MVP.sql)
// the system of record, and demotes localStorage to a CACHE.
//
// CONTRACT
//   • Server wins. If a server decision exists it is authoritative, always.
//   • localStorage still loads (backward compatibility with decisions recorded
//     before this migration) but is never preferred over the server.
//   • Nothing is ever silently discarded: a local-only decision is reported by
//     listLocalOnlyDecisions() so it can be migrated deliberately.
//   • Fail-safe, not fail-open: if the table is not deployed, or Supabase is not
//     configured (demo mode), every call degrades to the previous localStorage
//     behaviour. Applying the migration and deploying the app are therefore
//     independent, order-insensitive operations.
//
// The Supabase client is injected so this module is unit-testable without a
// database, matching the convention in complianceRepository.ts / serverAiSummary.ts.

import { supabase as defaultClient } from './supabase'
import {
  loadProcurementDecisions,
  saveProcurementDecision,
  PROCUREMENT_DECISION_LABELS,
  type StoredDecision,
} from './procurementControl'
import type { ProcurementDecision } from '../types'

/** Where the decision the UI is showing actually came from. */
export type DecisionSource = 'server' | 'local-cache' | 'none'

export interface ResolvedDecision {
  decision: ProcurementDecision | null
  reason: string | null
  decidedAt: string | null
  decidedBy: string | null
  source: DecisionSource
}

export interface RecordDecisionInput {
  batchId: string
  decision: ProcurementDecision
  reason: string
  /** Optional link to the immutable snapshot issued off this decision. */
  snapshotId?: string | null
  contentHash?: string | null
}

export interface RecordDecisionResult {
  ok: boolean
  /** 'server' = durably recorded. 'local-cache' = server unavailable, cached only. */
  persistedTo: 'server' | 'local-cache'
  error?: string
}

// Minimal structural type — avoids coupling to the full SupabaseClient generic.
interface DecisionClientLike {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        maybeSingle(): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>
      }
    }
    insert(row: Record<string, unknown>): Promise<{ error: { code?: string; message?: string } | null }>
  }
}

/** Postgres SQLSTATE for "relation does not exist" — i.e. migration 17 not applied. */
const UNDEFINED_TABLE = '42P01'

const TABLE = 'procurement_decisions'
const CURRENT_VIEW = 'procurement_decisions_current'

interface ServerDecisionRow {
  decision?: unknown
  reason?: unknown
  decided_at?: unknown
  decided_by?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// Every decision the UI can offer must be persistable. The label map is the one
// place the decision set is enumerated at runtime (its keys are exactly the
// ProcurementDecision union, enforced by its Record<ProcurementDecision, string>
// type), and it is what DDPBuyerPreview renders the dropdown from — so deriving
// the validator from it makes a UI option that the server rejects impossible.
// The DB CHECK in 17_PROCUREMENT_DECISIONS_MVP.sql:48 lists the same set.
function isProcurementDecision(v: unknown): v is ProcurementDecision {
  return typeof v === 'string' && Object.hasOwn(PROCUREMENT_DECISION_LABELS, v)
}

/**
 * True when the error means the table simply is not deployed yet. Treated as
 * "server unavailable", never as an application error — the app must keep
 * working against localStorage until migration 17 is applied.
 */
function isTableMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === UNDEFINED_TABLE) return true
  return /does not exist|could not find the table/i.test(error.message ?? '')
}

/**
 * Reads the authoritative decision for a batch from the server.
 * Returns null when there is no server decision, when the table is not
 * deployed, or when Supabase is not configured (demo mode).
 */
export async function fetchServerDecision(
  batchId: string,
  client: DecisionClientLike | null = defaultClient as DecisionClientLike | null,
): Promise<ResolvedDecision | null> {
  if (!client) return null

  const { data, error } = await client.from(CURRENT_VIEW)
    .select('decision, reason, decided_at, decided_by')
    .eq('batch_id', batchId)
    .maybeSingle()

  // Table absent (migration not applied) or any read failure ⇒ no server
  // decision. The caller falls back to the local cache.
  if (error || !data) return null

  const row = data as ServerDecisionRow
  if (!isProcurementDecision(row.decision)) return null

  return {
    decision: row.decision,
    reason: asString(row.reason),
    decidedAt: asString(row.decided_at),
    decidedBy: asString(row.decided_by),
    source: 'server',
  }
}

/**
 * Resolves the decision the UI should display. SERVER WINS.
 * Falls back to the localStorage cache only when the server has no row for this
 * batch — which is exactly the backward-compatibility case for decisions taken
 * before migration 17.
 */
export async function resolveDecision(
  batchId: string,
  client: DecisionClientLike | null = defaultClient as DecisionClientLike | null,
): Promise<ResolvedDecision> {
  const server = await fetchServerDecision(batchId, client)
  if (server) {
    // Refresh the cache so a subsequent synchronous render agrees with the server.
    try {
      saveProcurementDecision(batchId, server.decision as ProcurementDecision, server.reason ?? undefined)
    } catch {
      // A cache write failure must never break a successful server read.
    }
    return server
  }

  const local: StoredDecision | undefined = loadProcurementDecisions()[batchId]
  if (!local || !isProcurementDecision(local.decision)) {
    return { decision: null, reason: null, decidedAt: null, decidedBy: null, source: 'none' }
  }

  return {
    decision: local.decision,
    reason: asString(local.notes),
    decidedAt: asString(local.decidedAt),
    decidedBy: null, // pre-migration decisions have no recorded actor — that was the defect
    source: 'local-cache',
  }
}

/**
 * Records a decision. The server row is the audit record; the local write is
 * only a cache refresh so the synchronous render path stays consistent.
 *
 * `decided_by` is NOT sent: the column defaults to auth.uid() and the RLS policy
 * asserts decided_by = auth.uid(), so the actor is captured server-side and
 * cannot be spoofed by the client.
 */
export async function recordDecision(
  input: RecordDecisionInput,
  client: DecisionClientLike | null = defaultClient as DecisionClientLike | null,
): Promise<RecordDecisionResult> {
  const reason = input.reason.trim()
  if (!reason) {
    return { ok: false, persistedTo: 'local-cache', error: 'A reason is required to record a decision.' }
  }

  // Cache first so the UI stays consistent even if the network call fails, and
  // so a local-only decision is never lost — listLocalOnlyDecisions() will
  // surface it for migration.
  saveProcurementDecision(input.batchId, input.decision, reason)

  if (!client) {
    return { ok: true, persistedTo: 'local-cache' }
  }

  const { error } = await client.from(TABLE).insert({
    batch_id: input.batchId,
    decision: input.decision,
    reason,
    snapshot_id: input.snapshotId ?? null,
    content_hash: input.contentHash ?? null,
  })

  if (error) {
    // Migration not applied yet ⇒ previous behaviour, no user-visible failure.
    if (isTableMissing(error)) return { ok: true, persistedTo: 'local-cache' }
    // A real failure (e.g. RLS denied a non-admin) must be surfaced, not hidden.
    return {
      ok: false,
      persistedTo: 'local-cache',
      error: error.message ?? 'The decision could not be recorded on the server.',
    }
  }

  return { ok: true, persistedTo: 'server' }
}

/**
 * Batch ids that exist in the localStorage cache but have no server row.
 * These are decisions taken before migration 17. They are NEVER discarded and
 * never auto-uploaded — migrating them is a deliberate, operator-initiated act,
 * because each one needs a reason and an accountable actor it does not have.
 */
export async function listLocalOnlyDecisions(
  client: DecisionClientLike | null = defaultClient as DecisionClientLike | null,
): Promise<Array<{ batchId: string; decision: ProcurementDecision; decidedAt: string | null }>> {
  const local = loadProcurementDecisions()
  const batchIds = Object.keys(local)
  if (batchIds.length === 0 || !client) return []

  const localOnly: Array<{ batchId: string; decision: ProcurementDecision; decidedAt: string | null }> = []
  for (const batchId of batchIds) {
    const entry = local[batchId]
    if (!isProcurementDecision(entry?.decision)) continue
    const server = await fetchServerDecision(batchId, client)
    if (!server) {
      localOnly.push({
        batchId,
        decision: entry.decision,
        decidedAt: asString(entry.decidedAt),
      })
    }
  }
  return localOnly
}

/**
 * Migrates a single local-only decision to the server, under the CURRENT
 * operator's identity and with an explicit reason.
 *
 * The original decision has no recorded actor (that was the defect), so the
 * migrated row must not pretend otherwise: the reason is prefixed to state that
 * this is a migrated browser-local record and who re-attested it. Recording a
 * false provenance would be worse than the gap it replaces.
 */
export async function migrateLocalDecision(
  batchId: string,
  decision: ProcurementDecision,
  attestation: string,
  client: DecisionClientLike | null = defaultClient as DecisionClientLike | null,
): Promise<RecordDecisionResult> {
  const note = attestation.trim()
  if (!note) {
    return { ok: false, persistedTo: 'local-cache', error: 'An attestation is required to migrate a decision.' }
  }
  return recordDecision(
    {
      batchId,
      decision,
      reason: `[migrated from browser-local record; re-attested by the signed-in admin] ${note}`,
    },
    client,
  )
}

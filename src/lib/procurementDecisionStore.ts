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

/**
 * Where the decision the UI is showing actually came from.
 * 'unavailable' = the authoritative state could not be READ. It is NOT "no
 * decision": the caller must fail closed rather than trust the local cache.
 */
export type DecisionSource = 'server' | 'local-cache' | 'none' | 'unavailable'

export interface ResolvedDecision {
  decision: ProcurementDecision | null
  reason: string | null
  decidedAt: string | null
  decidedBy: string | null
  source: DecisionSource
  /** Set only when source === 'unavailable'. */
  error?: string
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
  /**
   * 'server'      = durably recorded, server-accepted.
   * 'local-cache' = the table is not deployed (or demo mode); cached only.
   * 'none'        = the server REFUSED the write. Nothing was cached, so this
   *                 decision cannot authorise anything.
   */
  persistedTo: 'server' | 'local-cache' | 'none'
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

/** PostgREST: the table is absent from the schema cache. */
const MISSING_TABLE_PGRST = 'PGRST205'

/** The only objects whose absence may legitimately degrade to the local cache. */
const DECISION_OBJECT = /procurement_decisions(_current)?/i

/**
 * True ONLY when the procurement-decision table itself is not deployed. That is
 * "server not provisioned yet" and may degrade to localStorage.
 *
 * Everything else — permission/RLS denial (42501), authentication failure,
 * undefined_column (42703, i.e. schema drift), validation, transient 5xx,
 * network — is an AUTHORITATIVE READ/WRITE FAILURE and must NOT degrade. Falling
 * back on those would let a stale or server-rejected cache authorise a buyer-pack
 * release, which is exactly the hole this store exists to close.
 *
 * The message fallback is deliberately narrow: it applies only when there is no
 * error code at all AND the message names the procurement-decision object, so a
 * generic "... does not exist" (e.g. a missing column) can never be mistaken for
 * a missing table.
 */
function isTableMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code) return error.code === UNDEFINED_TABLE || error.code === MISSING_TABLE_PGRST
  const message = error.message ?? ''
  return /does not exist|could not find the table|schema cache/i.test(message) && DECISION_OBJECT.test(message)
}

/**
 * The authoritative decision state could not be read. NOT the same as "there is
 * no decision" — the caller must fail closed, never substitute the local cache.
 */
export class DecisionReadUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionReadUnavailableError'
  }
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

  if (error) {
    // Migration 17 not applied ⇒ no server decision exists; the caller may use
    // the local cache. Any OTHER error means the authoritative state is unknown:
    // permission, RLS, auth, transient, schema drift. Those must fail closed.
    if (!isTableMissing(error)) {
      throw new DecisionReadUnavailableError(
        error.message ?? `The authoritative procurement decision could not be read (${error.code ?? 'unknown error'}).`,
      )
    }
    return null
  }
  if (!data) return null

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
  let server: ResolvedDecision | null
  try {
    server = await fetchServerDecision(batchId, client)
  } catch (err) {
    // The authoritative state is UNKNOWN. Reporting the cache here would let a
    // stale 'progress' authorise a release while the server may say hold/reject.
    // Fail closed: no decision, and say why.
    if (err instanceof DecisionReadUnavailableError) {
      return { decision: null, reason: null, decidedAt: null, decidedBy: null, source: 'unavailable', error: err.message }
    }
    throw err
  }

  if (server) {
    // Refresh the cache so a subsequent synchronous render agrees with the server.
    // The SERVER's decided_at is preserved — stamping browser time here would
    // rewrite the approval timestamp that prepareBuyerPackSnapshotInput freezes
    // into an immutable snapshot, so merely opening a pack would change it.
    try {
      saveProcurementDecision(
        batchId,
        server.decision as ProcurementDecision,
        server.reason ?? undefined,
        server.decidedAt ?? undefined,
      )
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

  // DEMO MODE (no Supabase): the local cache IS the store, exactly as before.
  if (!client) {
    saveProcurementDecision(input.batchId, input.decision, reason)
    return { ok: true, persistedTo: 'local-cache' }
  }

  // THE SERVER DECIDES FIRST. The cache is written only after the server accepts
  // the decision (or tells us the table does not exist).
  //
  // Writing the cache first — as this did — meant an insert refused by RLS still
  // left a 'progress' decision in localStorage, and the buyer-pack issue gate
  // reads that cache: a decision the SERVER REJECTED could authorise a release.
  // Migration 23 (23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql) hardened the
  // issue RPC so it now re-reads procurement_decisions_current server-side and
  // ignores the client-supplied p_procurement_decision — so the DB is the last
  // line of defence. This client-side discipline is therefore defence-in-depth,
  // not the sole guard: the cache must never record an unaccepted decision, and a
  // failed attempt must leave any prior legitimate record untouched, so the UI can
  // never even present a server-rejected decision as approved.
  const { error } = await client.from(TABLE).insert({
    batch_id: input.batchId,
    decision: input.decision,
    reason,
    snapshot_id: input.snapshotId ?? null,
    content_hash: input.contentHash ?? null,
  })

  if (error) {
    // Migration not applied yet ⇒ deliberate local-only fallback, as before.
    if (isTableMissing(error)) {
      saveProcurementDecision(input.batchId, input.decision, reason)
      return { ok: true, persistedTo: 'local-cache' }
    }
    // A genuine failure (RLS/permission/auth/validation/network). NOTHING is
    // cached: no new approval is created, and any prior record survives intact.
    return {
      ok: false,
      persistedTo: 'none',
      error: error.message ?? 'The decision could not be recorded on the server.',
    }
  }

  // Accepted by the server ⇒ safe to mirror into the cache.
  saveProcurementDecision(input.batchId, input.decision, reason)
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

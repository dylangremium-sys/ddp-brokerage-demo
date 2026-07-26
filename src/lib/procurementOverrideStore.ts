// ─── Procurement overrides — server-authoritative store (audit F2b) ──────────
//
// The release gate has two halves:
//   hasBlockingIssues = blockerRequirements.length > 0
//                     || unresolvedRisks.some(r => r.severity === 'blocker')
// (src/pages/admin/DDPBuyerPreview.tsx:89-92). Both inputs are operator-
// overridable. The DECISION half of that same invariant was made append-only,
// server-side and auth.uid()-bound by migration 17 and procurementDecisionStore.
// The OVERRIDE half was not: `ddp_risk_overrides` and `ddp_requirement_overrides`
// wrote straight to localStorage (procurementControl.ts:161-165, :321-325), NOT
// gated by shouldPersistToBrowser(), so it happened in Supabase mode too — and
// both keys are in SENSITIVE_DDP_KEYS, which signOut() wipes.
//
// So: admin A's clearances were invisible to admin B; every clearance silently
// reverted at sign-out; there was no actor, timestamp or reason behind a decision
// gating controlled-substance disclosure; and the values were settable from
// devtools by the very person the record is meant to hold accountable.
//
// This module makes public.risk_overrides / public.requirement_overrides
// (30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql) the system of
// record and demotes localStorage to a CACHE.
//
// CONTRACT — deliberately identical to procurementDecisionStore, because these
// two stores gate the SAME invariant and must not disagree about what counts as
// authoritative:
//   • Server wins. If a server override exists it is authoritative, always.
//   • localStorage still loads (backward compatibility with overrides recorded
//     before this migration) but is never preferred over the server.
//   • FAIL CLOSED, not fail open: if the authoritative read FAILS, the result is
//     'unavailable' — which is NOT "no override". The caller must treat the gate
//     as shut rather than substitute the cache. An override is a CLEARANCE; a
//     stale cached clearance is exactly what must never authorise a release.
//   • ONLY a genuinely absent table (42P01 / PGRST205) degrades to local. A
//     permission/RLS denial, schema drift, auth failure or network error does
//     not — degrading on those would let a server-refused clearance through.
//   • A failed write caches NOTHING, so the UI can never present a clearance the
//     server rejected.
//
// The Supabase client is injected so this module is unit-testable without a
// database, matching complianceRepository.ts / procurementDecisionStore.ts.

import { supabase as defaultClient } from './supabase'
import {
  loadRiskOverrides,
  saveRiskOverride,
  loadRequirementOverrides,
  saveRequirementOverride,
} from './procurementControl'
import type { RiskStatus, EvidenceStatus, DocumentRequirementType } from '../types'

/**
 * Where the override the UI is showing actually came from.
 * 'unavailable' = the authoritative state could not be READ. It is NOT "no
 * override": the caller must fail closed, never substitute the local cache.
 */
export type OverrideSource = 'server' | 'local-cache' | 'none' | 'unavailable'

export interface ResolvedRiskOverride {
  status: RiskStatus | null
  reason: string | null
  owner: string | null
  decidedAt: string | null
  decidedBy: string | null
  source: OverrideSource
  /** Set only when source === 'unavailable'. */
  error?: string
}

export interface ResolvedRequirementOverride {
  status: EvidenceStatus | null
  reason: string | null
  notes: string | null
  decidedAt: string | null
  decidedBy: string | null
  source: OverrideSource
  error?: string
}

export interface RecordOverrideResult {
  ok: boolean
  /**
   * 'server'      = durably recorded, server-accepted.
   * 'local-cache' = the table is not deployed (or demo mode); cached only.
   * 'none'        = the server REFUSED the write. Nothing was cached, so this
   *                 override cannot clear anything.
   */
  persistedTo: 'server' | 'local-cache' | 'none'
  error?: string
}

// Minimal structural type — avoids coupling to the full SupabaseClient generic.
// Exported so a test double can be TYPED against it rather than cast through
// `any`: a double is only meaningful if it actually satisfies the contract this
// module consumes, and a cast hides the day that contract changes.
export interface OverrideClientLike {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        maybeSingle(): Promise<{ data: unknown; error: DbError | null }>
        eq(col2: string, val2: string): {
          maybeSingle(): Promise<{ data: unknown; error: DbError | null }>
        }
      }
    }
    insert(row: Record<string, unknown>): Promise<{ error: DbError | null }>
  }
}

interface DbError { code?: string; message?: string }

/** Postgres SQLSTATE for "relation does not exist" — i.e. migration 30 not applied. */
const UNDEFINED_TABLE = '42P01'
/** PostgREST: the table is absent from the schema cache. */
const MISSING_TABLE_PGRST = 'PGRST205'

const RISK_TABLE = 'risk_overrides'
const RISK_VIEW = 'risk_overrides_current'
const REQUIREMENT_TABLE = 'requirement_overrides'
const REQUIREMENT_VIEW = 'requirement_overrides_current'

/** The only objects whose absence may legitimately degrade to the local cache. */
const OVERRIDE_OBJECT = /(risk|requirement)_overrides(_current)?/i

const RISK_STATUSES: readonly RiskStatus[] = ['open', 'in_review', 'resolved', 'accepted']
const EVIDENCE_STATUSES: readonly EvidenceStatus[] = [
  'claimed', 'documented', 'reviewed', 'verified', 'missing', 'rejected', 'expired',
]

function isRiskStatus(v: unknown): v is RiskStatus {
  return typeof v === 'string' && (RISK_STATUSES as readonly string[]).includes(v)
}
function isEvidenceStatus(v: unknown): v is EvidenceStatus {
  return typeof v === 'string' && (EVIDENCE_STATUSES as readonly string[]).includes(v)
}
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * True ONLY when the override table itself is not deployed. That is "server not
 * provisioned yet" and may degrade to localStorage.
 *
 * Everything else — permission/RLS denial (42501), authentication failure,
 * undefined_column (42703, i.e. schema drift), validation, transient 5xx,
 * network — is an AUTHORITATIVE READ/WRITE FAILURE and must NOT degrade.
 *
 * The message fallback is deliberately narrow: it applies only when there is no
 * error code at all AND the message names an override object, so a generic
 * "... does not exist" (e.g. a missing column) can never be mistaken for a
 * missing table.
 */
function isTableMissing(error: DbError | null): boolean {
  if (!error) return false
  if (error.code) return error.code === UNDEFINED_TABLE || error.code === MISSING_TABLE_PGRST
  const message = error.message ?? ''
  return /does not exist|could not find the table|schema cache/i.test(message) && OVERRIDE_OBJECT.test(message)
}

/**
 * The authoritative override state could not be read. NOT the same as "there is
 * no override" — the caller must fail closed.
 */
export class OverrideReadUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OverrideReadUnavailableError'
  }
}

function unavailableMessage(error: DbError): string {
  return error.message ?? `The authoritative override could not be read (${error.code ?? 'unknown error'}).`
}

// ─── Risk overrides ──────────────────────────────────────────────────────────

/**
 * Resolves the override for a risk. SERVER WINS.
 *
 * `riskId` is the CONTENT-BOUND id from composeRiskId() — `risk-batch-<id>#<fp>`.
 * That is deliberate and load-bearing: an override recorded against superseded
 * risk content has a different id, so it simply does not match, and a clearance
 * cannot travel to a risk that has since changed (audit F1a). Passing a bare
 * batch id here would reintroduce that defect.
 */
export async function resolveRiskOverride(
  riskId: string,
  client: OverrideClientLike | null = defaultClient as OverrideClientLike | null,
): Promise<ResolvedRiskOverride> {
  const none: ResolvedRiskOverride = {
    status: null, reason: null, owner: null, decidedAt: null, decidedBy: null, source: 'none',
  }

  const fromCache = (): ResolvedRiskOverride => {
    const local = loadRiskOverrides()[riskId]
    if (!local || !isRiskStatus(local.status)) return none
    return {
      status: local.status,
      reason: null,          // pre-migration overrides carry no reason — that was the defect
      owner: asString(local.owner),
      decidedAt: asString(local.updatedAt),
      decidedBy: null,       // ...and no actor
      source: 'local-cache',
    }
  }

  // DEMO MODE (no Supabase): the cache IS the store, exactly as before.
  if (!client) return fromCache()

  const { data, error } = await client.from(RISK_VIEW)
    .select('status, reason, owner, decided_at, decided_by')
    .eq('risk_id', riskId)
    .maybeSingle()

  if (error) {
    if (!isTableMissing(error)) {
      // FAIL CLOSED. The gate must not open on a cached clearance.
      return {
        ...none,
        source: 'unavailable',
        error: unavailableMessage(error),
      }
    }
    return fromCache()
  }
  if (!data) return fromCache()

  const row = data as Record<string, unknown>
  if (!isRiskStatus(row.status)) return fromCache()

  return {
    status: row.status,
    reason: asString(row.reason),
    owner: asString(row.owner),
    decidedAt: asString(row.decided_at),
    decidedBy: asString(row.decided_by),
    source: 'server',
  }
}

/**
 * Records a risk override. The server row is the audit record; the local write is
 * only a cache refresh so the synchronous render path stays consistent.
 *
 * `decided_by` is NOT sent: the column defaults to auth.uid() and the RLS policy
 * asserts decided_by = auth.uid(), so the actor is captured server-side and
 * cannot be spoofed by the client.
 */
export async function recordRiskOverride(
  input: { riskId: string; status: RiskStatus; reason: string; owner?: string },
  client: OverrideClientLike | null = defaultClient as OverrideClientLike | null,
): Promise<RecordOverrideResult> {
  const reason = input.reason.trim()
  if (!reason) {
    // The DB CHECK enforces this too; refusing here means the operator is never
    // surprised by a rejection after the fact.
    return { ok: false, persistedTo: 'none', error: 'A reason is required to override a risk.' }
  }

  if (!client) {
    saveRiskOverride(input.riskId, input.status, input.owner, reason)
    return { ok: true, persistedTo: 'local-cache' }
  }

  const { error } = await client.from(RISK_TABLE).insert({
    risk_id: input.riskId,
    status: input.status,
    reason,
    owner: input.owner ?? null,
  })

  if (error) {
    if (isTableMissing(error)) {
      saveRiskOverride(input.riskId, input.status, input.owner, reason)
      return { ok: true, persistedTo: 'local-cache' }
    }
    // A genuine failure (RLS/permission/auth/validation/network). NOTHING is
    // cached: no new clearance is created, and any prior record survives intact.
    return { ok: false, persistedTo: 'none', error: error.message ?? 'The override could not be recorded on the server.' }
  }

  saveRiskOverride(input.riskId, input.status, input.owner, reason)
  return { ok: true, persistedTo: 'server' }
}

// ─── Requirement overrides ───────────────────────────────────────────────────

/** Resolves the override for a farm's document requirement. SERVER WINS. */
export async function resolveRequirementOverride(
  farmId: string,
  type: DocumentRequirementType,
  client: OverrideClientLike | null = defaultClient as OverrideClientLike | null,
): Promise<ResolvedRequirementOverride> {
  const none: ResolvedRequirementOverride = {
    status: null, reason: null, notes: null, decidedAt: null, decidedBy: null, source: 'none',
  }

  const fromCache = (): ResolvedRequirementOverride => {
    const local = loadRequirementOverrides()[`${farmId}::${type}`]
    if (!local || !isEvidenceStatus(local.status)) return none
    return {
      status: local.status,
      reason: null,
      notes: asString(local.notes),
      decidedAt: asString(local.lastUpdated),
      decidedBy: null,
      source: 'local-cache',
    }
  }

  if (!client) return fromCache()

  const { data, error } = await client.from(REQUIREMENT_VIEW)
    .select('status, reason, notes, decided_at, decided_by')
    .eq('farm_id', farmId)
    .eq('requirement_type', type)
    .maybeSingle()

  if (error) {
    if (!isTableMissing(error)) {
      return { ...none, source: 'unavailable', error: unavailableMessage(error) }
    }
    return fromCache()
  }
  if (!data) return fromCache()

  const row = data as Record<string, unknown>
  if (!isEvidenceStatus(row.status)) return fromCache()

  return {
    status: row.status,
    reason: asString(row.reason),
    notes: asString(row.notes),
    decidedAt: asString(row.decided_at),
    decidedBy: asString(row.decided_by),
    source: 'server',
  }
}

/** Records a requirement override. Same server-first discipline as risks. */
export async function recordRequirementOverride(
  input: {
    farmId: string
    type: DocumentRequirementType
    status: EvidenceStatus
    reason: string
    notes?: string
  },
  client: OverrideClientLike | null = defaultClient as OverrideClientLike | null,
): Promise<RecordOverrideResult> {
  const reason = input.reason.trim()
  if (!reason) {
    return { ok: false, persistedTo: 'none', error: 'A reason is required to override a requirement.' }
  }

  if (!client) {
    saveRequirementOverride(input.farmId, input.type, input.status, input.notes)
    return { ok: true, persistedTo: 'local-cache' }
  }

  const { error } = await client.from(REQUIREMENT_TABLE).insert({
    farm_id: input.farmId,
    requirement_type: input.type,
    status: input.status,
    reason,
    notes: input.notes ?? null,
  })

  if (error) {
    if (isTableMissing(error)) {
      saveRequirementOverride(input.farmId, input.type, input.status, input.notes)
      return { ok: true, persistedTo: 'local-cache' }
    }
    return { ok: false, persistedTo: 'none', error: error.message ?? 'The override could not be recorded on the server.' }
  }

  saveRequirementOverride(input.farmId, input.type, input.status, input.notes)
  return { ok: true, persistedTo: 'server' }
}

/**
 * Whether an override may be treated as effective for the RELEASE GATE.
 *
 * 'unavailable' yields false — the whole point of the fail-closed contract. A
 * clearance whose server state could not be read must not clear anything.
 */
export function isEffectiveOverride(source: OverrideSource): boolean {
  return source === 'server' || source === 'local-cache'
}

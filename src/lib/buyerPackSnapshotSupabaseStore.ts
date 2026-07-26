// ─── Buyer pack snapshots — Supabase-backed repository (Phase B) ────────────
//
// Satisfies the SAME BuyerPackSnapshotRepository contract as the localStorage
// store, exactly as buyerPackSnapshotRepository.ts anticipated: "A Supabase-backed
// implementation can be added later purely by writing a new file that satisfies
// this interface; no domain or call-site logic needs to change."
//
// This is the file that CALLS public.issue_buyer_pack_snapshot()
// (10_BUYER_PACK_SNAPSHOTS_MVP.sql), with its ddp_admin gate, named-approver gate,
// advisory-lock version serialisation, and append-only prevent_buyer_pack_mutation()
// trigger.
//
// SERVER-AUTHORITATIVE RELEASE STATUS (migration 23). The release gate is the
// DATABASE, not this client. 23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql makes
// the RPC read the current decision for p_pack_id from procurement_decisions_current
// and require it to be a human 'progress' decision; the client-supplied
// p_procurement_decision is IGNORED server-side. This store therefore is NOT the
// source of truth for release status: p_pack_id (the authoritative decision-trail
// key) is what the server gate uses, and the stored decision is the server's.
//
// The RPC signature is unchanged, so this caller is unmodified in shape; only the
// authority moved to the server.
//
// APPEND-ONLY: save() never overwrites. The RPC computes the next version under
// an advisory lock, and UNIQUE (pack_id, version) is the backstop. A duplicate
// therefore surfaces as a database error, which is the correct outcome —
// matching the localStorage store's explicit "already exists" throw.

import { supabase as defaultClient } from './supabase'
import { isRealApprovalTimestamp } from './buyerPackSnapshot'
import type { BuyerPackSnapshot, BuyerPackSnapshotManifest, FrozenBuyerPackEvidence } from './buyerPackSnapshot'
import type { BuyerPackSnapshotRepository } from './buyerPackSnapshotRepository'

interface RpcErrorLike { code?: string; message?: string }

// Minimal structural type — avoids coupling to the SupabaseClient generics.
export interface SnapshotClientLike {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcErrorLike | null }>
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        order(col: string, opts: { ascending: boolean }): Promise<{ data: unknown; error: RpcErrorLike | null }>
      }
    }
  }
}

const TABLE = 'buyer_pack_snapshots'
const RPC = 'issue_buyer_pack_snapshot'

// ─── Missing-schema detection (migration 10 not applied) ────────────────────
//
// Mirrors procurementDecisionStore.isTableMissing(): a database that simply does
// not have the migration-10 objects yet is "server unavailable", never an
// application error — the app must keep working against localStorage until
// migration 10 is applied. EVERY OTHER ERROR still propagates: network, auth,
// permission/RLS, validation, and the 23505 append-only guard must NOT be
// swallowed, or a refused write would look like a successful one.
//
// The two call paths fail differently, so each is classified against only the
// codes it can actually raise:
//   readAll() → PostgREST table read: 42P01 undefined_table, PGRST205 table not
//               found in the schema cache.
//   save()    → PostgREST RPC: 42883 undefined_function, PGRST202 function not
//               found in the schema cache.
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205'])
const MISSING_FUNCTION_CODES = new Set(['42883', 'PGRST202'])

/** Raised only when the migration-10 objects are absent. Callers fall back. */
export class SnapshotSchemaMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotSchemaMissingError'
  }
}

function isMissingObject(error: RpcErrorLike, codes: Set<string>): boolean {
  if (error.code && codes.has(error.code)) return true
  // PostgREST does not always populate `code`; its schema-cache misses and
  // Postgres's undefined_table/function both say so in the message.
  return /does not exist|could not find the (table|function)|schema cache/i.test(error.message ?? '')
}

/** Row shape returned by the RPC and by a direct table read. */
interface SnapshotRow {
  snapshot_id: string
  pack_id: string
  version: number
  content_hash: string
  approval_id: string
  approval_timestamp: string
  procurement_decision: string
  approved_by: string
  generated_by: string
  generated_at: string
  frozen_evidence: unknown
  previous_snapshot_id?: string | null
}

/**
 * Maps a database row back onto the domain BuyerPackSnapshot shape the UI and
 * the domain layer already consume. The frozen evidence is stored as JSONB
 * exactly as it was hashed, so it round-trips unchanged.
 */
function rowToSnapshot(row: SnapshotRow): BuyerPackSnapshot {
  const manifest: BuyerPackSnapshotManifest = {
    snapshotId: row.snapshot_id,
    packId: row.pack_id,
    version: row.version,
    contentHash: row.content_hash,
    approvalId: row.approval_id,
    approvalTimestamp: row.approval_timestamp,
    procurementDecision: row.procurement_decision as BuyerPackSnapshotManifest['procurementDecision'],
    approvedBy: row.approved_by,
    generatedBy: row.generated_by,
    generatedAt: row.generated_at,
  }

  return {
    manifest,
    frozenEvidence: row.frozen_evidence as FrozenBuyerPackEvidence,
    immutable: true,
  }
}

/**
 * Fail closed on a malformed manifest BEFORE the RPC. The server (migration 23)
 * re-asserts its own gates, but a snapshot we already know is invalid — blank
 * identity, or an unknown approval time — must never be sent down the release
 * path: a refused RPC is a round-trip whose failure a caller then has to
 * interpret, whereas an obviously-invalid payload should be rejected outright.
 */
function assertIssuableManifest(m: BuyerPackSnapshotManifest): void {
  const requireNonBlank = (value: string, label: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Buyer pack snapshot cannot be issued: ${label} is missing.`)
    }
  }
  requireNonBlank(m.packId, 'pack id')
  requireNonBlank(m.contentHash, 'content hash')
  requireNonBlank(m.approvalId, 'approval id')
  requireNonBlank(m.approvedBy, 'approver')
  requireNonBlank(m.generatedBy, 'generating operator')
  if (m.procurementDecision !== 'progress') {
    throw new Error('Buyer pack snapshot cannot be issued: it is not backed by a recorded "progress" procurement decision.')
  }
  if (!isRealApprovalTimestamp(m.approvalTimestamp)) {
    throw new Error('Buyer pack snapshot cannot be issued: the approval timestamp is blank or malformed.')
  }
}

function isSnapshotRow(v: unknown): v is SnapshotRow {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.pack_id === 'string' && typeof r.version === 'number'
}

export function createSupabaseBuyerPackSnapshotRepository(
  client: SnapshotClientLike,
): BuyerPackSnapshotRepository {
  async function readAll(packId: string): Promise<BuyerPackSnapshot[]> {
    const { data, error } = await client.from(TABLE)
      .select('snapshot_id, pack_id, version, content_hash, approval_id, approval_timestamp, procurement_decision, approved_by, generated_by, generated_at, frozen_evidence, previous_snapshot_id')
      .eq('pack_id', packId)
      .order('version', { ascending: true })

    if (error) {
      // Migration 10 not applied ⇒ degrade (the caller falls back). Anything
      // else — permission denied, network, malformed request — still throws.
      if (isMissingObject(error, MISSING_TABLE_CODES)) {
        throw new SnapshotSchemaMissingError(`${TABLE} is not deployed: ${error.message ?? error.code ?? 'unknown'}`)
      }
      throw new Error(error.message ?? 'Could not read buyer pack snapshots.')
    }
    if (!Array.isArray(data)) return []
    return data.filter(isSnapshotRow).map(rowToSnapshot)
  }

  return {
    // This repository only ever talks to the database — it never writes
    // locally. When the schema is absent it throws SnapshotSchemaMissingError
    // and withLocalFallback, not this object, is what degrades.
    durability: () => 'server',
    /**
     * Issues an immutable snapshot via the RPC. The server re-asserts the
     * admin gate, the 'progress'-decision gate and the named-approver gate, so
     * a client that skipped the UI gate is still refused. The version is
     * assigned server-side — the client never picks it.
     */
    async save(snapshot: BuyerPackSnapshot): Promise<void> {
      const m = snapshot.manifest
      // Reject a known-invalid payload before it can reach the server.
      assertIssuableManifest(m)
      const { error } = await client.rpc(RPC, {
        // p_pack_id is the AUTHORITATIVE key: the server gate (migration 23) looks
        // up the current procurement decision for this pack. It must be sent.
        p_pack_id: m.packId,
        p_content_hash: m.contentHash,
        p_approval_id: m.approvalId,
        p_approval_timestamp: m.approvalTimestamp,
        // Passed for signature compatibility only. The server IGNORES it and
        // derives release status from procurement_decisions_current (migration 23);
        // it is not the source of truth for whether a pack may issue.
        p_procurement_decision: m.procurementDecision,
        p_approved_by: m.approvedBy,
        p_generated_by: m.generatedBy,
        p_frozen_evidence: snapshot.frozenEvidence,
      })

      if (error) {
        // UNIQUE (pack_id, version) violation ⇒ the append-only guard did its
        // job. Surface it in the same shape the localStorage store throws, so
        // call sites need no special-casing. Checked BEFORE the missing-object
        // test: a refused write must never be mistaken for an absent schema.
        if (error.code === '23505') {
          throw new Error(
            `Buyer pack snapshot ${m.packId} version ${m.version} already exists and cannot be overwritten.`,
          )
        }
        // The RPC does not exist ⇒ migration 10 is not applied ⇒ degrade.
        if (isMissingObject(error, MISSING_FUNCTION_CODES)) {
          throw new SnapshotSchemaMissingError(`${RPC}() is not deployed: ${error.message ?? error.code ?? 'unknown'}`)
        }
        throw new Error(error.message ?? 'The buyer pack snapshot could not be issued.')
      }
    },

    async getAll(packId: string): Promise<BuyerPackSnapshot[]> {
      return readAll(packId)
    },

    async getVersion(packId: string, version: number): Promise<BuyerPackSnapshot | null> {
      const all = await readAll(packId)
      return all.find(s => s.manifest.version === version) ?? null
    },

    async getLatest(packId: string): Promise<BuyerPackSnapshot | null> {
      const all = await readAll(packId)
      if (all.length === 0) return null
      return all.reduce((latest, s) => (s.manifest.version > latest.manifest.version ? s : latest))
    },
  }
}

/**
 * Wraps the Supabase repository so that a database WITHOUT the migration-10
 * objects degrades to `localFallback` instead of failing.
 *
 * Feature detection is per-operation, not per-process: the schema can appear
 * (migration applied) between two calls, and the very next call then uses the
 * server. This mirrors procurementDecisionStore, which already feature-detects
 * 42P01 — the two stores now behave the same way, so applying migration 10 and
 * deploying the app are independent, order-insensitive operations.
 *
 * ONLY SnapshotSchemaMissingError triggers the fallback. Permission/RLS denials,
 * the 23505 append-only guard, validation, auth and network failures all
 * propagate unchanged — degrading on those would turn a refused write into a
 * silent local one, which is exactly the failure this store exists to prevent.
 */
function withLocalFallback(
  server: BuyerPackSnapshotRepository,
  localFallback: BuyerPackSnapshotRepository,
): BuyerPackSnapshotRepository {
  // What the LAST completed operation actually did. The panel's durability
  // claim must follow the store, and this wrapper is the only place that knows:
  // it is configured for the server, but a call may have landed locally because
  // the schema is absent. Starts optimistic and is corrected by observation —
  // feature detection is per-operation, so this is re-evaluated every call and
  // flips back to 'server' the moment the migration appears.
  let degraded = false

  async function orFallback<T>(attempt: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      const result = await attempt()
      degraded = false
      return result
    } catch (err) {
      if (err instanceof SnapshotSchemaMissingError) {
        degraded = true
        return fallback()
      }
      // A permission/validation/network failure says nothing about WHERE
      // snapshots are stored, so the durability claim is left untouched.
      throw err
    }
  }

  return {
    durability: () => (degraded ? 'degraded-local' : 'server'),
    save: s => orFallback(() => server.save(s), () => localFallback.save(s)),
    getAll: p => orFallback(() => server.getAll(p), () => localFallback.getAll(p)),
    getLatest: p => orFallback(() => server.getLatest(p), () => localFallback.getLatest(p)),
    getVersion: (p, v) => orFallback(() => server.getVersion(p, v), () => localFallback.getVersion(p, v)),
  }
}

/**
 * Chooses the repository for the current environment.
 *
 * Supabase configured  ⇒ server-backed, immutable, RPC-gated (the real thing),
 *                        degrading to `localFallback` if migration 10 is absent.
 * Not configured (demo) ⇒ the existing localStorage repository, unchanged.
 *
 * This is what keeps the app working in demo mode and keeps the migration and
 * the app deploy independent of one another.
 */
export function selectBuyerPackSnapshotRepository(
  localFallback: BuyerPackSnapshotRepository,
  client: SnapshotClientLike | null = defaultClient as SnapshotClientLike | null,
): BuyerPackSnapshotRepository {
  if (!client) return localFallback
  return withLocalFallback(createSupabaseBuyerPackSnapshotRepository(client), localFallback)
}

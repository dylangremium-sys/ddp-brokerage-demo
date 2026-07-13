// ─── Buyer pack snapshots — Supabase-backed repository (Phase B) ────────────
//
// Satisfies the SAME BuyerPackSnapshotRepository contract as the localStorage
// store, exactly as buyerPackSnapshotRepository.ts anticipated: "A Supabase-backed
// implementation can be added later purely by writing a new file that satisfies
// this interface; no domain or call-site logic needs to change."
//
// This is the file that finally CALLS public.issue_buyer_pack_snapshot()
// (10_BUYER_PACK_SNAPSHOTS_MVP.sql:236). Until now that RPC — with its
// ddp_admin gate, its recorded-'progress'-decision gate, its named-approver
// gate, its advisory-lock version serialisation, and its append-only
// prevent_buyer_pack_mutation() trigger — has never been invoked by any code.
// Every guarantee it encodes was inert.
//
// The RPC is used AS WRITTEN. Its signature and preconditions are not modified.
//
// APPEND-ONLY: save() never overwrites. The RPC computes the next version under
// an advisory lock, and UNIQUE (pack_id, version) is the backstop. A duplicate
// therefore surfaces as a database error, which is the correct outcome —
// matching the localStorage store's explicit "already exists" throw.

import { supabase as defaultClient } from './supabase'
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

    if (error) throw new Error(error.message ?? 'Could not read buyer pack snapshots.')
    if (!Array.isArray(data)) return []
    return data.filter(isSnapshotRow).map(rowToSnapshot)
  }

  return {
    /**
     * Issues an immutable snapshot via the RPC. The server re-asserts the
     * admin gate, the 'progress'-decision gate and the named-approver gate, so
     * a client that skipped the UI gate is still refused. The version is
     * assigned server-side — the client never picks it.
     */
    async save(snapshot: BuyerPackSnapshot): Promise<void> {
      const m = snapshot.manifest
      const { error } = await client.rpc(RPC, {
        p_pack_id: m.packId,
        p_content_hash: m.contentHash,
        p_approval_id: m.approvalId,
        p_approval_timestamp: m.approvalTimestamp,
        p_procurement_decision: m.procurementDecision,
        p_approved_by: m.approvedBy,
        p_generated_by: m.generatedBy,
        p_frozen_evidence: snapshot.frozenEvidence,
      })

      if (error) {
        // UNIQUE (pack_id, version) violation ⇒ the append-only guard did its
        // job. Surface it in the same shape the localStorage store throws, so
        // call sites need no special-casing.
        if (error.code === '23505') {
          throw new Error(
            `Buyer pack snapshot ${m.packId} version ${m.version} already exists and cannot be overwritten.`,
          )
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
 * Chooses the repository for the current environment.
 *
 * Supabase configured  ⇒ server-backed, immutable, RPC-gated (the real thing).
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
  return createSupabaseBuyerPackSnapshotRepository(client)
}

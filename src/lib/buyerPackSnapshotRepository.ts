import type { BuyerPackSnapshot } from './buyerPackSnapshot'

// Storage-agnostic contract for persisting buyer pack snapshots. The domain
// layer (buyerPackSnapshot.ts) depends only on this interface — it must never
// import a concrete storage mechanism directly. A Supabase-backed
// implementation can be added later purely by writing a new file that
// satisfies this interface; no domain or call-site logic needs to change.
//
// Implementations must enforce append-only behaviour: save() must reject a
// (packId, version) pair that already exists rather than overwrite it.
//
// Methods are async (Promise-returning) so a Supabase-backed implementation can
// satisfy this same contract later without a second interface. The current
// localStorage implementation is synchronous internally and simply resolves
// immediately — Phase A behaviour is unchanged.
/**
 * Where this repository is ACTUALLY putting snapshots right now.
 *
 * The buyer-pack panel makes a factual claim to the operator about whether the
 * immutable record is durable. That claim was hardcoded as "Stored in this
 * browser only for now", which is false whenever Supabase is configured and
 * migration 10 is applied — as it is on production. It must therefore be
 * derived from the live repository, not from isSupabaseConfigured: the
 * server-backed repository degrades to local at RUNTIME when migration 10 is
 * absent, so the config says nothing reliable about where a snapshot landed.
 */
export type BuyerPackSnapshotDurability =
  /** Browser-only store. Demo mode — this is the intended behaviour there. */
  | 'local'
  /** Server-backed: append-only rows issued through the audited RPC. */
  | 'server'
  /** Configured for the server, but the schema is absent, so writes went local. */
  | 'degraded-local'

export interface BuyerPackSnapshotRepository {
  save(snapshot: BuyerPackSnapshot): Promise<void>
  getAll(packId: string): Promise<BuyerPackSnapshot[]>
  getVersion(packId: string, version: number): Promise<BuyerPackSnapshot | null>
  getLatest(packId: string): Promise<BuyerPackSnapshot | null>
  /**
   * The store's own account of where it is persisting. Required, so no
   * implementation can be added that leaves the UI to guess — guessing is the
   * defect this closes. Callers must re-read it after an operation rather than
   * caching it: a fallback repository can only know it has degraded once a call
   * has actually hit the missing schema.
   */
  durability(): BuyerPackSnapshotDurability
}

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
export interface BuyerPackSnapshotRepository {
  save(snapshot: BuyerPackSnapshot): Promise<void>
  getAll(packId: string): Promise<BuyerPackSnapshot[]>
  getVersion(packId: string, version: number): Promise<BuyerPackSnapshot | null>
  getLatest(packId: string): Promise<BuyerPackSnapshot | null>
}

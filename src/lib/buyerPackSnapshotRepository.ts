import type { BuyerPackSnapshot } from './buyerPackSnapshot'

// Storage-agnostic contract for persisting buyer pack snapshots. The domain
// layer (buyerPackSnapshot.ts) depends only on this interface — it must never
// import a concrete storage mechanism directly. A Supabase-backed
// implementation can be added later purely by writing a new file that
// satisfies this interface; no domain or call-site logic needs to change.
//
// Implementations must enforce append-only behaviour: save() must reject a
// (packId, version) pair that already exists rather than overwrite it.
export interface BuyerPackSnapshotRepository {
  save(snapshot: BuyerPackSnapshot): void
  getAll(packId: string): BuyerPackSnapshot[]
  getVersion(packId: string, version: number): BuyerPackSnapshot | null
  getLatest(packId: string): BuyerPackSnapshot | null
}

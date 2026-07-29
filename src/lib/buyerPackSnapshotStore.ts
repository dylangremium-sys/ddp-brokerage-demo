import type { BuyerPackSnapshot } from './buyerPackSnapshot'
import type { BuyerPackSnapshotRepository } from './buyerPackSnapshotRepository'

// The only concrete implementation of BuyerPackSnapshotRepository for this
// pass. Backed by localStorage, matching the persistence convention already
// used elsewhere in this codebase (see lib/procurementControl.ts). Nothing
// outside this file knows localStorage is involved — swapping in a
// Supabase-backed repository later means writing a new file, not editing
// the domain layer or any call site.

const STORAGE_KEY = 'ddp_buyer_pack_snapshots'

type SnapshotsByPackId = Record<string, BuyerPackSnapshot[]>

function readAll(): SnapshotsByPackId {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(all: SnapshotsByPackId): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function createLocalStorageBuyerPackSnapshotRepository(): BuyerPackSnapshotRepository {
  // localStorage is synchronous; these methods are async only to satisfy the
  // Promise-returning repository contract. The append-only guard, version
  // lookups, and latest-selection logic are identical to Phase A.
  return {
    // Unconditionally browser-local, and honestly so: in demo mode this IS the
    // intended store, not a degradation.
    durability: () => 'local',
    async save(snapshot: BuyerPackSnapshot): Promise<void> {
      const all = readAll()
      const existing = all[snapshot.manifest.packId] ?? []
      if (existing.some(s => s.manifest.version === snapshot.manifest.version)) {
        throw new Error(
          `Buyer pack snapshot ${snapshot.manifest.packId} version ${snapshot.manifest.version} already exists and cannot be overwritten.`,
        )
      }
      all[snapshot.manifest.packId] = [...existing, snapshot]
      writeAll(all)
    },

    async getAll(packId: string): Promise<BuyerPackSnapshot[]> {
      return readAll()[packId] ?? []
    },

    async getVersion(packId: string, version: number): Promise<BuyerPackSnapshot | null> {
      const existing = readAll()[packId] ?? []
      return existing.find(s => s.manifest.version === version) ?? null
    },

    async getLatest(packId: string): Promise<BuyerPackSnapshot | null> {
      const existing = readAll()[packId] ?? []
      if (existing.length === 0) return null
      return existing.reduce((latest, s) => (s.manifest.version > latest.manifest.version ? s : latest))
    },
  }
}

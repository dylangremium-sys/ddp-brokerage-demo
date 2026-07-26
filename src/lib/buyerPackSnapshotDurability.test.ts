import { beforeEach, describe, expect, it } from 'vitest'
import { createLocalStorageBuyerPackSnapshotRepository } from './buyerPackSnapshotStore'
import { selectBuyerPackSnapshotRepository, type SnapshotClientLike } from './buyerPackSnapshotSupabaseStore'
import type { BuyerPackSnapshotRepository } from './buyerPackSnapshotRepository'
import type { BuyerPackSnapshot } from './buyerPackSnapshot'

/**
 * F6 — the buyer-pack panel claimed the immutable record is browser-only when it
 * is a server record.
 *
 * DDPBuyerPreview.tsx:793-796 stated "Stored in this browser only for now —
 * tamper-evident, not a durable server record." That is false whenever Supabase
 * is configured: selectBuyerPackSnapshotRepository returns the RPC-backed
 * repository, and migration 10 is APPLIED_AND_VERIFIED on production.
 *
 * The copy must follow the ACTUAL store, not isSupabaseConfigured — the
 * server-backed repository falls back to local at runtime when migration 10 is
 * absent, so the config cannot tell you where a snapshot landed.
 */

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  installMemoryLocalStorage()
})

function snapshot(version: number): BuyerPackSnapshot {
  return {
    manifest: {
      snapshotId: `snap-${version}`,
      packId: 'batch-1',
      version,
      contentHash: 'a'.repeat(64),
      approvalId: 'approval-1',
      approvalTimestamp: '2026-07-20T10:00:00.000Z',
      procurementDecision: 'progress',
      approvedBy: 'DDP Admin',
      generatedBy: 'DDP Admin',
      generatedAt: '2026-07-20T10:00:00.000Z',
      previousSnapshotId: null,
    },
    frozenEvidence: {},
  } as unknown as BuyerPackSnapshot
}

function localDouble(): BuyerPackSnapshotRepository {
  const saved: BuyerPackSnapshot[] = []
  return {
    durability: () => 'local',
    async save(s) { saved.push(s) },
    async getAll() { return saved },
    async getLatest() { return saved.length ? saved[saved.length - 1] : null },
    async getVersion(_p, v) { return saved.find(s => s.manifest.version === v) ?? null },
  }
}

/**
 * Minimal client double, typed against the store's own exported
 * SnapshotClientLike rather than cast through `any`: the double is only
 * meaningful if it actually satisfies the contract the store consumes, and a
 * cast would hide the day that contract changes.
 */
function makeClient(
  opts: { readError?: { code?: string; message?: string }; rpcError?: { code?: string; message?: string } } = {},
): SnapshotClientLike {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order: async () => ({ data: opts.readError ? null : [], error: opts.readError ?? null }),
              }
            },
          }
        },
      }
    },
    rpc: async () => ({ data: null, error: opts.rpcError ?? null }),
  }
}

describe('F6 — the store reports where it actually persists', () => {
  it('reports local for the browser repository', () => {
    expect(createLocalStorageBuyerPackSnapshotRepository().durability()).toBe('local')
  })

  it('reports local in demo mode (no Supabase client)', () => {
    const repo = selectBuyerPackSnapshotRepository(createLocalStorageBuyerPackSnapshotRepository(), null)
    expect(repo.durability()).toBe('local')
  })

  it('reports server once a server-backed read succeeds', async () => {
    const repo = selectBuyerPackSnapshotRepository(localDouble(), makeClient())
    await repo.getLatest('batch-1')
    expect(repo.durability()).toBe('server')
  })

  it('reports degraded-local once a call falls back because migration 10 is absent', async () => {
    const client = makeClient({ readError: { code: '42P01', message: 'relation "public.buyer_pack_snapshots" does not exist' } })
    const repo = selectBuyerPackSnapshotRepository(localDouble(), client)
    expect(repo.durability()).toBe('server')   // optimistic until observed
    await repo.getLatest('batch-1')
    expect(repo.durability()).toBe('degraded-local')
  })

  it('returns to server the moment the migration appears', async () => {
    let readError: { code?: string; message?: string } | undefined = { code: '42P01', message: 'does not exist' }
    const client = {
      from() {
        return {
          select() {
            return { eq() { return { order: async () => ({ data: readError ? null : [], error: readError ?? null }) } } }
          },
        }
      },
      rpc: async () => ({ data: null, error: null }),
    }
    const repo = selectBuyerPackSnapshotRepository(localDouble(), client)
    await repo.getLatest('batch-1')
    expect(repo.durability()).toBe('degraded-local')

    readError = undefined   // migration applied between calls
    await repo.getLatest('batch-1')
    expect(repo.durability()).toBe('server')
  })

  it('does not claim degradation from a permission denial — that says nothing about storage location', async () => {
    const client = makeClient({ readError: { code: '42501', message: 'permission denied for table buyer_pack_snapshots' } })
    const repo = selectBuyerPackSnapshotRepository(localDouble(), client)
    await expect(repo.getLatest('batch-1')).rejects.toThrow(/permission denied/)
    expect(repo.durability()).toBe('server')
  })

  it('reports degraded-local after a WRITE falls back, not only a read', async () => {
    const client = makeClient({ rpcError: { code: '42883', message: 'function public.issue_buyer_pack_snapshot does not exist' } })
    const repo = selectBuyerPackSnapshotRepository(localDouble(), client)
    await repo.save(snapshot(1))
    expect(repo.durability()).toBe('degraded-local')
  })
})

/**
 * The panel is .tsx and this repo's vitest env is 'node' with no jsdom, so the
 * copy wiring is asserted against source text via `import.meta.glob(..., '?raw')`
 * — the existing convention (operationsDeskRouting.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}
const PREVIEW_SRC = raw(import.meta.glob('../pages/admin/DDPBuyerPreview.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('F6 — the panel copy is derived from the repository, not the config', () => {
  it('loads the source under assertion', () => {
    expect(PREVIEW_SRC.length).toBeGreaterThan(1000)
  })

  it('no longer hardcodes the browser-only claim', () => {
    // THE DEFECT, verbatim.
    expect(PREVIEW_SRC).not.toContain('Stored in this browser only for now — tamper-evident, not a durable server record.\n')
    // It survives only as one branch of the durability map, never as the
    // unconditional sentence in the rendered paragraph.
    const paragraph = PREVIEW_SRC.slice(
      PREVIEW_SRC.indexOf('Issuing preserves a hashed'),
      PREVIEW_SRC.indexOf('Issuing preserves a hashed') + 400,
    )
    expect(paragraph).toContain('SNAPSHOT_DURABILITY_COPY[snapshotDurability]')
    expect(paragraph).not.toContain('Stored in this browser only for now')
  })

  it('reads durability from the repository rather than re-deriving it from isSupabaseConfigured', () => {
    expect(PREVIEW_SRC).toContain('snapshotRepo.durability()')
    // The config flag must not be what decides this sentence.
    const mapBlock = PREVIEW_SRC.slice(
      PREVIEW_SRC.indexOf('const SNAPSHOT_DURABILITY_COPY'),
      PREVIEW_SRC.indexOf('interface Props'),
    )
    expect(mapBlock).not.toContain('isSupabaseConfigured')
  })

  it('covers every durability state the repository can report', () => {
    for (const state of ['server:', "'degraded-local':", 'local:']) {
      expect(PREVIEW_SRC, state).toContain(state)
    }
  })

  it('re-reads durability after the issue write, not only on mount', () => {
    const handler = PREVIEW_SRC.slice(
      PREVIEW_SRC.indexOf('async function handleIssueBuyerPack'),
      PREVIEW_SRC.indexOf('function recordDownload'),
    )
    expect(handler).toContain('setSnapshotDurability(snapshotRepo.durability())')
  })
})

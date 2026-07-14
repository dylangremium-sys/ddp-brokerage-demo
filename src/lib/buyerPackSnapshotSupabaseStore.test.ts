import { describe, it, expect, vi } from 'vitest'
import {
  createSupabaseBuyerPackSnapshotRepository,
  selectBuyerPackSnapshotRepository,
  type SnapshotClientLike,
} from './buyerPackSnapshotSupabaseStore'
import type { BuyerPackSnapshot } from './buyerPackSnapshot'
import type { BuyerPackSnapshotRepository } from './buyerPackSnapshotRepository'

const HASH = 'a'.repeat(64)

function row(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: 'snap-1',
    pack_id: 'batch-1',
    version: 1,
    content_hash: HASH,
    approval_id: 'appr-1',
    approval_timestamp: '2026-07-13T10:00:00Z',
    procurement_decision: 'progress',
    approved_by: 'DDP Admin',
    generated_by: 'DDP Admin',
    generated_at: '2026-07-13T10:00:01Z',
    frozen_evidence: { inventory: { id: 'batch-1' } },
    previous_snapshot_id: null,
    ...overrides,
  }
}

function snapshot(version = 1): BuyerPackSnapshot {
  return {
    manifest: {
      snapshotId: 'snap-1',
      packId: 'batch-1',
      version,
      contentHash: HASH,
      approvalId: 'appr-1',
      approvalTimestamp: '2026-07-13T10:00:00Z',
      procurementDecision: 'progress',
      approvedBy: 'DDP Admin',
      generatedBy: 'DDP Admin',
      generatedAt: '2026-07-13T10:00:01Z',
    },
    frozenEvidence: { inventory: { id: 'batch-1' } },
    immutable: true,
  } as unknown as BuyerPackSnapshot
}

function makeClient(opts: {
  rows?: Array<Record<string, unknown>>
  rpcError?: { code?: string; message?: string } | null
  readError?: { code?: string; message?: string } | null
} = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const client: SnapshotClientLike = {
    async rpc(fn, args) {
      rpcCalls.push({ fn, args })
      return { data: null, error: opts.rpcError ?? null }
    },
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async order() {
                  return { data: opts.rows ?? [], error: opts.readError ?? null }
                },
              }
            },
          }
        },
      }
    },
  }
  return { client, rpcCalls }
}

describe('createSupabaseBuyerPackSnapshotRepository — save() calls the RPC', () => {
  it('invokes issue_buyer_pack_snapshot with the exact documented parameter names', async () => {
    const { client, rpcCalls } = makeClient()
    const repo = createSupabaseBuyerPackSnapshotRepository(client)

    await repo.save(snapshot())

    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('issue_buyer_pack_snapshot')
    expect(rpcCalls[0].args).toMatchObject({
      p_pack_id: 'batch-1',
      p_content_hash: HASH,
      p_approval_id: 'appr-1',
      p_procurement_decision: 'progress',
      p_approved_by: 'DDP Admin',
      p_generated_by: 'DDP Admin',
    })
    expect(rpcCalls[0].args.p_frozen_evidence).toEqual({ inventory: { id: 'batch-1' } })
  })

  it('never sends a version — the server assigns it under an advisory lock', async () => {
    const { client, rpcCalls } = makeClient()
    await createSupabaseBuyerPackSnapshotRepository(client).save(snapshot(7))
    expect(rpcCalls[0].args).not.toHaveProperty('p_version')
    expect(rpcCalls[0].args).not.toHaveProperty('version')
  })

  it('translates a UNIQUE violation into the same "already exists" error the localStorage store throws', async () => {
    const { client } = makeClient({ rpcError: { code: '23505', message: 'duplicate key value' } })
    const repo = createSupabaseBuyerPackSnapshotRepository(client)
    await expect(repo.save(snapshot(1))).rejects.toThrow(/already exists and cannot be overwritten/i)
  })

  it('surfaces a server-side gate rejection (e.g. non-admin, or no recorded progress decision)', async () => {
    const { client } = makeClient({
      rpcError: { code: 'P0001', message: 'issue_buyer_pack_snapshot: ddp_admin role required' },
    })
    const repo = createSupabaseBuyerPackSnapshotRepository(client)
    await expect(repo.save(snapshot())).rejects.toThrow(/ddp_admin role required/i)
  })
})

describe('createSupabaseBuyerPackSnapshotRepository — reads', () => {
  it('maps a database row back onto the domain snapshot shape', async () => {
    const { client } = makeClient({ rows: [row()] })
    const latest = await createSupabaseBuyerPackSnapshotRepository(client).getLatest('batch-1')
    expect(latest?.manifest).toMatchObject({ packId: 'batch-1', version: 1, contentHash: HASH })
    expect(latest?.frozenEvidence).toEqual({ inventory: { id: 'batch-1' } })
  })

  it('getLatest returns the highest version', async () => {
    const { client } = makeClient({ rows: [row({ version: 1 }), row({ version: 3 }), row({ version: 2 })] })
    const latest = await createSupabaseBuyerPackSnapshotRepository(client).getLatest('batch-1')
    expect(latest?.manifest.version).toBe(3)
  })

  it('getVersion selects the requested version', async () => {
    const { client } = makeClient({ rows: [row({ version: 1 }), row({ version: 2 })] })
    const v = await createSupabaseBuyerPackSnapshotRepository(client).getVersion('batch-1', 2)
    expect(v?.manifest.version).toBe(2)
  })

  it('returns null / empty rather than throwing when a pack has no snapshots', async () => {
    const { client } = makeClient({ rows: [] })
    const repo = createSupabaseBuyerPackSnapshotRepository(client)
    expect(await repo.getLatest('nope')).toBeNull()
    expect(await repo.getAll('nope')).toEqual([])
  })

  it('throws on a genuine read failure rather than silently reporting "no snapshots"', async () => {
    const { client } = makeClient({ readError: { message: 'connection reset' } })
    await expect(createSupabaseBuyerPackSnapshotRepository(client).getAll('batch-1'))
      .rejects.toThrow(/connection reset/i)
  })
})

describe('selectBuyerPackSnapshotRepository — environment selection', () => {
  const localFallback = { save: vi.fn(), getAll: vi.fn(), getVersion: vi.fn(), getLatest: vi.fn() } as unknown as BuyerPackSnapshotRepository

  it('uses the localStorage repository in demo mode (no Supabase client)', () => {
    expect(selectBuyerPackSnapshotRepository(localFallback, null)).toBe(localFallback)
  })

  it('uses the Supabase repository when Supabase is configured', () => {
    const { client } = makeClient()
    expect(selectBuyerPackSnapshotRepository(localFallback, client)).not.toBe(localFallback)
  })
})

// ─── Regression: missing-schema fallback (migration 10 not applied) ──────────
//
// Supabase being *configured* is not the same as migration 10 being *applied*.
// Production is configured and has no migration-10 objects, so the store used to
// call a table and an RPC that do not exist: reads threw (an unhandled rejection
// in the buyer-pack view) and "Issue Buyer Pack" failed — regressing a feature
// that worked against localStorage. The store now degrades per-operation, exactly
// as procurementDecisionStore already does for 42P01.
//
// The critical asymmetry these tests pin: a MISSING SCHEMA degrades, but every
// other error still propagates. Swallowing a permission denial or the 23505
// append-only guard would turn a REFUSED write into a silent local one.
describe('missing migration-10 schema degrades to the local repository', () => {
  function makeLocal(seed: BuyerPackSnapshot[] = []) {
    const saved: BuyerPackSnapshot[] = [...seed]
    const local: BuyerPackSnapshotRepository = {
      async save(s) { saved.push(s) },
      async getAll() { return saved },
      async getLatest() { return saved.length ? saved[saved.length - 1] : null },
      async getVersion(_p, v) { return saved.find(s => s.manifest.version === v) ?? null },
    }
    return { local, saved }
  }

  // 42P01 = undefined_table; PGRST205 = table absent from the PostgREST schema cache.
  it.each([
    ['42P01', 'relation "public.buyer_pack_snapshots" does not exist'],
    ['PGRST205', "Could not find the table 'public.buyer_pack_snapshots' in the schema cache"],
  ])('READ: %s falls back to the local repository instead of throwing', async (code, message) => {
    const { local } = makeLocal([snapshot(3)])
    const { client } = makeClient({ readError: { code, message } })

    const repo = selectBuyerPackSnapshotRepository(local, client)

    // Resolves with the LOCAL history — it does not reject. This is the exact
    // condition that produced the unhandled rejection in DDPBuyerPreview.
    await expect(repo.getLatest('batch-1')).resolves.toMatchObject({ manifest: { version: 3 } })
    await expect(repo.getAll('batch-1')).resolves.toHaveLength(1)
    await expect(repo.getVersion('batch-1', 3)).resolves.toMatchObject({ manifest: { version: 3 } })
  })

  // 42883 = undefined_function; PGRST202 = function absent from the schema cache.
  it.each([
    ['42883', 'function public.issue_buyer_pack_snapshot(...) does not exist'],
    ['PGRST202', "Could not find the function public.issue_buyer_pack_snapshot in the schema cache"],
  ])('WRITE: %s falls back to the local repository instead of throwing', async (code, message) => {
    const { local, saved } = makeLocal()
    const { client, rpcCalls } = makeClient({ rpcError: { code, message } })

    const repo = selectBuyerPackSnapshotRepository(local, client)

    await expect(repo.save(snapshot())).resolves.toBeUndefined()
    expect(rpcCalls).toHaveLength(1)          // the RPC was attempted first
    expect(saved).toHaveLength(1)             // and the snapshot was NOT lost
  })

  it('an unrelated READ error still propagates — it is not treated as a missing schema', async () => {
    const { local } = makeLocal([snapshot(1)])
    const { client } = makeClient({ readError: { code: '42501', message: 'permission denied for table buyer_pack_snapshots' } })

    const repo = selectBuyerPackSnapshotRepository(local, client)

    await expect(repo.getLatest('batch-1')).rejects.toThrow(/permission denied/i)
  })

  it('an unrelated WRITE error still propagates — a refused write never becomes a silent local one', async () => {
    const { local, saved } = makeLocal()
    const { client } = makeClient({ rpcError: { code: '42501', message: 'permission denied for function issue_buyer_pack_snapshot' } })

    const repo = selectBuyerPackSnapshotRepository(local, client)

    await expect(repo.save(snapshot())).rejects.toThrow(/permission denied/i)
    expect(saved).toHaveLength(0)  // NOT written locally — the server refused it
  })

  it('the 23505 append-only guard still propagates and is not mistaken for a missing schema', async () => {
    const { local, saved } = makeLocal()
    const { client } = makeClient({ rpcError: { code: '23505', message: 'duplicate key value violates unique constraint' } })

    const repo = selectBuyerPackSnapshotRepository(local, client)

    await expect(repo.save(snapshot())).rejects.toThrow(/already exists and cannot be overwritten/i)
    expect(saved).toHaveLength(0)  // an overwrite attempt must not be laundered into the local store
  })

  it('when migration 10 IS applied, the server is used and the fallback is never touched', async () => {
    const { local, saved } = makeLocal()
    const localGetAll = vi.spyOn(local, 'getAll')
    const { client, rpcCalls } = makeClient({ rows: [row({ version: 2 })] })

    const repo = selectBuyerPackSnapshotRepository(local, client)

    await expect(repo.getLatest('batch-1')).resolves.toMatchObject({ manifest: { version: 2 } })
    await repo.save(snapshot())

    expect(rpcCalls[0].fn).toBe('issue_buyer_pack_snapshot')  // server write
    expect(localGetAll).not.toHaveBeenCalled()                 // server read
    expect(saved).toHaveLength(0)                              // nothing written locally
  })
})

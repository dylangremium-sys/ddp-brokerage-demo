import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FarmStatus, InventoryStatus } from '../types'

// ─── Audit R7: a status change and its audit record must be one transaction ──
//
// src/lib/db.ts previously issued an entity UPDATE and a status_history INSERT as
// two independent PostgREST calls. sbInsert throws on any error, so a failed
// history insert showed the operator a FAILED action while the row was already at
// the new status in the database. status_history is the compliance artefact, so
// the failure mode is silent divergence plus a misleading error.
//
// Migration 35 adds public.record_status_transition(), which performs both writes
// in one transaction. These tests drive the real exported functions with the
// Supabase client mocked, and assert on which calls actually leave the client —
// the RPC when it is deployed, and the legacy pair ONLY when it is not.

const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const FARM_ID = '22222222-2222-4222-8222-222222222222'
const BATCH_ID = '33333333-3333-4333-8333-333333333333'

type SbError = { code?: string; message?: string } | null

/** Records every call the code under test makes to the Supabase client. */
interface Recorder {
  rpc: Array<{ fn: string; args: Record<string, unknown> }>
  update: Array<{ table: string; data: Record<string, unknown> }>
  insert: Array<{ table: string; data: Record<string, unknown> }>
}

/**
 * Builds a Supabase mock whose rpc() returns `rpcError` and whose table writes
 * succeed. Returns the recorder so a test can assert on exactly what was sent.
 */
function mockSupabase(rpcError: SbError, opts: { insertError?: SbError } = {}) {
  const calls: Recorder = { rpc: [], update: [], insert: [] }
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args })
      return { data: rpcError ? null : 'history-row-id', error: rpcError }
    },
    from: (table: string) => ({
      update: (data: Record<string, unknown>) => ({
        eq: async () => {
          calls.update.push({ table, data })
          return { error: null }
        },
      }),
      insert: async (data: Record<string, unknown>) => {
        calls.insert.push({ table, data })
        return { error: opts.insertError ?? null }
      },
    }),
  }
  vi.doMock('./supabase', () => ({ supabase: client, isSupabaseConfigured: true }))
  return calls
}

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the RPC is deployed — one transactional call, and no second write', () => {
  it('updateFarmProfileStatus calls record_status_transition and nothing else', async () => {
    const calls = mockSupabase(null)
    const { updateFarmProfileStatus } = await import('./db')

    await updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, 'Pending Review' as FarmStatus, ADMIN_ID)

    expect(calls.rpc).toHaveLength(1)
    expect(calls.rpc[0].fn).toBe('record_status_transition')
    expect(calls.rpc[0].args).toEqual({
      p_entity_type: 'farm',
      p_entity_id: FARM_ID,
      p_new_status: 'Approved',
      p_old_status: 'Pending Review',
      p_reviewer_id: ADMIN_ID,
    })
    // The whole point: the legacy pair must NOT also run. Doing both would write
    // the history row twice.
    expect(calls.update).toHaveLength(0)
    expect(calls.insert).toHaveLength(0)
  })

  it('updateInventoryStatus calls record_status_transition and nothing else', async () => {
    const calls = mockSupabase(null)
    const { updateInventoryStatus } = await import('./db')

    await updateInventoryStatus(BATCH_ID, 'Approved' as InventoryStatus, 'Pending Review' as InventoryStatus, ADMIN_ID)

    expect(calls.rpc).toHaveLength(1)
    expect(calls.rpc[0].args.p_entity_type).toBe('inventory_batch')
    expect(calls.rpc[0].args.p_entity_id).toBe(BATCH_ID)
    expect(calls.update).toHaveLength(0)
    expect(calls.insert).toHaveLength(0)
  })

  it('a non-UUID reviewer id is sent as null rather than as a bad uuid', async () => {
    // Seed data uses ids like "profile-1". Sending one would make the RPC fail on
    // a type cast rather than record the transition.
    const calls = mockSupabase(null)
    const { updateFarmProfileStatus } = await import('./db')

    await updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, undefined, 'not-a-uuid')

    expect(calls.rpc[0].args.p_reviewer_id).toBeNull()
    expect(calls.rpc[0].args.p_old_status).toBeNull()
  })
})

describe('the RPC is NOT deployed — and only then, the legacy path runs', () => {
  // PGRST202 is what production actually returns for a missing FUNCTION. Verified
  // 2026-07-28 against the live project: POST /rest/v1/rpc/record_status_transition
  // -> {"code":"PGRST202","message":"Could not find the function ..."}.
  it('degrades on PGRST202 (PostgREST: function not in schema cache)', async () => {
    const calls = mockSupabase({ code: 'PGRST202', message: 'Could not find the function public.record_status_transition' })
    const { updateFarmProfileStatus } = await import('./db')

    await updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, 'Pending Review' as FarmStatus, ADMIN_ID)

    expect(calls.rpc).toHaveLength(1)
    expect(calls.update).toEqual([
      { table: 'farms', data: expect.objectContaining({ status: 'Approved', reviewed_by: ADMIN_ID }) },
    ])
    expect(calls.insert).toEqual([
      { table: 'status_history', data: expect.objectContaining({ entity_type: 'farm', new_status: 'Approved' }) },
    ])
  })

  it('degrades on 42883 (Postgres: undefined_function)', async () => {
    const calls = mockSupabase({ code: '42883', message: 'function public.record_status_transition(...) does not exist' })
    const { updateInventoryStatus } = await import('./db')

    await updateInventoryStatus(BATCH_ID, 'Rejected' as InventoryStatus, undefined, ADMIN_ID)

    expect(calls.update).toHaveLength(1)
    expect(calls.insert).toHaveLength(1)
  })

  it('degrades on a codeless message that names this function', async () => {
    const calls = mockSupabase({ message: 'Could not find the function record_status_transition in the schema cache' })
    const { updateFarmProfileStatus } = await import('./db')

    await updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, undefined, ADMIN_ID)

    expect(calls.update).toHaveLength(1)
  })

  it('does NOT degrade on a codeless "does not exist" that names something else', async () => {
    // A missing COLUMN must not be mistaken for a missing function — that is how
    // schema drift turns into a silent downgrade to the weaker path.
    mockSupabase({ message: 'column "reviewed_by" does not exist' })
    const { updateFarmProfileStatus } = await import('./db')

    await expect(
      updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, undefined, ADMIN_ID),
    ).rejects.toThrow(/does not exist/)
  })
})

describe('every other error fails closed — no silent retry through the weaker path', () => {
  // Each of these is an AUTHORITATIVE failure. Falling back would re-attempt the
  // write through the two-call path, whose checks are weaker than the RPC's.
  const cases: Array<[string, string, string]> = [
    ['42501', 'insufficient_privilege — the caller is not an administrator', 'permission denied'],
    ['42703', 'undefined_column — schema drift', 'column x does not exist'],
    ['22023', 'invalid_parameter_value — a rejected argument', 'entity_type must be'],
    ['PGRST301', 'JWT expired / authentication failure', 'JWT expired'],
    ['08006', 'connection failure — transient', 'connection failure'],
    ['P0002', 'no_data_found — the entity does not exist', 'farm does not exist'],
    ['25000', 'invalid_transaction_state', 'expected to update exactly 1 row'],
  ]

  for (const [code, why, message] of cases) {
    it(`throws on ${code} (${why}) and never touches the legacy path`, async () => {
      const calls = mockSupabase({ code, message })
      const { updateFarmProfileStatus } = await import('./db')

      await expect(
        updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, undefined, ADMIN_ID),
      ).rejects.toThrow(message)

      expect(calls.rpc).toHaveLength(1)
      expect(calls.update).toHaveLength(0)
      expect(calls.insert).toHaveLength(0)
    })
  }

  it('42501 in particular does not fall back — a permission denial is not "not deployed"', async () => {
    const calls = mockSupabase({ code: '42501', message: 'only a DDP administrator may record a status transition' })
    const { updateInventoryStatus } = await import('./db')

    await expect(
      updateInventoryStatus(BATCH_ID, 'Approved' as InventoryStatus, undefined, ADMIN_ID),
    ).rejects.toThrow(/administrator/)

    expect(calls.update).toHaveLength(0)
    expect(calls.insert).toHaveLength(0)
  })
})

describe('guards that predate this change still hold', () => {
  it('a non-UUID entity id skips the write entirely — no RPC, no legacy call', async () => {
    const calls = mockSupabase(null)
    const { updateFarmProfileStatus } = await import('./db')

    await updateFarmProfileStatus('farm-1', 'Approved' as FarmStatus, undefined, ADMIN_ID)

    expect(calls.rpc).toHaveLength(0)
    expect(calls.update).toHaveLength(0)
  })

  it('demo mode (no Supabase client) performs no write at all', async () => {
    vi.doMock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))
    const { updateFarmProfileStatus } = await import('./db')
    await expect(
      updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, undefined, ADMIN_ID),
    ).resolves.toBeUndefined()
  })
})

describe('the legacy path still reports R7 honestly while it is in use', () => {
  it('a failed history insert surfaces as a failure (the divergence the RPC removes)', async () => {
    // This documents the behaviour the fallback retains: the farm row has already
    // moved, yet the operator is told the action failed. It is exactly why the
    // fallback is temporary and why migration 35 needs applying.
    const calls = mockSupabase(
      { code: 'PGRST202', message: 'Could not find the function' },
      { insertError: { code: '08006', message: 'connection failure' } },
    )
    const { updateFarmProfileStatus } = await import('./db')

    await expect(
      updateFarmProfileStatus(FARM_ID, 'Approved' as FarmStatus, undefined, ADMIN_ID),
    ).rejects.toThrow('connection failure')

    // The entity update DID land before the history insert failed.
    expect(calls.update).toHaveLength(1)
    expect(calls.insert).toHaveLength(1)
  })
})

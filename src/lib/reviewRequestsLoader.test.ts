import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Behavioural coverage for the farmer review-request DB loader
 * (loadReviewRequestsFromDB) — specifically that it queries by inventory batch
 * OR farm, so farm-level requests (inventory_batch_id null, farm_id set) reach
 * the farmer inbox. The Supabase client is mocked so we can assert the exact
 * query construction (which PostgREST filter runs for each scope combination)
 * without a live database. RLS remains the server-side authority in production.
 */

const h = vi.hoisted(() => ({
  calls: {
    from: null as string | null,
    or: [] as string[],
    in: [] as Array<{ col: string; list: string[] }>,
  },
  result: { data: [] as unknown[], error: null as { message: string } | null },
}))

vi.mock('./supabase', () => {
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.or = (arg: string) => { h.calls.or.push(arg); return builder }
  builder.in = (col: string, list: string[]) => { h.calls.in.push({ col, list }); return builder }
  builder.order = () => Promise.resolve(h.result)
  return {
    isSupabaseConfigured: true,
    supabase: { from: (t: string) => { h.calls.from = t; return builder } },
  }
})

import { loadReviewRequestsFromDB } from './db'

const USER = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const BATCH = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const FARM = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

beforeEach(() => {
  h.calls.from = null
  h.calls.or = []
  h.calls.in = []
  h.result = { data: [], error: null }
})

describe('loadReviewRequestsFromDB — scope-aware query construction', () => {
  it('batch-only scope filters on inventory_batch_id', async () => {
    await loadReviewRequestsFromDB(USER, new Set(), new Set([BATCH]))
    expect(h.calls.from).toBe('farmer_review_requests')
    expect(h.calls.or).toHaveLength(0)
    expect(h.calls.in).toEqual([{ col: 'inventory_batch_id', list: [BATCH] }])
  })

  it('farm-only scope filters on farm_id even with zero batches (no early return)', async () => {
    await loadReviewRequestsFromDB(USER, new Set([FARM]), new Set())
    expect(h.calls.from).toBe('farmer_review_requests')
    expect(h.calls.or).toHaveLength(0)
    expect(h.calls.in).toEqual([{ col: 'farm_id', list: [FARM] }])
  })

  it('combined scope uses an OR (union), not an AND, of batch and farm', async () => {
    await loadReviewRequestsFromDB(USER, new Set([FARM]), new Set([BATCH]))
    expect(h.calls.or).toEqual([`inventory_batch_id.in.(${BATCH}),farm_id.in.(${FARM})`])
    expect(h.calls.in).toHaveLength(0) // union path, not a single-column filter
  })

  it('neither scope returns [] without issuing a query', async () => {
    const rows = await loadReviewRequestsFromDB(USER, new Set(), new Set())
    expect(rows).toEqual([])
    expect(h.calls.from).toBeNull() // no query built at all
  })

  it('maps both stock-level and farm-level rows returned by the query', async () => {
    h.result = {
      data: [
        { id: 'r-stock', inventory_batch_id: BATCH, farm_id: null, request_type: 'coa', message: 'm1', status: 'open', created_by: 'admin', created_at: '2026-02-02T00:00:00Z' },
        { id: 'r-farm', inventory_batch_id: null, farm_id: FARM, request_type: 'general', message: 'm2', status: 'open', created_by: 'admin', created_at: '2026-02-01T00:00:00Z' },
      ],
      error: null,
    }
    const rows = await loadReviewRequestsFromDB(USER, new Set([FARM]), new Set([BATCH]))
    expect(rows.map(r => r.id)).toEqual(['r-stock', 'r-farm'])
    expect(rows.find(r => r.id === 'r-farm')!.farmProfileId).toBe(FARM)
    expect(rows.find(r => r.id === 'r-stock')!.stockItemId).toBe(BATCH)
    // one row in → one row out; the query already returns distinct rows.
    expect(rows).toHaveLength(2)
  })

  it('a query error returns [] (a failure, not stale data)', async () => {
    h.result = { data: null as unknown as unknown[], error: { message: 'boom' } }
    const rows = await loadReviewRequestsFromDB(USER, new Set([FARM]), new Set([BATCH]))
    expect(rows).toEqual([])
  })
})

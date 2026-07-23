import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * loadFarmsFromDB / loadInventoryFromDB must DISTINGUISH a query failure from a
 * legitimately empty table: a failure throws (so the admin effect can mark the
 * Operations Desk source failed), while an empty result returns []. The Supabase
 * client is mocked so both outcomes can be driven without a database.
 */
const h = vi.hoisted(() => ({
  result: { data: [] as unknown[] | null, error: null as { message: string } | null },
}))

vi.mock('./supabase', () => {
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.order = () => Promise.resolve(h.result)
  return { isSupabaseConfigured: true, supabase: { from: () => builder } }
})

import { loadFarmsFromDB, loadInventoryFromDB } from './db'

beforeEach(() => { h.result = { data: [], error: null } })

describe('admin operational loaders — failure is distinguishable from empty', () => {
  it('loadFarmsFromDB returns [] for a legitimate empty result', async () => {
    h.result = { data: [], error: null }
    await expect(loadFarmsFromDB()).resolves.toEqual([])
  })

  it('loadFarmsFromDB throws on a query error (never a silent [])', async () => {
    h.result = { data: null, error: { message: 'farms boom' } }
    await expect(loadFarmsFromDB()).rejects.toThrow(/farms boom/)
  })

  it('loadInventoryFromDB returns [] for a legitimate empty result', async () => {
    h.result = { data: [], error: null }
    await expect(loadInventoryFromDB()).resolves.toEqual([])
  })

  it('loadInventoryFromDB throws on a query error (never a silent [])', async () => {
    h.result = { data: null, error: { message: 'inventory boom' } }
    await expect(loadInventoryFromDB()).rejects.toThrow(/inventory boom/)
  })
})

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/**
 * Guards the one place demo fixtures leaked into PRODUCTION.
 *
 * SEED_BENCHMARKS is fictional price guidance — 35,000–55,000 THB/kg for flower,
 * and four more rows. Two paths served it to real, signed-in farmers running
 * against a live Supabase backend:
 *
 *   1. data.ts loadMarketBenchmarks() returned the seed UNCONDITIONALLY. It had
 *      no `sbConfigured` guard, unlike loadInventory()/loadFarms() beside it, and
 *      App.tsx seeds its marketBenchmarks state from it at mount in every mode.
 *      So the fictional prices were on screen before any query ran.
 *   2. db.ts loadMarketBenchmarksFromDB() substituted the seed on a query error
 *      OR an empty table — so they persisted, with no badge and no warning.
 *
 * A farmer can act on a price. Fabricated commercial guidance is worse than
 * none, so both paths must return EMPTY when Supabase is configured.
 *
 * These tests assert the SOURCE of the data, not merely that a call succeeds —
 * a test asserting "returns an array" would pass over the whole defect.
 */

const SEEDED_FLOWER_MIN = 35000

// The suite runs in the 'node' environment, so localStorage is stubbed. Backed by
// a Map rather than db.persist.test.ts's plain object, so resetting between tests
// does not need `delete` on a computed key.
let store = new Map<string, string>()

describe('market benchmarks — no demo seed in Supabase mode', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  describe('data.ts loadMarketBenchmarks()', () => {
    beforeEach(() => {
      store = new Map()
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v) },
        removeItem: (k: string) => { store.delete(k) },
        clear: () => { store.clear() },
      })
      vi.resetModules()
    })

    it('returns EMPTY when Supabase is configured — no fictional prices at mount', async () => {
      vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
      vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
      const { loadMarketBenchmarks } = await import('../data')

      expect(loadMarketBenchmarks()).toEqual([])
    })

    it('still serves the seed in demo mode, where fixtures are the point', async () => {
      vi.stubEnv('VITE_SUPABASE_URL', '')
      vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
      const { loadMarketBenchmarks } = await import('../data')

      const benchmarks = loadMarketBenchmarks()
      expect(benchmarks.length).toBeGreaterThan(0)
      expect(benchmarks.some(b => b.priceMin === SEEDED_FLOWER_MIN)).toBe(true)
    })
  })

  describe('db.ts loadMarketBenchmarksFromDB()', () => {
    it('returns EMPTY on a query error, never the seed', async () => {
      vi.resetModules()
      vi.doMock('./supabase', () => ({
        isSupabaseConfigured: true,
        supabase: {
          from: () => ({
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
              }),
            }),
          }),
        },
      }))
      const { loadMarketBenchmarksFromDB } = await import('./db')

      await expect(loadMarketBenchmarksFromDB()).resolves.toEqual([])
      vi.doUnmock('./supabase')
    })

    it('returns EMPTY on an empty table, never the seed', async () => {
      vi.resetModules()
      vi.doMock('./supabase', () => ({
        isSupabaseConfigured: true,
        supabase: {
          from: () => ({
            select: () => ({
              eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
            }),
          }),
        },
      }))
      const { loadMarketBenchmarksFromDB } = await import('./db')

      await expect(loadMarketBenchmarksFromDB()).resolves.toEqual([])
      vi.doUnmock('./supabase')
    })

    it('returns the real rows when the table has them', async () => {
      vi.resetModules()
      vi.doMock('./supabase', () => ({
        isSupabaseConfigured: true,
        supabase: {
          from: () => ({
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({
                  data: [{
                    id: 'real-1', product_type: 'flower', thc_range: '18–22%',
                    price_min: 41000, price_max: 47000, unit: 'kg', visible_to_farmers: true,
                  }],
                  error: null,
                }),
              }),
            }),
          }),
        },
      }))
      const { loadMarketBenchmarksFromDB } = await import('./db')

      const rows = await loadMarketBenchmarksFromDB()
      expect(rows).toHaveLength(1)
      expect(rows[0].priceMin).toBe(41000)
      // and emphatically not the fixture
      expect(rows[0].priceMin).not.toBe(SEEDED_FLOWER_MIN)
      vi.doUnmock('./supabase')
    })
  })
})

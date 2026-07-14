import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InventoryItem, FarmProfile, ReviewRequest } from '../types'

// ─── The actual defect, tested through the real db.ts call path ─────────────
//
// App.tsx:117-118 calls persistInventory/persistFarms on EVERY React state change.
// In Supabase mode `inventory` and `farms` hold data fetched from the production
// database, so before this fix the entire production dataset was written to
// localStorage on every change — unencrypted, on the operator's machine.
//
// These tests drive the real exported functions with the Supabase module mocked to
// each mode, and assert on what actually lands in storage.

const store: Record<string, string> = {}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  })
  vi.resetModules()
})

const ITEMS = [{ id: 'batch-1', farmId: 'farm-1' }] as unknown as InventoryItem[]
const FARMS = [{ id: 'farm-1', farmName: 'Real Farm Co' }] as unknown as FarmProfile[]
const REQUESTS = [{ id: 'req-1', farmId: 'farm-1' }] as unknown as ReviewRequest[]

/**
 * EVERY write path that App.tsx can drive. The first version of this suite only
 * exercised persistInventory/persistFarms and asserted "no ddp_* key is created" —
 * which passed VACUOUSLY, because it never called the third persist effect
 * (App.tsx:119, saveReviewRequests) or the demo-reset path (App.tsx:477). Both were
 * still writing production data to the browser. Driving all of them here is what
 * makes the "no ddp_* key" assertion mean anything.
 */
async function driveAllPersistPaths() {
  const db = await import('./db')
  const data = await import('../data')
  db.persistInventory(ITEMS)          // App.tsx:117
  db.persistFarms(FARMS)              // App.tsx:118
  data.saveReviewRequests(REQUESTS)   // App.tsx:119
  await db.resetDemoData()            // App.tsx:477
}

describe('SUPABASE mode — production data must NOT reach browser storage', () => {
  beforeEach(() => {
    vi.doMock('./supabase', () => ({ supabase: null, isSupabaseConfigured: true }))
  })

  it('persistInventory writes NOTHING', async () => {
    const { persistInventory } = await import('./db')
    persistInventory(ITEMS)
    expect(store['ddp_inventory']).toBeUndefined()
  })

  it('persistFarms writes NOTHING', async () => {
    const { persistFarms } = await import('./db')
    persistFarms(FARMS)
    expect(store['ddp_farms']).toBeUndefined()
  })

  it('saveReviewRequests writes NOTHING (App.tsx:119; requests come from the DB at :161)', async () => {
    const { saveReviewRequests } = await import('../data')
    expect(saveReviewRequests(REQUESTS)).toBe(false)   // reports no persistence, truthfully
    expect(store['ddp_review_requests']).toBeUndefined()
  })

  it('resetDemoData does NOT re-seed browser storage (App.tsx:477)', async () => {
    const { resetDemoData } = await import('./db')
    await resetDemoData()
    expect(store['ddp_inventory']).toBeUndefined()
    expect(store['ddp_farms']).toBeUndefined()
  })

  it('NO ddp_* key is created by ANY persist path — inventory, farms, requests, reset', async () => {
    await driveAllPersistPaths()
    // The assertion that the first version of this suite made vacuously.
    expect(Object.keys(store).filter(k => k.startsWith('ddp_'))).toEqual([])
  })

  it('createFarmProfile does not mirror a real farm into the browser', async () => {
    const { createFarmProfile } = await import('./db')
    await createFarmProfile(FARMS[0])
    expect(store['ddp_farms']).toBeUndefined()
  })

  it('createInventoryBatch does not mirror a real batch into the browser', async () => {
    const { createInventoryBatch } = await import('./db')
    await createInventoryBatch(ITEMS[0])
    expect(store['ddp_inventory']).toBeUndefined()
  })
})

describe('DEMO mode — localStorage IS the store, behaviour must be unchanged', () => {
  beforeEach(() => {
    vi.doMock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))
  })

  it('persistInventory still persists', async () => {
    const { persistInventory } = await import('./db')
    persistInventory(ITEMS)
    expect(store['ddp_inventory']).toBeDefined()
    expect(JSON.parse(store['ddp_inventory'])[0].id).toBe('batch-1')
  })

  it('persistFarms still persists', async () => {
    const { persistFarms } = await import('./db')
    persistFarms(FARMS)
    expect(store['ddp_farms']).toBeDefined()
    expect(JSON.parse(store['ddp_farms'])[0].id).toBe('farm-1')
  })

  it('createFarmProfile still writes the farm locally', async () => {
    const { createFarmProfile } = await import('./db')
    await createFarmProfile(FARMS[0])
    expect(JSON.parse(store['ddp_farms'])[0].id).toBe('farm-1')
  })

  it('createInventoryBatch still writes the batch locally', async () => {
    const { createInventoryBatch } = await import('./db')
    await createInventoryBatch(ITEMS[0])
    expect(JSON.parse(store['ddp_inventory'])[0].id).toBe('batch-1')
  })

  it('saveReviewRequests still persists', async () => {
    const { saveReviewRequests } = await import('../data')
    expect(saveReviewRequests(REQUESTS)).toBe(true)
    expect(JSON.parse(store['ddp_review_requests'])[0].id).toBe('req-1')
  })

  it('resetDemoData still re-seeds the demo data', async () => {
    const { resetDemoData } = await import('./db')
    await resetDemoData()
    expect(store['ddp_inventory']).toBeDefined()
    expect(store['ddp_farms']).toBeDefined()
    expect(JSON.parse(store['ddp_inventory']).length).toBeGreaterThan(0)
  })

  it('all four persist paths still write in demo mode', async () => {
    await driveAllPersistPaths()
    const keys = Object.keys(store).filter(k => k.startsWith('ddp_'))
    expect(keys).toContain('ddp_inventory')
    expect(keys).toContain('ddp_farms')
    expect(keys).toContain('ddp_review_requests')
  })

  it('a storage quota failure does not throw out of the persist effect', async () => {
    const { persistInventory } = await import('./db')
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
      removeItem: () => {},
    })
    // App.tsx calls this inside a useEffect and there is no error boundary — a
    // throw here would blank the UI.
    expect(() => persistInventory(ITEMS)).not.toThrow()
  })
})

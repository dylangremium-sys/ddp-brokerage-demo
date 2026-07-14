import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InventoryItem, FarmProfile } from '../types'

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

  it('no ddp_* key is created at all by the persist effects', async () => {
    const { persistInventory, persistFarms } = await import('./db')
    persistInventory(ITEMS)
    persistFarms(FARMS)
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

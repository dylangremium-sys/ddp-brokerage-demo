import { describe, it, expect } from 'vitest'
import { resolveAdminDataApply, deskAdminDataView } from './adminDataLoad'

const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
const fail = (reason: string): PromiseSettledResult<never> => ({ status: 'rejected', reason: new Error(reason) })

describe('resolveAdminDataApply — set fulfilled, CLEAR rejected', () => {
  it('both succeed → ready, both SET, no detail clears', () => {
    const p = resolveAdminDataApply(ok(['farm']), ok(['batch']))
    expect(p.state).toBe('ready')
    expect(p.farms).toEqual({ kind: 'set', value: ['farm'] })
    expect(p.inventory).toEqual({ kind: 'set', value: ['batch'] })
    expect(p.farmsAvailable).toBe(true)
    expect(p.inventoryAvailable).toBe(true)
    expect(p.clearFarmDetail).toBe(false)
    expect(p.clearItemDetail).toBe(false)
  })

  it('both succeed with genuine [] → ready, SET the empty arrays (distinct from a clear)', () => {
    const p = resolveAdminDataApply(ok([] as string[]), ok([] as string[]))
    expect(p.state).toBe('ready')
    expect(p.farms).toEqual({ kind: 'set', value: [] })
    expect(p.inventory).toEqual({ kind: 'set', value: [] })
  })

  it('farms succeed / inventory rejected → SET farms, CLEAR inventory + its detail id', () => {
    const p = resolveAdminDataApply(ok(['farm']), fail('inventory boom'))
    expect(p.state).toBe('failed')
    expect(p.farms).toEqual({ kind: 'set', value: ['farm'] }) // fulfilled half preserved
    expect(p.inventory).toEqual({ kind: 'clear' })            // rejected → cleared, not retained
    expect(p.inventoryAvailable).toBe(false)
    expect(p.clearItemDetail).toBe(true)
    expect(p.clearFarmDetail).toBe(false)
  })

  it('inventory succeeds / farms rejected → SET inventory, CLEAR farms + its detail id', () => {
    const p = resolveAdminDataApply(fail('farms boom'), ok(['batch']))
    expect(p.state).toBe('failed')
    expect(p.inventory).toEqual({ kind: 'set', value: ['batch'] })
    expect(p.farms).toEqual({ kind: 'clear' })
    expect(p.clearFarmDetail).toBe(true)
    expect(p.clearItemDetail).toBe(false)
  })

  it('both fail → failed, CLEAR both + both detail ids (nothing retained)', () => {
    const p = resolveAdminDataApply(fail('a'), fail('b'))
    expect(p.state).toBe('failed')
    expect(p.farms).toEqual({ kind: 'clear' })
    expect(p.inventory).toEqual({ kind: 'clear' })
    expect(p.clearFarmDetail).toBe(true)
    expect(p.clearItemDetail).toBe(true)
  })
})

describe('deskAdminDataView — only current-load-fresh data reaches the desk', () => {
  const FARMS = ['farm-a', 'farm-b']       // shared arrays (may hold stale farmer subset)
  const INV = ['batch-a', 'batch-b']

  it('demo mode passes the settled seeded data through unchanged', () => {
    expect(deskAdminDataView(true, FARMS, INV, false, false)).toEqual({ farms: FARMS, inventory: INV })
  })

  it('idle/loading (neither fresh) → farms [], inventory null (unavailable, not empty)', () => {
    // Inventory is null, NOT [], so the desk never reads it as "no batches".
    expect(deskAdminDataView(false, FARMS, INV, false, false)).toEqual({ farms: [], inventory: null })
  })

  it('both fulfilled → both fresh datasets exposed', () => {
    expect(deskAdminDataView(false, FARMS, INV, true, true)).toEqual({ farms: FARMS, inventory: INV })
  })

  it('farms fulfilled / inventory rejected → fresh farms; inventory null (unavailable)', () => {
    expect(deskAdminDataView(false, FARMS, INV, true, false)).toEqual({ farms: FARMS, inventory: null })
  })

  it('inventory fulfilled / farms rejected → only fresh inventory; farms []', () => {
    expect(deskAdminDataView(false, FARMS, INV, false, true)).toEqual({ farms: [], inventory: INV })
  })

  it('both rejected → farms [], inventory null', () => {
    expect(deskAdminDataView(false, FARMS, INV, false, false)).toEqual({ farms: [], inventory: null })
  })

  it('a rejected dataset never leaks the retained (stale) rows it still holds', () => {
    // farms rejected but FARMS still holds prior rows for other pages — the desk
    // must NOT see them.
    const out = deskAdminDataView(false, FARMS, INV, false, true)
    expect(out.farms).toEqual([])
    expect(out.farms).not.toBe(FARMS)
  })
})

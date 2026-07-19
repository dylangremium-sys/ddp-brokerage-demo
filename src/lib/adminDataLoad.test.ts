import { describe, it, expect } from 'vitest'
import { resolveAdminDataLoad, deskAdminDataView } from './adminDataLoad'

const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
const fail = (reason: string): PromiseSettledResult<never> => ({ status: 'rejected', reason: new Error(reason) })

describe('resolveAdminDataLoad', () => {
  it('both succeed → ready, both datasets applied', () => {
    const o = resolveAdminDataLoad(ok(['farm']), ok(['batch']))
    expect(o).toEqual({ state: 'ready', farms: ['farm'], inventory: ['batch'] })
  })

  it('both succeed with empty arrays → ready, empty arrays applied (not absent)', () => {
    const o = resolveAdminDataLoad(ok([] as string[]), ok([] as string[]))
    expect(o.state).toBe('ready')
    expect(o.farms).toEqual([])
    expect(o.inventory).toEqual([])
  })

  it('farms succeed, inventory fails → failed, keeps the good farms half', () => {
    const o = resolveAdminDataLoad(ok(['farm']), fail('inventory boom'))
    expect(o.state).toBe('failed')
    expect(o.farms).toEqual(['farm']) // good half preserved
    expect('inventory' in o).toBe(false) // rejected → absent, not overwritten
  })

  it('inventory succeeds, farms fail → failed, keeps the good inventory half', () => {
    const o = resolveAdminDataLoad(fail('farms boom'), ok(['batch']))
    expect(o.state).toBe('failed')
    expect(o.inventory).toEqual(['batch'])
    expect('farms' in o).toBe(false)
  })

  it('both fail → failed, neither applied (arrays retained by the caller)', () => {
    const o = resolveAdminDataLoad(fail('a'), fail('b'))
    expect(o.state).toBe('failed')
    expect('farms' in o).toBe(false)
    expect('inventory' in o).toBe(false)
  })
})

describe('deskAdminDataView — only current-load-fresh data reaches the desk', () => {
  const FARMS = ['farm-a', 'farm-b']       // shared arrays (may hold stale farmer subset)
  const INV = ['batch-a', 'batch-b']

  it('demo mode passes the settled seeded data through unchanged', () => {
    expect(deskAdminDataView(true, FARMS, INV, false, false)).toEqual({ farms: FARMS, inventory: INV })
  })

  it('idle/loading (neither fresh) → desk receives [] / [], never the stale arrays', () => {
    expect(deskAdminDataView(false, FARMS, INV, false, false)).toEqual({ farms: [], inventory: [] })
  })

  it('both fulfilled → both fresh datasets exposed', () => {
    expect(deskAdminDataView(false, FARMS, INV, true, true)).toEqual({ farms: FARMS, inventory: INV })
  })

  it('farms fulfilled / inventory rejected → only fresh farms; inventory []', () => {
    expect(deskAdminDataView(false, FARMS, INV, true, false)).toEqual({ farms: FARMS, inventory: [] })
  })

  it('inventory fulfilled / farms rejected → only fresh inventory; farms []', () => {
    expect(deskAdminDataView(false, FARMS, INV, false, true)).toEqual({ farms: [], inventory: INV })
  })

  it('both rejected → neither exposed', () => {
    expect(deskAdminDataView(false, FARMS, INV, false, false)).toEqual({ farms: [], inventory: [] })
  })

  it('a rejected dataset never leaks the retained (stale) rows it still holds', () => {
    // farms rejected but FARMS still holds prior rows for other pages — the desk
    // must NOT see them.
    const out = deskAdminDataView(false, FARMS, INV, false, true)
    expect(out.farms).toEqual([])
    expect(out.farms).not.toBe(FARMS)
  })
})

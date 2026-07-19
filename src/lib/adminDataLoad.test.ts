import { describe, it, expect } from 'vitest'
import { resolveAdminDataLoad } from './adminDataLoad'

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

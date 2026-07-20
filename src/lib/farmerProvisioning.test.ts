import { describe, it, expect } from 'vitest'
import {
  provisionFarmer,
  listPendingProfiles,
  type ProvisioningClientLike,
} from './farmerProvisioning'

// A tiny fake of the Supabase query builder that records the calls made and
// returns a scripted result. Enough to exercise the provisioning policy without
// a live database.
function fakeClient(opts: {
  updateResult?: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }
  selectResult?: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }
}) {
  const calls: {
    table?: string
    update?: Record<string, unknown>
    updateEqs: Array<[string, string]>
    updateSelect?: string
    select?: string
    selectEq?: [string, string]
  } = { updateEqs: [] }
  const client: ProvisioningClientLike = {
    from(table: string) {
      calls.table = table
      return {
        update(values: Record<string, unknown>) {
          calls.update = values
          const chain = {
            eq(column: string, value: string) {
              calls.updateEqs.push([column, value])
              return chain
            },
            select(columns: string) {
              calls.updateSelect = columns
              return Promise.resolve(opts.updateResult ?? { data: [], error: null })
            },
          }
          return chain
        },
        select(columns: string) {
          calls.select = columns
          return {
            eq(column: string, value: string) {
              calls.selectEq = [column, value]
              return Promise.resolve(opts.selectResult ?? { data: [], error: null })
            },
          }
        },
      }
    },
  }
  return { client, calls }
}

describe('provisionFarmer', () => {
  it('promotes exactly one pending profile → ok:true, via a pending-constrained update that reads back the id', async () => {
    const { client, calls } = fakeClient({ updateResult: { data: [{ id: 'user-42' }], error: null } })
    const result = await provisionFarmer(client, 'user-42')
    expect(result).toEqual({ ok: true })
    expect(calls.table).toBe('profiles')
    expect(calls.update).toEqual({ role: 'farmer' })
    // Constrained to the id AND role = 'pending', and reads back the id.
    expect(calls.updateEqs).toEqual([['id', 'user-42'], ['role', 'pending']])
    expect(calls.updateSelect).toBe('id')
    // No email-based lookup/filter anywhere in the promotion query.
    expect(calls.updateEqs.some(([col]) => col === 'email')).toBe(false)
  })

  it('returns ok:false when zero rows are returned (RLS-filtered non-admin, no DB error)', async () => {
    const { client } = fakeClient({ updateResult: { data: [], error: null } })
    expect((await provisionFarmer(client, 'user-42')).ok).toBe(false)
  })

  it('returns ok:false for a nonexistent id (zero rows)', async () => {
    const { client } = fakeClient({ updateResult: { data: [], error: null } })
    expect((await provisionFarmer(client, 'ghost')).ok).toBe(false)
  })

  it('returns ok:false for an already non-pending profile (excluded by role = pending → zero rows)', async () => {
    const { client } = fakeClient({ updateResult: { data: [], error: null } })
    expect((await provisionFarmer(client, 'already-farmer')).ok).toBe(false)
  })

  it('returns ok:false when the returned row id does not match the requested id', async () => {
    const { client } = fakeClient({ updateResult: { data: [{ id: 'someone-else' }], error: null } })
    expect((await provisionFarmer(client, 'user-42')).ok).toBe(false)
  })

  it('reports failure (does not throw) when RLS/DB returns an error', async () => {
    const { client } = fakeClient({ updateResult: { data: null, error: { message: 'permission denied' } } })
    expect(await provisionFarmer(client, 'user-42')).toEqual({ ok: false, error: 'permission denied' })
  })

  it('refuses an empty user id without calling the database', async () => {
    const { client, calls } = fakeClient({})
    const result = await provisionFarmer(client, '')
    expect(result.ok).toBe(false)
    expect(calls.table).toBeUndefined()
  })
})

describe('listPendingProfiles', () => {
  it('queries profiles where role = pending and maps the rows', async () => {
    const { client, calls } = fakeClient({
      selectResult: {
        data: [
          { id: 'u1', email: 'a@x.com', display_name: 'Alice', role: 'pending' },
          { id: 'u2', email: null, display_name: null, role: 'pending' },
        ],
        error: null,
      },
    })
    const rows = await listPendingProfiles(client)
    expect(calls.table).toBe('profiles')
    expect(calls.selectEq).toEqual(['role', 'pending'])
    expect(rows).toEqual([
      { id: 'u1', email: 'a@x.com', displayName: 'Alice' },
      { id: 'u2', email: '', displayName: '' },
    ])
  })

  it('throws when the query errors', async () => {
    const { client } = fakeClient({ selectResult: { data: null, error: { message: 'boom' } } })
    await expect(listPendingProfiles(client)).rejects.toThrow('boom')
  })
})

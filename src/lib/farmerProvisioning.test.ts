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
  updateResult?: { error: { message: string } | null }
  selectResult?: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }
}) {
  const calls: {
    table?: string
    update?: Record<string, unknown>
    updateEq?: [string, string]
    select?: string
    selectEq?: [string, string]
  } = {}
  const client: ProvisioningClientLike = {
    from(table: string) {
      calls.table = table
      return {
        update(values: Record<string, unknown>) {
          calls.update = values
          return {
            eq(column: string, value: string) {
              calls.updateEq = [column, value]
              return Promise.resolve(opts.updateResult ?? { error: null })
            },
          }
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
  it('promotes a pending account by setting profiles.role = farmer for that id', async () => {
    const { client, calls } = fakeClient({ updateResult: { error: null } })
    const result = await provisionFarmer(client, 'user-42')
    expect(result).toEqual({ ok: true })
    expect(calls.table).toBe('profiles')
    expect(calls.update).toEqual({ role: 'farmer' })
    expect(calls.updateEq).toEqual(['id', 'user-42'])
  })

  it('reports failure (does not throw) when RLS/DB rejects the update', async () => {
    // Simulates a non-admin caller: the "admin update role" policy denies the
    // update, so Supabase returns an error rather than changing the row.
    const { client } = fakeClient({ updateResult: { error: { message: 'permission denied' } } })
    const result = await provisionFarmer(client, 'user-42')
    expect(result).toEqual({ ok: false, error: 'permission denied' })
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

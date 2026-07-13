// Offline regression test for the staging suite's synthetic-data cleanup.
//
// It exercises the REAL exported helpers (deleteSyntheticFarms /
// countResidualFarms) against an in-memory fake Supabase client — no network,
// no staging. Importing the script does not trigger a live run: main() is
// guarded to execute only when the file is invoked directly.
//
// Why this test exists: an earlier cleanup filtered synthetic farms on a
// non-existent `name` column while the rows were inserted under `farm_name`, so
// the delete matched nothing and the residue check then reported "0" — a false
// clean that let 24 orphaned rows accumulate across runs. These tests fail if
// that drift ever returns.

import { describe, it, expect } from 'vitest'
import { deleteSyntheticFarms, countResidualFarms } from './run-staging-security-tests.mjs'

// Minimal fake of the Supabase query chains the helpers use:
//   from('farms').delete().ilike(col, `${tag}%`)
//   from('farms').select('id').ilike(col, `${tag}%`)
// It matches on EXACTLY the column the helper passes, so a helper that filtered
// the wrong column would match nothing here — which is the whole point.
function makeFakeClient(initialFarms, { deleteIsNoOp = false } = {}) {
  const farms = initialFarms.map(f => ({ ...f }))
  return {
    _farms: farms,
    from(table) {
      if (table !== 'farms') throw new Error(`unexpected table: ${table}`)
      const q = { mode: null }
      const api = {
        delete() { q.mode = 'delete'; return api },
        select() { q.mode = 'select'; return api },
        ilike(col, pattern) {
          const prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern
          const match = r => typeof r[col] === 'string' && r[col].startsWith(prefix)
          if (q.mode === 'delete') {
            if (!deleteIsNoOp) {
              for (let i = farms.length - 1; i >= 0; i--) if (match(farms[i])) farms.splice(i, 1)
            }
            return Promise.resolve({ data: null, error: null })
          }
          return Promise.resolve({ data: farms.filter(match), error: null })
        },
      }
      return api
    },
  }
}

const TAG = 'security-test-1783966397990-f7047fe1'

describe('cleanup removes exactly the synthetic records it created', () => {
  it('deletes tag-matched synthetic farms and leaves unrelated farms untouched', async () => {
    const client = makeFakeClient([
      { id: 'a', farm_name: `${TAG}-A` },
      { id: 'b', farm_name: `${TAG}-B` },
      { id: 'real', farm_name: 'Green Valley Farm' },        // a real farm — must survive
      { id: 'other', farm_name: 'security-test-OTHERRUN-A' }, // different run — not our tag
    ])

    await deleteSyntheticFarms(client, TAG)

    const remaining = client._farms.map(f => f.id)
    expect(remaining).toContain('real')
    expect(remaining).toContain('other')   // scoped to THIS run's tag, not all synthetic
    expect(remaining).not.toContain('a')
    expect(remaining).not.toContain('b')
  })

  it('reports zero residue once its own records are gone', async () => {
    const client = makeFakeClient([
      { id: 'a', farm_name: `${TAG}-A` },
      { id: 'b', farm_name: `${TAG}-B` },
    ])
    await deleteSyntheticFarms(client, TAG)
    expect(await countResidualFarms(client, TAG)).toBe(0)
  })
})

describe('cleanup targets farm_name, not name (the exact bug that regressed)', () => {
  it('does NOT delete a real farm whose `name` matches but whose `farm_name` does not', async () => {
    // This row would have been wrongly matched by the old `name`-column filter.
    const client = makeFakeClient([
      { id: 'trap', name: `${TAG}-A`, farm_name: 'Legitimate Farm Co' },
      { id: 'synthetic', farm_name: `${TAG}-A` },
    ])

    await deleteSyntheticFarms(client, TAG)

    const remaining = client._farms.map(f => f.id)
    expect(remaining).toContain('trap')        // must survive — it is a real farm
    expect(remaining).not.toContain('synthetic')
    // And residue detection also keys off farm_name, so it sees the real farm as clean.
    expect(await countResidualFarms(client, TAG)).toBe(0)
  })
})

describe('residue detection fails when synthetic records remain', () => {
  it('returns a non-zero count if a delete did not remove the row (would fail the live assertion)', async () => {
    // Simulate a broken/failed delete: the synthetic row survives.
    const client = makeFakeClient([{ id: 'z', farm_name: `${TAG}-A` }], { deleteIsNoOp: true })

    await deleteSyntheticFarms(client, TAG)
    const residue = await countResidualFarms(client, TAG)

    expect(residue).toBe(1)
    // The live suite asserts `residue === 0`; prove that assertion WOULD fail here
    // rather than silently passing on leftover data.
    expect(residue === 0).toBe(false)
  })
})

describe('helpers are null-safe (a missing signed-in client must not throw)', () => {
  it('deleteSyntheticFarms tolerates a null client', async () => {
    await expect(deleteSyntheticFarms(null, TAG)).resolves.toBeUndefined()
  })
  it('countResidualFarms returns 0 for a null client', async () => {
    expect(await countResidualFarms(null, TAG)).toBe(0)
  })
})

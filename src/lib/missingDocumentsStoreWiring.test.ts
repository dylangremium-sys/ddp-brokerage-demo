import { beforeEach, describe, expect, it } from 'vitest'
import {
  resolveRequirementOverrides,
  recordRequirementOverride,
  requirementKey,
  isEffectiveOverride,
} from './procurementOverrideStore'
import { saveRequirementOverride, loadRequirementOverrides } from './procurementControl'
import type { DocumentRequirementType, EvidenceStatus } from '../types'

/**
 * F2b adoption — the Missing Document Matrix moves onto the server-authoritative
 * override store.
 *
 * The matrix drives half of the release gate: a requirement it shows as
 * Rejected/Expired is a blocker, and moving one OFF those statuses clears a
 * blocker. Yet it wrote overrides straight to localStorage in Supabase mode too
 * (saveRequirementOverride), with no actor, no reason, invisible to other
 * admins, and wiped by sign-out. It now batch-resolves through
 * resolveRequirementOverrides (server wins, fail closed) and records through
 * recordRequirementOverride (append-only, reason required, refused writes cache
 * nothing).
 */

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  installMemoryLocalStorage()
})

/** Stub matching the OverrideClientLike shape the store consumes. */
function stubClient(
  read: { data?: unknown; error?: { code?: string; message?: string } | null },
  insertError: { code?: string; message?: string } | null = null,
) {
  const reads: Array<{ table: string; col: string; vals: string[] }> = []
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: null, error: null }),
                eq() { return { maybeSingle: async () => ({ data: null, error: null }) } },
              }
            },
            in: async (col: string, vals: string[]) => {
              reads.push({ table, col, vals })
              return { data: read.data ?? null, error: read.error ?? null }
            },
          }
        },
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row })
          return { error: insertError }
        },
      }
    },
  }
  return { client, reads, inserts }
}

const ROW = (farmId: string, type: string, status: string) => ({
  farm_id: farmId,
  requirement_type: type,
  status,
  reason: 'checked against the issuing authority',
  notes: null,
  decided_at: '2026-07-20T10:00:00.000Z',
  decided_by: '11111111-1111-1111-1111-111111111111',
})

const COA = 'coa' as DocumentRequirementType

describe('store behaviour — server wins over the cache for the listed farms', () => {
  it('prefers the server row over a cached override for the same key', async () => {
    // Admin A's browser cache, written before the migration.
    saveRequirementOverride('farm-1', COA, 'verified' as EvidenceStatus)
    // Admin B's later server-recorded decision.
    const { client } = stubClient({ data: [ROW('farm-1', 'coa', 'rejected')] })

    const { byKey, unavailable } = await resolveRequirementOverrides(['farm-1'], client)
    expect(unavailable).toBe(false)
    const resolved = byKey.get(requirementKey('farm-1', COA))
    expect(resolved?.source).toBe('server')
    expect(resolved?.status).toBe('rejected')
  })

  it('reads all farms in ONE query rather than an N+1 of per-cell reads', async () => {
    const { client, reads } = stubClient({ data: [] })
    await resolveRequirementOverrides(['a', 'b', 'c', 'd'], client)
    expect(reads).toHaveLength(1)
    expect(reads[0].table).toBe('requirement_overrides_current')
    expect(reads[0].col).toBe('farm_id')
    expect(reads[0].vals).toEqual(['a', 'b', 'c', 'd'])
  })

  it('de-duplicates farm ids before querying', async () => {
    const { client, reads } = stubClient({ data: [] })
    await resolveRequirementOverrides(['a', 'a', 'b'], client)
    expect(reads[0].vals).toEqual(['a', 'b'])
  })

  it('short-circuits an empty farm set without querying', async () => {
    const { client, reads } = stubClient({ data: [] })
    const { byKey, unavailable } = await resolveRequirementOverrides([], client)
    expect(reads).toHaveLength(0)
    expect(byKey.size).toBe(0)
    expect(unavailable).toBe(false)
  })

  it('keys the resolution by the composite requirementKey', () => {
    expect(requirementKey('farm-1', COA)).toBe('farm-1::coa')
  })
})

describe('store behaviour — a failed read returns an EMPTY map, so membership is not a signal', () => {
  it('reports unavailable with an empty byKey and never substitutes the cache', async () => {
    saveRequirementOverride('farm-1', COA, 'verified' as EvidenceStatus)
    // RLS denial — NOT a missing table.
    const { client } = stubClient({ error: { code: '42501', message: 'permission denied for view requirement_overrides_current' } })

    const { byKey, unavailable, error } = await resolveRequirementOverrides(['farm-1'], client)
    expect(unavailable).toBe(true)
    expect(error).toContain('permission denied')
    // THE TRAP a caller must not fall into: the map is EMPTY on a failed read,
    // so byKey.get() returns undefined exactly as it would for "no override".
    // Only the `unavailable` flag distinguishes the two.
    expect(byKey.size).toBe(0)
    expect(byKey.get(requirementKey('farm-1', COA))).toBeUndefined()
  })

  it('does not degrade to the cache on schema drift or a transient failure', async () => {
    saveRequirementOverride('farm-1', COA, 'verified' as EvidenceStatus)
    for (const err of [
      { code: '42703', message: 'column c.status does not exist' },
      { message: 'fetch failed' },
      { code: '503', message: 'service unavailable' },
    ]) {
      const { client } = stubClient({ error: err })
      const { byKey, unavailable } = await resolveRequirementOverrides(['farm-1'], client)
      expect(unavailable, JSON.stringify(err)).toBe(true)
      expect(byKey.size, JSON.stringify(err)).toBe(0)
    }
  })

  it('isEffectiveOverride refuses an unavailable source, so it can never be applied', () => {
    expect(isEffectiveOverride('server')).toBe(true)
    expect(isEffectiveOverride('local-cache')).toBe(true)
    expect(isEffectiveOverride('none')).toBe(false)
    expect(isEffectiveOverride('unavailable')).toBe(false)
  })
})

describe('store behaviour — documented degradations keep demo mode unchanged', () => {
  it('falls back to the cache when migration 30 is genuinely absent', async () => {
    saveRequirementOverride('farm-1', COA, 'reviewed' as EvidenceStatus)
    const { client } = stubClient({ error: { code: '42P01', message: 'relation "requirement_overrides_current" does not exist' } })
    const { byKey, unavailable } = await resolveRequirementOverrides(['farm-1'], client)
    expect(unavailable).toBe(false)
    expect(byKey.get('farm-1::coa')?.source).toBe('local-cache')
    expect(byKey.get('farm-1::coa')?.status).toBe('reviewed')
  })

  it('uses the cache in demo mode (no client), leaving demo behaviour unchanged', async () => {
    saveRequirementOverride('farm-1', COA, 'documented' as EvidenceStatus)
    const { byKey, unavailable } = await resolveRequirementOverrides(['farm-1'], null)
    expect(unavailable).toBe(false)
    expect(byKey.get('farm-1::coa')?.source).toBe('local-cache')
  })

  it('records to localStorage in demo mode and reports it honestly', async () => {
    const result = await recordRequirementOverride(
      { farmId: 'farm-1', type: COA, status: 'reviewed' as EvidenceStatus, reason: 'demo review' },
      null,
    )
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('local-cache')
    expect(loadRequirementOverrides()['farm-1::coa']?.status).toBe('reviewed')
  })
})

describe('store behaviour — a reason is required, in every mode, before anything is written', () => {
  it('refuses a blank reason against a server client without attempting the insert', async () => {
    const { client, inserts } = stubClient({ data: [] })
    const result = await recordRequirementOverride(
      { farmId: 'farm-1', type: COA, status: 'verified' as EvidenceStatus, reason: '   ' },
      client,
    )
    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(inserts).toHaveLength(0)
    expect(loadRequirementOverrides()['farm-1::coa']).toBeUndefined()
  })

  it('refuses a blank reason even in demo mode', async () => {
    const result = await recordRequirementOverride(
      { farmId: 'farm-1', type: COA, status: 'verified' as EvidenceStatus, reason: '' },
      null,
    )
    expect(result.ok).toBe(false)
    expect(loadRequirementOverrides()['farm-1::coa']).toBeUndefined()
  })
})

describe('store behaviour — a refused write caches nothing', () => {
  it('reports the failure and leaves the cache untouched on an RLS denial', async () => {
    const { client } = stubClient({ data: [] }, { code: '42501', message: 'new row violates row-level security policy' })
    const result = await recordRequirementOverride(
      { farmId: 'farm-1', type: COA, status: 'verified' as EvidenceStatus, reason: 'looks complete' },
      client,
    )
    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(result.error).toContain('row-level security')
    // Nothing cached: the matrix cannot later present this as an applied status.
    expect(loadRequirementOverrides()['farm-1::coa']).toBeUndefined()
  })

  it('records durably and refreshes the cache on an accepted write', async () => {
    const { client, inserts } = stubClient({ data: [] })
    const result = await recordRequirementOverride(
      { farmId: 'farm-1', type: COA, status: 'verified' as EvidenceStatus, reason: 'checked against the lab portal' },
      client,
    )
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('server')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('requirement_overrides')
    expect(inserts[0].row.reason).toBe('checked against the lab portal')
    expect(loadRequirementOverrides()['farm-1::coa']?.status).toBe('verified')
  })
})

/**
 * The page itself is .tsx and this repo's vitest env is 'node' with no jsdom, so
 * the wiring is asserted against source text via `import.meta.glob(..., '?raw')`
 * — the existing convention (operationsDeskRouting.test.ts,
 * overrideProvenanceNotice.test.ts, buyerPreviewApprovedList.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}
const MATRIX_SRC = raw(import.meta.glob('../pages/admin/DDPMissingDocuments.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('wiring — the matrix reads and writes through the authoritative store', () => {
  it('loads the source under assertion', () => {
    expect(MATRIX_SRC.length).toBeGreaterThan(1000)
  })

  it('imports the store and batch-resolves the farm set through it', () => {
    expect(MATRIX_SRC).toContain("from '../../lib/procurementOverrideStore'")
    expect(MATRIX_SRC).toContain('resolveRequirementOverrides(')
    // An N+1 of per-cell single reads is explicitly out of contract.
    expect(MATRIX_SRC).not.toContain('resolveRequirementOverride(')
  })

  it('records through recordRequirementOverride, not the raw localStorage writer', () => {
    expect(MATRIX_SRC).toContain('recordRequirementOverride(')
    // THE DEFECT, verbatim: the fire-and-forget browser-local write.
    expect(MATRIX_SRC).not.toMatch(/saveRequirementOverride\s*\(/)
  })

  it('no longer reads the raw localStorage cache directly', () => {
    // Both raw-cache readers are gone: the store is the only source of override
    // state, and with it the forced re-render that papered over the cache read.
    expect(MATRIX_SRC).not.toMatch(/applyRequirementOverrides\s*\(/)
    expect(MATRIX_SRC).not.toMatch(/loadRequirementOverrides\s*\(/)
    expect(MATRIX_SRC).not.toContain('renderTick')
  })

  it('derives staleness from a stable farm-set key instead of resetting state in an effect', () => {
    expect(MATRIX_SRC).toContain("farms.map(f => f.id).join(' ')")
    expect(MATRIX_SRC).toContain('resolvedOverrides.key === farmKey')
  })
})

describe('wiring — fail closed on unavailable, distinct from loading, never from map membership', () => {
  it('branches on the resolution settling and on `unavailable`, as two distinct states', () => {
    expect(MATRIX_SRC).toContain("overrideState === 'loading'")
    expect(MATRIX_SRC).toContain("overrideState === 'unavailable'")
    // The tri-state is derived from null (in flight) vs unavailable (failed) —
    // the two conditions the store contract says must never be conflated.
    expect(MATRIX_SRC).toMatch(/resolution === null \? 'loading' : resolution\.unavailable \? 'unavailable' : 'resolved'/)
  })

  it('applies overrides only from a settled, successful read', () => {
    expect(MATRIX_SRC).toContain('resolution === null || resolution.unavailable')
    expect(MATRIX_SRC).toContain('isEffectiveOverride(override.source)')
  })

  it('does NOT infer failure from map membership — the failed-read map is empty', () => {
    // Membership checks against byKey would read a failed read as "no
    // overrides". Only per-key lookups for APPLYING overrides use the map.
    expect(MATRIX_SRC).not.toMatch(/byKey\.(has|size)/)
  })

  it('tells the operator the unavailable statuses are derived, not authoritative', () => {
    expect(MATRIX_SRC).toContain('could not be verified against the server')
    expect(MATRIX_SRC).toContain('not</strong> a statement that none exist')
  })
})

describe('wiring — a reason is captured from the operator before any write', () => {
  it('a select change only proposes; the pending override starts with a BLANK reason', () => {
    expect(MATRIX_SRC).toContain("{ farmId, type, status, reason: '' }")
  })

  it('the confirm button is disabled until a non-blank reason is supplied', () => {
    expect(MATRIX_SRC).toContain('disabled={!pending.reason.trim() || saving}')
  })

  it('the handler refuses to write without a reason, belt-and-braces with the store', () => {
    expect(MATRIX_SRC).toContain('const reason = pending.reason.trim()')
    expect(MATRIX_SRC).toContain('if (!reason) return')
  })

  it('the reason is typed by the operator, never fabricated', () => {
    // The only reason ever sent is the pending cell's operator-typed text; no
    // literal reason string exists anywhere in the page.
    expect(MATRIX_SRC).not.toMatch(/reason:\s*['"`][^'"`]+['"`]/)
  })
})

describe('wiring — the write is awaited and its failure is handled', () => {
  it('awaits the record call and branches on ok', () => {
    expect(MATRIX_SRC).toContain('const result = await recordRequirementOverride(')
    expect(MATRIX_SRC).toContain('if (!result.ok)')
  })

  it('surfaces the refusal and does not present the attempted status as applied', () => {
    expect(MATRIX_SRC).toContain('setWriteError(result.error ??')
    // The failure branch returns BEFORE the re-resolve/pending-clear, so the
    // displayed pill keeps showing the authoritative status.
    expect(MATRIX_SRC).toMatch(/if \(!result\.ok\) \{[\s\S]*?return\s*\}/)
  })

  it('re-resolves from the authoritative source after a successful write', () => {
    // Two call sites: the mount/farm-set effect and the post-write refresh.
    expect(MATRIX_SRC.match(/resolveRequirementOverrides\(/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('wiring — provenance notice counts only browser-local overrides', () => {
  it('keeps the shared notice with its established subject', () => {
    expect(MATRIX_SRC).toContain("from '../../components/shared/BrowserOnlyProvenanceNotice'")
    expect(MATRIX_SRC).toMatch(/<BrowserOnlyProvenanceNotice[\s\S]{0,120}subject="document status overrides"/)
    expect(MATRIX_SRC).toContain('count={overriddenCount}')
  })

  it("counts only source === 'local-cache' — server-recorded overrides are durable and attributed", () => {
    expect(MATRIX_SRC).toContain(".source === 'local-cache'")
    // The count comes from the resolution's provenance, not from re-reading the
    // raw cache (which also holds refreshed copies of SERVER rows).
    expect(MATRIX_SRC).not.toMatch(/loadRequirementOverrides\s*\(/)
  })
})

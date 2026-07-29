import { beforeEach, describe, expect, it } from 'vitest'
import {
  resolveRiskOverride,
  recordRiskOverride,
  resolveRequirementOverride,
  recordRequirementOverride,
  isEffectiveOverride,
  type OverrideClientLike,
} from './procurementOverrideStore'
import {
  loadRiskOverrides,
  loadRequirementOverrides,
  saveRiskOverride,
  saveRequirementOverride,
} from './procurementControl'

/**
 * F2b — the durable half of "the blocking-issue side of the release gate is
 * browser-local, unattributed, and destroyed by sign-out".
 *
 * Acceptance criteria from the finding, each covered below:
 *   • server wins
 *   • RLS denial → 'unavailable' → gate CLOSED (not "no override")
 *   • table-missing → local fallback
 *   • a failed write caches nothing
 *   • demo mode unchanged
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

type DbError = { code?: string; message?: string }

/**
 * Client double matching the OverrideClientLike shape. `select().eq()` returns an
 * object carrying BOTH maybeSingle (single-key reads, risks) and a further eq
 * (composite-key reads, requirements).
 */
function stubClient(opts: {
  readData?: unknown
  readError?: DbError
  insertError?: DbError
} = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const reads: Array<{ table: string; filters: Array<[string, string]> }> = []

  const client = {
    from(table: string) {
      return {
        select() {
          const filters: Array<[string, string]> = []
          const node = {
            eq(col: string, val: string) {
              filters.push([col, val])
              return node
            },
            async maybeSingle() {
              reads.push({ table, filters })
              return { data: opts.readError ? null : (opts.readData ?? null), error: opts.readError ?? null }
            },
            // The batch-read arm of the contract. Present so the double stays a
            // TYPED implementation of OverrideClientLike rather than a cast —
            // which is the point of typing it: when the store's contract grew an
            // `in()`, tsc said so here instead of the gap going unnoticed.
            async in(col: string, vals: string[]) {
              filters.push([col, vals.join(',')])
              reads.push({ table, filters })
              return { data: opts.readError ? null : (opts.readData ?? null), error: opts.readError ?? null }
            },
          }
          return node
        },
        async insert(row: Record<string, unknown>) {
          inserts.push({ table, row })
          return { error: opts.insertError ?? null }
        },
      }
    },
  }
  // Typed against the store's own exported contract, so the double is checked
  // rather than asserted.
  return { client: client as OverrideClientLike, inserts, reads }
}

const RISK_ID = 'risk-batch-1#deadbeef'

describe('F2b — server wins', () => {
  it('prefers the server override over a conflicting local cache', async () => {
    saveRiskOverride(RISK_ID, 'resolved', 'Admin A', 'cleared locally')
    const { client } = stubClient({
      readData: {
        status: 'open', reason: 'reopened after new lab result', owner: 'Admin B',
        decided_at: '2026-07-20T10:00:00.000Z', decided_by: '1111',
      },
    })
    const resolved = await resolveRiskOverride(RISK_ID, client)
    expect(resolved.source).toBe('server')
    expect(resolved.status).toBe('open')
    expect(resolved.reason).toBe('reopened after new lab result')
    expect(resolved.decidedBy).toBe('1111')
  })

  it('carries the actor and reason the localStorage record never had', async () => {
    const { client } = stubClient({
      readData: { status: 'accepted', reason: 'risk accepted by DDP', owner: 'Admin B', decided_at: '2026-07-20T10:00:00.000Z', decided_by: 'uuid-b' },
    })
    const resolved = await resolveRiskOverride(RISK_ID, client)
    expect(resolved.decidedBy).toBe('uuid-b')
    expect(resolved.decidedAt).toBe('2026-07-20T10:00:00.000Z')
    expect(resolved.reason).toBeTruthy()
  })

  it('reads the requirement override on the composite (farm_id, type) key', async () => {
    const { client, reads } = stubClient({
      readData: { status: 'rejected', reason: 'certificate expired', notes: null, decided_at: '2026-07-20T10:00:00.000Z', decided_by: 'uuid-b' },
    })
    const resolved = await resolveRequirementOverride('farm-1', 'farm_license', client)
    expect(resolved.source).toBe('server')
    expect(resolved.status).toBe('rejected')
    expect(reads[0].filters).toEqual([['farm_id', 'farm-1'], ['requirement_type', 'farm_license']])
  })
})

describe('F2b — RLS denial fails the gate CLOSED, it is not "no override"', () => {
  const DENIALS: DbError[] = [
    { code: '42501', message: 'permission denied for view risk_overrides_current' },
    { code: '42703', message: 'column c.status does not exist' },        // schema drift
    { message: 'fetch failed' },                                          // network
    { code: '503', message: 'service unavailable' },                      // transient
  ]

  it.each(DENIALS)('risk: $code $message → unavailable, cache NOT substituted', async (err) => {
    saveRiskOverride(RISK_ID, 'resolved', 'Admin A', 'cleared locally')
    const { client } = stubClient({ readError: err })
    const resolved = await resolveRiskOverride(RISK_ID, client)

    expect(resolved.source).toBe('unavailable')
    // The critical assertion: the cached 'resolved' must NOT surface.
    expect(resolved.status).toBeNull()
    expect(resolved.error).toBeTruthy()
    // And the gate is shut.
    expect(isEffectiveOverride(resolved.source)).toBe(false)
  })

  it.each(DENIALS)('requirement: $code $message → unavailable, cache NOT substituted', async (err) => {
    saveRequirementOverride('farm-1', 'farm_license', 'verified', 'cleared locally')
    const { client } = stubClient({ readError: err })
    const resolved = await resolveRequirementOverride('farm-1', 'farm_license', client)

    expect(resolved.source).toBe('unavailable')
    expect(resolved.status).toBeNull()
    expect(isEffectiveOverride(resolved.source)).toBe(false)
  })

  it('distinguishes unavailable from a genuine absence', async () => {
    const { client } = stubClient({ readData: null })
    const absent = await resolveRiskOverride('risk-none#00000000', client)
    expect(absent.source).toBe('none')
    expect(absent.status).toBeNull()
    // Both have a null status; only one is a claim that no override exists.
    expect(absent.source).not.toBe('unavailable')
  })
})

describe('F2b — table-missing degrades to the local cache', () => {
  it.each([
    { code: '42P01', message: 'relation "public.risk_overrides_current" does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.risk_overrides_current' in the schema cache" },
  ])('risk: $code falls back to local', async (err) => {
    saveRiskOverride(RISK_ID, 'resolved', 'Admin A', 'pre-migration clearance')
    const { client } = stubClient({ readError: err })
    const resolved = await resolveRiskOverride(RISK_ID, client)
    expect(resolved.source).toBe('local-cache')
    expect(resolved.status).toBe('resolved')
    // Pre-migration records have no actor or reason — that was the defect, and
    // the store must not pretend otherwise.
    expect(resolved.decidedBy).toBeNull()
    expect(resolved.reason).toBeNull()
  })

  it('requirement: 42P01 falls back to local', async () => {
    saveRequirementOverride('farm-1', 'farm_license', 'verified', 'pre-migration')
    const { client } = stubClient({ readError: { code: '42P01', message: 'relation "requirement_overrides_current" does not exist' } })
    const resolved = await resolveRequirementOverride('farm-1', 'farm_license', client)
    expect(resolved.source).toBe('local-cache')
    expect(resolved.status).toBe('verified')
  })

  it('does not mistake a missing COLUMN for a missing table', async () => {
    saveRiskOverride(RISK_ID, 'resolved', 'Admin A', 'cached')
    // No code at all, and the message does not name an override object.
    const { client } = stubClient({ readError: { message: 'column "owner" does not exist' } })
    const resolved = await resolveRiskOverride(RISK_ID, client)
    expect(resolved.source).toBe('unavailable')
  })
})

describe('F2b — a failed write caches nothing', () => {
  it('risk: an RLS-refused insert leaves the cache untouched', async () => {
    const { client, inserts } = stubClient({
      insertError: { code: '42501', message: 'new row violates row-level security policy' },
    })
    const result = await recordRiskOverride(
      { riskId: RISK_ID, status: 'resolved', reason: 'clearing this' }, client,
    )
    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(inserts).toHaveLength(1)
    // NOTHING cached — the UI must not present a server-rejected clearance.
    expect(loadRiskOverrides()[RISK_ID]).toBeUndefined()
  })

  it('risk: a failed write leaves a PRIOR legitimate record intact', async () => {
    saveRiskOverride(RISK_ID, 'in_review', 'Admin A', 'earlier legitimate record')
    const { client } = stubClient({ insertError: { code: '42501', message: 'denied' } })
    await recordRiskOverride({ riskId: RISK_ID, status: 'resolved', reason: 'attempt' }, client)
    expect(loadRiskOverrides()[RISK_ID].status).toBe('in_review')
  })

  it('requirement: an RLS-refused insert leaves the cache untouched', async () => {
    const { client } = stubClient({ insertError: { code: '42501', message: 'denied' } })
    const result = await recordRequirementOverride(
      { farmId: 'farm-1', type: 'farm_license', status: 'verified', reason: 'clearing' }, client,
    )
    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(loadRequirementOverrides()['farm-1::farm_license']).toBeUndefined()
  })

  it('caches only after the server ACCEPTS the write', async () => {
    const { client } = stubClient({})
    const result = await recordRiskOverride(
      { riskId: RISK_ID, status: 'resolved', reason: 'COA received' }, client,
    )
    expect(result.persistedTo).toBe('server')
    expect(loadRiskOverrides()[RISK_ID].status).toBe('resolved')
  })

  it('never sends decided_by — the actor is server-captured and unspoofable', async () => {
    const { client, inserts } = stubClient({})
    await recordRiskOverride({ riskId: RISK_ID, status: 'resolved', reason: 'ok' }, client)
    expect(Object.keys(inserts[0].row)).not.toContain('decided_by')
    expect(inserts[0].row).toMatchObject({ risk_id: RISK_ID, status: 'resolved', reason: 'ok' })
  })

  it('refuses a blank reason before it reaches the server, and caches nothing', async () => {
    const { client, inserts } = stubClient({})
    const result = await recordRiskOverride({ riskId: RISK_ID, status: 'resolved', reason: '   ' }, client)
    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(inserts).toHaveLength(0)
    expect(loadRiskOverrides()[RISK_ID]).toBeUndefined()
  })

  it('caches when the table is genuinely absent (deliberate local-only fallback)', async () => {
    const { client } = stubClient({ insertError: { code: '42P01', message: 'relation "risk_overrides" does not exist' } })
    const result = await recordRiskOverride({ riskId: RISK_ID, status: 'resolved', reason: 'ok' }, client)
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('local-cache')
    expect(loadRiskOverrides()[RISK_ID].status).toBe('resolved')
  })
})

describe('F2b — demo mode is unchanged', () => {
  it('writes to and reads from localStorage with no client', async () => {
    const result = await recordRiskOverride({ riskId: RISK_ID, status: 'accepted', reason: 'demo' }, null)
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('local-cache')

    const resolved = await resolveRiskOverride(RISK_ID, null)
    expect(resolved.source).toBe('local-cache')
    expect(resolved.status).toBe('accepted')
  })

  it('never reports unavailable in demo mode — the gate must not jam shut offline', async () => {
    const resolved = await resolveRiskOverride('risk-absent#0', null)
    expect(resolved.source).toBe('none')
  })

  it('requirement overrides behave identically in demo mode', async () => {
    await recordRequirementOverride(
      { farmId: 'farm-1', type: 'farm_license', status: 'verified', reason: 'demo' }, null,
    )
    const resolved = await resolveRequirementOverride('farm-1', 'farm_license', null)
    expect(resolved.source).toBe('local-cache')
    expect(resolved.status).toBe('verified')
  })
})

describe('F2b — the risk key stays content-bound (does not reintroduce F1a)', () => {
  it('reads on the full composed risk id, fingerprint included', async () => {
    const { client, reads } = stubClient({ readData: null })
    await resolveRiskOverride(RISK_ID, client)
    expect(reads[0].filters).toEqual([['risk_id', RISK_ID]])
    expect(reads[0].filters[0][1]).toContain('#')
  })

  it('an override on one fingerprint does not resolve for another', async () => {
    saveRiskOverride('risk-batch-1#aaaaaaaa', 'resolved', 'Admin A', 'cleared')
    const { client } = stubClient({ readError: { code: '42P01', message: 'relation "risk_overrides_current" does not exist' } })
    // Same batch, different risk content ⇒ different id ⇒ no clearance.
    const resolved = await resolveRiskOverride('risk-batch-1#bbbbbbbb', client)
    expect(resolved.source).toBe('none')
    expect(resolved.status).toBeNull()
  })
})

describe('F2b — isEffectiveOverride encodes the fail-closed rule', () => {
  it('treats server and local-cache as effective', () => {
    expect(isEffectiveOverride('server')).toBe(true)
    expect(isEffectiveOverride('local-cache')).toBe(true)
  })

  it('treats unavailable and none as NOT effective', () => {
    expect(isEffectiveOverride('unavailable')).toBe(false)
    expect(isEffectiveOverride('none')).toBe(false)
  })
})

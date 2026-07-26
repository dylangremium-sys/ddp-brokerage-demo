import { beforeEach, describe, expect, it } from 'vitest'
import {
  resolveRiskOverrides,
  recordRiskOverride,
  isEffectiveOverride,
} from './procurementOverrideStore'
import { loadRiskOverrides, saveRiskOverride } from './procurementControl'

/**
 * F2b adoption — the Risk Register moves off raw localStorage and onto the
 * server-authoritative override store.
 *
 * The page used to call applyRiskOverrides(deriveAutoRisks(...)) synchronously
 * and saveRiskOverride() on every select change: browser-only, unattributed,
 * reason-less, wiped by sign-out, and invisible to every other admin — while
 * driving half of the release gate (hasBlockingIssues). It now batch-resolves
 * the authoritative state via resolveRiskOverrides and writes through
 * recordRiskOverride, failing CLOSED when the authoritative read fails.
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

/** Stub matching the OverrideClientLike shape the store consumes. */
function stubClient(opts: { readData?: unknown; readError?: DbError; insertError?: DbError } = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const batchReads: Array<{ table: string; col: string; vals: string[] }> = []
  const client = {
    from(table: string) {
      return {
        select() {
          const single = { maybeSingle: async () => ({ data: null, error: null }) }
          return {
            eq() { return { ...single, eq() { return single } } },
            in: async (col: string, vals: string[]) => {
              batchReads.push({ table, col, vals })
              return { data: opts.readError ? null : (opts.readData ?? []), error: opts.readError ?? null }
            },
          }
        },
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row })
          return { error: opts.insertError ?? null }
        },
      }
    },
  }
  return { client, inserts, batchReads }
}

const ROW = (riskId: string, status: string) => ({
  risk_id: riskId,
  status,
  reason: 'reviewed with the farm',
  owner: 'QA',
  decided_at: '2026-07-20T10:00:00.000Z',
  decided_by: '11111111-1111-1111-1111-111111111111',
})

// A content-bound id in the composeRiskId shape the page passes through.
const RISK_A = 'risk-batch-inv-1#0a1b2c3d'
const RISK_B = 'risk-farm-farm-1-watchlist#4e5f6071'

describe('F2b adoption — the batch resolve the page relies on', () => {
  it('resolves all risk ids in ONE query, not an N+1', async () => {
    const { client, batchReads } = stubClient({ readData: [] })
    await resolveRiskOverrides([RISK_A, RISK_B], client)
    expect(batchReads).toHaveLength(1)
    expect(batchReads[0].table).toBe('risk_overrides_current')
    expect(batchReads[0].col).toBe('risk_id')
    expect(batchReads[0].vals).toEqual([RISK_A, RISK_B])
  })

  it('server wins over a stale browser cache', async () => {
    // Admin A's browser still caches a clearance; the server's current row says
    // the risk went back into review.
    saveRiskOverride(RISK_A, 'resolved')
    const { client } = stubClient({ readData: [ROW(RISK_A, 'in_review')] })
    const { byKey, unavailable } = await resolveRiskOverrides([RISK_A], client)
    expect(unavailable).toBe(false)
    expect(byKey.get(RISK_A)?.source).toBe('server')
    expect(byKey.get(RISK_A)?.status).toBe('in_review')
    expect(byKey.get(RISK_A)?.decidedBy).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('a failed authoritative read is UNAVAILABLE for every key, never the cache', async () => {
    saveRiskOverride(RISK_A, 'resolved')
    // RLS denial — NOT a missing table, so no degrade.
    const { client } = stubClient({ readError: { code: '42501', message: 'permission denied for view risk_overrides_current' } })
    const { byKey, unavailable, error } = await resolveRiskOverrides([RISK_A, RISK_B], client)
    expect(unavailable).toBe(true)
    expect(error).toContain('permission denied')
    for (const id of [RISK_A, RISK_B]) {
      expect(byKey.get(id)?.source).toBe('unavailable')
      expect(byKey.get(id)?.status).toBeNull()
      expect(isEffectiveOverride(byKey.get(id)!.source)).toBe(false)
    }
  })

  it('degrades to the cache ONLY when the override table is genuinely absent', async () => {
    saveRiskOverride(RISK_A, 'accepted')
    const { client } = stubClient({ readError: { code: '42P01', message: 'relation "risk_overrides_current" does not exist' } })
    const { byKey, unavailable } = await resolveRiskOverrides([RISK_A], client)
    expect(unavailable).toBe(false)
    expect(byKey.get(RISK_A)?.source).toBe('local-cache')
    expect(byKey.get(RISK_A)?.status).toBe('accepted')
  })

  it('demo mode (no client) resolves from the cache, unchanged', async () => {
    saveRiskOverride(RISK_A, 'in_review')
    const { byKey, unavailable } = await resolveRiskOverrides([RISK_A], null)
    expect(unavailable).toBe(false)
    expect(byKey.get(RISK_A)?.source).toBe('local-cache')
    expect(byKey.get(RISK_A)?.status).toBe('in_review')
  })

  it('reports source "none" for a risk with neither a server row nor a cache entry', async () => {
    const { client } = stubClient({ readData: [] })
    const { byKey } = await resolveRiskOverrides([RISK_A], client)
    expect(byKey.get(RISK_A)?.source).toBe('none')
    expect(byKey.get(RISK_A)?.status).toBeNull()
  })
})

describe('F2b adoption — the write path the page relies on', () => {
  it('refuses a blank or whitespace reason without touching the server or the cache', async () => {
    for (const reason of ['', '   ', '\n\t']) {
      const { client, inserts } = stubClient()
      const result = await recordRiskOverride({ riskId: RISK_A, status: 'resolved', reason }, client)
      expect(result.ok, JSON.stringify(reason)).toBe(false)
      expect(result.persistedTo).toBe('none')
      expect(inserts).toHaveLength(0)
      expect(loadRiskOverrides()[RISK_A]).toBeUndefined()
    }
  })

  it('refuses a blank reason in demo mode too — the reason contract is uniform', async () => {
    const result = await recordRiskOverride({ riskId: RISK_A, status: 'resolved', reason: '  ' }, null)
    expect(result.ok).toBe(false)
    expect(loadRiskOverrides()[RISK_A]).toBeUndefined()
  })

  it('a server-refused write caches NOTHING, so the UI cannot show it as applied', async () => {
    const { client } = stubClient({ insertError: { code: '42501', message: 'new row violates row-level security policy' } })
    const result = await recordRiskOverride({ riskId: RISK_A, status: 'resolved', reason: 'triaged' }, client)
    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(result.error).toContain('row-level security')
    expect(loadRiskOverrides()[RISK_A]).toBeUndefined()
  })

  it('an accepted write reaches the server with the trimmed reason and refreshes the cache', async () => {
    const { client, inserts } = stubClient()
    const result = await recordRiskOverride({ riskId: RISK_A, status: 'in_review', reason: '  awaiting fresh COA  ' }, client)
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('server')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('risk_overrides')
    expect(inserts[0].row).toMatchObject({ risk_id: RISK_A, status: 'in_review', reason: 'awaiting fresh COA' })
    // decided_by is NOT sent — the server captures the actor from auth.uid().
    expect(inserts[0].row.decided_by).toBeUndefined()
    expect(loadRiskOverrides()[RISK_A]?.status).toBe('in_review')
  })

  it('demo mode persists to localStorage exactly as before', async () => {
    const result = await recordRiskOverride({ riskId: RISK_A, status: 'accepted', reason: 'demo triage' }, null)
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('local-cache')
    expect(loadRiskOverrides()[RISK_A]?.status).toBe('accepted')
  })
})

describe('F2b adoption — only effective sources may change a displayed status', () => {
  it.each([
    ['server', true],
    ['local-cache', true],
    ['none', false],
    ['unavailable', false],
  ] as const)('source %s → effective %s', (source, expected) => {
    expect(isEffectiveOverride(source)).toBe(expected)
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
const RISK_SRC = raw(import.meta.glob('../pages/admin/DDPRiskRegister.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('F2b adoption — the Risk Register is wired to the authoritative store', () => {
  it('loads the source under assertion', () => {
    expect(RISK_SRC.length).toBeGreaterThan(1000)
  })

  it('imports the store and batch-resolves the visible risk ids', () => {
    expect(RISK_SRC).toContain("from '../../lib/procurementOverrideStore'")
    expect(RISK_SRC).toContain('resolveRiskOverrides(')
    // An N+1 of per-row single reads is explicitly out of contract.
    expect(RISK_SRC).not.toContain('resolveRiskOverride(')
  })

  it('writes through recordRiskOverride and never through the raw local save', () => {
    expect(RISK_SRC).toContain('recordRiskOverride({')
    // THE DEFECT, by name: the fire-and-forget localStorage write.
    expect(RISK_SRC).not.toMatch(/saveRiskOverride/)
    // The synchronous localStorage merge is gone with it — overrides are applied
    // only from the resolved batch.
    expect(RISK_SRC).not.toMatch(/applyRiskOverrides/)
  })

  it('re-resolves on a stable key of the risk-id set, derived rather than reset in the effect', () => {
    expect(RISK_SRC).toContain("autoRisks.map(r => r.riskId).join(' ')")
    // The {key, value} + derive pattern (ApprovedInventoryList): staleness is
    // computed, so react-hooks/set-state-in-effect has nothing to flag.
    expect(RISK_SRC).toContain('resolvedOverrides.key === riskKey')
  })

  it('fails CLOSED: loading and unavailable are distinct branches, and neither applies overrides', () => {
    // Loading branch — the read has not settled.
    expect(RISK_SRC).toContain('resolution === null && (')
    // Unavailable branch — the read FAILED; distinct copy, distinct condition.
    expect(RISK_SRC).toContain('resolution !== null && resolution.unavailable && (')
    // Never rendered as "no overrides": the copy says the state is unknown.
    expect(RISK_SRC).toContain('not</strong> a statement that no overrides exist')
    // And the applied statuses fall back to the derived risks in BOTH states.
    expect(RISK_SRC).toContain('if (resolution === null || resolution.unavailable) return autoRisks')
  })

  it('only an effective source may replace a derived status', () => {
    expect(RISK_SRC).toContain('isEffectiveOverride(override.source)')
  })

  it('requires a non-blank reason before a write is attempted, and never fabricates one', () => {
    // The confirm control is disabled until a reason is typed…
    expect(RISK_SRC).toContain('disabled={!pendingReason.trim() || saving}')
    // …and the handler independently refuses a blank one.
    expect(RISK_SRC).toContain('const reason = pendingReason.trim()')
    expect(RISK_SRC).toContain('if (!reason) return')
    // No placeholder/default reason is ever passed to the store.
    expect(RISK_SRC).not.toMatch(/reason:\s*['"`]/)
  })

  it('awaits the write, surfaces a refusal, and does not show the refused status as applied', () => {
    expect(RISK_SRC).toContain('await recordRiskOverride({')
    expect(RISK_SRC).toContain('if (!result.ok)')
    expect(RISK_SRC).toContain('setWriteError(result.error')
  })

  it('re-resolves from the authoritative source after a successful write', () => {
    expect(RISK_SRC).toContain('const next = await resolveRiskOverrides(')
    expect(RISK_SRC).toContain('setResolvedOverrides({ key: riskKey, value: next })')
  })

  it('the provenance notice counts ONLY browser-only overrides, not server-recorded ones', () => {
    expect(RISK_SRC).toContain('count={overriddenCount}')
    // Asserted as the CONTRACT — the count is driven by the resolved source and
    // only 'local-cache' qualifies — rather than by pinning one expression's
    // exact syntax. The original form also read the raw localStorage map first,
    // which was redundant at best and over-counting at worst: the store's
    // write-throughs mean that cache also holds copies of durable SERVER rows.
    expect(RISK_SRC).toMatch(/resolution\.byKey\.get\(r\.riskId\)\?\.source === 'local-cache'/)
    expect(RISK_SRC, 'the raw-cache read must be gone, not merely supplemented')
      .not.toMatch(/loadRiskOverrides\(\)/)
  })

  it('shows per-row provenance in the decision-panel vocabulary', () => {
    expect(RISK_SRC).toContain('Recorded server-side (append-only, attributed to the signed-in admin).')
    expect(RISK_SRC).toContain('only in this browser')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { resolveApprovedListState, resolveApprovedListGate, isListApprovalDecision, type ApprovedListState } from './buyerPreviewApprovedList'
import { resolveDecisions } from './procurementDecisionStore'
import { saveProcurementDecision } from './procurementControl'

/**
 * F3 — the Qualified Buyer Preview list marked batches "Human-Approved" from the
 * localStorage cache.
 *
 * DDPBuyerPreview.tsx:843-845 called computeBuyerDisclosureStatus with no
 * `authoritative` argument, so it fell through to loadProcurementDecisions() —
 * raw localStorage. The single-batch pack deliberately refuses this and fails
 * closed on source === 'unavailable'. The list did not.
 *
 * Non-adversarial repro, asserted below: admin A records 'progress' on batch X
 * (server row + cache write); admin B later records 'hold'; admin A's list still
 * showed X under "Human-Approved Available Inventory" with the DDP Verified
 * Supply Seal.
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

/** Stub matching the DecisionClientLike shape resolveDecisions consumes. */
function stubClient(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const calls: Array<{ table: string; col: string; vals: string[] }> = []
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq() { return { maybeSingle: async () => ({ data: null, error: null }) } },
            in: async (col: string, vals: string[]) => {
              calls.push({ table, col, vals })
              return { data: result.data ?? null, error: result.error ?? null }
            },
          }
        },
        insert: async () => ({ error: null }),
      }
    },
  }
  return { client, calls }
}

const ROW = (batchId: string, decision: string) => ({
  batch_id: batchId,
  decision,
  reason: 'reviewed',
  decided_at: '2026-07-20T10:00:00.000Z',
  decided_by: '11111111-1111-1111-1111-111111111111',
})

describe('F3 — server wins over the cache for the listed batches', () => {
  it('excludes a batch the server says is on hold even though the cache says progress', async () => {
    // Admin A's browser cache, written when they recorded 'progress'.
    saveProcurementDecision('batch-x', 'progress', 'looks fine')
    // Admin B's later decision — the server's current row.
    const { client } = stubClient({ data: [ROW('batch-x', 'hold')] })

    const { decisions, unavailable } = await resolveDecisions(['batch-x'], client)
    expect(unavailable).toBe(false)
    const resolved = decisions.get('batch-x')
    expect(resolved?.source).toBe('server')
    expect(resolved?.decision).toBe('hold')
    expect(isListApprovalDecision(resolved)).toBe(false)

    expect(resolveApprovedListState({ resolution: { unavailable }, approvedCount: 0 }))
      .toBe<ApprovedListState>('none-approved')
  })

  it('includes a batch the server confirms as progress', async () => {
    const { client } = stubClient({ data: [ROW('batch-x', 'progress')] })
    const { decisions } = await resolveDecisions(['batch-x'], client)
    expect(decisions.get('batch-x')?.source).toBe('server')
    expect(isListApprovalDecision(decisions.get('batch-x'))).toBe(true)
  })

  it('reads all batches in ONE query rather than an N+1 of single reads', async () => {
    const { client, calls } = stubClient({ data: [] })
    await resolveDecisions(['a', 'b', 'c', 'd', 'e'], client)
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('procurement_decisions_current')
    expect(calls[0].col).toBe('batch_id')
    expect(calls[0].vals).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('de-duplicates ids before querying', async () => {
    const { client, calls } = stubClient({ data: [] })
    await resolveDecisions(['a', 'a', 'b'], client)
    expect(calls[0].vals).toEqual(['a', 'b'])
  })
})

describe('F3 — a failed authoritative read is not "no approved batches"', () => {
  it('marks every requested batch unavailable and never substitutes the cache', async () => {
    saveProcurementDecision('batch-x', 'progress', 'cached approval')
    // RLS denial — NOT a missing table.
    const { client } = stubClient({ error: { code: '42501', message: 'permission denied for view procurement_decisions_current' } })

    const { decisions, unavailable, error } = await resolveDecisions(['batch-x', 'batch-y'], client)
    expect(unavailable).toBe(true)
    expect(error).toContain('permission denied')
    for (const id of ['batch-x', 'batch-y']) {
      expect(decisions.get(id)?.source).toBe('unavailable')
      expect(decisions.get(id)?.decision).toBeNull()
      expect(isListApprovalDecision(decisions.get(id))).toBe(false)
    }
  })

  it('renders as "unavailable", not as a confirmed empty list', () => {
    expect(resolveApprovedListState({ resolution: { unavailable: true }, approvedCount: 0 }))
      .toBe<ApprovedListState>('unavailable')
  })

  it('does not degrade to the cache on schema drift (42703) or a transient failure', async () => {
    saveProcurementDecision('batch-x', 'progress', 'cached approval')
    for (const err of [
      { code: '42703', message: 'column c.decision does not exist' },
      { message: 'fetch failed' },
      { code: '503', message: 'service unavailable' },
    ]) {
      const { client } = stubClient({ error: err })
      const { decisions, unavailable } = await resolveDecisions(['batch-x'], client)
      expect(unavailable, JSON.stringify(err)).toBe(true)
      expect(decisions.get('batch-x')?.source).toBe('unavailable')
    }
  })
})

describe('F3 — loading is distinguishable from a confirmed empty list', () => {
  it('reports loading while the read is in flight', () => {
    expect(resolveApprovedListState({ resolution: null, approvedCount: 0 }))
      .toBe<ApprovedListState>('loading')
  })

  it('reports none-approved only from a settled successful read', () => {
    expect(resolveApprovedListState({ resolution: { unavailable: false }, approvedCount: 0 }))
      .toBe<ApprovedListState>('none-approved')
  })

  it('reports has-approved when at least one batch cleared the bar', () => {
    expect(resolveApprovedListState({ resolution: { unavailable: false }, approvedCount: 2 }))
      .toBe<ApprovedListState>('has-approved')
  })

  it('never claims none-approved from a failed read, whatever the count', () => {
    expect(resolveApprovedListState({ resolution: { unavailable: true }, approvedCount: 0 }))
      .not.toBe<ApprovedListState>('none-approved')
  })
})

describe('F3 — documented degradations still work', () => {
  it('falls back to the cache when migration 17 is genuinely absent', async () => {
    saveProcurementDecision('batch-x', 'progress', 'pre-migration decision')
    const { client } = stubClient({ error: { code: '42P01', message: 'relation "procurement_decisions_current" does not exist' } })
    const { decisions, unavailable } = await resolveDecisions(['batch-x'], client)
    expect(unavailable).toBe(false)
    expect(decisions.get('batch-x')?.source).toBe('local-cache')
    expect(isListApprovalDecision(decisions.get('batch-x'))).toBe(true)
  })

  it('uses the cache in demo mode (no client), leaving demo behaviour unchanged', async () => {
    saveProcurementDecision('batch-x', 'progress', 'demo decision')
    const { decisions, unavailable } = await resolveDecisions(['batch-x'], null)
    expect(unavailable).toBe(false)
    expect(decisions.get('batch-x')?.source).toBe('local-cache')
  })

  it('reports "none" for a batch with neither a server row nor a cached decision', async () => {
    const { client } = stubClient({ data: [] })
    const { decisions } = await resolveDecisions(['batch-z'], client)
    expect(decisions.get('batch-z')?.source).toBe('none')
    expect(isListApprovalDecision(decisions.get('batch-z'))).toBe(false)
  })

  it('returns an entry for every requested id, so a caller cannot read a gap as approval', async () => {
    const { client } = stubClient({ data: [ROW('a', 'progress')] })
    const { decisions } = await resolveDecisions(['a', 'b', 'c'], client)
    expect([...decisions.keys()].sort()).toEqual(['a', 'b', 'c'])
  })

  it('short-circuits an empty candidate set without querying', async () => {
    const { client, calls } = stubClient({ data: [] })
    const { decisions, unavailable } = await resolveDecisions([], client)
    expect(calls).toHaveLength(0)
    expect(decisions.size).toBe(0)
    expect(unavailable).toBe(false)
  })
})

/**
 * The list itself is .tsx and this repo's vitest env is 'node' with no jsdom, so
 * the wiring is asserted against source text via `import.meta.glob(..., '?raw')`
 * — the existing convention (operationsDeskRouting.test.ts, db.persist.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}
const PREVIEW_SRC = raw(import.meta.glob('../pages/admin/DDPBuyerPreview.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('F3 — the list is wired to the authoritative read', () => {
  it('loads the source under assertion', () => {
    expect(PREVIEW_SRC.length).toBeGreaterThan(1000)
  })

  it('no longer calls computeBuyerDisclosureStatus without an authoritative decision', () => {
    // THE DEFECT, verbatim: the two-argument call falls through to
    // loadProcurementDecisions() — raw localStorage — at :98-100.
    expect(PREVIEW_SRC).not.toContain('computeBuyerDisclosureStatus(i, farms)')
    expect(PREVIEW_SRC).not.toMatch(/computeBuyerDisclosureStatus\(\s*\w+\s*,\s*farms\s*\)/)
  })

  /**
   * Why this is a structural count and not another `toMatch`: the regex above
   * anchors on the call ENDING at `farms`, so it passed a call that supplied the
   * authoritative decision and then stopped — `(item, farms, authoritative)`.
   * That is exactly the shape the list shipped with, and its override half went
   * on reading localStorage for a full review cycle underneath a green test and
   * a source comment asserting the opposite. Count the arguments instead: any
   * call site short of all four re-opens one half of the gate, whichever half it
   * happens to be.
   */
  function callSiteArity(src: string): number[] {
    const arities: number[] = []
    const needle = 'computeBuyerDisclosureStatus('
    for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
      // Skip the declaration itself; only calls are under assertion.
      if (/function\s+$/.test(src.slice(Math.max(0, at - 10), at))) continue
      let depth = 0
      let commas = 0
      let i = at + needle.length - 1
      for (; i < src.length; i++) {
        const c = src[i]
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break }
        else if (c === ',' && depth === 1) commas++
      }
      arities.push(commas + 1)
    }
    return arities
  }

  it('passes all five arguments at every call site — decision, override AND rule-enforcement halves', () => {
    const arities = callSiteArity(PREVIEW_SRC)
    // Both gate-bearing surfaces: the single-batch pack and the preview list.
    expect(arities.length).toBeGreaterThanOrEqual(2)
    // Was four. Compliance-rule enforcement added a fifth argument, and it is
    // under exactly the same assertion for exactly the same reason: a call site
    // short of the full set re-opens whichever half it omitted. This number is
    // meant to be bumped deliberately when the gate grows another authoritative
    // input — never to be relaxed to a >= or a "some".
    expect(arities).toEqual(arities.map(() => 5))
  })

  /**
   * The arity check above proves the ARGUMENT is passed, not that it is passed
   * something real: `computeBuyerDisclosureStatus(item, farms, a, o, null)`
   * would satisfy it while pinning the gate shut forever, and
   * `..., { blockingAlerts: [], unavailable: false }` would satisfy it while
   * disabling rule enforcement entirely. Both call sites must therefore pass a
   * value that traces back to the resolver.
   */
  it('feeds the rule-enforcement argument from the authoritative resolver, not a literal', () => {
    expect(PREVIEW_SRC).toContain('resolveEnforcedRuleAlerts(')
    expect(PREVIEW_SRC).toContain('resolveEnforcedRuleAlertsForBatches(')
    // The single-batch pack passes the state it resolved…
    expect(PREVIEW_SRC).toContain('overrideState, ruleEnforcement)')
    // …and the list passes the per-batch entry it looked up.
    expect(PREVIEW_SRC).toContain('overrideState, rules)')
  })

  it('resolves authoritative overrides for the listed batches, batched', () => {
    expect(PREVIEW_SRC).toContain('resolveRiskOverrides')
    expect(PREVIEW_SRC).toContain('resolveRequirementOverrides')
    // Same N+1 prohibition the decision read is held to.
    expect(PREVIEW_SRC).not.toMatch(/\.map\([^)]*resolveRequirementOverrides\(/)
  })

  it('treats an unsettled or failed OVERRIDE read as zero approved batches', () => {
    expect(PREVIEW_SRC).toContain('overrideState === null || overrideState.unavailable')
  })

  it('batch-resolves the listed batches through the store', () => {
    expect(PREVIEW_SRC).toContain('resolveDecisions')
    // An N+1 of per-row single reads is explicitly out of contract.
    expect(PREVIEW_SRC).not.toMatch(/\.map\([^)]*resolveDecision\(/)
  })

  it('renders loading and unavailable as distinct states from a confirmed empty list', () => {
    expect(PREVIEW_SRC).toContain('resolveApprovedListState')
    for (const state of ["listState === 'loading'", "listState === 'unavailable'", "listState === 'none-approved'"]) {
      expect(PREVIEW_SRC, state).toContain(state)
    }
    // The bare length check that conflated all three is gone.
    expect(PREVIEW_SRC).not.toContain('{approved.length === 0 ? (')
  })

  it('treats an unsettled or failed resolution as zero approved batches', () => {
    expect(PREVIEW_SRC).toContain('resolution === null || resolution.unavailable')
  })

  it('treats an unsettled or failed RULE-ENFORCEMENT read as zero approved batches', () => {
    expect(PREVIEW_SRC).toContain('ruleSet === null || ruleSet.unavailable')
  })

  /**
   * THE DEFECT this file was extended for. `ruleSet` gated the `approved` array
   * but was absent from the state fold, so a failed rule read rendered the grey
   * "No batches are currently human approved" all-clear. Asserting the call site
   * passes all three reads to the shared gate is what stops the two diverging.
   */
  it('feeds ALL THREE authoritative reads into the user-visible list state', () => {
    expect(PREVIEW_SRC).toContain('resolveApprovedListGate([resolution, overrideState, ruleSet])')
    // The hand-rolled fold that omitted rule enforcement must not come back.
    expect(PREVIEW_SRC).not.toContain('{ unavailable: resolution.unavailable || overrideState.unavailable }')
  })
})

describe('F3 — the list-state gate folds every authoritative read', () => {
  const ok = { unavailable: false }
  const failed = { unavailable: true }

  it('reports settled and healthy only when every read succeeded', () => {
    expect(resolveApprovedListGate([ok, ok, ok])).toEqual({ unavailable: false })
  })

  it.each([
    ['resolution', [null, ok, ok]],
    ['overrides', [ok, null, ok]],
    ['rule enforcement', [ok, ok, null]],
  ] as const)('stays unsettled while the %s read is in flight', (_label, reads) => {
    expect(resolveApprovedListGate([...reads])).toBeNull()
  })

  it.each([
    ['resolution', [failed, ok, ok]],
    ['overrides', [ok, failed, ok]],
    ['rule enforcement', [ok, ok, failed]],
  ] as const)('reports unavailable when the %s read failed', (_label, reads) => {
    expect(resolveApprovedListGate([...reads])).toEqual({ unavailable: true })
  })

  it('lets an unsettled read dominate a failed one, so loading never reads as a failure', () => {
    expect(resolveApprovedListGate([failed, null, ok])).toBeNull()
  })

  /**
   * The end-to-end property the screen actually shipped broken: a failed or
   * unsettled rule read yields zero approved batches, and that zero must NEVER
   * surface as 'none-approved' — the only state that asserts nothing is approved.
   */
  it.each([
    ['failed', failed, 'unavailable'],
    ['unsettled', null, 'loading'],
  ] as const)('never reports none-approved when the rule read is %s', (_label, ruleSet, expected) => {
    const state = resolveApprovedListState({
      resolution: resolveApprovedListGate([ok, ok, ruleSet]),
      approvedCount: 0,
    })
    expect(state).toBe(expected)
    expect(state).not.toBe('none-approved')
  })

  it('still reaches none-approved from a fully settled successful read', () => {
    expect(resolveApprovedListState({
      resolution: resolveApprovedListGate([ok, ok, ok]),
      approvedCount: 0,
    })).toBe('none-approved')
  })
})

describe('F3 — isListApprovalDecision matches the single-batch pack rule', () => {
  it('rejects a progress decision with no timestamp', () => {
    expect(isListApprovalDecision({ decision: 'progress', decidedAt: null, source: 'server' })).toBe(false)
  })

  it('rejects a progress decision from a failed read', () => {
    expect(isListApprovalDecision({ decision: 'progress', decidedAt: '2026-07-20T00:00:00Z', source: 'unavailable' })).toBe(false)
  })

  it('rejects every non-progress decision', () => {
    for (const d of ['hold', 'reject', 'request_documents', 'request_fresh_coa', 'request_inventory_proof', 'escalate_review']) {
      expect(isListApprovalDecision({ decision: d, decidedAt: '2026-07-20T00:00:00Z', source: 'server' }), d).toBe(false)
    }
  })

  it('rejects an absent decision', () => {
    expect(isListApprovalDecision(undefined)).toBe(false)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  fetchServerDecision,
  resolveDecision,
  recordDecision,
  listLocalOnlyDecisions,
  migrateLocalDecision,
} from './procurementDecisionStore'
import {
  DECISION_KEY,
  saveProcurementDecision,
  loadProcurementDecisions,
  PROCUREMENT_DECISION_LABELS,
} from './procurementControl'
import type { ProcurementDecision } from '../types'

// ─── In-memory localStorage (the cache layer) ──────────────────────────────
beforeEach(() => {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  })
})

// ─── Fake Supabase client ──────────────────────────────────────────────────
type ErrLike = { code?: string; message?: string } | null

function makeClient(opts: {
  serverRow?: Record<string, unknown> | null
  readError?: ErrLike
  insertError?: ErrLike
  onInsert?: (row: Record<string, unknown>) => void
}) {
  const inserted: Array<Record<string, unknown>> = []
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: opts.serverRow ?? null, error: opts.readError ?? null }
                },
              }
            },
          }
        },
        async insert(row: Record<string, unknown>) {
          inserted.push(row)
          opts.onInsert?.(row)
          return { error: opts.insertError ?? null }
        },
      }
    },
  }
  return { client: client as never, inserted }
}

const TABLE_MISSING = { code: '42P01', message: 'relation "procurement_decisions" does not exist' }

describe('fetchServerDecision', () => {
  it('returns the server decision when one exists', async () => {
    const { client } = makeClient({
      serverRow: { decision: 'progress', reason: 'COA reviewed', decided_at: '2026-07-13T10:00:00Z', decided_by: 'user-1' },
    })
    const result = await fetchServerDecision('batch-1', client)
    expect(result).toMatchObject({ decision: 'progress', reason: 'COA reviewed', source: 'server' })
  })

  it('returns null when the table is not deployed (migration 17 not applied)', async () => {
    const { client } = makeClient({ readError: TABLE_MISSING })
    expect(await fetchServerDecision('batch-1', client)).toBeNull()
  })

  it('returns null in demo mode (no Supabase client)', async () => {
    expect(await fetchServerDecision('batch-1', null)).toBeNull()
  })

  it('rejects a malformed decision value rather than trusting it', async () => {
    const { client } = makeClient({ serverRow: { decision: 'totally-approved', reason: 'x' } })
    expect(await fetchServerDecision('batch-1', client)).toBeNull()
  })
})

describe('resolveDecision — server wins', () => {
  it('prefers the server decision over a conflicting local cache', async () => {
    saveProcurementDecision('batch-1', 'hold', 'local says hold')
    const { client } = makeClient({
      serverRow: { decision: 'reject', reason: 'server says reject', decided_at: 'ts', decided_by: 'u' },
    })

    const result = await resolveDecision('batch-1', client)

    expect(result.decision).toBe('reject')
    expect(result.source).toBe('server')
    // and the cache is refreshed so a later synchronous render agrees
    expect(loadProcurementDecisions()['batch-1'].decision).toBe('reject')
  })

  it('falls back to the local cache when the server has no row (backward compatibility)', async () => {
    saveProcurementDecision('batch-legacy', 'progress', 'decided before migration 17')
    const { client } = makeClient({ serverRow: null })

    const result = await resolveDecision('batch-legacy', client)

    expect(result.decision).toBe('progress')
    expect(result.source).toBe('local-cache')
    // The pre-migration defect is reported honestly: there is no recorded actor.
    expect(result.decidedBy).toBeNull()
  })

  it('falls back to the local cache when the table is not deployed', async () => {
    saveProcurementDecision('batch-2', 'hold', 'x')
    const { client } = makeClient({ readError: TABLE_MISSING })
    const result = await resolveDecision('batch-2', client)
    expect(result.decision).toBe('hold')
    expect(result.source).toBe('local-cache')
  })

  it('reports source "none" when neither server nor cache has a decision', async () => {
    const { client } = makeClient({ serverRow: null })
    expect((await resolveDecision('unknown', client)).source).toBe('none')
  })
})

describe('recordDecision', () => {
  it('writes to the server and never sends decided_by (the actor is server-captured)', async () => {
    const { client, inserted } = makeClient({})
    const result = await recordDecision(
      { batchId: 'batch-1', decision: 'progress', reason: 'All documents verified.' }, client)

    expect(result).toMatchObject({ ok: true, persistedTo: 'server' })
    expect(inserted[0]).toMatchObject({ batch_id: 'batch-1', decision: 'progress', reason: 'All documents verified.' })
    // decided_by must NOT be client-supplied — the column defaults to auth.uid()
    // and RLS asserts decided_by = auth.uid(). Sending it would invite spoofing.
    expect(inserted[0]).not.toHaveProperty('decided_by')
  })

  it('records a REJECTION — impossible before migration 17', async () => {
    const { client, inserted } = makeClient({})
    const result = await recordDecision(
      { batchId: 'b', decision: 'reject', reason: 'Cadmium above EU limit.' }, client)
    expect(result.ok).toBe(true)
    expect(inserted[0].decision).toBe('reject')
  })

  it('requires a reason — a decision without one is not an audit record', async () => {
    const { client, inserted } = makeClient({})
    const result = await recordDecision({ batchId: 'b', decision: 'progress', reason: '   ' }, client)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/reason is required/i)
    expect(inserted).toHaveLength(0)
  })

  it('degrades to the local cache when the table is not deployed (no user-visible failure)', async () => {
    const { client } = makeClient({ insertError: TABLE_MISSING })
    const result = await recordDecision({ batchId: 'b', decision: 'hold', reason: 'r' }, client)
    expect(result).toMatchObject({ ok: true, persistedTo: 'local-cache' })
    expect(loadProcurementDecisions()['b'].decision).toBe('hold')
  })

  it('SURFACES a genuine server failure (e.g. RLS denial) instead of hiding it', async () => {
    const { client } = makeClient({ insertError: { code: '42501', message: 'new row violates row-level security policy' } })
    const result = await recordDecision({ batchId: 'b', decision: 'progress', reason: 'r' }, client)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/row-level security/i)
  })

  it('never loses the decision: a failed server write still leaves it in the cache', async () => {
    const { client } = makeClient({ insertError: { code: '42501', message: 'denied' } })
    await recordDecision({ batchId: 'b', decision: 'reject', reason: 'r' }, client)
    expect(loadProcurementDecisions()['b'].decision).toBe('reject')
  })
})

describe('listLocalOnlyDecisions / migrateLocalDecision', () => {
  it('lists cached decisions that have no server row, and omits those that do', async () => {
    saveProcurementDecision('batch-local', 'progress', 'old')
    const { client } = makeClient({ serverRow: null })
    const localOnly = await listLocalOnlyDecisions(client)
    expect(localOnly).toEqual([expect.objectContaining({ batchId: 'batch-local', decision: 'progress' })])
  })

  it('does not list a decision that already exists on the server', async () => {
    saveProcurementDecision('batch-synced', 'progress', 'x')
    const { client } = makeClient({
      serverRow: { decision: 'progress', reason: 'x', decided_at: 't', decided_by: 'u' },
    })
    expect(await listLocalOnlyDecisions(client)).toEqual([])
  })

  it('migrates under the current admin and labels the provenance honestly', async () => {
    saveProcurementDecision('batch-old', 'progress', 'legacy')
    const { client, inserted } = makeClient({})

    const result = await migrateLocalDecision('batch-old', 'progress', 'Re-reviewed COA on 2026-07-13.', client)

    expect(result).toMatchObject({ ok: true, persistedTo: 'server' })
    // The migrated row must not pretend to know who originally decided — the
    // original record had no actor, and claiming otherwise would be worse than
    // the gap it replaces.
    expect(inserted[0].reason).toMatch(/migrated from browser-local record/i)
    expect(inserted[0].reason).toMatch(/Re-reviewed COA/)
  })

  it('refuses to migrate without an attestation', async () => {
    const { client, inserted } = makeClient({})
    const result = await migrateLocalDecision('b', 'progress', '  ', client)
    expect(result.ok).toBe(false)
    expect(inserted).toHaveLength(0)
  })

  it('never silently discards local data', () => {
    saveProcurementDecision('batch-x', 'hold', 'keep me')
    expect(localStorage.getItem(DECISION_KEY)).toContain('batch-x')
  })
})

// ─── Regression: every decision the UI offers must persist ──────────────────
//
// The store previously accepted only progress|hold|reject, while the dropdown
// (DDPBuyerPreview.tsx:573, rendered from PROCUREMENT_DECISION_LABELS) offers
// all seven values in the ProcurementDecision union. The other four were written
// to the local cache, rejected by the database CHECK, and then dropped on read —
// invisible to resolveDecision AND to listLocalOnlyDecisions. These tests fail if
// the UI set and the persisted set ever diverge again.
const ALL_DECISIONS = Object.keys(PROCUREMENT_DECISION_LABELS) as ProcurementDecision[]

describe('every decision the UI offers round-trips through the server store', () => {
  it('offers exactly the seven values in the ProcurementDecision union', () => {
    expect(ALL_DECISIONS).toEqual([
      'progress', 'hold', 'reject',
      'request_documents', 'request_fresh_coa', 'request_inventory_proof', 'escalate_review',
    ])
  })

  it.each(ALL_DECISIONS)('recordDecision("%s") sends it to the server', async decision => {
    const { client, inserted } = makeClient({})

    const result = await recordDecision(
      { batchId: `batch-${decision}`, decision, reason: `reason for ${decision}` },
      client,
    )

    expect(result).toMatchObject({ ok: true, persistedTo: 'server' })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ batch_id: `batch-${decision}`, decision })
  })

  it.each(ALL_DECISIONS)('fetchServerDecision reads "%s" back rather than discarding it', async decision => {
    const { client } = makeClient({
      serverRow: { decision, reason: 'r', decided_at: 'ts', decided_by: 'u' },
    })

    const result = await fetchServerDecision(`batch-${decision}`, client)

    expect(result).not.toBeNull()
    expect(result?.decision).toBe(decision)
    expect(result?.source).toBe('server')
  })

  it.each(ALL_DECISIONS)('resolveDecision surfaces a cached "%s" instead of reporting none', async decision => {
    saveProcurementDecision('batch-legacy', decision, 'decided before migration 17')
    const { client } = makeClient({ serverRow: null })

    const result = await resolveDecision('batch-legacy', client)

    expect(result.decision).toBe(decision)
    expect(result.source).toBe('local-cache')
  })

  it.each(ALL_DECISIONS)('listLocalOnlyDecisions reports an unsynced "%s"', async decision => {
    saveProcurementDecision('batch-unsynced', decision, 'never reached the server')
    const { client } = makeClient({ serverRow: null })

    const localOnly = await listLocalOnlyDecisions(client)

    expect(localOnly.map(d => d.batchId)).toContain('batch-unsynced')
    expect(localOnly.find(d => d.batchId === 'batch-unsynced')?.decision).toBe(decision)
  })

  it('still rejects a value that is not a decision at all', async () => {
    const { client } = makeClient({ serverRow: { decision: 'totally-approved', reason: 'x' } })
    expect(await fetchServerDecision('batch-1', client)).toBeNull()
  })
})

// The database is the other half of this contract: a value the UI offers but the
// CHECK constraint omits is rejected at INSERT with SQLSTATE 23514. That half is
// asserted in scripts/migration-17-decision-set.test.mjs, which compares the SQL
// CHECK against the TypeScript union directly (this file cannot read from disk —
// the app tsconfig does not expose node types to src).

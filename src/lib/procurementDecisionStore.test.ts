import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  fetchServerDecision,
  resolveDecision,
  recordDecision,
  listLocalOnlyDecisions,
  migrateLocalDecision,
  DecisionReadUnavailableError,
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

  // CORRECTED (Codex P1). This test previously asserted the opposite — that a
  // server-REFUSED write "still leaves it in the cache" — which encoded the
  // vulnerability as intended behaviour: the buyer-pack issue gate reads that
  // cache, so a decision the server rejected could authorise a release. Nothing
  // is lost by not caching it: the failure is returned to the caller, which
  // surfaces it and leaves the operator to retry against the server.
  it('a server-REFUSED write is not cached, and the failure is surfaced to the caller', async () => {
    const { client } = makeClient({ insertError: { code: '42501', message: 'denied' } })
    const result = await recordDecision({ batchId: 'b', decision: 'reject', reason: 'r' }, client)

    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    expect(result.error).toMatch(/denied/i)
    expect(loadProcurementDecisions()['b']).toBeUndefined()
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

// ═══ Authorization hardening (Codex P1/P1/P2) ══════════════════════════════
//
// The buyer-pack issue gate reads the procurement decision. Migration 10's RPC
// trusts the CLIENT-SUPPLIED p_procurement_decision (10_..._MVP.sql:262) and does
// not verify a row in procurement_decisions — so the decision the client believes
// in IS the authorization. Three ways that belief could be wrong:
//
//   1. a server-REFUSED write was cached anyway and read back as an approval;
//   2. a server read that FAILED (RLS/permission/transient) silently degraded to
//      a stale cached 'progress';
//   3. the cached decidedAt was re-stamped with browser time, rewriting the
//      approval timestamp frozen into an immutable snapshot.
//
// These tests assert observable outcomes — what is in the cache, what resolves,
// and what a subsequent read reports — not which functions were called.

const PERMISSION_DENIED = { code: '42501', message: 'new row violates row-level security policy' }
const AUTH_FAILURE = { code: 'PGRST301', message: 'JWT expired' }
const TRANSIENT = { message: 'Failed to fetch' }
const TABLE_ABSENT = { code: '42P01', message: 'relation "procurement_decisions" does not exist' }

describe('write path — a server-refused decision must never authorize issuance', () => {
  it('1. a successful server insert updates the local cache', async () => {
    const { client, inserted } = makeClient({})
    const result = await recordDecision({ batchId: 'b1', decision: 'progress', reason: 'COA reviewed' }, client)

    expect(result).toMatchObject({ ok: true, persistedTo: 'server' })
    expect(inserted).toHaveLength(1)
    expect(loadProcurementDecisions()['b1'].decision).toBe('progress')
  })

  it('2. a missing-table insert falls back to the local cache', async () => {
    const { client } = makeClient({ insertError: TABLE_ABSENT })
    const result = await recordDecision({ batchId: 'b2', decision: 'progress', reason: 'r' }, client)

    expect(result).toMatchObject({ ok: true, persistedTo: 'local-cache' })
    expect(loadProcurementDecisions()['b2'].decision).toBe('progress')
  })

  it.each([
    ['RLS/permission denied', PERMISSION_DENIED],
    ['authentication failure', AUTH_FAILURE],
    ['transient/network failure', TRANSIENT],
  ])('3+4. a %s insert fails AND caches nothing', async (_label, insertError) => {
    const { client } = makeClient({ insertError })

    const result = await recordDecision({ batchId: 'b3', decision: 'progress', reason: 'r' }, client)

    expect(result.ok).toBe(false)
    expect(result.persistedTo).toBe('none')
    // THE ASSERTION THAT MATTERS: no approval was created.
    expect(loadProcurementDecisions()['b3']).toBeUndefined()
  })

  it('5. a failed insert does not overwrite an existing legitimate cached decision', async () => {
    saveProcurementDecision('b4', 'hold', 'previously held', '2026-07-01T00:00:00Z')
    const { client } = makeClient({ insertError: PERMISSION_DENIED })

    const result = await recordDecision({ batchId: 'b4', decision: 'progress', reason: 'trying to progress' }, client)

    expect(result.ok).toBe(false)
    const cached = loadProcurementDecisions()['b4']
    expect(cached.decision).toBe('hold')                 // prior record survives
    expect(cached.decidedAt).toBe('2026-07-01T00:00:00Z')
    expect(cached.notes).toBe('previously held')
  })

  it('6. a failed progress insert cannot later resolve as an approved decision', async () => {
    const { client: writeClient } = makeClient({ insertError: PERMISSION_DENIED })
    await recordDecision({ batchId: 'b5', decision: 'progress', reason: 'r' }, writeClient)

    // Now read it back: the server has no row, and the cache must not have one.
    const { client: readClient } = makeClient({ serverRow: null })
    const resolved = await resolveDecision('b5', readClient)

    expect(resolved.decision).toBeNull()      // NOT 'progress' — the gate stays shut
    expect(resolved.source).toBe('none')
  })
})

describe('read path — only a genuinely absent table may fall back to cache', () => {
  it('7. a missing decision table falls back to the cache', async () => {
    saveProcurementDecision('r1', 'progress', 'pre-migration decision')
    const { client } = makeClient({ readError: TABLE_ABSENT })

    const resolved = await resolveDecision('r1', client)

    expect(resolved.decision).toBe('progress')
    expect(resolved.source).toBe('local-cache')
  })

  it.each([
    ['8. permission denial', PERMISSION_DENIED],
    ['9. authentication failure', AUTH_FAILURE],
    ['10. transient/server failure', TRANSIENT],
    ['schema drift (undefined_column) is NOT a missing table', { code: '42703', message: 'column "reason" does not exist' }],
  ])('%s does not fall back to the cache', async (_label, readError) => {
    // A stale 'progress' sits in the cache — precisely the dangerous case.
    saveProcurementDecision('r2', 'progress', 'stale local approval')
    const { client } = makeClient({ readError })

    const resolved = await resolveDecision('r2', client)

    // 11. the stale cached 'progress' is NOT returned
    expect(resolved.decision).toBeNull()
    expect(resolved.source).toBe('unavailable')
    expect(resolved.error).toBeTruthy()
    // and the cache itself is left intact for later reconciliation
    expect(loadProcurementDecisions()['r2'].decision).toBe('progress')
  })

  it('11b. fetchServerDecision throws a typed error rather than reporting "no decision"', async () => {
    const { client } = makeClient({ readError: PERMISSION_DENIED })
    await expect(fetchServerDecision('r3', client)).rejects.toBeInstanceOf(DecisionReadUnavailableError)
  })

  it('12. a successful server read overrides stale local state', async () => {
    saveProcurementDecision('r4', 'progress', 'stale local approval')
    const { client } = makeClient({
      serverRow: { decision: 'reject', reason: 'server says reject', decided_at: '2026-07-02T09:00:00Z', decided_by: 'u1' },
    })

    const resolved = await resolveDecision('r4', client)

    expect(resolved.decision).toBe('reject')
    expect(resolved.source).toBe('server')
    expect(loadProcurementDecisions()['r4'].decision).toBe('reject')  // cache corrected
  })
})

describe('timestamp integrity — the approval time is the server’s, not the browser’s', () => {
  const SERVER_TS = '2026-07-02T09:00:00Z'

  it('13. a server decision retains its original decided_at', async () => {
    const { client } = makeClient({
      serverRow: { decision: 'progress', reason: 'ok', decided_at: SERVER_TS, decided_by: 'u1' },
    })

    const resolved = await resolveDecision('t1', client)

    expect(resolved.decidedAt).toBe(SERVER_TS)
    expect(loadProcurementDecisions()['t1'].decidedAt).toBe(SERVER_TS)  // not browser time
  })

  it('14. refreshing the same server decision does not change the cached timestamp', async () => {
    const { client } = makeClient({
      serverRow: { decision: 'progress', reason: 'ok', decided_at: SERVER_TS, decided_by: 'u1' },
    })

    await resolveDecision('t2', client)
    const first = loadProcurementDecisions()['t2'].decidedAt
    await resolveDecision('t2', client)   // simulate re-opening the page
    const second = loadProcurementDecisions()['t2'].decidedAt

    expect(first).toBe(SERVER_TS)
    expect(second).toBe(SERVER_TS)        // opening the pack does not rewrite the approval time
  })

  it('15. a genuinely local-only decision still receives a local timestamp', async () => {
    const before = Date.now()
    const { client } = makeClient({ insertError: TABLE_ABSENT })

    await recordDecision({ batchId: 't3', decision: 'progress', reason: 'r' }, client)

    const cached = loadProcurementDecisions()['t3']
    expect(cached.decidedAt).toBeTruthy()
    expect(new Date(cached.decidedAt).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('16. the snapshot approval timestamp is the authoritative server timestamp', async () => {
    // prepareBuyerPackSnapshotInput consumes { decision, notes, decidedAt } and
    // freezes decidedAt as the snapshot approval timestamp. Feed it exactly what
    // resolveDecision now yields for a server row.
    const { client } = makeClient({
      serverRow: { decision: 'progress', reason: 'ok', decided_at: SERVER_TS, decided_by: 'u1' },
    })

    const resolved = await resolveDecision('t4', client)
    const snapshotInputDecision = {
      decision: resolved.decision,
      notes: resolved.reason ?? undefined,
      decidedAt: resolved.decidedAt,
    }

    expect(snapshotInputDecision.decidedAt).toBe(SERVER_TS)
    expect(snapshotInputDecision.decidedAt).not.toBe(new Date().toISOString())
  })
})

// Offline regression tests for the staging harness's NON-VACUITY guarantees.
//
// Each describe block below corresponds to one substantive finding from the
// final independent review. Every one of these probes previously reported PASS
// while proving nothing — or while an actual security failure was in progress.
// These tests exercise the REAL exported classifiers, so restoring any of the
// old behaviour turns them red.
//
// Importing the suite does not trigger a live run: main() executes only when
// the file is invoked directly.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BENCHMARK_TABLE,
  benchmarkFixturePayload,
  seedBenchmarkFixture,
  classifySelectError,
  classifySelectDenial,
  classifyAffirmativeSelect,
  classifyAmbiguousInsert,
  pendingInsertLookup,
  findInsertedRowIds,
  evaluatePendingListProbe,
  MIGRATION_22_TABLES,
  buildPendingProbeRegistry,
} from './run-staging-security-tests.mjs'

const SUBJECT = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const TAG = 'security-test-1783966397990-f7047fe1'

const ok = (rows) => ({ data: rows, error: null })
const err = (error) => ({ data: null, error })

// ── Finding 1: market_price_benchmarks SELECT verification is non-vacuous ────
describe('finding 1 — market_price_benchmarks needs a genuine subject fixture', () => {
  // A minimal admin client whose benchmark table starts EMPTY, which is exactly
  // the condition under which both old probes passed simultaneously.
  function makeAdmin({ rows = [], insertFails = false, readbackFails = false } = {}) {
    const table = rows.map(r => ({ ...r }))
    let seq = 0
    return {
      _rows: table,
      from(t) {
        expect(t).toBe(BENCHMARK_TABLE)
        const q = { mode: null, payload: null, id: null }
        const api = {
          insert(payload) { q.mode = 'insert'; q.payload = payload; return api },
          select() { q.mode = q.mode ?? 'select'; return api },
          eq(col, val) { q.id = val; expect(col).toBe('id'); return api },
          maybeSingle() {
            if (readbackFails) return Promise.resolve({ data: null, error: { code: 'PGRST301' } })
            const row = table.find(r => r.id === q.id)
            return Promise.resolve({ data: row ?? null, error: null })
          },
          then(res) {
            if (q.mode === 'insert') {
              if (insertFails) return Promise.resolve({ data: null, error: { code: '42501' } }).then(res)
              const row = { id: `bench-${++seq}`, ...q.payload }
              table.push(row)
              return Promise.resolve({ data: [{ id: row.id }], error: null }).then(res)
            }
            return Promise.resolve({ data: table.filter(r => !q.id || r.id === q.id), error: null }).then(res)
          },
        }
        return api
      },
    }
  }

  it('an EMPTY benchmark table cannot make both the control and the denial pass', () => {
    // The old probes ran unfiltered: `select('id').limit(1)` on an empty table
    // returns { data: [], error: null }. isDenied() called that "denied" and
    // isAllowed() called it "allowed" — the same response scored both ways.
    const emptyResponse = ok([])

    // Without a confirmed subject id neither classifier will score it at all.
    expect(classifySelectDenial(emptyResponse, null).status).toBe('BLOCK')
    expect(classifyAffirmativeSelect(emptyResponse, null).status).toBe('BLOCK')

    // And with a subject that the table does not actually contain, the
    // affirmative control FAILS rather than silently passing.
    expect(classifyAffirmativeSelect(emptyResponse, SUBJECT).status).toBe('FAIL')
  })

  it('seeds a farmer-visible benchmark row and records its exact id', async () => {
    const admin = makeAdmin()
    const res = await seedBenchmarkFixture(admin, TAG)

    expect(res.id).toBeTruthy()
    expect(res.note).toBeNull()
    const row = admin._rows.find(r => r.id === res.id)
    // visible_to_farmers must be true, or the farmer control would fail for a
    // reason unrelated to migration 22 (the permissive policy filters on it).
    expect(row.visible_to_farmers).toBe(true)
    expect(row.product_type).toContain(TAG)
  })

  it('payload is tag-scoped and farmer-visible', () => {
    const p = benchmarkFixturePayload(TAG)
    expect(p.product_type.startsWith(TAG)).toBe(true)
    expect(p.visible_to_farmers).toBe(true)
  })

  it('BLOCKS when the fixture cannot be created', async () => {
    const res = await seedBenchmarkFixture(makeAdmin({ insertFails: true }), TAG)
    expect(res.id).toBeNull()
    expect(res.note).toMatch(/could not create/i)
  })

  it('BLOCKS when the fixture cannot be confirmed by read-back', async () => {
    const res = await seedBenchmarkFixture(makeAdmin({ readbackFails: true }), TAG)
    expect(res.id).toBeNull()
    expect(res.note).toMatch(/unconfirmed/i)
    // The row was still created, so it must be tracked for cleanup.
    expect(res.createdId).toBeTruthy()
  })

  it('BLOCKS a fixture that is not visible_to_farmers', async () => {
    const admin = makeAdmin()
    // Force the read-back to observe an invisible row.
    const original = admin.from.bind(admin)
    admin.from = (t) => {
      const api = original(t)
      const maybeSingle = api.maybeSingle
      api.maybeSingle = async () => {
        const r = await maybeSingle()
        return r.data ? { data: { ...r.data, visible_to_farmers: false }, error: null } : r
      }
      return api
    }
    const res = await seedBenchmarkFixture(admin, TAG)
    expect(res.id).toBeNull()
    expect(res.note).toMatch(/visible_to_farmers/)
  })

  it('the pending denial requires a confirmed subject row', () => {
    expect(classifySelectDenial(ok([]), null).status).toBe('BLOCK')
    expect(classifySelectDenial(ok([]), SUBJECT).status).toBe('PASS')
  })

  it('the farmer control requires the EXACT row to be returned', () => {
    expect(classifyAffirmativeSelect(ok([{ id: SUBJECT }]), SUBJECT).status).toBe('PASS')
    expect(classifyAffirmativeSelect(ok([{ id: OTHER }]), SUBJECT).status).toBe('FAIL')
    expect(classifyAffirmativeSelect(ok([]), SUBJECT).status).toBe('FAIL')
  })

  it('does NOT add the SELECT-only table to the 11-table FOR ALL registry', () => {
    // Migration 22 protects market_price_benchmarks with a RESTRICTIVE FOR
    // SELECT policy and gives it no farmer write path. Adding write probes here
    // would test the admin-only write policy, not the migration 22 control.
    expect(MIGRATION_22_TABLES).toHaveLength(11)
    expect(MIGRATION_22_TABLES).not.toContain(BENCHMARK_TABLE)
    const registry = buildPendingProbeRegistry()
    expect(registry.filter(p => p.table === BENCHMARK_TABLE)).toHaveLength(0)
    for (const op of ['insert', 'update', 'delete']) {
      expect(registry.some(p => p.table === BENCHMARK_TABLE && p.operation === op)).toBe(false)
    }
  })
})

// The benchmark fixture is created inside main(), which cannot run offline (it
// requires live staging credentials). Its cleanup wiring is therefore asserted
// against the source: the fixture must be tracked on `created`, deleted by id
// as admin, and verified by read-back — the same discipline every other
// synthetic row in this suite is held to.
describe('finding 1 — cleanup includes the benchmark fixture', () => {
  const SRC = readFileSync(new URL('./run-staging-security-tests.mjs', import.meta.url), 'utf8')

  it('tracks the created benchmark id for teardown', () => {
    expect(SRC).toMatch(/created\s*=\s*\{[^}]*benchmarks:\s*\[\]/)
    expect(SRC).toMatch(/created\.benchmarks\.push\(bench\.createdId\)/)
  })

  it('deletes tracked benchmark rows as admin and verifies removal by read-back', () => {
    const block = SRC.slice(SRC.indexOf('created.benchmarks?.length'))
    expect(block).toMatch(/admin\.client\.from\(BENCHMARK_TABLE\)\.delete\(\)\.eq\('id', id\)/)
    expect(block).toMatch(/admin\.client\.from\(BENCHMARK_TABLE\)\.select\('id'\)\.eq\('id', id\)/)
    // A failed removal must surface as a cleanup failure, which fails the run.
    expect(block).toMatch(/cleanupVerified: allGone/)
  })

  it('tracks the fixture even when the row could not be confirmed', () => {
    // An unconfirmed fixture still exists in the table — it must not be orphaned.
    expect(SRC).toMatch(/if \(bench\.createdId\) created\.benchmarks\.push/)
  })
})

// ── Finding 2: affirmative SELECT controls must require returned rows ───────
describe('finding 2 — affirmative access-retention requires the expected row', () => {
  it('an empty result is a FAIL, not a pass (RLS denies without an error)', () => {
    const v = classifyAffirmativeSelect(ok([]), SUBJECT)
    expect(v.ok).toBe(false)
    expect(v.status).toBe('FAIL')
    expect(v.reason).toMatch(/ACCESS LOST/)
  })

  it('the wrong row is a FAIL', () => {
    expect(classifyAffirmativeSelect(ok([{ id: OTHER }]), SUBJECT).ok).toBe(false)
  })

  it('the expected row present is a PASS', () => {
    expect(classifyAffirmativeSelect(ok([{ id: SUBJECT }]), SUBJECT).ok).toBe(true)
  })

  it('accepts a maybeSingle()-shaped single-object response', () => {
    expect(classifyAffirmativeSelect({ data: { id: SUBJECT }, error: null }, SUBJECT).ok).toBe(true)
  })

  it('no subject id at all BLOCKS — an unfiltered SELECT is not evidence', () => {
    expect(classifyAffirmativeSelect(ok([{ id: OTHER }]), null).status).toBe('BLOCK')
    expect(classifyAffirmativeSelect(ok([{ id: OTHER }]), undefined).status).toBe('BLOCK')
  })

  it('an error never passes an affirmative control', () => {
    expect(classifyAffirmativeSelect(err({ code: 'PGRST301' }), SUBJECT).ok).toBe(false)
  })
})

// ── Finding 3: arbitrary SELECT errors are not RLS denial ───────────────────
describe('finding 3 — SELECT errors are never classified as RLS denial', () => {
  it('an empty successful SELECT over a known row is the ONLY denial signature', () => {
    const v = classifySelectDenial(ok([]), SUBJECT)
    expect(v.status).toBe('PASS')
    expect(v.reason).toMatch(/empty result, no error/)
  })

  it('the protected row coming back is a SECURITY FAILURE', () => {
    const v = classifySelectDenial(ok([{ id: SUBJECT }]), SUBJECT)
    expect(v.status).toBe('FAIL')
    expect(v.reason).toMatch(/SECURITY FAILURE/)
  })

  it('other protected rows coming back is also a FAIL', () => {
    expect(classifySelectDenial(ok([{ id: OTHER }]), SUBJECT).status).toBe('FAIL')
  })

  it.each([
    ['expired JWT', { code: 'PGRST301', message: 'JWT expired' }, 'auth'],
    ['401 unauthorized', { status: '401', message: 'Unauthorized' }, 'auth'],
    ['insufficient privilege', { code: '42501', message: 'permission denied' }, 'auth'],
    ['network failure', { message: 'TypeError: fetch failed' }, 'transport'],
    ['connection refused', { message: 'ECONNREFUSED' }, 'transport'],
    ['server error', { status: '500', message: 'Internal Server Error' }, 'server'],
    ['undefined column', { code: '42703', message: 'column x does not exist' }, 'schema'],
    ['undefined table', { code: '42P01', message: 'relation does not exist' }, 'schema'],
    ['malformed query', { code: 'PGRST100', message: 'syntax error' }, 'schema'],
  ])('%s is classified as %s and BLOCKS — never PASS', (_label, error, kind) => {
    expect(classifySelectError(error).kind).toBe(kind)
    const v = classifySelectDenial(err(error), SUBJECT)
    expect(v.status).toBe('BLOCK')
    expect(v.ok).toBe(false)
  })

  it('an unclassifiable error still never counts as denial', () => {
    const v = classifySelectDenial(err({ message: 'something strange happened' }), SUBJECT)
    expect(v.ok).toBe(false)
    expect(v.status).toBe('BLOCK')
  })

  it('classifySelectError never returns a policy verdict', () => {
    for (const e of [{ code: 'PGRST301' }, { status: '500' }, { message: 'weird' }]) {
      expect(classifySelectError(e).kind).not.toBe('policy')
    }
    expect(classifySelectError(null)).toBeNull()
  })
})

// ── Finding 4: ambiguous INSERT outcomes need an admin readback ─────────────
describe('finding 4 — empty INSERT results are resolved by admin readback', () => {
  it('a successful-but-unreadable INSERT FAILS instead of passing as denied', () => {
    // The write classifier read "no error + 0 rows" as "denied (0 rows
    // affected)". If the row is really there, that is a silent breach.
    const v = classifyAmbiguousInsert({ ok: true, ids: ['leaked-1'] }, [])
    expect(v.status).toBe('FAIL')
    expect(v.reason).toMatch(/INSERT SUCCEEDED but was hidden/)
  })

  it('registers the leaked row id for cleanup', () => {
    const v = classifyAmbiguousInsert({ ok: true, ids: ['leaked-1', 'leaked-2'] }, [])
    expect(v.leakedIds).toEqual(['leaked-1', 'leaked-2'])
  })

  it('confirmed absence passes', () => {
    const v = classifyAmbiguousInsert({ ok: true, ids: [] }, [])
    expect(v.status).toBe('PASS')
    expect(v.leakedIds).toEqual([])
  })

  it('pre-existing rows are not mistaken for a leak', () => {
    // The fixture seeder already put a row in most of these tables.
    const v = classifyAmbiguousInsert({ ok: true, ids: ['fixture-1'] }, ['fixture-1'])
    expect(v.status).toBe('PASS')
    expect(v.leakedIds).toEqual([])
  })

  it('a new row alongside a known fixture row is still caught', () => {
    const v = classifyAmbiguousInsert({ ok: true, ids: ['fixture-1', 'leaked-1'] }, ['fixture-1'])
    expect(v.status).toBe('FAIL')
    expect(v.leakedIds).toEqual(['leaked-1'])
  })

  it('a FAILED readback BLOCKS — it can never pass', () => {
    for (const rb of [null, undefined, { ok: false, error: { code: '42501' } }, { ok: false, ids: [], error: null }]) {
      const v = classifyAmbiguousInsert(rb, [])
      expect(v.status).toBe('BLOCK')
      expect(v.ok).toBe(false)
    }
  })

  it('defines deterministic lookup criteria for EVERY tested table', () => {
    const ctx = { tag: TAG, userId: 'user-1', farmId: 'farm-1' }
    for (const table of MIGRATION_22_TABLES) {
      const criteria = pendingInsertLookup(table, ctx)
      expect(Array.isArray(criteria), `${table} lookup`).toBe(true)
      expect(criteria.length, `${table} lookup is empty`).toBeGreaterThan(0)
    }
  })

  it('does NOT rely on farmId alone — that would match the seeded fixture', () => {
    const ctx = { tag: TAG, userId: 'user-1', farmId: 'farm-1' }
    for (const table of MIGRATION_22_TABLES) {
      const criteria = pendingInsertLookup(table, ctx)
      const columns = criteria.map(([c]) => c)
      const onlyFarmScoped = columns.length === 1 && ['farm_id', 'entity_id'].includes(columns[0])
      expect(onlyFarmScoped, `${table} is located by farm scope alone`).toBe(false)
    }
  })

  it('applies every criterion when searching for the inserted row', async () => {
    const applied = []
    const client = {
      from() {
        const api = {
          select() { return api },
          eq(col, val) { applied.push([col, val]); return api },
          then(res) { return Promise.resolve({ data: [{ id: 'found-1' }], error: null }).then(res) },
        }
        return api
      },
    }
    const criteria = pendingInsertLookup('inventory_batches', { tag: TAG, userId: 'u', farmId: 'f' })
    const res = await findInsertedRowIds(client, 'inventory_batches', criteria)
    expect(res.ok).toBe(true)
    expect(res.ids).toEqual(['found-1'])
    expect(applied).toEqual(criteria)
  })

  it('reports a readback error rather than an empty id list', async () => {
    const client = {
      from() {
        const api = {
          select() { return api },
          eq() { return api },
          then(res) { return Promise.resolve({ data: null, error: { code: '42501' } }).then(res) },
        }
        return api
      },
    }
    const res = await findInsertedRowIds(client, 'farms', [['farm_name', 'x']])
    expect(res.ok).toBe(false)
    // Critically: this must NOT be indistinguishable from "no rows found".
    expect(classifyAmbiguousInsert(res, []).status).toBe('BLOCK')
  })
})

// ── Finding 5: the pending storage-list probe must be differential ──────────
describe('finding 5 — the pending list probe is differential and non-vacuous', () => {
  const base = {
    controlObjectName: 'ctl.txt',
    ownerCanSeeControl: true,
    pendingError: null,
    pendingNames: [],
    cleanupVerified: true,
  }

  it('BLOCKS when no control object exists at the prefix', () => {
    // This is the original defect: listing a bare prefix returns [] for
    // everyone, so the probe passed without any policy being consulted.
    const v = evaluatePendingListProbe({ ...base, controlObjectName: null })
    expect(v.status).toBe('BLOCK')
    expect(v.reason).toMatch(/vacuous/)
  })

  it('BLOCKS when the owner cannot see its own control object', () => {
    const v = evaluatePendingListProbe({ ...base, ownerCanSeeControl: false })
    expect(v.status).toBe('BLOCK')
    expect(v.reason).toMatch(/not proven non-empty/)
  })

  it('PASSES only when the object provably exists and the pending user cannot see it', () => {
    const v = evaluatePendingListProbe(base)
    expect(v.status).toBe('PASS')
    expect(v.reason).toMatch(/denied by policy/)
  })

  it('FAILS when the pending identity lists the control object', () => {
    const v = evaluatePendingListProbe({ ...base, pendingNames: ['ctl.txt'] })
    expect(v.status).toBe('FAIL')
    expect(v.reason).toMatch(/SECURITY FAILURE/)
  })

  it('distinguishes empty-by-policy from empty-because-no-object', () => {
    // Identical pending response; only the existence of the control differs.
    const emptyResponse = { pendingError: null, pendingNames: [] }
    expect(evaluatePendingListProbe({ ...base, ...emptyResponse }).status).toBe('PASS')
    expect(evaluatePendingListProbe({ ...base, ...emptyResponse, controlObjectName: null }).status).toBe('BLOCK')
  })

  it('BLOCKS on an auth/transport error rather than reading it as denial', () => {
    expect(evaluatePendingListProbe({ ...base, pendingError: { code: 'PGRST301' } }).status).toBe('BLOCK')
    expect(evaluatePendingListProbe({ ...base, pendingError: { message: 'fetch failed' } }).status).toBe('BLOCK')
  })

  // Teardown is no longer folded into this verdict. Cleanup and access control
  // are separate result categories: a teardown defect used to be reported as a
  // listing-policy FAIL, which both mislabelled the defect and meant cleanup
  // "success" read as evidence the policy enforced. Residue is now asserted
  // independently by the run-scoped storage sweep (see
  // scripts/staging-storage-cleanup.test.mjs).
  it('ignores teardown state — cleanup is asserted separately, not as a policy verdict', () => {
    expect(evaluatePendingListProbe({ ...base, cleanupVerified: false }).status).toBe('PASS')
  })
})

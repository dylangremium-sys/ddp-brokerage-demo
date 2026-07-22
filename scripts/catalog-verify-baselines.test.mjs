// scripts/catalog-verify-baselines.test.mjs
//
// OFFLINE regression coverage for the three catalog VERIFY scripts remediated in
// Workstream A.
//
// WHY THIS EXISTS. On 2026-07-21 and again on 2026-07-22 the staging harness
// reported exactly three failures — 12/14/15 catalog VERIFY — while every
// behavioural security probe passed. None of the three was a security defect.
// Each failed because it froze a 2026-07-11 catalog snapshot:
//
//   12/V5  count(*) = 6 functions          → 11 exist (migrations 10/17/19/22/23)
//   14/V4  anon still HOLDS TRUNCATE       → migration 15 deliberately revoked it
//   14/V5  tables=20 policies=43 funcs=6   → 24/63/11 after intended growth
//   14/V6  farm guard must be ABSENT       → migration 19 installed it
//   15/V2  every table fully client-CRUD   → migration 17 is admin-only by design
//   15/V6  rls_on = 20                     → 24, and a 21st secure table would FAIL
//   15/V7  buyer_pack + farm guard ABSENT  → migrations 10 and 19 shipped them
//   15/V8  every function SECURITY DEFINER → migration 17's RAISE-only trigger is not
//
// A count is not a security property. These tests pin the corrected invariants:
// each assertion must survive legitimate schema growth and must still fail when
// the property it protects is actually violated.
//
// TWO LAYERS, deliberately:
//   1. Static assertions over the real SQL text — proves the shipped scripts no
//      longer contain the frozen-count equalities and DO contain the guards.
//   2. Fixture simulation — the predicate each corrected assertion expresses is
//      modelled in JS and exercised against synthetic catalogs. This mirrors the
//      SQL rather than executing it (no database here by design), so layer 1
//      exists to keep the SQL and the model from drifting apart.
//
// No test contacts Supabase.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sql = (f) => readFileSync(join(ROOT, f), 'utf8')

const V12 = '12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql'
const V14 = '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql'
const V15 = '15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql'

// Strip SQL comments so assertions test executable text, not the rationale
// comments (which deliberately quote the old, removed expressions).
const code = (f) => sql(f)
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n')

// ── Layer 1 — the shipped SQL no longer freezes the catalog ────────────────
describe('the remediated VERIFY scripts contain no frozen catalog counts', () => {
  it('12: the WHOLE-SCHEMA count(*) = 6 inventory is gone', () => {
    // The distinction that matters. `count(*) = 6` is fine as a PRESENCE check
    // scoped by `proname IN (...)` — "all six are still here". It is not fine as
    // an unscoped inventory — "only six may ever exist", which is what failed.
    // So: every count(*) = 6 must sit in a statement that also scopes by name.
    const statements = code(V12).split(';')
    const unscoped = statements.filter((s) => /count\(\*\)\s*=\s*6/.test(s) && !/proname\s+IN\s*\(/i.test(s))
    expect(unscoped, `unscoped count(*) = 6 in: ${unscoped.join(' | ').slice(0, 200)}`).toEqual([])
  })

  it('12: and the surviving count(*) = 6 is genuinely a scoped presence check', () => {
    const stmt = code(V12).split(';').find((s) => /count\(\*\)\s*=\s*6/.test(s))
    expect(stmt).toBeDefined()
    expect(stmt).toMatch(/proname\s+IN\s*\(/i)
    expect(stmt).toMatch(/is_ddp_admin/)
  })

  it('14: the 20/43/6/4 object-count equality is gone', () => {
    const c = code(V14)
    expect(c).not.toMatch(/tables\s*=\s*20/)
    expect(c).not.toMatch(/policies\s*=\s*43/)
    expect(c).not.toMatch(/app_funcs\s*=\s*6/)
    expect(c).not.toMatch(/pub_triggers\s*=\s*4/)
  })

  it('15: the 20/43/6/4 counts and rls_on = 20 are gone', () => {
    const c = code(V15)
    expect(c).not.toMatch(/tables\s*=\s*20/)
    expect(c).not.toMatch(/policies\s*=\s*43/)
    expect(c).not.toMatch(/funcs\s*=\s*6/)
    expect(c).not.toMatch(/triggers\s*=\s*4/)
    expect(c).not.toMatch(/rls_on\s*=\s*20/)
  })

  it('the expired absence clauses are gone', () => {
    // 14/V6 and 15/V7 required objects that migrations 19 and 10 then shipped.
    expect(code(V14)).not.toMatch(/to_regprocedure\('public\.fn_protect_farm_admin_fields\(\)'\)\s+IS\s+NULL\s+THEN/i)
    expect(code(V15)).not.toMatch(/relname\s+LIKE\s+'buyer_pack%'\)\s*=\s*0/i)
  })

  it('14/V4 no longer demands the privilege migration 15 revoked', () => {
    // The old form asserted anon HOLDS truncate/trigger; the new form asserts NOT.
    const c = code(V14)
    expect(c).toMatch(/NOT has_table_privilege\('anon',\s*'public\.farms',\s*'TRUNCATE'\)/)
    expect(c).toMatch(/NOT has_table_privilege\('anon',\s*'public\.farms',\s*'TRIGGER'\)/)
  })
})

describe('the remediated VERIFY scripts still assert the dangerous-grant guards', () => {
  it('12 keeps the PUBLIC/anon EXECUTE guard and adds a search_path guard', () => {
    const c = code(V12)
    expect(c).toMatch(/has_function_privilege\('public'/)
    expect(c).toMatch(/has_function_privilege\('anon'/)
    expect(c).toMatch(/prosecdef/)
    expect(c).toMatch(/search_path=%/)
  })

  it('14 asserts RLS is on for every table, not a table count', () => {
    expect(code(V14)).toMatch(/NOT c\.relrowsecurity/)
    expect(code(V14)).toMatch(/tables_without_rls\s*=\s*0/)
  })

  it('15 keeps a whole-schema non-CRUD over-grant guard', () => {
    const c = code(V15)
    expect(c).toMatch(/'TRUNCATE'\), \('TRIGGER'\), \('REFERENCES'\), \('MAINTAIN'\)/)
    expect(c).toMatch(/over_grants/)
    expect(c).toMatch(/tables_without_rls\s*=\s*0/)
  })

  it('15/V8 still rejects PUBLIC/anon EXECUTE and unpinned SECURITY DEFINER', () => {
    const c = code(V15)
    expect(c).toMatch(/PUBLIC can EXECUTE/)
    expect(c).toMatch(/anon can EXECUTE/)
    expect(c).toMatch(/SECURITY DEFINER without a pinned search_path/)
  })

  it('15/V8 names its one reviewed exception explicitly rather than broadening', () => {
    const c = code(V15)
    expect(c).toMatch(/prevent_procurement_decision_mutation/)
    expect(c).toMatch(/not SECURITY DEFINER \(review required\)/)
  })

  it('all three remain SELECT-only (no mutating top-level statement)', () => {
    for (const f of [V12, V14, V15]) {
      const c = code(f)
      expect(c, f).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL|DO)\b/im)
    }
  })
})

// ── Layer 2 — the corrected predicates, modelled and exercised ─────────────
//
// Each helper mirrors one corrected assertion. Fixtures below represent catalogs.

const fn = (name, over = {}) => ({
  name, owner: 'postgres', secdef: true, pinnedSearchPath: true,
  publicExec: false, anonExec: false, ...over,
})

const BASELINE_SIX = [
  'is_ddp_admin', 'has_farm_membership', 'handle_new_user',
  'fn_protect_owner_notes', 'fn_protect_review_request_fields',
  'prevent_compliance_audit_log_mutation',
].map((n) => fn(n))

// The five functions later migrations legitimately added.
const GROWTH_FIVE = [
  fn('fn_protect_farm_admin_fields'),
  fn('has_operational_farmer_access'),
  fn('issue_buyer_pack_snapshot'),
  fn('prevent_buyer_pack_mutation'),
  fn('prevent_procurement_decision_mutation', { secdef: false }), // migration 17, reviewed
]

// 12/V5 + 15/V8 + 12/V6: function safety, growth tolerant.
const functionOffenders = (fns) => fns
  .map((f) => {
    if (f.publicExec) return `${f.name} [PUBLIC can EXECUTE]`
    if (f.anonExec) return `${f.name} [anon can EXECUTE]`
    if (f.owner !== 'postgres') return `${f.name} [owner is not postgres]`
    if (f.secdef && !f.pinnedSearchPath) return `${f.name} [SECURITY DEFINER without a pinned search_path]`
    if (!f.secdef && f.name !== 'prevent_procurement_decision_mutation') return `${f.name} [not SECURITY DEFINER (review required)]`
    return null
  })
  .filter(Boolean)

const sixPresent = (fns) => BASELINE_SIX.every((b) => fns.some((f) => f.name === b.name))

describe('12/V5 + V6 — function checks survive growth and still catch exposure', () => {
  it('passes on the ORIGINAL six-function catalog', () => {
    expect(sixPresent(BASELINE_SIX)).toBe(true)
    expect(functionOffenders(BASELINE_SIX)).toEqual([])
  })

  it('passes on the CURRENT eleven-function catalog — growth is not a failure', () => {
    const all = [...BASELINE_SIX, ...GROWTH_FIVE]
    expect(all).toHaveLength(11)
    expect(sixPresent(all)).toBe(true)
    expect(functionOffenders(all)).toEqual([])
  })

  it('this is the exact case the old count(*) = 6 assertion failed on', () => {
    const all = [...BASELINE_SIX, ...GROWTH_FIVE]
    expect(all.length).not.toBe(6)      // old assertion: FAIL
    expect(functionOffenders(all)).toEqual([]) // new assertion: PASS
  })

  it('FAILS when a function becomes PUBLIC-executable', () => {
    const bad = [...BASELINE_SIX.slice(1), fn('is_ddp_admin', { publicExec: true })]
    expect(functionOffenders(bad)).toContain('is_ddp_admin [PUBLIC can EXECUTE]')
  })

  it('FAILS when a function becomes anon-executable', () => {
    const bad = [...BASELINE_SIX.slice(1), fn('is_ddp_admin', { anonExec: true })]
    expect(functionOffenders(bad)).toContain('is_ddp_admin [anon can EXECUTE]')
  })

  it('FAILS on SECURITY DEFINER without a pinned search_path', () => {
    const bad = [...BASELINE_SIX, fn('newly_added', { pinnedSearchPath: false })]
    expect(functionOffenders(bad)).toContain('newly_added [SECURITY DEFINER without a pinned search_path]')
  })

  it('FAILS when a function is not owned by postgres', () => {
    const bad = [...BASELINE_SIX, fn('newly_added', { owner: 'app_user' })]
    expect(functionOffenders(bad)).toContain('newly_added [owner is not postgres]')
  })

  it('FAILS when one of the six is dropped', () => {
    expect(sixPresent(BASELINE_SIX.filter((f) => f.name !== 'is_ddp_admin'))).toBe(false)
  })

  it('a NEW non-definer function still surfaces; only the reviewed one is exempt', () => {
    const withNew = [...BASELINE_SIX, ...GROWTH_FIVE, fn('some_new_guard', { secdef: false })]
    const offenders = functionOffenders(withNew)
    expect(offenders).toContain('some_new_guard [not SECURITY DEFINER (review required)]')
    expect(offenders.join(' ')).not.toContain('prevent_procurement_decision_mutation')
  })
})

// 14/V5 + 15/V6: RLS posture, count independent.
const tbl = (name, over = {}) => ({ name, rls: true, forceRls: false, ...over })
const ORIGINAL_20 = Array.from({ length: 20 }, (_, i) => tbl(`t${i + 1}`))
const GROWN_24 = [...ORIGINAL_20, tbl('buyer_pack_snapshots'), tbl('procurement_decisions'),
  tbl('buyer_pack_audit_log'), tbl('buyer_pack_download_log')]

const rlsPosture = (tables) => ({
  tablesWithoutRls: tables.filter((t) => !t.rls).map((t) => t.name),
  forceRls: tables.filter((t) => t.forceRls).length,
})

describe('14/V5 + 15/V6 — RLS posture is asserted, not table count', () => {
  it('passes on the original 20 tables', () => {
    const r = rlsPosture(ORIGINAL_20)
    expect(r.tablesWithoutRls).toEqual([])
    expect(r.forceRls).toBe(0)
  })

  it('passes on the grown 24-table catalog — this is what rls_on = 20 failed on', () => {
    expect(GROWN_24).toHaveLength(24)
    expect(rlsPosture(GROWN_24).tablesWithoutRls).toEqual([])
  })

  it('the old assertion would have FAILED a 21st table even WITH RLS enabled', () => {
    const secure21 = [...ORIGINAL_20, tbl('a_new_secure_table')]
    expect(secure21.filter((t) => t.rls)).toHaveLength(21)
    expect(21 === 20).toBe(false)                        // old: FAIL on a secure outcome
    expect(rlsPosture(secure21).tablesWithoutRls).toEqual([]) // new: PASS
  })

  it('FAILS — and names the table — when a new table ships without RLS', () => {
    const bad = [...GROWN_24, tbl('unprotected_new_table', { rls: false })]
    expect(rlsPosture(bad).tablesWithoutRls).toEqual(['unprotected_new_table'])
  })

  it('FAILS when FORCE RLS is switched on', () => {
    const bad = [...GROWN_24.slice(1), tbl('t1', { forceRls: true })]
    expect(rlsPosture(bad).forceRls).toBe(1)
  })
})

// 15/V2 + V2a: client privileges — scoped CRUD, whole-schema over-grant guard.
const CLIENT_ROLES = ['anon', 'authenticated']
const NON_CRUD = ['TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN']
const MIGRATION_15_TABLES = ['farms', 'profiles', 'documents']

const missingCrud = (grants) => {
  const out = []
  for (const t of MIGRATION_15_TABLES) {
    for (const r of CLIENT_ROLES) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        if (!grants[`${t}/${r}/${p}`]) out.push(`${t}/${r}/${p}`)
      }
    }
  }
  return out
}
const overGrants = (allTables, grants) => {
  const out = []
  for (const t of allTables) {
    for (const r of CLIENT_ROLES) {
      for (const p of NON_CRUD) if (grants[`${t}/${r}/${p}`]) out.push(`${t}/${r}/${p}`)
    }
  }
  return out
}
const fullCrud = (tables) => {
  const g = {}
  for (const t of tables) for (const r of CLIENT_ROLES) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) g[`${t}/${r}/${p}`] = true
  return g
}

describe('15/V2 + V2a — CRUD scoped to migration-15 tables, over-grants caught schema-wide', () => {
  it('passes when the migration-15 tables retain client CRUD', () => {
    expect(missingCrud(fullCrud(MIGRATION_15_TABLES))).toEqual([])
  })

  it('tolerates migration 17s admin-only table — the exact 6 "missing" grants', () => {
    // procurement_decisions: anon has none, authenticated has no UPDATE/DELETE.
    const grants = fullCrud([...MIGRATION_15_TABLES])
    grants['procurement_decisions/authenticated/SELECT'] = true
    grants['procurement_decisions/authenticated/INSERT'] = true
    expect(missingCrud(grants)).toEqual([])   // new: scoped, PASS
    // The old unscoped form counted 6 absences on this table alone:
    const oldStyle = []
    for (const r of CLIENT_ROLES) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      if (!grants[`procurement_decisions/${r}/${p}`]) oldStyle.push(`${r}/${p}`)
    }
    expect(oldStyle).toHaveLength(6)          // old: FAIL
  })

  it('FAILS when a migration-15 table loses client CRUD', () => {
    const grants = fullCrud(MIGRATION_15_TABLES)
    delete grants['farms/anon/SELECT']
    expect(missingCrud(grants)).toEqual(['farms/anon/SELECT'])
  })

  it('FAILS when ANY table — including a new one — over-grants non-CRUD', () => {
    const all = [...MIGRATION_15_TABLES, 'procurement_decisions', 'brand_new_table']
    const grants = fullCrud(MIGRATION_15_TABLES)
    grants['brand_new_table/anon/TRUNCATE'] = true
    expect(overGrants(all, grants)).toEqual(['brand_new_table/anon/TRUNCATE'])
  })

  it('the over-grant guard is NOT scoped — it covers tables added after migration 15', () => {
    const all = [...MIGRATION_15_TABLES, 'procurement_decisions']
    const grants = fullCrud(MIGRATION_15_TABLES)
    grants['procurement_decisions/authenticated/TRIGGER'] = true
    expect(overGrants(all, grants)).toContain('procurement_decisions/authenticated/TRIGGER')
  })
})

// 15/V7 + 14/V6: prior-migration invariants without expired absence clauses.
const priorMigrationsActive = (s) =>
  s.mig11Trigger === true && s.anonDefaultNonCrud === 0 && s.anonCanExecIsDdpAdmin === false

describe('15/V7 + 14/V6 — genuine invariants kept, expired absence clauses dropped', () => {
  const healthy = { mig11Trigger: true, anonDefaultNonCrud: 0, anonCanExecIsDdpAdmin: false }

  it('passes with buyer-pack tables and the farm guard PRESENT', () => {
    // Both objects were required to be ABSENT by the old assertion.
    expect(priorMigrationsActive({ ...healthy, buyerPackTables: 4, farmGuardExists: true })).toBe(true)
  })

  it('FAILS when migration 11s TRUNCATE trigger is dropped', () => {
    expect(priorMigrationsActive({ ...healthy, mig11Trigger: false })).toBe(false)
  })

  it('FAILS when anon regains a non-CRUD default privilege', () => {
    expect(priorMigrationsActive({ ...healthy, anonDefaultNonCrud: 1 })).toBe(false)
  })

  it('FAILS when anon regains EXECUTE on is_ddp_admin()', () => {
    expect(priorMigrationsActive({ ...healthy, anonCanExecIsDdpAdmin: true })).toBe(false)
  })
})

// ── The three staging failures, as regression cases ────────────────────────
describe('the exact 2026-07-21/22 staging failures now pass, without weakening', () => {
  const LIVE = {
    functions: [...BASELINE_SIX, ...GROWTH_FIVE],   // 11
    tables: GROWN_24,                               // 24, all RLS on
    prior: { mig11Trigger: true, anonDefaultNonCrud: 0, anonCanExecIsDdpAdmin: false },
  }

  it('12 VERIFY: 11 functions, none exposed → PASS', () => {
    expect(LIVE.functions).toHaveLength(11)
    expect(sixPresent(LIVE.functions)).toBe(true)
    expect(functionOffenders(LIVE.functions)).toEqual([])
  })

  it('14 VERIFY: 24 tables all with RLS, farms non-CRUD revoked → PASS', () => {
    expect(rlsPosture(LIVE.tables).tablesWithoutRls).toEqual([])
    const farmsAnon = { TRUNCATE: false, TRIGGER: false, REFERENCES: false, MAINTAIN: false, SELECT: true }
    expect(Object.entries(farmsAnon).every(([p, v]) => (p === 'SELECT' ? v : !v))).toBe(true)
  })

  it('15 VERIFY: admin-only table tolerated, one reviewed non-definer function → PASS', () => {
    expect(functionOffenders(LIVE.functions)).toEqual([])
    expect(priorMigrationsActive(LIVE.prior)).toBe(true)
  })

  it('but a real regression in any of the three still FAILS', () => {
    expect(functionOffenders([...LIVE.functions, fn('leaky', { anonExec: true })])).not.toEqual([])
    expect(rlsPosture([...LIVE.tables, tbl('naked', { rls: false })]).tablesWithoutRls).toEqual(['naked'])
    expect(priorMigrationsActive({ ...LIVE.prior, anonCanExecIsDdpAdmin: true })).toBe(false)
  })
})

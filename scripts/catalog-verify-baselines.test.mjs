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
  it('12: no count(*) = N presence assertion remains at all', () => {
    // The first remediation kept `count(*) = 6` scoped by `proname IN (...)`.
    // That still counted bare NAMES, so a same-name/wrong-argument overload
    // satisfied it (substitution passed) while an extra legitimate overload
    // broke it (growth failed). Presence is now an exact-signature anti-join,
    // so no count-based presence assertion should survive.
    const c = code(V12)
    expect(c).not.toMatch(/count\(\*\)\s*=\s*6/)
    expect(c).not.toMatch(/proname\s+IN\s*\(/i)
  })

  it('12: presence is asserted per exact signature, and counts only the MISSING', () => {
    const c = code(V12)
    // The only surviving count is over the anti-join's misses, which is the
    // opposite of an inventory: it grows with absence, not with the catalog.
    expect(c).toMatch(/count\(\*\) FILTER \(WHERE missing\) = 0/)
    expect(c).toMatch(/to_regprocedure\('public\.' \|\| e\.signature\) IS NULL AS missing/)
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

// ── Absence detection — the gap the first remediation opened ────────────────
//
// Replacing frozen counts with property checks made the scripts blind to objects
// that STOPPED existing: a catalog-driven query yields no rows for a missing
// object, so nothing fails. The old counts caught disappearance incidentally;
// removing them (correctly, since they also failed on growth) removed that too.
//
// Both scripts now drive from an EXPECTED set and anti-join the catalog, which
// detects absence AND tolerates growth instead of trading one for the other.

// --- VERIFY 12: exact required signatures -------------------------------------
const REQUIRED_SIGNATURES = [
  'is_ddp_admin()',
  'has_farm_membership(uuid)',
  'handle_new_user()',
  'fn_protect_owner_notes()',
  'fn_protect_review_request_fields()',
  'prevent_compliance_audit_log_mutation()',
]

// Mirrors `to_regprocedure('public.'||signature) IS NULL` — exact identity match,
// so a same-name/different-argument overload does NOT satisfy a requirement.
const missingSignatures = (catalogSignatures) =>
  REQUIRED_SIGNATURES.filter((s) => !catalogSignatures.includes(s))

const ALL_PRESENT = [...REQUIRED_SIGNATURES]

describe('VERIFY 12 — required functions are checked by exact signature', () => {
  it('1. all six exact signatures present → PASS', () => {
    expect(missingSignatures(ALL_PRESENT)).toEqual([])
  })

  it('2. an exact signature absent → FAIL, naming it', () => {
    const catalog = ALL_PRESENT.filter((s) => s !== 'has_farm_membership(uuid)')
    expect(missingSignatures(catalog)).toEqual(['has_farm_membership(uuid)'])
  })

  it('3. replaced by a same-name WRONG-ARGUMENT overload → FAIL', () => {
    // The exact case Codex raised: proname-counting would still see 6 and PASS.
    const catalog = ALL_PRESENT
      .filter((s) => s !== 'has_farm_membership(uuid)')
      .concat('has_farm_membership(text)')
    expect(catalog).toHaveLength(6)                       // a bare-name count: 6 → PASS
    expect(missingSignatures(catalog)).toEqual(['has_farm_membership(uuid)']) // exact: FAIL
  })

  it('4. expected signature PLUS a legitimate overload → PASS', () => {
    // The false-positive direction: bare-name counting would see 7 and FAIL.
    const catalog = [...ALL_PRESENT, 'has_farm_membership(text)']
    expect(catalog).toHaveLength(7)
    expect(missingSignatures(catalog)).toEqual([])
  })

  it('5. unrelated legitimate functions added → PASS', () => {
    const catalog = [...ALL_PRESENT,
      'fn_protect_farm_admin_fields()', 'has_operational_farmer_access()',
      'issue_buyer_pack_snapshot(uuid,text)', 'prevent_buyer_pack_mutation()',
      'prevent_procurement_decision_mutation()']
    expect(catalog).toHaveLength(11)
    expect(missingSignatures(catalog)).toEqual([])
  })

  it('6. a dangerous grant on a NEW function is still caught by the schema-wide guard', () => {
    const fns = [...BASELINE_SIX, ...GROWTH_FIVE, fn('brand_new_helper', { anonExec: true })]
    expect(missingSignatures(ALL_PRESENT)).toEqual([])            // presence: PASS
    expect(functionOffenders(fns)).toContain('brand_new_helper [anon can EXECUTE]') // property: FAIL
  })

  it('7. complete absence → FAIL listing every signature', () => {
    expect(missingSignatures([])).toEqual(REQUIRED_SIGNATURES)
  })

  it('static: the SQL uses explicit signatures, not proname totals', () => {
    const c = code(V12)
    expect(c).toMatch(/to_regprocedure\('public\.' \|\| e\.signature\)/)
    expect(c).toMatch(/has_farm_membership\(uuid\)/)          // identity args, not bare name
    expect(c).toMatch(/WITH expected\(signature\) AS \(/)
    // The bare-name presence count is gone.
    expect(c).not.toMatch(/proname\s+IN\s*\(/i)
  })
})

// --- VERIFY 15: governed-table expected set -----------------------------------
const GOVERNED_19 = [
  'compliance_alerts', 'compliance_entity_status', 'compliance_reviews',
  'compliance_rules', 'ddp_scores', 'documents', 'farm_memberships',
  'farm_profiles', 'farmer_documents', 'farmer_photos', 'farmer_review_requests',
  'farms', 'inventory_batches', 'legal_updates', 'market_price_benchmarks',
  'profiles', 'regulatory_sources', 'risk_flags', 'status_history',
]
const CRUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

// Mirrors the LEFT JOIN + UNION ALL: ABSENT and MISSING_GRANT as distinct causes.
const governedFindings = (presentTables, grants) => {
  const out = []
  for (const t of GOVERNED_19) {
    if (!presentTables.includes(t)) { out.push({ cause: 'ABSENT', detail: t }); continue }
    for (const r of CLIENT_ROLES) for (const p of CRUD) {
      if (!grants[`${t}/${r}/${p}`]) out.push({ cause: 'MISSING_GRANT', detail: `${t}/${r}/${p}` })
    }
  }
  return out
}
const grantAll = (tables) => {
  const g = {}
  for (const t of tables) for (const r of CLIENT_ROLES) for (const p of CRUD) g[`${t}/${r}/${p}`] = true
  return g
}

describe('VERIFY 15 — governed tables are driven by an expected set', () => {
  it('1. all governed tables present with full CRUD → PASS', () => {
    expect(governedFindings(GOVERNED_19, grantAll(GOVERNED_19))).toEqual([])
  })

  it('2. one governed table entirely ABSENT → FAIL (the old form passed here)', () => {
    const present = GOVERNED_19.filter((t) => t !== 'farms')
    const found = governedFindings(present, grantAll(present))
    expect(found).toEqual([{ cause: 'ABSENT', detail: 'farms' }])
    // The previous catalog-driven form produced no row for a missing table:
    const oldStyle = present.filter((t) => GOVERNED_19.includes(t))
      .flatMap((t) => CLIENT_ROLES.flatMap((r) => CRUD.filter((p) => !grantAll(present)[`${t}/${r}/${p}`])))
    expect(oldStyle).toEqual([])   // old: PASS despite farms being gone
  })

  it('2b. a governed table RENAMED fails under its original expected name', () => {
    const present = GOVERNED_19.filter((t) => t !== 'ddp_scores').concat('ddp_scores_v2')
    const found = governedFindings(present, grantAll(present))
    expect(found).toEqual([{ cause: 'ABSENT', detail: 'ddp_scores' }])
  })

  it('3. present but required grants incomplete → FAIL as MISSING_GRANT', () => {
    const grants = grantAll(GOVERNED_19)
    delete grants['farms/anon/SELECT']
    const found = governedFindings(GOVERNED_19, grants)
    expect(found).toEqual([{ cause: 'MISSING_GRANT', detail: 'farms/anon/SELECT' }])
  })

  it('4. an additional legitimate RLS-enabled table → PASS', () => {
    const present = [...GOVERNED_19, 'buyer_pack_snapshots']
    expect(governedFindings(present, grantAll(present))).toEqual([])
    expect(rlsPosture([...GROWN_24, tbl('buyer_pack_snapshots')]).tablesWithoutRls).toEqual([])
  })

  it('5. an additional restricted/admin-only table → PASS (not required to be writable)', () => {
    // procurement_decisions: anon has nothing, authenticated no UPDATE/DELETE.
    const present = [...GOVERNED_19, 'procurement_decisions']
    const grants = grantAll(GOVERNED_19)
    grants['procurement_decisions/authenticated/SELECT'] = true
    expect(governedFindings(present, grants)).toEqual([])
  })

  it('6. RLS disabled on a present table → FAIL via the whole-schema property', () => {
    const bad = [...GROWN_24, tbl('naked_table', { rls: false })]
    expect(rlsPosture(bad).tablesWithoutRls).toEqual(['naked_table'])
  })

  it('7. a forbidden non-CRUD privilege → FAIL via the whole-schema guard', () => {
    const all = [...GOVERNED_19, 'procurement_decisions']
    const grants = grantAll(GOVERNED_19)
    grants['procurement_decisions/anon/TRUNCATE'] = true
    expect(overGrants(all, grants)).toEqual(['procurement_decisions/anon/TRUNCATE'])
  })

  it('8. the diagnostic distinguishes ABSENT from MISSING_GRANT', () => {
    const present = GOVERNED_19.filter((t) => t !== 'documents')
    const grants = grantAll(present)
    delete grants['profiles/authenticated/DELETE']
    const found = governedFindings(present, grants)
    expect(found.filter((f) => f.cause === 'ABSENT')).toEqual([{ cause: 'ABSENT', detail: 'documents' }])
    expect(found.filter((f) => f.cause === 'MISSING_GRANT'))
      .toEqual([{ cause: 'MISSING_GRANT', detail: 'profiles/authenticated/DELETE' }])
  })

  it('static: the SQL drives from an expected VALUES set and LEFT JOINs the catalog', () => {
    const c = code(V15)
    expect(c).toMatch(/WITH expected\(relname\) AS \(/)
    expect(c).toMatch(/oid IS NULL/)          // the absence arm
    expect(c).toMatch(/'ABSENT'/)
    expect(c).toMatch(/'MISSING_GRANT'/)
    // No catalog-driven relname filter remains for the governed set.
    expect(c).not.toMatch(/AND c\.relname IN \(/)
  })
})

describe('the two-layer model holds for both scripts', () => {
  it('an object disappearing fails even when everything remaining is secure', () => {
    // Secure remaining catalog…
    const present = GOVERNED_19.filter((t) => t !== 'farms')
    expect(overGrants(present, grantAll(present))).toEqual([])      // no over-grants
    expect(rlsPosture(GROWN_24).tablesWithoutRls).toEqual([])       // RLS everywhere
    expect(functionOffenders([...BASELINE_SIX, ...GROWTH_FIVE])).toEqual([])
    // …yet absence still fails, in both scripts.
    expect(governedFindings(present, grantAll(present))).toHaveLength(1)
    expect(missingSignatures(ALL_PRESENT.filter((s) => s !== 'is_ddp_admin()'))).toEqual(['is_ddp_admin()'])
  })

  it('a legitimate new object never fails merely because the catalog grew', () => {
    const present = [...GOVERNED_19, 'buyer_pack_snapshots', 'procurement_decisions']
    const grants = grantAll(GOVERNED_19)
    expect(governedFindings(present, grants)).toEqual([])
    expect(missingSignatures([...ALL_PRESENT, 'issue_buyer_pack_snapshot(uuid,text)'])).toEqual([])
  })
})

// ── V8 exemption scoped to the exact reviewed signature ────────────────────
//
// The exemption for migration 17's RAISE-only trigger body was written as
// `p.proname <> 'prevent_procurement_decision_mutation'` — a BARE NAME, so every
// overload of that name was exempted. A future
// `prevent_procurement_decision_mutation(uuid)` shipped as SECURITY INVOKER would
// have escaped review, defeating the clause's documented purpose ("a NEW
// non-definer function still surfaces here for a decision").
//
// This is the same bare-name-vs-exact-signature defect corrected for the PRESENCE
// check one round earlier; it survived in the EXEMPTION clause. Only the exact
// zero-argument signature is exempt now.

const EXEMPT_SIGNATURE = 'prevent_procurement_decision_mutation()'

// Mirrors V8's CASE, keyed on the exact regprocedure signature rather than name.
const sigFn = (signature, over = {}) => ({
  signature, owner: 'postgres', secdef: true, pinnedSearchPath: true,
  publicExec: false, anonExec: false, ...over,
})

const v8Offenders = (fns) => fns
  .map((f) => {
    if (f.publicExec) return `${f.signature} [PUBLIC can EXECUTE]`
    if (f.anonExec) return `${f.signature} [anon can EXECUTE]`
    if (f.owner !== 'postgres') return `${f.signature} [owner is not postgres]`
    if (f.secdef && !f.pinnedSearchPath) return `${f.signature} [SECURITY DEFINER without a pinned search_path]`
    if (!f.secdef && f.signature !== EXEMPT_SIGNATURE) return `${f.signature} [not SECURITY DEFINER (review required)]`
    return null
  })
  .filter(Boolean)

const HEALTHY_SIGS = [
  sigFn('is_ddp_admin()'), sigFn('has_farm_membership(uuid)'), sigFn('handle_new_user()'),
  sigFn('fn_protect_owner_notes()'), sigFn('fn_protect_review_request_fields()'),
  sigFn('prevent_compliance_audit_log_mutation()'), sigFn('fn_protect_farm_admin_fields()'),
  sigFn('has_operational_farmer_access()'), sigFn('issue_buyer_pack_snapshot(uuid,text)'),
  sigFn('prevent_buyer_pack_mutation()'),
  sigFn(EXEMPT_SIGNATURE, { secdef: false }),   // the reviewed exception
]

describe('VERIFY 15/V8 — the SECURITY INVOKER exemption is signature-scoped', () => {
  it('the exact reviewed zero-argument function remains exempt', () => {
    expect(v8Offenders(HEALTHY_SIGS)).toEqual([])
    // …and it is genuinely SECURITY INVOKER, i.e. the exemption is doing work.
    expect(HEALTHY_SIGS.find((f) => f.signature === EXEMPT_SIGNATURE).secdef).toBe(false)
  })

  it('a same-name INVOKER overload is NOT exempt and fails V8', () => {
    // The exact case Codex raised: bare-name matching would have exempted this.
    const withOverload = [...HEALTHY_SIGS,
      sigFn('prevent_procurement_decision_mutation(uuid)', { secdef: false })]
    const offenders = v8Offenders(withOverload)
    expect(offenders).toEqual(['prevent_procurement_decision_mutation(uuid) [not SECURITY DEFINER (review required)]'])
    // The zero-argument original stays exempt alongside it.
    expect(offenders.join(' ')).not.toContain(`${EXEMPT_SIGNATURE} [`)
  })

  it('a bare-name predicate would have exempted that overload — the defect', () => {
    const overload = sigFn('prevent_procurement_decision_mutation(uuid)', { secdef: false })
    const bareName = (sig) => sig.split('(')[0]
    // Old behaviour: exempt because the NAME matches.
    expect(bareName(overload.signature)).toBe(bareName(EXEMPT_SIGNATURE))
    // New behaviour: not exempt, because the SIGNATURE differs.
    expect(overload.signature).not.toBe(EXEMPT_SIGNATURE)
    expect(v8Offenders([overload])).toHaveLength(1)
  })

  it('a same-name DEFINER overload with a pinned search_path passes', () => {
    // Sharing the name must not fail it either — the exemption narrowed, it did
    // not become a prohibition on the name.
    const withDefinerOverload = [...HEALTHY_SIGS,
      sigFn('prevent_procurement_decision_mutation(text)', { secdef: true, pinnedSearchPath: true })]
    expect(v8Offenders(withDefinerOverload)).toEqual([])
  })

  it('a same-name DEFINER overload WITHOUT a pinned search_path still fails', () => {
    const bad = [...HEALTHY_SIGS,
      sigFn('prevent_procurement_decision_mutation(text)', { secdef: true, pinnedSearchPath: false })]
    expect(v8Offenders(bad)).toEqual([
      'prevent_procurement_decision_mutation(text) [SECURITY DEFINER without a pinned search_path]'])
  })

  it('an unrelated non-definer function still fails — the exemption did not broaden', () => {
    const bad = [...HEALTHY_SIGS, sigFn('some_new_guard()', { secdef: false })]
    expect(v8Offenders(bad)).toEqual(['some_new_guard() [not SECURITY DEFINER (review required)]'])
  })

  it('dangerous EXECUTE grants are still caught regardless of the exemption', () => {
    const bad = [...HEALTHY_SIGS, sigFn(EXEMPT_SIGNATURE.replace('()', '(int)'), { secdef: false, anonExec: true })]
    expect(v8Offenders(bad)[0]).toContain('[anon can EXECUTE]')
  })

  it('static: V8 compares an exact regprocedure signature, with no bare-name exemption', () => {
    const c = code(V15)
    expect(c).toMatch(/p\.oid::regprocedure::text <> 'prevent_procurement_decision_mutation\(\)'/)
    expect(c).not.toMatch(/proname\s*<>\s*'prevent_procurement_decision_mutation'/)
  })

  it('static: the only remaining bare-name predicate is the trigger-wiring check', () => {
    // pg_trigger -> pg_proc via tgfoid: a POSITIVE requirement that the trigger
    // calls the guard, not an exemption. PostgreSQL trigger functions must be
    // declared with zero parameters, so no overload with arguments can be
    // attached to a trigger and impersonate it.
    const bare = code(V15).split('\n').filter((l) => /proname\s*(=|<>|IN)/.test(l))
    expect(bare).toHaveLength(1)
    expect(bare[0]).toContain("fn.proname = 'prevent_compliance_audit_log_mutation'")
    expect(code(V15)).toMatch(/JOIN pg_proc fn ON fn\.oid = t\.tgfoid/)
  })

  it('static: VERIFY 12 presence checks use exact signatures throughout', () => {
    const c = code(V12)
    expect(c).toMatch(/to_regprocedure\('public\.' \|\| e\.signature\)/)
    expect(c).not.toMatch(/proname\s*(=|<>|IN)/)
  })
})

// ── Required audit-log guard triggers ──────────────────────────────────────
//
// V5 enumerates triggers that EXIST, so a dropped guard emits no row and the
// harness — which fails a VERIFY file only when its output contains the literal
// FAIL — sees nothing. `V6 triggers = 4` was the sole detector and was removed.
// 11_..._VERIFY.sql is NOT a backstop: it emits counts/rows for human reading
// and contains zero FAIL verdicts, so it can never fail the harness.

const GUARD_FN = 'prevent_compliance_audit_log_mutation()'
const AUDIT_TABLE = 'compliance_audit_log'
const REQUIRED_TRIGGERS = ['compliance_audit_log_no_truncate', 'compliance_audit_log_no_update_delete']

const trg = (tgname, over = {}) => ({
  tgname, onTable: AUDIT_TABLE, fn: GUARD_FN, enabled: 'A', ...over,
})
const BOTH_GUARDS = REQUIRED_TRIGGERS.map((n) => trg(n))

// Mirrors V5a's anti-join + CASE ladder.
const triggerDefects = (catalog) => REQUIRED_TRIGGERS.map((name) => {
  const t = catalog.find((x) => x.tgname === name)
  if (!t) return `${name}: ABSENT`
  if (t.onTable !== AUDIT_TABLE) return `${name}: WRONG_TABLE`
  if (t.fn !== GUARD_FN) return `${name}: WRONG_FUNCTION`
  if (t.enabled !== 'A') return `${name}: DISABLED`
  return null
}).filter(Boolean)

// Mirrors the OLD existence-driven V5: one row per trigger that EXISTS.
const v5RowsEmitted = (catalog) => catalog.filter((t) => t.onTable === AUDIT_TABLE).length

describe('VERIFY 15/V5a — required audit-log triggers are driven from an expected set', () => {
  it('1. both required triggers present and correctly wired → PASS', () => {
    expect(triggerDefects(BOTH_GUARDS)).toEqual([])
  })

  it('2. compliance_audit_log_no_update_delete absent → FAIL', () => {
    const c = BOTH_GUARDS.filter((t) => t.tgname !== 'compliance_audit_log_no_update_delete')
    expect(triggerDefects(c)).toEqual(['compliance_audit_log_no_update_delete: ABSENT'])
  })

  it('3. compliance_audit_log_no_truncate absent → FAIL', () => {
    const c = BOTH_GUARDS.filter((t) => t.tgname !== 'compliance_audit_log_no_truncate')
    expect(triggerDefects(c)).toEqual(['compliance_audit_log_no_truncate: ABSENT'])
  })

  it('4. a required trigger renamed → FAIL under the expected name', () => {
    const c = [trg('compliance_audit_log_no_truncate'), trg('audit_no_update_delete_v2')]
    expect(triggerDefects(c)).toEqual(['compliance_audit_log_no_update_delete: ABSENT'])
  })

  it('5. trigger attached to the wrong table → FAIL as WRONG_TABLE', () => {
    const c = [trg('compliance_audit_log_no_truncate'),
      trg('compliance_audit_log_no_update_delete', { onTable: 'farms' })]
    expect(triggerDefects(c)).toEqual(['compliance_audit_log_no_update_delete: WRONG_TABLE'])
  })

  it('6. trigger wired to the wrong function → FAIL as WRONG_FUNCTION', () => {
    const c = [trg('compliance_audit_log_no_truncate'),
      trg('compliance_audit_log_no_update_delete', { fn: 'some_other_guard()' })]
    expect(triggerDefects(c)).toEqual(['compliance_audit_log_no_update_delete: WRONG_FUNCTION'])
  })

  it('7. trigger disabled (not ENABLE ALWAYS) → FAIL as DISABLED', () => {
    for (const state of ['O', 'D', 'R']) {
      const c = [trg('compliance_audit_log_no_truncate'),
        trg('compliance_audit_log_no_update_delete', { enabled: state })]
      expect(triggerDefects(c), `enabled=${state}`).toEqual(['compliance_audit_log_no_update_delete: DISABLED'])
    }
  })

  it('8. an additional unrelated trigger → PASS', () => {
    const c = [...BOTH_GUARDS, trg('some_new_audit_trigger', { fn: 'other()' })]
    expect(triggerDefects(c)).toEqual([])
  })

  it('9. existing-trigger property checks still fail on a malformed PRESENT trigger', () => {
    // V5 (unchanged) grades attributes of triggers that exist; V5a grades presence.
    // A present-but-disabled trigger is caught by both, from different angles.
    const c = [trg('compliance_audit_log_no_truncate'),
      trg('compliance_audit_log_no_update_delete', { enabled: 'O' })]
    expect(v5RowsEmitted(c)).toBe(2)                       // V5 still emits both rows
    expect(triggerDefects(c)).toHaveLength(1)              // V5a also flags it
  })

  it('10. diagnostics name the exact trigger and defect class', () => {
    const c = [trg('compliance_audit_log_no_update_delete', { onTable: 'farms' })]
    const d = triggerDefects(c)
    expect(d).toContain('compliance_audit_log_no_truncate: ABSENT')
    expect(d).toContain('compliance_audit_log_no_update_delete: WRONG_TABLE')
    expect(d).toHaveLength(2)
  })

  it('THE DEFECT: the old existence-driven query alone emits NO failure on absence', () => {
    const oneDropped = BOTH_GUARDS.filter((t) => t.tgname !== 'compliance_audit_log_no_update_delete')
    // Old V5: one row per EXISTING trigger — the dropped one simply is not there,
    // so no row, no 'FAIL' literal, and the harness marks the file PASS.
    expect(v5RowsEmitted(oneDropped)).toBe(1)
    expect(v5RowsEmitted(oneDropped)).not.toBe(0)  // the surviving trigger still passes
    // New V5a: absence is a finding.
    expect(triggerDefects(oneDropped)).toEqual(['compliance_audit_log_no_update_delete: ABSENT'])
  })

  it('static: V5a anti-joins an expected trigger set with defect classes', () => {
    const c = code(V15)
    expect(c).toMatch(/WITH expected\(tgname\) AS \(/)
    expect(c).toMatch(/'compliance_audit_log_no_truncate'/)
    expect(c).toMatch(/'compliance_audit_log_no_update_delete'/)
    for (const d of ['ABSENT', 'WRONG_TABLE', 'WRONG_FUNCTION', 'DISABLED']) {
      expect(c, d).toMatch(new RegExp(`'${d}'`))
    }
    expect(c).toMatch(/LEFT JOIN pg_trigger t ON t\.tgname = e\.tgname/)
    expect(c).toMatch(/to_regprocedure\('public\.prevent_compliance_audit_log_mutation\(\)'\)/)
  })
})

// ── Deleted-count responsibility matrix ────────────────────────────────────
//
// The removed `V6 tables = 20 AND policies = 43 AND storage_fd = 3 AND funcs = 6
// AND triggers = 4 AND force_rls = 0 AND rls_on = 20` was, incidentally, the only
// absence detector for several object classes. This test enumerates every class
// that line covered and asserts each now has either an explicit expected-object
// anti-join, or a documented property check that makes one unnecessary.
//
// It fails if a future edit removes the last effective absence detector for a
// required class. It deliberately encodes NO totals.
describe('every object class the removed frozen count covered is still guarded', () => {
  const c15 = code(V15)
  const c14 = code(V14)
  const c12 = code(V12)

  const MATRIX = [
    { cls: 'tables (governed)', detector: () => /WITH expected\(relname\) AS \(/.test(c15) && /'ABSENT'/.test(c15),
      kind: 'expected-set anti-join' },
    { cls: 'functions (required)', detector: () => /to_regprocedure\('public\.' \|\| e\.signature\) IS NULL AS missing/.test(c12),
      kind: 'expected-set anti-join' },
    { cls: 'triggers (audit guards)', detector: () => /WITH expected\(tgname\) AS \(/.test(c15) && /'ABSENT'/.test(c15),
      kind: 'expected-set anti-join' },
    { cls: 'storage policies (farmer-documents)', detector: () => /storage_fd >= 3/.test(c15) && /storage_fd >= 3/.test(c14),
      kind: 'property: >= floor, fails on drop, tolerates additions' },
    { cls: 'rls_on', detector: () => /tables_without_rls = 0/.test(c15) && /tables_without_rls = 0/.test(c14),
      kind: 'property: stronger than a count — every table, present and future' },
    { cls: 'force_rls', detector: () => /force_rls = 0/.test(c15) && /force_rls = 0/.test(c14),
      kind: 'property: absolute, count-independent' },
    { cls: 'public RLS policies', detector: () => /WITH expected\(tablename, policyname, cmd, permissive, roles, has_using, has_check\) AS \(/.test(c15) && /'ABSENT'/.test(c15),
      kind: 'expected-set anti-join' },
    { cls: 'migration-22 restrictive overlay', detector: () => /WITH expected_restrictive\(tablename\) AS \(/.test(c15) && /p\.permissive = 'RESTRICTIVE'/.test(c15),
      kind: 'expected-set anti-join, reported separately' },
  ]

  it.each(MATRIX)('$cls has an effective detector ($kind)', ({ detector }) => {
    expect(detector()).toBe(true)
  })

  it('no class is guarded by a reinstated catalog total', () => {
    for (const c of [c12, c14, c15]) {
      expect(c).not.toMatch(/tables\s*=\s*\d+/)
      expect(c).not.toMatch(/policies\s*=\s*\d+/)
      expect(c).not.toMatch(/triggers\s*=\s*\d+/)
      expect(c).not.toMatch(/rls_on\s*=\s*\d+/)
    }
  })

  // This assertion was previously INVERTED: it asserted that no harness-effective
  // file referenced pg_policies in schema public, cementing the coverage gap as
  // expected behaviour. Written that way it would have FAILED the moment the gap
  // was closed — a test that actively defends a security hole. The gap is now
  // closed by V9/V9a in migration 15, so the assertion is reversed to demand the
  // coverage it used to forbid.
  it('public RLS policy absence IS covered by a harness-effective detector', () => {
    const harnessEffective = [c12, c14, c15]
    const anyPublicPolicyAssertion = harnessEffective.some((c) =>
      /pg_policies[\s\S]{0,200}schemaname\s*=\s*'public'/.test(c))
    expect(anyPublicPolicyAssertion).toBe(true)
    // The detector must live in a file the harness actually fails on, which means
    // it has to emit the literal FAIL — the only thing the runner greps for.
    expect(c15).toMatch(/V9 required public RLS policies present/)
    expect(c15).toMatch(/'V9 required public RLS policies present' AS check,\s*\n\s*CASE WHEN count\(\*\) = 0 THEN 'PASS' ELSE 'FAIL' END/)
    expect(c15).toMatch(/'V9a migration-22 restrictive overlay intact' AS check,\s*\n\s*CASE WHEN count\(\*\) = 0 THEN 'PASS' ELSE 'FAIL' END/)
  })
})

// ── VERIFY 15 / V9 — required public RLS policies ──────────────────────────
//
// The expected set is PARSED OUT OF THE SHIPPED SQL rather than restated here.
// A hand-copied duplicate would be free to drift from the file it claims to
// model, and every scenario below would keep passing while the real check rotted.
const EXPECTED_POLICIES = (() => {
  const c = code(V15)
  const block = c.match(
    /WITH expected\(tablename, policyname, cmd, permissive, roles, has_using, has_check\) AS \(\s*VALUES([\s\S]*?)\n\),/)
  if (!block) throw new Error('V9 expected-policy VALUES block not found in ' + V15)
  return [...block[1].matchAll(
    /\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(true|false),\s*(true|false)\)/g)]
    .map((m) => ({
      tablename: m[1], policyname: m[2], cmd: m[3], permissive: m[4],
      roles: m[5], hasUsing: m[6] === 'true', hasCheck: m[7] === 'true',
    }))
})()

// Mirrors the V9 CASE ladder, in the same order — the order is load-bearing:
// WRONG_TABLE must be tested before ABSENT, or a moved policy reports as missing.
const policyDefects = (catalog, expected = EXPECTED_POLICIES) => {
  const nameMatches = (n) => catalog.filter((p) => p.policyname === n)
  const out = []
  for (const e of expected) {
    const found = catalog.find((p) => p.tablename === e.tablename && p.policyname === e.policyname)
    const byName = nameMatches(e.policyname)
    let defect = null
    if (!found && byName.length > 0) defect = `WRONG_TABLE (found on ${byName.map((p) => p.tablename).sort()[0]})`
    else if (!found) defect = 'ABSENT'
    else if (byName.length > 1) defect = `DUPLICATE_MATCH (${byName.length} policies share this name)`
    else if (found.permissive !== e.permissive) defect = `WRONG_MODE (is ${found.permissive}, expected ${e.permissive})`
    else if (found.cmd !== e.cmd) defect = `WRONG_COMMAND (is ${found.cmd}, expected ${e.cmd})`
    else if (found.roles !== e.roles) defect = `WRONG_ROLES (is ${found.roles}, expected ${e.roles})`
    else if (found.hasUsing !== e.hasUsing) defect = `USING clause ${e.hasUsing ? 'missing' : 'unexpectedly present'}`
    else if (found.hasCheck !== e.hasCheck) defect = `WITH CHECK clause ${e.hasCheck ? 'missing' : 'unexpectedly present'}`
    if (defect) out.push({ policy: `${e.tablename}.${e.policyname}`, defect })
  }
  return out
}

const LIVE = () => EXPECTED_POLICIES.map((p) => ({ ...p }))
const M22_OVERLAY_TABLES = [
  'farms', 'farm_profiles', 'farm_memberships', 'inventory_batches', 'farmer_documents',
  'farmer_photos', 'farmer_review_requests', 'documents', 'ddp_scores', 'risk_flags', 'status_history',
]
const overlayMissing = (catalog) => M22_OVERLAY_TABLES.filter((t) => !catalog.some((p) =>
  p.tablename === t && p.policyname === `${t}: operational farmer or admin`
  && p.permissive === 'RESTRICTIVE' && p.cmd === 'ALL'))

describe('VERIFY 15 / V9 — required public RLS policies cannot vanish silently', () => {
  it('1. the expected set matches the migration corpus: 63 policies, 12 restrictive', () => {
    expect(EXPECTED_POLICIES).toHaveLength(63)
    expect(EXPECTED_POLICIES.filter((p) => p.permissive === 'RESTRICTIVE')).toHaveLength(12)
  })

  it('2. the live staging catalog (63 in public, 12 restrictive) → PASS', () => {
    expect(policyDefects(LIVE())).toEqual([])
  })

  it('3. legitimate growth — a new table with new policies → still PASS', () => {
    const grown = [...LIVE(),
      { tablename: 'shipments', policyname: 'shipments: admin all', cmd: 'ALL', permissive: 'PERMISSIVE', roles: 'public', hasUsing: true, hasCheck: true },
      { tablename: 'shipments', policyname: 'shipments: operational farmer or admin', cmd: 'ALL', permissive: 'RESTRICTIVE', roles: 'public', hasUsing: true, hasCheck: true }]
    expect(policyDefects(grown)).toEqual([])
  })

  it('4. a permissive policy dropped → ABSENT', () => {
    const c = LIVE().filter((p) => p.policyname !== 'profiles: select own or admin')
    expect(policyDefects(c)).toEqual([{ policy: 'profiles.profiles: select own or admin', defect: 'ABSENT' }])
  })

  it('5. a migration-22 RESTRICTIVE overlay dropped → ABSENT (the privilege escalation)', () => {
    const c = LIVE().filter((p) => p.policyname !== 'farms: operational farmer or admin')
    expect(policyDefects(c)).toEqual([{ policy: 'farms.farms: operational farmer or admin', defect: 'ABSENT' }])
  })

  it('6. the entire restrictive overlay rolled back → all 12 reported, not just a count', () => {
    const c = LIVE().filter((p) => p.permissive !== 'RESTRICTIVE')
    const d = policyDefects(c)
    expect(d).toHaveLength(12)
    expect(d.every((x) => x.defect === 'ABSENT')).toBe(true)
  })

  it('7. a policy moved to another table → WRONG_TABLE, not ABSENT', () => {
    const c = LIVE().map((p) => p.policyname === 'documents: admin all' ? { ...p, tablename: 'ddp_scores' } : p)
    expect(policyDefects(c)).toEqual([
      { policy: 'documents.documents: admin all', defect: 'WRONG_TABLE (found on ddp_scores)' }])
  })

  it('8. the same policy name planted on a second table → DUPLICATE_MATCH', () => {
    const c = [...LIVE(), { ...LIVE().find((p) => p.policyname === 'documents: admin all'), tablename: 'risk_flags' }]
    expect(policyDefects(c)).toEqual([
      { policy: 'documents.documents: admin all', defect: 'DUPLICATE_MATCH (2 policies share this name)' }])
  })

  it('9. a RESTRICTIVE overlay silently downgraded to PERMISSIVE → WRONG_MODE', () => {
    const c = LIVE().map((p) => p.policyname === 'farms: operational farmer or admin'
      ? { ...p, permissive: 'PERMISSIVE' } : p)
    expect(policyDefects(c)).toEqual([{
      policy: 'farms.farms: operational farmer or admin',
      defect: 'WRONG_MODE (is PERMISSIVE, expected RESTRICTIVE)' }])
  })

  it('10. an overlay narrowed from FOR ALL to FOR SELECT → WRONG_COMMAND', () => {
    const c = LIVE().map((p) => p.policyname === 'documents: operational farmer or admin'
      ? { ...p, cmd: 'SELECT' } : p)
    expect(policyDefects(c)).toEqual([{
      policy: 'documents.documents: operational farmer or admin',
      defect: 'WRONG_COMMAND (is SELECT, expected ALL)' }])
  })

  it('11. an admin-only policy widened from authenticated to public → WRONG_ROLES', () => {
    const target = 'procurement_decisions: admin select'
    expect(EXPECTED_POLICIES.find((p) => p.policyname === target).roles).toBe('authenticated')
    const c = LIVE().map((p) => p.policyname === target ? { ...p, roles: 'public' } : p)
    expect(policyDefects(c)).toEqual([{
      policy: `procurement_decisions.${target}`,
      defect: 'WRONG_ROLES (is public, expected authenticated)' }])
  })

  it('12. a USING clause dropped (row filter removed) → reported', () => {
    const c = LIVE().map((p) => p.policyname === 'farms: farmer select own' ? { ...p, hasUsing: false } : p)
    expect(policyDefects(c)).toEqual([
      { policy: 'farms.farms: farmer select own', defect: 'USING clause missing' }])
  })

  it('13. a WITH CHECK dropped (write guard removed) → reported', () => {
    const c = LIVE().map((p) => p.policyname === 'farms: farmer insert own' ? { ...p, hasCheck: false } : p)
    expect(policyDefects(c)).toEqual([
      { policy: 'farms.farms: farmer insert own', defect: 'WITH CHECK clause missing' }])
  })

  it('14. SWAP — drop one policy, add an unrelated one: total unchanged, V9 still FAILS', () => {
    const c = LIVE().filter((p) => p.policyname !== 'risk_flags: operational farmer or admin')
    c.push({ tablename: 'shipments', policyname: 'shipments: admin all', cmd: 'ALL', permissive: 'PERMISSIVE', roles: 'public', hasUsing: true, hasCheck: true })
    expect(c).toHaveLength(63)                       // a restored `policies = 63` would PASS here
    expect(policyDefects(c)).toEqual([
      { policy: 'risk_flags.risk_flags: operational farmer or admin', defect: 'ABSENT' }])
  })

  it('15. the unapplied FARM_RESAVE draft half is excluded; the applied half is required', () => {
    const names = EXPECTED_POLICIES.map((p) => p.policyname)
    expect(names).toContain('farms: farmer update own')            // migration 19 depends on it
    expect(names).not.toContain('farm_profiles: farmer update own') // never applied
  })

  it('16. V9a — a missing overlay table is NAMED, and a downgraded one still fails', () => {
    expect(overlayMissing(LIVE())).toEqual([])
    expect(overlayMissing(LIVE().filter((p) => p.policyname !== 'ddp_scores: operational farmer or admin')))
      .toEqual(['ddp_scores'])
    const downgraded = LIVE().map((p) => p.policyname === 'status_history: operational farmer or admin'
      ? { ...p, permissive: 'PERMISSIVE' } : p)
    expect(overlayMissing(downgraded)).toEqual(['status_history'])
  })
})

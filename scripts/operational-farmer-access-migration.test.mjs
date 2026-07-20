// Static regression guard for migration 22 — the operational-farmer RLS overlay.
// Reads the SQL (and the routing source) as text and locks in the properties
// that make the overlay correct and safe, so a future edit cannot silently
// weaken it or start rewriting the existing permissive policies. The live
// behavioural proof lives in 21_..._VERIFY.sql and the staging security suite.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const HARD = strip(read('22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql'))
const VERIFY = strip(read('22_OPERATIONAL_FARMER_ACCESS_RLS_VERIFY.sql'))
const ROLLBACK = strip(read('22_OPERATIONAL_FARMER_ACCESS_RLS_ROLLBACK.sql'))
const ROUTING = read('src/lib/postLoginRouting.ts')

// Every anonymous DO block in a script, matched on its own dollar-quote tag.
function doBlocks(sql) {
  return sql.match(/\bDO\s+(\$[A-Za-z_]*\$)[\s\S]*?\1/gi) || []
}
// Section C is the 11-table overlay check. Isolating it matters: sections C and
// D assert on similarly named locals with similar predicate text, so a generic
// substring search over the whole VERIFY file stays green even if section C is
// deleted outright. Every section-C assertion below runs against THIS slice.
const VERIFY_SECTION_C = doBlocks(VERIFY).find((b) => b.includes('VERIFY C FAILED')) ?? ''

// PL/pgSQL RAISE format strings interpolate with a bare `%`; `%s` is C/printf
// syntax and is silently WRONG here — it emits a literal "s" after the
// substituted value, or, when it is the last placeholder, shifts every argument
// by one. Scan RAISE statements only: `%` is also a LIKE wildcard, and the
// VERIFY file legitimately contains patterns such as '%search_path%' whose text
// includes the characters "%s".
function malformedRaisePlaceholders(sql) {
  const found = []
  for (const stmt of sql.match(/\bRAISE\s+(?:EXCEPTION|NOTICE|WARNING|INFO|LOG|DEBUG)\b[\s\S]*?;/gi) || []) {
    for (const [literal] of stmt.matchAll(/'(?:[^']|'')*'/g)) {
      // A literal both starting and ending with % is a LIKE pattern, not a
      // format string — those are the valid `%` uses we must not flag.
      if (/^'%[\s\S]*%'$/.test(literal)) continue
      if (/%s/.test(literal)) found.push(literal)
    }
  }
  return found
}

// The exact audited farmer-operated tables (must all be covered).
const AUDITED_TABLES = [
  'farms', 'farm_profiles', 'farm_memberships', 'inventory_batches',
  'farmer_documents', 'farmer_photos', 'farmer_review_requests',
  'documents', 'ddp_scores', 'risk_flags', 'status_history',
]
// Existing permissive/admin policy fragments migration 22 must NOT touch.
const EXISTING_POLICY_FRAGMENTS = [
  'farmer insert own', 'farmer update own', 'farmer select own',
  'farmer upload own', 'farmer resolve own', 'admin all',
]

describe('migration 22 helper — database-backed farmer role check', () => {
  it('reads role from public.profiles (not JWT metadata)', () => {
    expect(HARD).toMatch(/FROM\s+public\.profiles[\s\S]*role\s*=\s*'farmer'/i)
    expect(HARD).not.toMatch(/raw_user_meta_data|request\.jwt|jwt[\s\S]{0,20}role/i)
  })

  it('is SECURITY DEFINER, STABLE, pinned search_path, least-privilege grants', () => {
    expect(HARD).toMatch(/CREATE OR REPLACE FUNCTION public\.has_operational_farmer_access\(\)/)
    expect(HARD).toMatch(/SECURITY DEFINER/)
    expect(HARD).toMatch(/\bSTABLE\b/)
    expect(HARD).toMatch(/SET search_path\s*=\s*public, auth, pg_temp/)
    expect(HARD).toMatch(/REVOKE EXECUTE ON FUNCTION public\.has_operational_farmer_access\(\) FROM anon/)
    expect(HARD).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.has_operational_farmer_access\(\) TO authenticated/)
  })
})

describe('migration 22 restrictive overlay', () => {
  it('covers every audited farmer table', () => {
    for (const t of AUDITED_TABLES) expect(HARD).toContain(`'${t}'`)
  })

  it('creates AS RESTRICTIVE FOR ALL policies gated on helper OR admin, both USING and WITH CHECK', () => {
    expect(HARD).toMatch(/AS RESTRICTIVE FOR ALL/)
    expect(HARD).toMatch(/USING \(public\.has_operational_farmer_access\(\) OR public\.is_ddp_admin\(\)\)/)
    expect(HARD).toMatch(/WITH CHECK \(public\.has_operational_farmer_access\(\) OR public\.is_ddp_admin\(\)\)/)
  })

  it('OVERLAYS — never recreates or drops an existing permissive/admin farmer policy', () => {
    for (const frag of EXISTING_POLICY_FRAGMENTS) expect(HARD).not.toContain(frag)
    // The only policy identifier it manages is its own overlay name.
    expect(HARD).toContain('operational farmer or admin')
  })

  it('scopes the storage policy to only the two farmer buckets', () => {
    expect(HARD).toMatch(/ON storage\.objects/)
    expect(HARD).toMatch(/bucket_id IS DISTINCT FROM 'farmer-documents'/)
    expect(HARD).toMatch(/bucket_id IS DISTINCT FROM 'farmer-photos'/)
  })

  it('tests bucket_id NULL-safely, so unrelated buckets are never denied', () => {
    // bucket_id is nullable. Under a RESTRICTIVE policy `NULL NOT IN (...)`
    // evaluates to NULL, which denies — making any NULL-bucket row inaccessible
    // to every non-farmer, non-admin caller. That is an availability regression
    // on precisely the buckets this policy promises to leave alone.
    expect(HARD).not.toMatch(/bucket_id NOT IN/)
  })

  it('guards storage.objects DDL with an ownership precondition', () => {
    // CREATE POLICY on storage.objects requires ownership of it (Supabase:
    // supabase_storage_admin). This file is ONE transaction, so failing that
    // check at the storage statement would roll back the 11-table overlay too.
    // The precondition must therefore run BEFORE any DDL in this file, and the
    // owner must be read from the catalog rather than hardcoded.
    expect(HARD).toMatch(/pg_has_role\(current_user/)
    expect(HARD).toMatch(/pg_get_userbyid\(c\.relowner\)/)
    expect(HARD.indexOf('pg_has_role')).toBeLessThan(HARD.indexOf('ON storage.objects'))
  })

  it('gates market_price_benchmarks with a restrictive FOR SELECT policy (narrowest command)', () => {
    // The only pending exposure is the SELECT read; there is no farmer write
    // policy, so FOR SELECT (not FOR ALL) is the narrowest correct control.
    expect(HARD).toMatch(/ON public\.market_price_benchmarks\s+AS RESTRICTIVE\s+FOR SELECT/)
    expect(HARD).toMatch(/CREATE POLICY "market_price_benchmarks: operational farmer or admin"[\s\S]*USING \(public\.has_operational_farmer_access\(\) OR public\.is_ddp_admin\(\)\)/)
    // Enable RLS on it; do not touch its existing permissive "farmer select visible" policy.
    expect(HARD).toMatch(/ALTER TABLE public\.market_price_benchmarks ENABLE ROW LEVEL SECURITY/)
  })
})

describe('migration 22 verify proves the enforcement', () => {
  it('checks RESTRICTIVE + FOR ALL + RLS + anon-revoked + behaviour + no-drop', () => {
    expect(VERIFY).toMatch(/RESTRICTIVE/)
    expect(VERIFY).toMatch(/relrowsecurity/)
    expect(VERIFY).toMatch(/has_function_privilege\('anon'/)
    expect(VERIFY).toMatch(/pending identity/i)
    expect(VERIFY).toMatch(/farmer insert own/) // proves pre-existing policy still present
    expect(VERIFY).toMatch(/ROLLBACK\s*;?\s*$/m)
  })

  it('asserts the EFFECTIVE PREDICATE in SECTION C itself, not just somewhere in the file', () => {
    // Without these, a policy created `AS RESTRICTIVE FOR ALL USING (true)
    // WITH CHECK (true)` — a complete no-op — passes every other assertion.
    // Scoped to the section-C DO block: section D asserts on identically named
    // locals with near-identical predicate text, so a file-wide substring match
    // would stay green with section C deleted entirely.
    expect(VERIFY_SECTION_C).not.toBe('')
    expect(VERIFY_SECTION_C).toMatch(/SELECT permissive, cmd, qual, with_check/)

    // The two failure messages unique to section C's predicate enforcement.
    expect(VERIFY_SECTION_C).toMatch(/VERIFY C FAILED: % policy USING does not gate on/)
    expect(VERIFY_SECTION_C).toMatch(/VERIFY C FAILED: % policy WITH CHECK does not gate on/)

    // USING (qual) is checked against BOTH authorization helpers, and a NULL
    // qual — an unconditional policy — is rejected rather than read as absent.
    expect(VERIFY_SECTION_C).toMatch(/v_qual IS NULL/)
    expect(VERIFY_SECTION_C).toMatch(/v_qual NOT LIKE '%has_operational_farmer_access%'/)
    expect(VERIFY_SECTION_C).toMatch(/v_qual NOT LIKE '%is_ddp_admin%'/)

    // WITH CHECK (with_check) governs writes and must be held to the same bar.
    expect(VERIFY_SECTION_C).toMatch(/v_check IS NULL/)
    expect(VERIFY_SECTION_C).toMatch(/v_check NOT LIKE '%has_operational_farmer_access%'/)
    expect(VERIFY_SECTION_C).toMatch(/v_check NOT LIKE '%is_ddp_admin%'/)
  })

  it('applies section C to all eleven public tables', () => {
    // The predicate enforcement above is only worth as much as its coverage:
    // the loop it runs inside must iterate every audited table.
    for (const t of AUDITED_TABLES) expect(VERIFY_SECTION_C).toContain(`'${t}'`)
    expect(VERIFY_SECTION_C).toMatch(/FOREACH t IN ARRAY tables LOOP/)
  })

  it('has no malformed %s RAISE placeholders in the migration 22 SQL', () => {
    // `%s` in a PL/pgSQL RAISE either appends a stray "s" or shifts every
    // subsequent argument — the diagnostic lies at exactly the moment it is
    // needed. See malformedRaisePlaceholders() for why this is scoped to RAISE.
    expect(malformedRaisePlaceholders(HARD)).toEqual([])
    expect(malformedRaisePlaceholders(VERIFY)).toEqual([])
    expect(malformedRaisePlaceholders(ROLLBACK)).toEqual([])
  })

  it('distinguishes a malformed %s placeholder from a valid % placeholder', () => {
    // Guards the detector itself: if it flagged everything, or nothing, the
    // assertion above would be worthless.
    expect(malformedRaisePlaceholders(`RAISE EXCEPTION 'boom %s', t;`))
      .toEqual([`'boom %s'`])
    // Valid PL/pgSQL substitution — a bare %.
    expect(malformedRaisePlaceholders(`RAISE EXCEPTION 'boom %', t;`)).toEqual([])
    // A LIKE pattern that happens to contain the characters "%s".
    expect(malformedRaisePlaceholders(`RAISE EXCEPTION 'nope' WHEN x LIKE '%search_path%';`)).toEqual([])
    // %s outside any RAISE is a LIKE wildcard, not a format-string defect.
    expect(malformedRaisePlaceholders(`IF x NOT LIKE '%search_path%' THEN NULL; END IF;`)).toEqual([])
  })

  it('checks the storage policy WITH CHECK, which governs uploads', () => {
    // A correct USING with a missing WITH CHECK leaves pending WRITES unguarded
    // while passing every read-side assertion.
    expect(VERIFY).toMatch(/storage policy WITH CHECK is missing or does not match/)
  })

  it('performs a real denied write, with a control that makes it attributable', () => {
    // The catalog sections cannot prove a policy denies anything. Section G
    // must (a) run as a non-owner role, since RLS is bypassed for the owner,
    // (b) admit the farmer first, so the pending denial is attributable to the
    // overlay rather than to a missing grant or a CHECK constraint.
    expect(VERIFY).toMatch(/SET LOCAL ROLE authenticated/)
    expect(VERIFY).toMatch(/VERIFY G FAILED: the farmer identity could not insert/)
    expect(VERIFY).toMatch(/WHEN insufficient_privilege THEN/)
    expect(VERIFY).toMatch(/VERIFY G FAILED: a pending identity successfully INSERTed/)
    // A non-RLS failure must be reported as inconclusive, never as a denial.
    expect(VERIFY).toMatch(/VERIFY G INCONCLUSIVE/)
  })
})

describe('migration 22 rollback removes only its own objects', () => {
  it('drops the overlay policies + helper and nothing else, and never disables RLS', () => {
    expect(ROLLBACK).toContain('operational farmer or admin')
    expect(ROLLBACK).toMatch(/DROP FUNCTION IF EXISTS public\.has_operational_farmer_access\(\)/)
    for (const frag of EXISTING_POLICY_FRAGMENTS) expect(ROLLBACK).not.toContain(frag)
    expect(ROLLBACK).not.toMatch(/DISABLE ROW LEVEL SECURITY/)
  })
})

describe('login routing is unchanged by this migration', () => {
  it('pending denied; ddp_admin and farmer routes intact', () => {
    expect(ROUTING).toMatch(/case 'pending':[\s\S]*denied/)
    expect(ROUTING).toMatch(/case 'ddp_admin':[\s\S]*ddp-overview/)
    expect(ROUTING).toMatch(/case 'farmer':[\s\S]*farmer-dashboard/)
  })
})

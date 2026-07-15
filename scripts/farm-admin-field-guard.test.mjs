// Static regression guard for migration 19 — the farm admin-field self-approval
// guard. These assertions read the SQL files as text (they cannot run against a
// database in CI) and lock in the properties that make the guard correct, so a
// future edit cannot silently weaken it. The live behavioural proof lives in
// 19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql (Sections B), run against a database.
//
// It lives in scripts/ (.mjs) rather than src/ because reading from disk needs
// node types the app tsconfig deliberately does not expose to src — matching
// scripts/migration-17-decision-set.test.mjs.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')

// Comment-stripped views so keywords quoted in explanatory prose (e.g. the header
// that literally discusses `role = 'admin'`) can never be read as code.
const stripComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const FORWARD = '19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql'
const VERIFY = '19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql'
const ROLLBACK = '19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql'

// Admin-controlled columns, enumerated from schema (SUPABASE_SCHEMA.sql:20-25 +
// AUTH_RLS_SCHEMA.sql:38-39). Drift here is the exact defect this test catches.
const PROTECTED_COLUMNS = [
  'status', 'compliance_status', 'export_readiness',
  'risk_level', 'partner_tier', 'reviewed_by', 'created_by',
]

describe('migration 19 — forward migration (guard function + trigger)', () => {
  const raw = read(FORWARD)
  const code = stripComments(raw)

  it('delegates the admin decision to the canonical is_ddp_admin() predicate', () => {
    expect(code).toMatch(/is_ddp_admin\s*\(/i)
  })

  it('carries no invalid role = \'admin\' literal (the original bug)', () => {
    expect(code).not.toMatch(/role\s*=\s*'admin'/i)
  })

  it('preserves every admin-controlled column for non-admins', () => {
    for (const col of PROTECTED_COLUMNS) {
      expect(code, `column ${col} must be preserved (new.${col} := old.${col})`)
        .toMatch(new RegExp(`new\\.${col}\\s*:=\\s*old\\.${col}`, 'i'))
    }
  })

  it('protects exactly the enumerated columns on UPDATE — no drift in the assignment set', () => {
    const assigned = [...code.matchAll(/new\.([a-z_]+)\s*:=\s*old\./gi)].map((m) => m[1].toLowerCase())
    expect([...new Set(assigned)].sort()).toEqual([...PROTECTED_COLUMNS].sort())
  })

  it('installs a BEFORE INSERT OR UPDATE row trigger on public.farms bound to the guard', () => {
    expect(code).toMatch(/create\s+trigger\s+trg_protect_farm_admin_fields\s+before\s+insert\s+or\s+update\s+on\s+public\.farms/is)
    expect(code).toMatch(/execute\s+function\s+public\.fn_protect_farm_admin_fields\s*\(\s*\)/is)
  })

  it('has a farmer-INSERT branch that forces created_by and neutralises every protected field', () => {
    expect(code, 'must branch on TG_OP for INSERT').toMatch(/tg_op\s*=\s*'insert'/i)
    // created_by anchored to the caller (cannot be spoofed); status pinned to the
    // proven farmer entry value; the other five neutralised to NULL.
    expect(code).toMatch(/new\.created_by\s*:=\s*auth\.uid\(\)/i)
    expect(code).toMatch(/new\.status\s*:=\s*'Submitted to DDP'/i)
    for (const col of ['reviewed_by', 'compliance_status', 'export_readiness', 'risk_level', 'partner_tier']) {
      expect(code, `INSERT must set new.${col} := null`).toMatch(new RegExp(`new\\.${col}\\s*:=\\s*null`, 'i'))
    }
  })

  it('is SECURITY DEFINER with a fixed search_path', () => {
    expect(code).toMatch(/security\s+definer/i)
    expect(code).toMatch(/set\s+search_path\s*=\s*public\s*,\s*pg_temp/i)
  })

  it('revokes direct execution from PUBLIC and anon (least privilege)', () => {
    expect(code).toMatch(/revoke\s+execute\s+on\s+function\s+public\.fn_protect_farm_admin_fields\s*\(\s*\)\s+from\s+[^;]*\bpublic\b/i)
    expect(code).toMatch(/revoke\s+execute\s+on\s+function\s+public\.fn_protect_farm_admin_fields\s*\(\s*\)\s+from\s+[^;]*\banon\b/i)
  })

  it('declares the deliberate no-grant ACL decision (trigger-only function)', () => {
    expect(raw).toMatch(/acl-no-grant:\s*fn_protect_farm_admin_fields/i)
  })
})

describe('migration 19 — verification script', () => {
  const raw = read(VERIFY)
  const code = stripComments(raw)

  it('uses BEGIN/ROLLBACK and contains no COMMIT', () => {
    expect(code).toMatch(/\bbegin\b/i)
    expect(code).toMatch(/\brollback\b/i)
    expect(code).not.toMatch(/\bcommit\b/i)
  })

  it('exercises a real UPDATE and a real INSERT against public.farms (non-vacuous behaviour)', () => {
    expect(code).toMatch(/update\s+public\.farms\s+set/i)
    expect(code).toMatch(/insert\s+into\s+public\.farms/i)
  })

  it('has both a farmer-INSERT test and an admin-INSERT test', () => {
    expect(code, 'farmer-INSERT test (B5) with created_by anti-spoof assertion').toMatch(/verify b5/i)
    expect(code).toMatch(/created_by not forced/i)
    expect(code, 'admin-INSERT test (B6)').toMatch(/verify b6/i)
  })

  it('asserts each protected column behaviourally', () => {
    for (const col of PROTECTED_COLUMNS) {
      expect(code, `VERIFY must reference protected column ${col}`)
        .toMatch(new RegExp(`\\b${col}\\b`, 'i'))
    }
  })

  it('has explicit RAISE assertions and a residue check covering inserted rows and auth.users', () => {
    expect(code).toMatch(/raise\s+exception/i)      // real assertions, not silent selects
    expect(code).toMatch(/residue/i)
    const residueTail = code.slice(code.lastIndexOf('rollback;'))
    expect(residueTail, 'residue must cover seeded auth.users').toMatch(/leftover_auth_users/i)
    expect(residueTail, 'residue must cover the farmer-INSERT row').toContain('000fa000-0000-0000-0000-000000000003')
    expect(residueTail, 'residue must cover the admin-INSERT row').toContain('000fa000-0000-0000-0000-000000000004')
  })
})

describe('migration 19 — rollback script', () => {
  const raw = read(ROLLBACK)
  const code = stripComments(raw)

  it('drops the trigger and the function', () => {
    expect(code).toMatch(/drop\s+trigger\s+if\s+exists\s+trg_protect_farm_admin_fields\s+on\s+public\.farms/i)
    expect(code).toMatch(/drop\s+function\s+if\s+exists\s+public\.fn_protect_farm_admin_fields/i)
  })

  it('does NOT drop the farmer-update RLS policy (scope discipline)', () => {
    expect(code).not.toMatch(/drop\s+policy[^;]*farms: farmer update own/i)
  })
})

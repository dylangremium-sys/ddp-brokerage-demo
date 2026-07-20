// Static regression guard for migration 21 — DDP-controlled farmer provisioning.
// These assertions read the SQL (and the auth service) as text — they cannot run
// against a database in CI — and lock in the properties that make the fix
// correct, so a future edit cannot silently reopen public self-provisioning.
// The live behavioural proof lives in 20_..._VERIFY.sql, run against a database.
//
// Lives in scripts/ (.mjs) because reading from disk needs node types the app
// tsconfig deliberately withholds from src (matches farm-admin-field-guard.test.mjs).

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')

// Strip comments so keywords quoted in explanatory prose are never read as code.
const stripComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const HARDENING = stripComments(read('21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql'))
const VERIFY = stripComments(read('21_DDP_CONTROLLED_FARMER_PROVISIONING_VERIFY.sql'))
const ROLLBACK = stripComments(read('21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql'))
// Raw text retained: the rollback's ORDERING REQUIREMENT is documentation, and
// documentation is the entire mitigation for a hazard SQL cannot enforce.
const ROLLBACK_RAW = read('21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql')
const AUTH_TS = read('src/services/auth.ts')

// Extract the body of the recreated handle_new_user() function from a script.
function triggerBody(sql) {
  const m = sql.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$\$;/i)
  return m ? m[0] : ''
}

const norm = (s) => s.replace(/\s+/g, ' ')

describe('migration 21 — hardening blocks self-provisioning at the DB', () => {
  it('recreates handle_new_user to stamp new users as pending, not farmer', () => {
    const body = triggerBody(HARDENING)
    expect(body).not.toBe('')
    expect(body).toMatch(/'pending'/)
    // The trigger body itself must not assign the operational farmer role.
    expect(body).not.toMatch(/'farmer'/)
  })

  it('widens the role CHECK to include pending', () => {
    expect(norm(HARDENING)).toMatch(/role IN \('ddp_admin', 'farmer', 'pending'\)/)
  })

  it('makes pending the new column default', () => {
    expect(norm(HARDENING)).toMatch(/ALTER COLUMN role SET DEFAULT 'pending'/)
  })

  it('enables RLS and asserts the three role-guard policies (admin-only role change)', () => {
    expect(HARDENING).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(HARDENING).toContain('"profiles: select own or admin"')
    expect(HARDENING).toContain('"profiles: update own no role change"')
    expect(HARDENING).toContain('"profiles: admin update role"')
    // The role-change path is gated on ddp_admin.
    expect(norm(HARDENING)).toMatch(/"profiles: admin update role"[\s\S]*?USING \(public\.is_ddp_admin\(\)\)/)
  })

  it('keeps the trigger callable only by the trigger mechanism (not client roles)', () => {
    expect(norm(HARDENING)).toMatch(/REVOKE EXECUTE ON FUNCTION public\.handle_new_user\(\) FROM PUBLIC, anon, authenticated/)
  })
})

describe('migration 21 — verify proves the enforcement', () => {
  it('asserts a brand-new auth user is pending and fails loudly otherwise', () => {
    expect(VERIFY).toMatch(/expected pending/i)
    expect(VERIFY).toMatch(/RAISE EXCEPTION/i)
  })

  it('checks RLS is enabled and the role-guard policies exist', () => {
    expect(VERIFY).toMatch(/relrowsecurity/i)
    expect(VERIFY).toMatch(/pg_policies/i)
  })

  it('guards real data and leaves no residue (precondition + ROLLBACK)', () => {
    expect(VERIFY).toMatch(/PRECONDITION FAILED/i)
    expect(VERIFY).toMatch(/ROLLBACK/i)
  })
})

describe('migration 21 — rollback is a true inverse', () => {
  it('restores the farmer auto-assignment in handle_new_user', () => {
    expect(triggerBody(ROLLBACK)).toMatch(/'farmer'/)
  })

  it('restores the two-value role CHECK and farmer default', () => {
    expect(norm(ROLLBACK)).toMatch(/role IN \('ddp_admin', 'farmer'\)/)
    expect(norm(ROLLBACK)).toMatch(/ALTER COLUMN role SET DEFAULT 'farmer'/)
    expect(norm(ROLLBACK)).not.toMatch(/'pending'/)
  })

  it('states that migration 22 must be rolled back FIRST', () => {
    // Restoring the 'farmer' default makes has_operational_farmer_access() true
    // for every self-signed-up account, which reduces migration 22's overlay to
    // a no-op while its policies remain in the catalog looking applied. Nothing
    // in SQL can prevent running these out of order, so the warning is the
    // control — and an untested warning is one edit away from disappearing.
    expect(ROLLBACK_RAW).toMatch(/ORDERING REQUIREMENT/)
    expect(ROLLBACK_RAW).toMatch(/roll back migration 22 BEFORE this file/i)
    expect(ROLLBACK_RAW).toMatch(/no-op/i)
  })
})

describe('auth service no longer self-assigns the farmer role', () => {
  it('signUpFarmer does not write role: farmer from the client', () => {
    expect(AUTH_TS).not.toMatch(/role:\s*'farmer'/)
  })

  it('exposes an admin-only provisioning path instead', () => {
    expect(AUTH_TS).toMatch(/export (async )?function provisionFarmer/)
    expect(AUTH_TS).toMatch(/export (async )?function listPendingProfiles/)
  })
})

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { definesFarmGuard, findUnexpectedGuardRedefinitions, findUnguardedHandleNewUserDowngrades } from './guardRedefinition.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const CANONICAL = '19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql'
const TOKEN = 'ACL-TEST-EXEMPT: INTENTIONAL-DRAFT'

describe('definesFarmGuard', () => {
  it('matches a real CREATE [OR REPLACE] FUNCTION of the guard, with or without the schema qualifier', () => {
    expect(definesFarmGuard('CREATE OR REPLACE FUNCTION public.fn_protect_farm_admin_fields()')).toBe(true)
    expect(definesFarmGuard('create function fn_protect_farm_admin_fields ( )')).toBe(true)
  })
  it('does NOT match a mere reference, revoke, drop, or trigger binding', () => {
    expect(definesFarmGuard('REVOKE EXECUTE ON FUNCTION public.fn_protect_farm_admin_fields() FROM authenticated;')).toBe(false)
    expect(definesFarmGuard('DROP FUNCTION IF EXISTS public.fn_protect_farm_admin_fields();')).toBe(false)
    expect(definesFarmGuard('CREATE TRIGGER t BEFORE INSERT ON public.farms EXECUTE FUNCTION public.fn_protect_farm_admin_fields();')).toBe(false)
  })
  it('does NOT match the guard name inside a comment', () => {
    expect(definesFarmGuard('-- CREATE OR REPLACE FUNCTION public.fn_protect_farm_admin_fields() would be a downgrade')).toBe(false)
  })
})

describe('findUnexpectedGuardRedefinitions', () => {
  const opts = { canonicalFile: CANONICAL, exemptionToken: TOKEN }

  it('allows the canonical file to define the guard', () => {
    const files = [{ name: CANONICAL, body: 'CREATE OR REPLACE FUNCTION public.fn_protect_farm_admin_fields() ...' }]
    expect(findUnexpectedGuardRedefinitions(files, opts)).toEqual([])
  })

  it('allows a token-exempt draft to redefine the guard', () => {
    const files = [{ name: 'FARM_RESAVE_PERSISTENCE_MIGRATION.sql', body: `-- ${TOKEN}\nCREATE OR REPLACE FUNCTION public.fn_protect_farm_admin_fields() ...` }]
    expect(findUnexpectedGuardRedefinitions(files, opts)).toEqual([])
  })

  it('FLAGS a non-canonical file that redefines the guard WITHOUT the exemption token (the downgrade the audit exposed)', () => {
    const files = [
      { name: CANONICAL, body: 'CREATE OR REPLACE FUNCTION public.fn_protect_farm_admin_fields() -- hardened' },
      { name: '25_SNEAKY_DOWNGRADE.sql', body: "CREATE OR REPLACE FUNCTION public.fn_protect_farm_admin_fields() ... role = 'admin' ... BEFORE UPDATE" },
    ]
    expect(findUnexpectedGuardRedefinitions(files, opts)).toEqual(['25_SNEAKY_DOWNGRADE.sql'])
  })

  it('does not flag files that only reference the guard', () => {
    const files = [
      { name: '20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql', body: 'REVOKE EXECUTE ON FUNCTION public.fn_protect_farm_admin_fields() FROM authenticated;' },
      { name: '19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql', body: 'SELECT public.fn_protect_farm_admin_fields IS NOT NULL;' },
    ]
    expect(findUnexpectedGuardRedefinitions(files, opts)).toEqual([])
  })
})

// Integration: the REAL gate must pass on the REAL corpus (proves Check 13 is
// green today), and its exit code is trustworthy.
describe('check-security-migrations gate (integration, real corpus)', () => {
  it('passes on the current repository', () => {
    const out = execFileSync('node', [join(REPO_ROOT, 'scripts', 'check-security-migrations.mjs')], { encoding: 'utf8' })
    expect(out).toMatch(/No unexpected redefinition of fn_protect_farm_admin_fields/)
    expect(out).toMatch(/RESULT: PASS/)
  })
})

describe('findUnguardedHandleNewUserDowngrades (DDP audit A2)', () => {
  const ROLLBACK_21 = '21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql'
  const opts = { allowedRollbackFile: ROLLBACK_21 }
  const GUARD = "DO $g$ BEGIN IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'handle_new_user' AND p.prosrc LIKE '%''pending''%') THEN RAISE EXCEPTION 'refused'; END IF; END $g$;"

  it('FLAGS a farmer-minting definition with no downgrade guard', () => {
    const files = [{ name: 'BASELINE.sql', body: "CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.profiles(id, role) VALUES (NEW.id, 'farmer'); RETURN NEW; END $$;" }]
    expect(findUnguardedHandleNewUserDowngrades(files, opts)).toEqual(['BASELINE.sql'])
  })

  it('does NOT flag the same definition once it carries the downgrade guard', () => {
    const files = [{ name: 'BASELINE.sql', body: `${GUARD}\nCREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.profiles(id, role) VALUES (NEW.id, 'farmer'); RETURN NEW; END $$;` }]
    expect(findUnguardedHandleNewUserDowngrades(files, opts)).toEqual([])
  })

  it('does NOT flag the hardened pending-minting definition', () => {
    const files = [{ name: '21_HARDENING.sql', body: "CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.profiles(id, role) VALUES (NEW.id, 'pending'); RETURN NEW; END $$;\nALTER TABLE public.profiles ADD CONSTRAINT c CHECK (role IN ('ddp_admin','farmer','pending'));" }]
    expect(findUnguardedHandleNewUserDowngrades(files, opts)).toEqual([])
  })

  it('exempts migration 21 own rollback (restoring farmer is its documented purpose)', () => {
    const files = [{ name: ROLLBACK_21, body: "CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.profiles(id, role) VALUES (NEW.id, 'farmer'); RETURN NEW; END $$;" }]
    expect(findUnguardedHandleNewUserDowngrades(files, opts)).toEqual([])
  })

  it('the real corpus has no unguarded downgrade path', () => {
    const files = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.sql'))
      .map((f) => ({ name: f, body: readFileSync(join(REPO_ROOT, f), 'utf8') }))
    expect(findUnguardedHandleNewUserDowngrades(files, opts)).toEqual([])
  })
})

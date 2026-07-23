import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHardeningProblems, findVerifyProblems, findRollbackProblems } from './auditLogActorMigration.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8')

const HARDENING = '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql'
const VERIFY = '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_VERIFY.sql'
const ROLLBACK = '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_ROLLBACK.sql'

// The real files must be sound...
describe('migration 25 — the real files pass', () => {
  it('HARDENING has no problems', () => expect(findHardeningProblems(read(HARDENING))).toEqual([]))
  it('VERIFY has no problems', () => expect(findVerifyProblems(read(VERIFY))).toEqual([]))
  it('ROLLBACK has no problems', () => expect(findRollbackProblems(read(ROLLBACK))).toEqual([]))
})

// ...and — the part that actually matters — the checks must CATCH a weakened one.
// Each case takes the REAL file and degrades exactly one property.
describe('migration 25 — checks catch a weakened migration (negative coverage)', () => {
  const hardening = read(HARDENING)

  it('catches removal of the auth.uid() override (the whole point of the migration)', () => {
    const weakened = hardening.replace(/NEW\.actor_id := auth\.uid\(\);/, 'NEW.actor_id := NEW.actor_id;')
    expect(findHardeningProblems(weakened)).toContain('does not force NEW.actor_id := auth.uid() (client value not overridden)')
  })

  it('catches an unpinned search_path on the trigger function', () => {
    const weakened = hardening.replace(/SET search_path = public, auth, pg_temp\n/, '')
    expect(findHardeningProblems(weakened)).toContain('trigger function has no pinned search_path')
  })

  it('catches the trigger being changed away from BEFORE INSERT', () => {
    const weakened = hardening.replace(/BEFORE INSERT ON public\.compliance_audit_log/i, 'AFTER INSERT ON public.compliance_audit_log')
    expect(findHardeningProblems(weakened)).toContain('trigger is not BEFORE INSERT on public.compliance_audit_log')
  })

  it('catches the EXECUTE revoke being dropped (function left client-callable)', () => {
    const weakened = hardening.replace(/REVOKE EXECUTE ON FUNCTION public\.fn_compliance_audit_log_set_actor\(\)[^;]*;/, '')
    expect(findHardeningProblems(weakened)).toContain('does not revoke EXECUTE from authenticated (client-callable)')
  })

  it('catches scope creep into RLS policies', () => {
    const weakened = hardening + '\nCREATE POLICY "sneaky" ON public.compliance_audit_log FOR SELECT USING (true);'
    expect(findHardeningProblems(weakened)).toContain('changes an RLS policy (out of scope)')
  })

  it('catches a VERIFY that stops exercising a forged actor_id', () => {
    const weakened = read(VERIFY).replace(/victim/g, 'other')
    expect(findVerifyProblems(weakened)).toContain('VERIFY does not exercise a forged (different) actor_id')
  })

  it('catches a VERIFY that COMMITs its fixture (not rollback-safe)', () => {
    const weakened = read(VERIFY).replace(/\nrollback;/, '\ncommit;')
    expect(findVerifyProblems(weakened)).toContain('VERIFY contains COMMIT (must be BEGIN/ROLLBACK only)')
  })

  it('catches a ROLLBACK that leaves the trigger behind', () => {
    const weakened = read(ROLLBACK).replace(/DROP TRIGGER IF EXISTS compliance_audit_log_set_actor[^;]*;/, '')
    expect(findRollbackProblems(weakened)).toContain('does not drop the trigger')
  })

  it('catches a ROLLBACK that overreaches into migration 9 objects', () => {
    const weakened = read(ROLLBACK) + '\nDROP TABLE public.compliance_audit_log;'
    expect(findRollbackProblems(weakened)).toContain('drops the table/policy/append-only trigger (overreach)')
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasExecutablePendingGuard, findAnonAuditLogWriteGrants, hasRlsFullRollbackOptIn, findUnguardedTargetedRlsDisables, findUnguardedDestructiveRollbacks } from './rollbackSafety.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8')

describe('hasExecutablePendingGuard (DDP audit A3)', () => {
  it('does NOT accept a precondition that is only documented in a comment', () => {
    const commentOnly = `-- PRECONDITION: no profile rows may have role = 'pending' when this runs.\nBEGIN;\nALTER TABLE public.profiles ADD CONSTRAINT c CHECK (role IN ('ddp_admin','farmer'));\nCOMMIT;`
    expect(hasExecutablePendingGuard(commentOnly)).toBe(false)
  })

  it('accepts an executable guard that tests for pending rows and RAISEs', () => {
    const enforced = `BEGIN;\nDO $g$ DECLARE n int; BEGIN\n  SELECT count(*) INTO n FROM public.profiles WHERE role = 'pending';\n  IF n > 0 THEN RAISE EXCEPTION 'refused: % pending', n; END IF;\nEND $g$;\nCOMMIT;`
    expect(hasExecutablePendingGuard(enforced)).toBe(true)
  })

  it('the real migration-21 rollback enforces it', () => {
    expect(hasExecutablePendingGuard(read('21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql'))).toBe(true)
  })
})

describe('findAnonAuditLogWriteGrants (DDP audit A4)', () => {
  it('FLAGS a rollback that re-grants UPDATE/DELETE on the audit log to anon', () => {
    const files = [{ name: 'R.sql', body: 'GRANT UPDATE, DELETE ON TABLE public.compliance_audit_log TO anon, authenticated;' }]
    expect(findAnonAuditLogWriteGrants(files)).toEqual([{ file: 'R.sql', privileges: 'UPDATE, DELETE' }])
  })

  it('allows the same grant to authenticated only', () => {
    const files = [{ name: 'R.sql', body: 'GRANT UPDATE, DELETE ON TABLE public.compliance_audit_log TO authenticated;' }]
    expect(findAnonAuditLogWriteGrants(files)).toEqual([])
  })

  it('allows a read-only grant to anon (SELECT is not a write vector)', () => {
    const files = [{ name: 'R.sql', body: 'GRANT SELECT ON TABLE public.compliance_audit_log TO anon;' }]
    expect(findAnonAuditLogWriteGrants(files)).toEqual([])
  })

  it('ignores a commented-out grant', () => {
    const files = [{ name: 'R.sql', body: '-- GRANT UPDATE ON TABLE public.compliance_audit_log TO anon;' }]
    expect(findAnonAuditLogWriteGrants(files)).toEqual([])
  })

  it('the real corpus contains no anon write grant on the audit log', () => {
    const files = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.sql')).map((f) => ({ name: f, body: read(f) }))
    expect(findAnonAuditLogWriteGrants(files)).toEqual([])
  })
})

describe('hasRlsFullRollbackOptIn (RLS_ROLLBACK tenant-isolation strip)', () => {
  it('does NOT accept a prose-only warning', () => {
    expect(hasRlsFullRollbackOptIn('-- WARNING: this removes all tenant isolation!\nALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;')).toBe(false)
  })
  it('accepts an executable session opt-in that RAISEs', () => {
    const sql = `DO $g$ BEGIN IF current_setting('rls.disable_tenant_isolation') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'refused'; END IF; END $g$;`
    expect(hasRlsFullRollbackOptIn(sql)).toBe(true)
  })
  it('the real RLS_ROLLBACK.sql requires the opt-in', () => {
    expect(hasRlsFullRollbackOptIn(read('RLS_ROLLBACK.sql'))).toBe(true)
  })
})

describe('findUnguardedTargetedRlsDisables (per-block tenant-isolation opt-in)', () => {
  const GUARD = `DO $g$ BEGIN IF coalesce(current_setting('rls.disable_tenant_isolation', true),'') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'refused'; END IF; END $g$;`

  it('FLAGS a targeted block whose DISABLE has no guard', () => {
    const sql = `-- TARGETED ROLLBACKS\nALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;`
    expect(findUnguardedTargetedRlsDisables(sql)).toEqual(['profiles'])
  })

  it('accepts a targeted block that carries its own guard', () => {
    const sql = `-- TARGETED ROLLBACKS\n${GUARD}\nALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;`
    expect(findUnguardedTargetedRlsDisables(sql)).toEqual([])
  })

  it('FLAGS the second block when only the first is guarded (a single top guard is not enough)', () => {
    const sql = `-- TARGETED ROLLBACKS\n${GUARD}\nALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.farms DISABLE ROW LEVEL SECURITY;`
    expect(findUnguardedTargetedRlsDisables(sql)).toEqual(['farms'])
  })

  it('ignores the FULL ROLLBACK block above the targeted marker', () => {
    const sql = `ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;\n-- TARGETED ROLLBACKS\n${GUARD}\nALTER TABLE public.farms DISABLE ROW LEVEL SECURITY;`
    expect(findUnguardedTargetedRlsDisables(sql)).toEqual([])
  })

  it('the real RLS_ROLLBACK.sql has every targeted block guarded', () => {
    expect(findUnguardedTargetedRlsDisables(read('RLS_ROLLBACK.sql'))).toEqual([])
  })
})

describe('findUnguardedDestructiveRollbacks (audit-critical DROP opt-in)', () => {
  const specs = [{ file: 'R.sql', setting: 'buyer_pack.rollback_destructive' }]

  it('FLAGS a rollback that drops an append-only table with no opt-in guard', () => {
    const files = [{ name: 'R.sql', body: 'BEGIN; DROP TABLE IF EXISTS public.buyer_pack_snapshots; COMMIT;' }]
    expect(findUnguardedDestructiveRollbacks(files, specs)).toEqual(['R.sql'])
  })

  it('accepts one that refuses unless the destructive opt-in is set', () => {
    const body = `BEGIN; DO $g$ BEGIN IF current_setting('buyer_pack.rollback_destructive') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'refused'; END IF; END $g$; DROP TABLE public.buyer_pack_snapshots; COMMIT;`
    expect(findUnguardedDestructiveRollbacks([{ name: 'R.sql', body }], specs)).toEqual([])
  })

  it('does not accept a prose-only warning as a guard', () => {
    const body = `-- WARNING: set buyer_pack.rollback_destructive first!\nDROP TABLE public.buyer_pack_snapshots;`
    expect(findUnguardedDestructiveRollbacks([{ name: 'R.sql', body }], specs)).toEqual(['R.sql'])
  })

  it('the real 10/17/24 rollbacks all carry their destructive opt-in guard', () => {
    const files = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.sql')).map((f) => ({ name: f, body: read(f) }))
    expect(findUnguardedDestructiveRollbacks(files, [
      { file: '10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql', setting: 'buyer_pack.rollback_destructive' },
      { file: '17_PROCUREMENT_DECISIONS_ROLLBACK.sql', setting: 'procurement.rollback_destructive' },
      { file: '24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql', setting: 'evidence.rollback_destructive' },
    ])).toEqual([])
  })
})

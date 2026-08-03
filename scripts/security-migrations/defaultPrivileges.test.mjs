import { describe, it, expect } from 'vitest'
import { findClientDefaultPrivilegeGrants } from './defaultPrivileges.mjs'

const TOKEN = 'ACL-TEST-EXEMPT: INTENTIONAL-DRAFT'
const opts = { exemptionToken: TOKEN }

// The exact statement that opened the untracked draft of migration 47 on
// 2026-08-02, and passed every gate in CI.
const REAL_OFFENDER =
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;'

describe('findClientDefaultPrivilegeGrants', () => {
  it('FLAGS the real migration-47 statement', () => {
    const files = [{ name: '47_AI_JOB_QUEUE_FOUNDATION_HARDENING.sql', body: REAL_OFFENDER }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([{
      file: '47_AI_JOB_QUEUE_FOUNDATION_HARDENING.sql',
      statement: REAL_OFFENDER,
      roles: ['authenticated'],
    }])
  })

  it('is not fooled by per-table REVOKEs later in the same file', () => {
    // Migration 47 revoked the same privileges back off its own two tables, which
    // is what made the widening look local. Those REVOKEs are ordinary statements
    // and must not cancel the default-privilege grant.
    const files = [{
      name: '47_AI_JOB_QUEUE_FOUNDATION_HARDENING.sql',
      body: [
        REAL_OFFENDER,
        'CREATE TABLE ai_jobs (id text primary key);',
        'REVOKE UPDATE ON ai_jobs FROM authenticated, anon;',
        'REVOKE DELETE ON ai_jobs FROM authenticated, anon;',
      ].join('\n'),
    }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toHaveLength(1)
  })

  it('does NOT flag migration 14 — a REVOKE narrows, and spans lines', () => {
    const files = [{
      name: '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql',
      body: 'ALTER DEFAULT PRIVILEGES\nFOR ROLE postgres\nIN SCHEMA public\nREVOKE TRUNCATE, TRIGGER, REFERENCES, MAINTAIN\nON TABLES\nFROM anon, authenticated;',
    }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([])
  })

  it("does NOT flag migration 14's ROLLBACK, whose job is to restore the grant", () => {
    const files = [{
      name: '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_ROLLBACK.sql',
      body: 'ALTER DEFAULT PRIVILEGES\nFOR ROLE postgres\nIN SCHEMA public\nGRANT TRUNCATE, TRIGGER, REFERENCES, MAINTAIN\nON TABLES\nTO anon, authenticated;',
    }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([])
  })

  it('does NOT flag a comment describing the hazard (20, 24, 36, 44 all do)', () => {
    const files = [{
      name: '36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql',
      body: "-- Supabase's baseline ALTER DEFAULT PRIVILEGES grants client roles CRUD on new\n-- public tables. Revoke explicitly.\nREVOKE ALL ON public.public_intake_attempts FROM anon;",
    }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([])
  })

  it('does NOT read `IN SCHEMA public` as the PUBLIC pseudo-role', () => {
    const files = [{
      name: 'x.sql',
      body: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO service_role;',
    }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([])
  })

  it('flags a grant to PUBLIC, and reports every client role named', () => {
    const files = [{
      name: 'y.sql',
      body: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated, PUBLIC;',
    }]
    const [offender] = findClientDefaultPrivilegeGrants(files, opts)
    expect(offender.roles.sort()).toEqual(['anon', 'authenticated', 'public'])
  })

  it('flags each statement separately when one file carries two', () => {
    const files = [{
      name: 'z.sql',
      body: [
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;',
        'CREATE TABLE t (id int);',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO authenticated;',
      ].join('\n'),
    }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toHaveLength(2)
  })

  it('ignores token-exempt drafts', () => {
    const files = [{ name: 'draft.sql', body: `-- ${TOKEN}\n${REAL_OFFENDER}` }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([])
  })

  it('finds nothing in a file with no default-privilege statement at all', () => {
    const files = [{ name: 'q.sql', body: 'GRANT SELECT ON public.farms TO authenticated;' }]
    expect(findClientDefaultPrivilegeGrants(files, opts)).toEqual([])
  })
})

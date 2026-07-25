import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  findMigrationSplits,
  findNumberCollisions,
  findPaddingInconsistencies,
  nextAvailableNumber,
  parseMigrationFilename,
} from './migration-numbering.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootSql = () => readdirSync(REPO_ROOT).filter((name) => name.toLowerCase().endsWith('.sql'))

describe('parseMigrationFilename', () => {
  it('strips exactly one trailing role suffix', () => {
    expect(parseMigrationFilename('24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql'))
      .toMatchObject({ number: 24, stem: 'EVIDENCE_REQUEST_RESOLUTION' })
    expect(parseMigrationFilename('24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql'))
      .toMatchObject({ number: 24, stem: 'EVIDENCE_REQUEST_RESOLUTION' })
    expect(parseMigrationFilename('10_BUYER_PACK_SNAPSHOTS_MVP.sql'))
      .toMatchObject({ number: 10, stem: 'BUYER_PACK_SNAPSHOTS' })
  })

  it('does NOT strip a second suffix (8_COA_UPLOAD_STORAGE_MIGRATION keeps STORAGE)', () => {
    expect(parseMigrationFilename('8_COA_UPLOAD_STORAGE_MIGRATION.sql'))
      .toMatchObject({ number: 8, stem: 'COA_UPLOAD_STORAGE' })
  })

  it('prefers the longest suffix match', () => {
    expect(parseMigrationFilename('20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql'))
      .toMatchObject({ number: 20, stem: 'FARM_ADMIN_FIELD_GUARD' })
    expect(parseMigrationFilename('13_PUBLIC_FUNCTION_EXECUTE_DRIFT_CHECK.sql'))
      .toMatchObject({ number: 13, stem: 'PUBLIC_FUNCTION_EXECUTE' })
  })

  it('leaves a migration with no role suffix intact', () => {
    expect(parseMigrationFilename('23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql'))
      .toMatchObject({ number: 23, stem: 'BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE' })
  })

  it('ignores unnumbered files', () => {
    expect(parseMigrationFilename('SUPABASE_SCHEMA.sql')).toBeNull()
    expect(parseMigrationFilename('RLS_ROLLBACK.sql')).toBeNull()
    expect(parseMigrationFilename('README.md')).toBeNull()
  })
})

describe('findNumberCollisions — companions are not collisions', () => {
  it('accepts HARDENING + VERIFY + ROLLBACK sharing one ordinal', () => {
    expect(findNumberCollisions([
      '26_WATCHTOWER_SOURCE_GOVERNANCE_HARDENING.sql',
      '26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql',
      '26_WATCHTOWER_SOURCE_GOVERNANCE_ROLLBACK.sql',
    ])).toEqual([])
  })

  it('accepts a four-companion migration (24 has an extra STORAGE file)', () => {
    expect(findNumberCollisions([
      '24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql',
      '24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql',
      '24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql',
      '24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql',
    ])).toEqual([])
  })
})

describe('findNumberCollisions — catches the real defect (negative coverage)', () => {
  // This is the exact clash that blocked PR 44: main carried Watchtower at 25,
  // the PR carried the audit-log actor hardening at 25 too.
  const CLASHING = [
    '25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql',
    '25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql',
    '25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql',
    '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql',
    '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_VERIFY.sql',
    '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_ROLLBACK.sql',
  ]

  it('FLAGS ordinal 25 claimed by two unrelated migrations', () => {
    const found = findNumberCollisions(CLASHING)
    expect(found).toHaveLength(1)
    expect(found[0].number).toBe(25)
    expect(found[0].stems).toEqual([
      'COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE',
      'WATCHTOWER_INGESTION_PROVENANCE',
    ])
    expect(found[0].files).toHaveLength(6)
  })

  it('is CLEAN once one side is renumbered to 27 (the applied fix)', () => {
    const repaired = CLASHING.map((name) => name.replace(/^25_COMPLIANCE/, '27_COMPLIANCE'))
    expect(findNumberCollisions(repaired)).toEqual([])
  })

  it('reports every colliding ordinal, not just the first', () => {
    expect(findNumberCollisions([
      '25_ALPHA_HARDENING.sql', '25_BETA_HARDENING.sql',
      '30_GAMMA_HARDENING.sql', '30_DELTA_HARDENING.sql',
    ]).map((c) => c.number)).toEqual([25, 30])
  })
})

describe('findMigrationSplits', () => {
  it('FLAGS a half-finished renumbering (HARDENING moved, VERIFY left behind)', () => {
    const found = findMigrationSplits([
      '27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql',
      '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_VERIFY.sql',
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ stem: 'COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE', numbers: [25, 27] })
  })

  it('accepts a declared corrective pair', () => {
    expect(findMigrationSplits([
      '19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql',
      '20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql',
    ], { allowedSplits: { FARM_ADMIN_FIELD_GUARD: [19, 20] } })).toEqual([])
  })

  it('does NOT let an allowlist entry excuse an ordinal outside it', () => {
    expect(findMigrationSplits([
      '19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql',
      '20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql',
      '31_FARM_ADMIN_FIELD_GUARD_VERIFY.sql',
    ], { allowedSplits: { FARM_ADMIN_FIELD_GUARD: [19, 20] } })).toHaveLength(1)
  })
})

describe('findPaddingInconsistencies', () => {
  it('FLAGS the same ordinal spelled two ways', () => {
    expect(findPaddingInconsistencies(['7_ALPHA_HARDENING.sql', '07_ALPHA_VERIFY.sql']))
      .toEqual([{ number: 7, prefixes: ['07', '7'] }])
  })

  it('accepts consistent spelling', () => {
    expect(findPaddingInconsistencies(['7_ALPHA_HARDENING.sql', '7_ALPHA_VERIFY.sql'])).toEqual([])
  })
})

describe('nextAvailableNumber', () => {
  it('returns max + 1', () => {
    expect(nextAvailableNumber(['9_A_MVP.sql', '26_B_HARDENING.sql', 'SUPABASE_SCHEMA.sql'])).toBe(27)
  })

  it('returns 1 for an empty corpus', () => {
    expect(nextAvailableNumber(['SUPABASE_SCHEMA.sql'])).toBe(1)
  })
})

describe('the REAL repository corpus is sound (integration)', () => {
  it('has no ordinal collision', () => {
    expect(findNumberCollisions(rootSql())).toEqual([])
  })

  it('has consistent ordinal padding', () => {
    expect(findPaddingInconsistencies(rootSql())).toEqual([])
  })

  it('the gate script exits 0 and says PASS', () => {
    const out = execFileSync('node', [join(REPO_ROOT, 'scripts', 'check-migration-numbering.mjs')], { encoding: 'utf8' })
    expect(out).toMatch(/RESULT: PASS/)
    expect(out).toMatch(/no ordinal claimed twice/)
  })
})

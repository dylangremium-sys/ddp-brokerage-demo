// Offline regression tests for the pending-user (migration 22) probe matrix.
//
// These exercise the REAL exported helpers from the staging suite against
// in-memory data — no network, no staging, no credentials. Importing the script
// does not trigger a live run: main() is guarded to run only when invoked
// directly.
//
// Why this file exists: migration 22 applies its restrictive overlay to ELEVEN
// tables, but the pending probes originally covered three. Seven tables were
// unverified, and a probe that cannot run was recorded as SKIP — which left the
// suite green while migration 22's central guarantee went untested. These tests
// fail if either regression returns.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIGRATION_22_TABLES,
  migration22PolicyName,
  PENDING_PREFLIGHT_FACTS,
  buildPendingPreflightSql,
  parsePreflightFacts,
  evaluatePendingPreflight,
  buildPendingProbeRegistry,
  pendingInsertPayload,
  pendingUpdatePayload,
  classifyStorageOutcome,
  summarisePendingMatrix,
  pendingFilterColumn,
  redactSecrets,
} from './run-staging-security-tests.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION_22 = readFileSync(join(ROOT, '22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql'), 'utf8')
const HARNESS_SRC = readFileSync(join(ROOT, 'scripts/run-staging-security-tests.mjs'), 'utf8')

// The set of facts that must all be true for the matrix to be allowed to run.
const ALL_FACTS_PRESENT = Object.fromEntries(PENDING_PREFLIGHT_FACTS.map((k) => [k, true]))

describe('the probe registry mirrors migration 22 exactly', () => {
  it('lists the same tables the migration loops over', () => {
    // Parse the authoritative `tables text[] := ARRAY[ ... ];` block from SQL.
    const block = MIGRATION_22.match(/tables text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/)
    expect(block, 'migration 22 must declare its table array').toBeTruthy()
    const fromSql = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(fromSql.length).toBe(11)
    expect([...MIGRATION_22_TABLES].sort()).toEqual([...fromSql].sort())
  })

  it('covers all 11 tables across SELECT, INSERT, UPDATE and DELETE', () => {
    const registry = buildPendingProbeRegistry()
    expect(registry).toHaveLength(11 * 4)
    for (const table of MIGRATION_22_TABLES) {
      for (const operation of ['select', 'insert', 'update', 'delete']) {
        expect(
          registry.some((p) => p.table === table && p.operation === operation),
          `missing ${operation} probe for ${table}`,
        ).toBe(true)
      }
    }
  })

  it('has no duplicate probe names', () => {
    const names = buildPendingProbeRegistry().map((p) => p.probeName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names the table and operation in every probe, so a failure is unambiguous', () => {
    for (const p of buildPendingProbeRegistry()) {
      expect(p.probeName).toContain(p.table)
      expect(p.probeName).toContain(p.operation)
    }
  })

  it('uses the migration policy naming convention', () => {
    expect(migration22PolicyName('farms')).toBe('farms: operational farmer or admin')
    // The convention is built in SQL as t || ': operational farmer or admin'.
    expect(MIGRATION_22).toContain("': operational farmer or admin'")
  })
})

describe('preflight refuses to assert unless migrations 21 and 22 are present', () => {
  it('passes only when every required fact is true', () => {
    expect(evaluatePendingPreflight(ALL_FACTS_PRESENT).ok).toBe(true)
  })

  it('blocks when migration 21 signals are absent', () => {
    for (const fact of [
      'role_constraint_allows_pending',
      'role_default_is_pending',
      'handle_new_user_assigns_pending',
    ]) {
      const facts = { ...ALL_FACTS_PRESENT, [fact]: false }
      const verdict = evaluatePendingPreflight(facts)
      expect(verdict.ok, `${fact} must block`).toBe(false)
      expect(verdict.blockers).toContain(fact)
    }
  })

  it('blocks when has_operational_farmer_access() is absent', () => {
    const verdict = evaluatePendingPreflight({ ...ALL_FACTS_PRESENT, has_operational_farmer_access_exists: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.blockers).toContain('has_operational_farmer_access_exists')
  })

  it('blocks when ANY ONE of the 11 restrictive policies is missing', () => {
    for (const table of MIGRATION_22_TABLES) {
      const key = `policy_present:${table}`
      const verdict = evaluatePendingPreflight({ ...ALL_FACTS_PRESENT, [key]: false })
      expect(verdict.ok, `${key} must block`).toBe(false)
      expect(verdict.blockers).toContain(key)
    }
  })

  it('blocks on missing facts entirely (absent is not true)', () => {
    expect(evaluatePendingPreflight({}).ok).toBe(false)
    expect(evaluatePendingPreflight(undefined).ok).toBe(false)
    expect(evaluatePendingPreflight(null).blockers).toHaveLength(PENDING_PREFLIGHT_FACTS.length)
  })

  it('reports the documented blocked message', () => {
    expect(evaluatePendingPreflight({}).summary)
      .toContain('PENDING PREFLIGHT FAILED — MIGRATIONS 21/22 NOT PRESENT')
  })

  it('queries every required fact, including all 11 policies', () => {
    const sql = buildPendingPreflightSql()
    for (const table of MIGRATION_22_TABLES) expect(sql).toContain(migration22PolicyName(table))
    expect(sql).toContain('has_operational_farmer_access')
    expect(sql).toContain('handle_new_user')
    // Read-only: the preflight must never mutate the target database.
    expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|create)\b/i)
  })

  it('parses psql fact output and ignores noise', () => {
    const facts = parsePreflightFacts('role_default_is_pending=true\nnoise line\npolicy_present:farms=false\n')
    expect(facts.role_default_is_pending).toBe(true)
    expect(facts['policy_present:farms']).toBe(false)
    expect(Object.keys(facts)).toHaveLength(2)
  })
})

describe('insert payloads reach RLS instead of tripping a pre-RLS constraint', () => {
  const ctx = { tag: 'security-test-tag', userId: 'user-uuid', farmId: 'farm-uuid' }

  it('defines a payload for every table', () => {
    for (const table of MIGRATION_22_TABLES) {
      expect(() => pendingInsertPayload(table, ctx), `${table} insert payload`).not.toThrow()
      expect(() => pendingUpdatePayload(table, ctx), `${table} update payload`).not.toThrow()
    }
  })

  it('does not reintroduce the farmer_documents column drift', () => {
    // The original probe inserted doc_type/file_path. Neither column exists —
    // the write failed with SQLSTATE 42703 (undefined_column) BEFORE RLS ran,
    // so it was testing the schema, not the policy.
    const payload = pendingInsertPayload('farmer_documents', ctx)
    expect(payload).not.toHaveProperty('doc_type')
    expect(payload).not.toHaveProperty('file_path')
    expect(payload).toHaveProperty('document_type')
    expect(payload).toHaveProperty('file_name')
  })

  it('supplies the NOT NULL columns that have no default', () => {
    // Confirmed against the staging catalog: these are the only three.
    expect(pendingInsertPayload('farmer_photos', ctx).file_url).toBeTruthy()
    expect(pendingInsertPayload('farmer_review_requests', ctx).request_type).toBeTruthy()
    expect(pendingInsertPayload('farmer_review_requests', ctx).message).toBeTruthy()
  })

  it('satisfies CHECK constraints, which fire before RLS', () => {
    expect(['coa', 'photo', 'quantity', 'price', 'batch_number', 'licence', 'general'])
      .toContain(pendingInsertPayload('farmer_review_requests', ctx).request_type)
    expect(['open', 'resolved']).toContain(pendingInsertPayload('farmer_review_requests', ctx).status)
    expect(['owner', 'operator']).toContain(pendingInsertPayload('farm_memberships', ctx).role)
  })

  it('tags synthetic writes so an unexpected success is traceable', () => {
    // farm_memberships/ddp_scores carry no free-text column, so they are exempt.
    const tagless = new Set(['farm_memberships', 'ddp_scores', 'farm_profiles'])
    for (const table of MIGRATION_22_TABLES) {
      if (tagless.has(table)) continue
      const values = JSON.stringify(pendingInsertPayload(table, ctx))
      expect(values, `${table} payload should carry the run tag`).toContain(ctx.tag)
    }
  })
})

describe('UPDATE/DELETE probes filter on a column that actually exists', () => {
  it('uses id for farms and entity_id for status_history', () => {
    // Filtering farms/status_history on farm_id raises SQLSTATE 42703 before RLS
    // runs, so the probe would test the schema instead of the policy. This was a
    // real failure observed on staging.
    expect(pendingFilterColumn('farms')).toBe('id')
    expect(pendingFilterColumn('status_history')).toBe('entity_id')
  })

  it('uses farm_id for every other operational table', () => {
    for (const table of MIGRATION_22_TABLES) {
      if (table === 'farms' || table === 'status_history') continue
      expect(pendingFilterColumn(table), `${table} filter column`).toBe('farm_id')
    }
  })

  it('never filters a table on a column it does not have', () => {
    // farms has no farm_id; status_history has neither farm_id nor id-as-farm.
    expect(pendingFilterColumn('farms')).not.toBe('farm_id')
    expect(pendingFilterColumn('status_history')).not.toBe('farm_id')
  })
})

describe('probes requiring a fixture are BLOCKED, never silently skipped', () => {
  it('marks UPDATE and DELETE probes as fixture-dependent', () => {
    // Without a real row, "0 rows affected" is indistinguishable from denial.
    for (const p of buildPendingProbeRegistry()) {
      if (p.operation === 'update' || p.operation === 'delete') {
        expect(p.requires, `${p.probeName} must declare its fixture`).toContain('farmFixture')
      }
    }
  })

  it('does not require a fixture to attempt a farm insert or any select', () => {
    const registry = buildPendingProbeRegistry()
    expect(registry.find((p) => p.table === 'farms' && p.operation === 'insert').requires).toHaveLength(0)
    for (const p of registry.filter((p) => p.operation === 'select')) expect(p.requires).toHaveLength(0)
  })
})

describe('matrix aggregation treats non-executed probes as non-passing', () => {
  const pass = (n) => ({ name: n, status: 'PASS' })

  it('passes only when everything ran and succeeded', () => {
    const m = summarisePendingMatrix([pass('a'), pass('b')])
    expect(m).toMatchObject({ total: 2, passed: 2, failed: 0, skipped: 0, blocked: 0, cleanupFailures: 0 })
    expect(m.overallPassing).toBe(true)
  })

  it('a SKIP makes the matrix non-passing', () => {
    expect(summarisePendingMatrix([pass('a'), { name: 'b', status: 'SKIP' }]).overallPassing).toBe(false)
  })

  it('a BLOCK makes the matrix non-passing and is not counted as a pass', () => {
    const m = summarisePendingMatrix([pass('a'), { name: 'b', status: 'BLOCK' }])
    expect(m.blocked).toBe(1)
    expect(m.passed).toBe(1)
    expect(m.overallPassing).toBe(false)
  })

  it('a cleanup failure makes the matrix non-passing', () => {
    const m = summarisePendingMatrix([pass('a'), { name: 'b', status: 'PASS', cleanupVerified: false }])
    expect(m.cleanupFailures).toBe(1)
    expect(m.overallPassing).toBe(false)
  })

  it('an empty matrix is not a pass', () => {
    expect(summarisePendingMatrix([]).overallPassing).toBe(false)
    expect(summarisePendingMatrix(null).overallPassing).toBe(false)
  })
})

describe('storage outcomes distinguish denial from absence', () => {
  it('treats 404/not-found as NOT proof of denial', () => {
    expect(classifyStorageOutcome({ error: { statusCode: '404', message: 'Object not found' } }).outcome)
      .toBe('not-found')
  })

  it('classifies a policy denial as denied', () => {
    expect(classifyStorageOutcome({ error: { statusCode: '403', message: 'new row violates row-level security policy' } }).outcome)
      .toBe('denied')
    expect(classifyStorageOutcome({ error: { statusCode: 401, message: 'Unauthorized' } }).outcome).toBe('denied')
  })

  it('classifies an invalid request as not exercising the policy', () => {
    expect(classifyStorageOutcome({ error: { statusCode: '400', message: 'Invalid key' } }).outcome).toBe('invalid')
  })

  it('reports success and absence of a response distinctly', () => {
    expect(classifyStorageOutcome({ data: {} }).outcome).toBe('allowed')
    expect(classifyStorageOutcome(null).outcome).toBe('unavailable')
  })
})

describe('the harness never leaks credentials into output', () => {
  it('redacts connection strings, JWTs and password-shaped values', () => {
    expect(redactSecrets('postgresql://user:hunter2@db.szqo.supabase.co:5432/postgres'))
      .toBe('<redacted-connection-string>')
    expect(redactSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef'))
      .toContain('<redacted-jwt>')
    expect(redactSecrets('password: swordfish')).toContain('<redacted>')
    expect(redactSecrets('password: swordfish')).not.toContain('swordfish')
    expect(redactSecrets('service_role=abc123')).not.toContain('abc123')
  })

  it('is applied to printed probe detail', () => {
    expect(HARNESS_SRC).toMatch(/redactSecrets\(r\.detail\)/)
  })
})

describe('the environment guard still refuses production and unknown refs', () => {
  it('pins the approved staging ref and the rejected production ref', () => {
    expect(HARNESS_SRC).toContain("const STAGING_REF = 'szqocdabwkjrggrddocx'")
    expect(HARNESS_SRC).toContain("const PRODUCTION_REF = 'iihxjrfxmycjafbtjvvq'")
  })

  it('refuses the production ref and any non-staging ref', () => {
    expect(HARNESS_SRC).toMatch(/points at the PRODUCTION ref/)
    expect(HARNESS_SRC).toMatch(/is not the approved staging ref/)
  })

  it('refuses a preflight against a production connection string', () => {
    expect(HARNESS_SRC).toMatch(/pending preflight refused \(production connection string\)/)
  })

  it('fails the process when any probe is blocked', () => {
    expect(HARNESS_SRC).toMatch(/failed > 0 \|\| blocked > 0 \|\| cleanupFailures > 0/)
  })
})

// Offline regression tests for the staging suite's Evidence group (migration 24).
//
// They exercise the REAL exported helpers against the merged migration-24 SQL —
// no network, no staging. Importing the script does not trigger a live run:
// main() is guarded to execute only when the file is invoked directly.
//
// Why these tests exist:
//   1. DRIFT GUARD — the Evidence preflight and probe lists must stay in step
//      with the objects the migration actually creates. If migration 24 gains a
//      table / RPC / storage policy and this harness is not updated, the run would
//      silently prove less than it claims. These tests fail instead.
//   2. FAIL-CLOSED SEMANTICS — the preflight must report "not ready" the moment a
//      single required fact is absent, so a partially-applied migration can never
//      read as present.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  EVIDENCE_TABLES,
  EVIDENCE_RPCS,
  EVIDENCE_BUCKET_ID,
  EVIDENCE_BUCKET_SIZE_LIMIT,
  EVIDENCE_STORAGE_POLICIES,
  EVIDENCE_PREFLIGHT_FACTS,
  buildEvidencePreflightSql,
  evaluateEvidencePreflight,
  evidenceProbeNames,
  parsePreflightFacts,
} from './run-staging-security-tests.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HARDENING = readFileSync(join(ROOT, '24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql'), 'utf8')
const STORAGE = readFileSync(join(ROOT, '24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql'), 'utf8')

const allTrue = () => Object.fromEntries(EVIDENCE_PREFLIGHT_FACTS.map((k) => [k, true]))

describe('evidence preflight — fail-closed evaluation', () => {
  it('is ok only when EVERY required fact is present', () => {
    expect(evaluateEvidencePreflight(allTrue()).ok).toBe(true)
  })

  it('blocks (not ok) when any single fact is missing, and names it', () => {
    for (const fact of EVIDENCE_PREFLIGHT_FACTS) {
      const facts = allTrue()
      delete facts[fact]
      const v = evaluateEvidencePreflight(facts)
      expect(v.ok, `missing ${fact} must not be ok`).toBe(false)
      expect(v.blockers).toContain(fact)
    }
  })

  it('treats a false fact exactly like a missing one (fail-closed)', () => {
    const facts = allTrue()
    facts['bucket_private'] = false
    expect(evaluateEvidencePreflight(facts).ok).toBe(false)
  })

  it('is not ok for empty / null facts', () => {
    expect(evaluateEvidencePreflight({}).ok).toBe(false)
    expect(evaluateEvidencePreflight(null).ok).toBe(false)
  })
})

describe('evidence preflight SQL — shape and coverage', () => {
  const sql = buildEvidencePreflightSql()

  it('emits exactly one fact line per required fact', () => {
    // Every emitted `'<fact>=' ||` prefix must correspond to a declared fact.
    const emitted = [...sql.matchAll(/'([^']+)=' \|\|/g)].map((m) => m[1])
    expect(new Set(emitted)).toEqual(new Set(EVIDENCE_PREFLIGHT_FACTS))
    expect(emitted.length).toBe(EVIDENCE_PREFLIGHT_FACTS.length)
  })

  it('checks every table for presence AND rls', () => {
    for (const t of EVIDENCE_TABLES) {
      expect(sql).toContain(`table_present:${t}=`)
      expect(sql).toContain(`rls_enabled:${t}=`)
      expect(sql).toContain(`c.relname='${t}'`)
    }
  })

  it('checks every RPC by name', () => {
    for (const f of EVIDENCE_RPCS) expect(sql).toContain(`p.proname='${f}'`)
  })

  it('checks bucket privacy and the exact size ceiling', () => {
    expect(sql).toContain(`storage.buckets where id='${EVIDENCE_BUCKET_ID}'`)
    expect(sql).toContain('public is false')
    expect(sql).toContain(`file_size_limit = ${EVIDENCE_BUCKET_SIZE_LIMIT}`)
  })

  it('checks every storage policy by exact name', () => {
    for (const p of EVIDENCE_STORAGE_POLICIES) expect(sql).toContain(p)
  })

  it('round-trips through parsePreflightFacts', () => {
    const facts = parsePreflightFacts(EVIDENCE_PREFLIGHT_FACTS.map((k) => `${k}=true`).join('\n'))
    expect(evaluateEvidencePreflight(facts).ok).toBe(true)
  })
})

describe('evidence ground truth stays in step with migration 24 SQL', () => {
  it('every declared table is CREATEd by the HARDENING migration', () => {
    for (const t of EVIDENCE_TABLES) {
      expect(new RegExp(`create table[^;]*public\\.${t}\\b`, 'i').test(HARDENING),
        `${t} not found as a CREATE TABLE in HARDENING`).toBe(true)
    }
  })

  it('the HARDENING migration creates no evidence table the list omits (reverse guard)', () => {
    const created = [...HARDENING.matchAll(/create table[^;]*?public\.(evidence_\w+)/gi)].map((m) => m[1])
    expect(new Set(created)).toEqual(new Set(EVIDENCE_TABLES))
  })

  it('every declared RPC is defined by the HARDENING migration', () => {
    for (const f of EVIDENCE_RPCS) {
      expect(new RegExp(`create or replace function public\\.${f}\\s*\\(`, 'i').test(HARDENING),
        `${f} not found as a CREATE FUNCTION in HARDENING`).toBe(true)
    }
  })

  it('every declared storage policy is CREATEd by the STORAGE migration', () => {
    for (const p of EVIDENCE_STORAGE_POLICIES) {
      expect(STORAGE.includes(`CREATE POLICY "${p}"`), `${p} not found in STORAGE`).toBe(true)
    }
  })

  it('the STORAGE migration creates no evidence-bucket policy the list omits (reverse guard)', () => {
    const created = [...STORAGE.matchAll(/CREATE POLICY "(evidence-request-files:[^"]+)"/g)].map((m) => m[1])
    expect(new Set(created)).toEqual(new Set(EVIDENCE_STORAGE_POLICIES))
  })

  it('the bucket id and size ceiling match the STORAGE migration', () => {
    expect(STORAGE).toContain(`'${EVIDENCE_BUCKET_ID}'`)
    expect(STORAGE).toContain(String(EVIDENCE_BUCKET_SIZE_LIMIT))
  })
})

describe('evidence probe-name lists', () => {
  const n = evidenceProbeNames()

  it('are stable and non-empty', () => {
    expect(n.tier1.length).toBeGreaterThan(0)
    expect(n.pending.length).toBe(4)
    expect(n.operatorOnly.length).toBeGreaterThan(0)
  })

  it('have one anon-SELECT probe per evidence table', () => {
    for (const t of EVIDENCE_TABLES) expect(n.tier1).toContain(`anon cannot SELECT ${t}`)
  })

  it('have no duplicate names across tier1 + pending + operatorOnly', () => {
    const all = [...n.tier1, ...n.pending, ...n.operatorOnly.map(([name]) => name)]
    expect(new Set(all).size).toBe(all.length)
  })

  it('carry a reason string for every operator-only probe (never silently dropped)', () => {
    for (const [name, reason] of n.operatorOnly) {
      expect(typeof name).toBe('string')
      expect(reason).toMatch(/operator-only/)
    }
  })
})

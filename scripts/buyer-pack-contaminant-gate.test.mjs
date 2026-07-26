// Static regression guard for migration 29 — the contaminant blocker gate on
// Buyer Pack issuance. These assertions read the SQL files as text (they cannot
// run against a database in CI) and lock in the properties that make issuance
// refuse a batch whose own lab results record a failed contaminant test. The
// live behavioural proof is 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_VERIFY.sql
// (Section B), run against a database.
//
// Lives in scripts/ (.mjs) for node fs access, matching the other migration tests
// and mirroring scripts/buyer-pack-authoritative-gate.test.mjs.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')
const stripComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')

const FORWARD = '29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql'
const VERIFY = '29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_VERIFY.sql'
const ROLLBACK = '29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_ROLLBACK.sql'

/** The PL/pgSQL body only (between AS $$ ... $$;). */
function fnBody(sql) {
  const m = stripComments(sql).match(/as\s+\$\$([\s\S]*?)\$\$\s*;/i)
  return m ? m[1] : ''
}

const CONTAMINANT_COLUMNS = [
  'heavy_metals_status',
  'pesticides_status',
  'mycotoxins_status',
  'microbial_status',
]

describe('migration 29 — companion completeness', () => {
  it('ships the HARDENING + VERIFY + ROLLBACK triple', () => {
    for (const f of [FORWARD, VERIFY, ROLLBACK]) {
      expect(() => read(f), `${f} is missing`).not.toThrow()
      expect(read(f).length, `${f} is empty`).toBeGreaterThan(500)
    }
  })
})

describe('migration 29 — forward migration (contaminant blocker gate)', () => {
  const raw = read(FORWARD)
  const code = stripComments(raw)
  const body = fnBody(raw)

  it('CREATE OR REPLACEs issue_buyer_pack_snapshot (does not edit migration 10/17/23)', () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.issue_buyer_pack_snapshot/i)
    // It must not drop or alter the tables the earlier migrations own.
    expect(code).not.toMatch(/drop\s+table/i)
    expect(code).not.toMatch(/alter\s+table\s+public\.(buyer_pack_snapshots|procurement_decisions)/i)
  })

  it('reads the batch lab results from inventory_batches', () => {
    expect(body).toMatch(/public\.inventory_batches/i)
  })

  it.each(CONTAMINANT_COLUMNS)('gates on %s = fail', (column) => {
    // A partial gate is a silent hole: a batch failing only this test would issue.
    expect(body).toMatch(new RegExp(`${column}\\s*=\\s*'fail'`, 'i'))
  })

  it('fails CLOSED with a RAISE EXCEPTION naming the failed test', () => {
    expect(body).toMatch(/raise\s+exception[^;]*failed\s+contaminant\s+test/i)
  })

  it('resolves the batch from p_pack_id, not p_batch_id alone', () => {
    // The live client (buyerPackSnapshotSupabaseStore.ts) never sends p_batch_id,
    // so a p_batch_id-only gate would be VACUOUS in production.
    expect(body).toMatch(/coalesce\s*\(\s*v_pack_uuid\s*,\s*p_batch_id\s*\)/i)
    expect(body).toMatch(/p_pack_id::uuid/i)
  })

  it('gives the AUTHORITATIVE pack id precedence over the client-supplied batch id', () => {
    // Reversing this is a live exploit, not a style preference: with p_batch_id
    // winning, an authenticated admin passes the UUID of any CLEAN batch while
    // p_pack_id names a contaminated one — the gate inspects the clean row,
    // passes, and issues a snapshot keyed to the contaminated pack.
    expect(body, 'p_batch_id must not be the first COALESCE argument')
      .not.toMatch(/coalesce\s*\(\s*p_batch_id\s*,/i)
  })

  it('refuses a p_batch_id that conflicts with a UUID pack id', () => {
    expect(body).toMatch(/does not match pack/i)
  })

  it('guards the uuid cast so a non-UUID pack id cannot raise 22P02', () => {
    expect(body).toMatch(/\[0-9a-f\]\{8\}-/i)
  })

  it('refuses a UUID pack id that names no batch (fails closed)', () => {
    expect(body).toMatch(/does not exist/i)
  })

  it('does NOT treat not_tested or NULL as a failure', () => {
    // Only the literal 'fail' may block; an absent test is a documentation gap
    // and blocking on it would break the ordinary awaiting-COA path.
    for (const column of CONTAMINANT_COLUMNS) {
      expect(body).not.toMatch(new RegExp(`${column}\\s*=\\s*'not_tested'`, 'i'))
      expect(body).not.toMatch(new RegExp(`${column}\\s+is\\s+null`, 'i'))
    }
  })

  it('PRESERVES migration 23: still server-authoritative on the decision', () => {
    expect(body, 'must read the server trail').toMatch(/procurement_decisions_current/i)
    expect(body, 'must join to the same pack').toMatch(/batch_id\s*=\s*p_pack_id/i)
    expect(body, 'must reject a non-progress decision').toMatch(/v_decision\s*<>\s*'progress'/i)
    expect(body, 'must reject when there is no decision').toMatch(/v_decision\s+is\s+null/i)
    expect(body, 'must not reference the client value').not.toMatch(/p_procurement_decision/i)
    expect(body, 'must stay admin-gated').toMatch(/is_ddp_admin/i)
  })

  it('keeps the migration-10 issuance mechanics intact', () => {
    expect(body, 'advisory lock').toMatch(/pg_advisory_xact_lock/i)
    expect(body, 'server-assigned version').toMatch(/v_next_version/i)
    expect(body, 'audit log write').toMatch(/buyer_pack_audit_log/i)
    expect(body, 'server-captured issuer').toMatch(/auth\.uid\(\)/i)
  })

  it('stays SECURITY DEFINER with a pinned search_path', () => {
    expect(code).toMatch(/security\s+definer/i)
    expect(code).toMatch(/set\s+search_path\s*=\s*public,\s*auth,\s*pg_temp/i)
  })

  it('does not widen the EXECUTE ACL', () => {
    expect(code).toMatch(/revoke\s+execute[\s\S]*?from\s+public/i)
    expect(code).toMatch(/revoke\s+execute[\s\S]*?from\s+anon/i)
    expect(code).toMatch(/grant\s+execute[\s\S]*?to\s+authenticated/i)
    expect(code, 'must not grant service_role').not.toMatch(/grant\s+execute[\s\S]*?to\s+service_role/i)
  })
})

describe('migration 29 — VERIFY is behavioural, rollback-safe and non-vacuous', () => {
  const raw = read(VERIFY)
  const code = stripComments(raw)

  it('Section A proves the RPC body references the batch fail-status check', () => {
    // The section headers are comments, so they are asserted against the raw
    // text; the assertions themselves are executable and use the stripped code.
    expect(raw).toMatch(/SECTION A/i)
    expect(code).toMatch(/inventory_batches/i)
    for (const column of CONTAMINANT_COLUMNS) {
      expect(code, `Section A does not assert ${column}`).toMatch(new RegExp(column, 'i'))
    }
  })

  it('Section A also re-asserts migration 23, so a rollback to 23 is detected', () => {
    expect(code).toMatch(/procurement_decisions_current/i)
    expect(code).toMatch(/p_procurement_decision/i)
  })

  it('Section B builds a fixture and leaves NO residue (rollback, no commit)', () => {
    expect(raw).toMatch(/SECTION B/i)
    expect(code).toMatch(/\bbegin\s*;/i)
    expect(code).toMatch(/\brollback\s*;/i)
    // A COMMIT in a fixture-building VERIFY would write test rows to the target.
    expect(code, 'VERIFY must never COMMIT its fixture').not.toMatch(/^\s*commit\s*;/im)
  })

  it('Section B asserts its test ids are absent before seeding', () => {
    expect(code).toMatch(/PRECONDITION FAILED/i)
  })

  it('Section B covers each contaminant failure, the clean case, and the untested case', () => {
    // The clean and untested cases are what prove the gate is specific rather
    // than simply refusing everything.
    expect(code).toMatch(/clean batch/i)
    expect(code).toMatch(/not_tested/i)
    for (const name of ['heavy metals', 'pesticides', 'mycotoxins', 'microbial']) {
      expect(code, `Section B does not exercise ${name}`).toMatch(new RegExp(name, 'i'))
    }
  })

  it('Section B asserts a refusal writes neither a snapshot nor an audit row', () => {
    expect(code).toMatch(/snapshot row\(s\) written despite refusal/i)
    expect(code).toMatch(/audit row\(s\) written despite refusal/i)
  })

  it('Section B records the known non-UUID limitation rather than hiding it', () => {
    expect(code).toMatch(/KNOWN LIMITATION/i)
  })
})

describe('migration 29 — ROLLBACK reverses only this migration', () => {
  const raw = read(ROLLBACK)
  const code = stripComments(raw)
  const body = fnBody(raw)

  it('restores migration 23 (keeps the server-authoritative decision gate)', () => {
    expect(body, 'must keep reading the server trail').toMatch(/procurement_decisions_current/i)
    expect(body, 'must keep gating on the server decision').toMatch(/v_decision\s*<>\s*'progress'/i)
    expect(body, 'must keep ignoring the client value').not.toMatch(/p_procurement_decision/i)
  })

  it('removes the contaminant gate (that is what makes it a rollback)', () => {
    expect(body).not.toMatch(/inventory_batches/i)
    for (const column of CONTAMINANT_COLUMNS) {
      expect(body).not.toMatch(new RegExp(column, 'i'))
    }
  })

  it('does not fall back to migration 10 (which would re-open the worse defect)', () => {
    // Restoring migration 10 would re-trust the CLIENT decision — a strictly
    // more serious regression than the one being rolled back.
    expect(body).not.toMatch(/p_procurement_decision\s*<>\s*'progress'/i)
  })

  it('carries an explicit security warning about what it re-opens', () => {
    expect(raw).toMatch(/SECURITY WARNING/i)
    expect(raw).toMatch(/re-opens/i)
  })

  it('touches no table, policy, privilege or trigger', () => {
    expect(code).not.toMatch(/drop\s+table/i)
    expect(code).not.toMatch(/drop\s+policy/i)
    expect(code).not.toMatch(/drop\s+trigger/i)
  })
})

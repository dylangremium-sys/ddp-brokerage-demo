// Static regression guard for migration 23 — server-authoritative Buyer Pack
// issuance. These assertions read the SQL files as text (they cannot run against a
// database in CI) and lock in the properties that make issuance depend on the
// server decision trail rather than the client. The live behavioural proof is
// 23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql (Section B), run against a
// database.
//
// Lives in scripts/ (.mjs) for node fs access, matching the other migration tests.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')
const stripComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')

const FORWARD = '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql'
const VERIFY = '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql'
const ROLLBACK = '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_ROLLBACK.sql'

// The PL/pgSQL body only (between AS $$ ... $$;), so a parameter named
// p_procurement_decision in the signature is NOT counted as a body reference.
function fnBody(sql) {
  const m = stripComments(sql).match(/as\s+\$\$([\s\S]*?)\$\$\s*;/i)
  return m ? m[1] : ''
}

describe('migration 23 — forward migration (server-authoritative issuance)', () => {
  const raw = read(FORWARD)
  const code = stripComments(raw)
  const body = fnBody(raw)

  it('CREATE OR REPLACEs issue_buyer_pack_snapshot (does not edit migration 10/17)', () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.issue_buyer_pack_snapshot/i)
  })

  it('reads the server-authoritative decision trail (procurement_decisions_current)', () => {
    expect(body).toMatch(/procurement_decisions_current/i)
  })

  it('joins the decision to the SAME pack (batch_id = p_pack_id)', () => {
    expect(body).toMatch(/batch_id\s*=\s*p_pack_id/i)
  })

  it('gates on the SERVER decision being progress, and blocks null/hold/reject', () => {
    expect(body, 'must reject a non-progress current decision').toMatch(/v_decision\s*<>\s*'progress'/i)
    expect(body, 'must reject when there is no decision').toMatch(/v_decision\s+is\s+null/i)
  })

  it('does NOT gate on, or store, the client p_procurement_decision (ignored)', () => {
    // The classic defect regex must be gone…
    expect(code).not.toMatch(/p_procurement_decision\s*<>\s*'progress'/i)
    // …and the body must not reference the client argument at all (so it is neither
    // authorization input nor the stored value).
    expect(body).not.toMatch(/p_procurement_decision/i)
  })

  it('stores the server-derived decision value (v_decision) in the snapshot', () => {
    expect(body).toMatch(/\bv_decision\b/i)
  })

  it('re-asserts a non-null actor and a non-blank reason', () => {
    expect(body).toMatch(/v_decided_by\s+is\s+null/i)
    expect(body).toMatch(/v_reason\s+is\s+null\s+or\s+length\s*\(\s*btrim\s*\(\s*v_reason/i)
  })

  it('remains admin-gated and requires a non-blank pack id', () => {
    expect(body).toMatch(/is_ddp_admin\s*\(/i)
    expect(body).toMatch(/p_pack_id\s+is\s+null\s+or\s+length\s*\(\s*btrim\s*\(\s*p_pack_id/i)
  })

  it('adds no service-role or client bypass', () => {
    expect(code).not.toMatch(/service_role/i)
  })
})

describe('migration 23 — verification script', () => {
  const code = stripComments(read(VERIFY))
  const residueTail = code.slice(code.lastIndexOf('rollback;'))

  it('uses BEGIN/ROLLBACK and contains no COMMIT', () => {
    expect(code).toMatch(/\bbegin\b/i)
    expect(code).toMatch(/\brollback\b/i)
    expect(code).not.toMatch(/\bcommit\b/i)
  })

  it('actually calls the RPC (non-vacuous behaviour)', () => {
    expect(code).toMatch(/issue_buyer_pack_snapshot\s*\(/i)
  })

  it('has a non-vacuous post-rollback residue check', () => {
    expect(code).toMatch(/raise\s+exception/i)
    expect(residueTail).toMatch(/leftover_/i)
    expect(residueTail).toMatch(/residue/i)
  })

  it('covers the core blocking scenarios (hold, reject, no-decision, stale, other-pack)', () => {
    for (const pk of ['PK-HOLD', 'PK-REJECT', 'PK-NONE', 'PK-STALE-HOLD', 'PK-STALE-REJECT']) {
      expect(code, `VERIFY must exercise ${pk}`).toContain(pk)
    }
  })
})

describe('migration 23 — VERIFY Section A scans comment-stripped source', () => {
  // pg_proc.prosrc is the function BODY and INCLUDES its comments. Migration 23's
  // body legitimately NAMES p_procurement_decision in comments (to document that it
  // is ignored). A Section A scan for that identifier against RAW prosrc therefore
  // false-fails on the correct, applied function — the exact defect this guards.
  const raw = read(VERIFY)
  // The object-state do-block + summary, bounded by the two real section banners
  // (unique ASCII substrings — not the lowercase mentions in the file header).
  const sectionA = raw.slice(
    raw.indexOf('OBJECT STATE (read-only; RAISEs on drift)'),
    raw.indexOf('BEHAVIOUR (ephemeral fixture'),
  )

  it('is bounded correctly (non-empty slice between the real banners)', () => {
    expect(sectionA.length).toBeGreaterThan(0)
  })

  it('derives a comment-stripped copy of the source before scanning it', () => {
    // v_code := regexp_replace(v_src, '--...', ...) — strips line comments.
    expect(sectionA).toMatch(/v_code\s*:=\s*regexp_replace\(\s*v_src\s*,\s*'--/i)
  })

  it('scans the comment-stripped code (not raw prosrc/v_src) for the client argument', () => {
    // The "client value is ignored" check must run against the stripped source…
    expect(sectionA).toMatch(/position\(\s*'p_procurement_decision'\s+in\s+v_code\s*\)/i)
    // …and must NOT revert to raw v_src, which reintroduces the false positive.
    expect(sectionA).not.toMatch(/position\(\s*'p_procurement_decision'\s+in\s+v_src\s*\)/i)
  })

  it('strips comments in the informational ignores_client_decision summary too', () => {
    // The summary boolean must also scan comment-stripped prosrc, or it reports the
    // correct function as trusting the client value.
    expect(sectionA).toMatch(/position\(\s*'p_procurement_decision'\s+in\s+regexp_replace\(\s*p\.prosrc\s*,\s*'--/i)
  })
})

describe('migration 23 — rollback script', () => {
  const code = stripComments(read(ROLLBACK))

  it('restores migration 10\'s client-trusting definition', () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.issue_buyer_pack_snapshot/i)
    expect(code).toMatch(/p_procurement_decision\s*<>\s*'progress'/i)
  })

  it('does not reference the server trail (it is a true reversal)', () => {
    // The restored function must NOT contain the authoritative lookup.
    expect(fnBody(read(ROLLBACK))).not.toMatch(/procurement_decisions_current/i)
  })
})

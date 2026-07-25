#!/usr/bin/env node
// scripts/check-security-migrations.mjs
//
// Dependency-free static assurance gate for the DDP security migrations.
// It reads repository SQL files only. It NEVER connects to a database, writes
// files, deploys, or requires any external package. Exit code is non-zero if
// any check fails.
//
// These are narrow, explicit, comment-stripped string/regex rules — NOT a full
// SQL parser. They exist to catch drift (stale headers, mis-placed exemption
// tokens, accidental scope creep in the hardened migrations), not to validate
// arbitrary SQL.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findUnexpectedGuardRedefinitions, findUnguardedHandleNewUserDowngrades } from './security-migrations/guardRedefinition.mjs'
import { findMutableSearchPathDefiners } from './security-migrations/definerSearchPath.mjs'
import { hasExecutablePendingGuard, findAnonAuditLogWriteGrants, hasRlsFullRollbackOptIn, findUnguardedTargetedRlsDisables, findUnguardedDestructiveRollbacks } from './security-migrations/rollbackSafety.mjs'
import { findHardeningProblems as mig25Hardening, findVerifyProblems as mig25Verify, findRollbackProblems as mig25Rollback } from './security-migrations/auditLogActorMigration.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Constants (ground truth) ────────────────────────────────────────────────
const EXEMPTION_TOKEN = 'ACL-TEST-EXEMPT: INTENTIONAL-DRAFT'

const ALLOWED_TOKEN_FILES = [
  '10_BUYER_PACK_SNAPSHOTS_MVP.sql',
  'FARM_ADMIN_ROLE_CHECK_FIX.sql',
  'FARM_RESAVE_PERSISTENCE_MIGRATION.sql',
]

const MIGRATIONS = {
  11: {
    hardening: '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_HARDENING.sql',
    verify: '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_VERIFY.sql',
    rollback: '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_ROLLBACK.sql',
  },
  12: {
    hardening: '12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql',
    verify: '12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql',
    rollback: '12_PUBLIC_FUNCTION_EXECUTE_ROLLBACK.sql',
  },
  14: {
    hardening: '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql',
    verify: '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql',
    rollback: '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_ROLLBACK.sql',
  },
  15: {
    hardening: '15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql',
    verify: '15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql',
    rollback: '15_EXISTING_TABLE_AND_AUDIT_LOG_ROLLBACK.sql',
  },
}

const ACTIVE_FILES = Object.values(MIGRATIONS).flatMap((m) => [m.hardening, m.verify, m.rollback])

const STALE_HEADER_PHRASES = [
  'NOT COMMITTED',
  'NOT PUSHED',
  'NOT APPLIED TO PRODUCTION',
  'staging-tested only',
]

const MUTATING_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALTER',
  'CREATE', 'DROP', 'GRANT', 'REVOKE', 'CALL', 'DO',
]

const EXPECTED_15_TABLES = [
  'compliance_alerts', 'compliance_audit_log', 'compliance_entity_status',
  'compliance_reviews', 'compliance_rules', 'ddp_scores', 'documents',
  'farm_memberships', 'farm_profiles', 'farmer_documents', 'farmer_photos',
  'farmer_review_requests', 'farms', 'inventory_batches', 'legal_updates',
  'market_price_benchmarks', 'profiles', 'regulatory_sources', 'risk_flags',
  'status_history',
]

// Migration 19 — farm admin-field self-approval guard (bespoke rules; NOT part of
// the generic MIGRATIONS registry because its VERIFY is deliberately behavioural
// — BEGIN/ROLLBACK with UPDATEs — rather than SELECT-only).
const FARM_GUARD = {
  forward: '19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql',
  verify: '19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql',
  rollback: '19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql',
}
// Admin-controlled columns, enumerated from schema (SUPABASE_SCHEMA.sql:20-25 +
// AUTH_RLS_SCHEMA.sql:38-39). Drift from this set is a failure.
const FARM_GUARD_PROTECTED_COLUMNS = [
  'status', 'compliance_status', 'export_readiness',
  'risk_level', 'partner_tier', 'reviewed_by', 'created_by',
].sort()

// Corrective ACL migration (migration 20). Supabase default-grants EXECUTE on new
// public functions directly to `authenticated`, so the trigger-only guard must be
// revoked from public, anon, AND authenticated for the combined 19 + 20 end state.
const FARM_GUARD_ACLFIX = '20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql'
const FARM_GUARD_REVOKE_ROLES = ['public', 'anon', 'authenticated']

// ── Helpers ─────────────────────────────────────────────────────────────────
let failures = 0
function pass(label) { console.log(`PASS  ${label}`) }
function fail(label, reason) { console.log(`FAIL  ${label}\n        → ${reason}`); failures++ }
function check(label, ok, reason) { ok ? pass(label) : fail(label, reason) }

function read(file) { return readFileSync(join(ROOT, file), 'utf8') }

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}
// Strip single-quoted string literals (handling '' escapes) — extra safety so a
// keyword inside a literal can never be read as a statement.
function stripStrings(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''")
}
function statements(sql) {
  return stripComments(sql).split(';').map((s) => s.trim()).filter(Boolean)
}
function firstWord(stmt) {
  const m = stmt.trim().match(/^([A-Za-z_]+)/)
  return m ? m[1].toUpperCase() : ''
}

// ── Checks ──────────────────────────────────────────────────────────────────
console.log('DDP security-migration static assurance gate\n')

// Check 0 — companion completeness (check 4 in spec; run first so later checks
// can safely read the files).
let allPresent = true
for (const [n, m] of Object.entries(MIGRATIONS)) {
  for (const role of ['hardening', 'verify', 'rollback']) {
    const f = m[role]
    if (!existsSync(join(ROOT, f))) {
      fail(`Migration ${n} companion (${role})`, `missing file: ${f}`)
      allPresent = false
    }
  }
}
if (allPresent) pass('Companion completeness: 11/12/14/15 each have HARDENING + VERIFY + ROLLBACK')

// Discover every root-level *.sql file for token scanning.
const rootSql = readdirSync(ROOT).filter((f) => f.endsWith('.sql'))

// Check 1 — exemption token appears in exactly the three allowed draft files.
const filesWithToken = rootSql.filter((f) => read(f).includes(EXEMPTION_TOKEN)).sort()
const expectedTokenFiles = [...ALLOWED_TOKEN_FILES].sort()
check(
  'Exemption token confined to the three genuine-draft files',
  JSON.stringify(filesWithToken) === JSON.stringify(expectedTokenFiles),
  `token found in [${filesWithToken.join(', ')}], expected [${expectedTokenFiles.join(', ')}]`,
)

// Check 2 — no active migration carries the exemption token.
const activeWithToken = ACTIVE_FILES.filter((f) => existsSync(join(ROOT, f)) && read(f).includes(EXEMPTION_TOKEN))
check(
  'No active migration (11/12/14/15) carries the exemption token',
  activeWithToken.length === 0,
  `token present in active migration(s): ${activeWithToken.join(', ')}`,
)

// Check 3 — active migration headers contain no stale status claims.
for (const f of ACTIVE_FILES) {
  if (!existsSync(join(ROOT, f))) continue
  const body = read(f)
  const hits = STALE_HEADER_PHRASES.filter((p) => body.toLowerCase().includes(p.toLowerCase()))
  check(`No stale status claim in ${f}`, hits.length === 0, `contains stale phrase(s): ${hits.join(', ')}`)
}

// Check 5 — every VERIFY file is SELECT-only (no top-level mutating statement).
for (const [n, m] of Object.entries(MIGRATIONS)) {
  if (!existsSync(join(ROOT, m.verify))) continue
  const cleaned = stripStrings(read(m.verify))
  const offenders = statements(cleaned)
    .map((s) => firstWord(s))
    .filter((w) => MUTATING_KEYWORDS.includes(w))
  check(
    `Migration ${n} VERIFY is SELECT-only`,
    offenders.length === 0,
    `${m.verify} has top-level mutating statement(s): ${[...new Set(offenders)].join(', ')}`,
  )
}

// Check 6 — Migration 11 narrowly scoped to the TRUNCATE trigger + function
// EXECUTE revocation (idempotent DROP TRIGGER IF EXISTS of the same trigger is
// allowed).
{
  const f = MIGRATIONS[11].hardening
  const stmts = statements(read(f))
  const problems = []
  let hasTruncateTrigger = false
  let hasExecRevoke = false
  for (const s of stmts) {
    const w = firstWord(s)
    if (w === 'BEGIN' || w === 'COMMIT') continue
    if (w === 'DROP' && /\bTRIGGER\b/i.test(s) && /compliance_audit_log_no_truncate/i.test(s)) continue
    if (w === 'CREATE' && /\bTRIGGER\b/i.test(s) && /\bTRUNCATE\b/i.test(s)) { hasTruncateTrigger = true; continue }
    if (w === 'REVOKE' && /\bEXECUTE\s+ON\s+FUNCTION\b/i.test(s)) { hasExecRevoke = true; continue }
    problems.push(`${w}: ${s.replace(/\s+/g, ' ').slice(0, 70)}…`)
  }
  if (/\bON\s+TABLE\b/i.test(read(f)) || /ALTER\s+DEFAULT\s+PRIVILEGES/i.test(read(f)) || /\bPOLICY\b/i.test(read(f))) {
    problems.push('references a table-privilege / default-privilege / policy change (out of scope)')
  }
  check('Migration 11 scoped to TRUNCATE trigger + function EXECUTE revoke',
    problems.length === 0 && hasTruncateTrigger && hasExecRevoke,
    problems.length ? problems.join(' | ') : 'missing required trigger or EXECUTE revoke')
}

// Check 7 — Migration 12 changes only function EXECUTE ACLs.
{
  const f = MIGRATIONS[12].hardening
  const stmts = statements(read(f))
  const problems = []
  let hasRevoke = false, hasGrant = false
  for (const s of stmts) {
    const w = firstWord(s)
    if (w === 'BEGIN' || w === 'COMMIT') continue
    if (w === 'REVOKE' && /\bEXECUTE\s+ON\s+FUNCTION\b/i.test(s) && !/\bON\s+TABLE\b/i.test(s)) { hasRevoke = true; continue }
    if (w === 'GRANT' && /\bEXECUTE\s+ON\s+FUNCTION\b/i.test(s) && !/\bON\s+TABLE\b/i.test(s)) { hasGrant = true; continue }
    problems.push(`${w}: ${s.replace(/\s+/g, ' ').slice(0, 70)}…`)
  }
  check('Migration 12 changes only function EXECUTE ACLs',
    problems.length === 0 && hasRevoke && hasGrant,
    problems.length ? problems.join(' | ') : 'missing EXECUTE REVOKE or GRANT')
}

// Check 8 — Migration 14 changes only FUTURE default privileges and revokes no CRUD.
{
  const f = MIGRATIONS[14].hardening
  const body = read(f)
  const stmts = statements(body)
  const problems = []
  let hasDefaultPriv = false
  for (const s of stmts) {
    const w = firstWord(s)
    if (w === 'BEGIN' || w === 'COMMIT') continue
    if (w === 'ALTER' && /DEFAULT\s+PRIVILEGES/i.test(s) && /\bON\s+TABLES\b/i.test(s)) { hasDefaultPriv = true; continue }
    problems.push(`${w}: ${s.replace(/\s+/g, ' ').slice(0, 70)}…`)
  }
  if (/\bALTER\s+TABLE\b/i.test(body)) problems.push('contains ALTER TABLE (existing-object change, out of scope)')
  if (/\bON\s+TABLE\b(?!S)/i.test(stripComments(body))) problems.push('contains ON TABLE (existing-table privilege change)')
  if (/\bREVOKE\b[^;]*\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(stripComments(body))) problems.push('revokes CRUD (SELECT/INSERT/UPDATE/DELETE)')
  check('Migration 14 only future default privileges; no CRUD revoke',
    problems.length === 0 && hasDefaultPriv,
    problems.length ? problems.join(' | ') : 'missing ALTER DEFAULT PRIVILEGES ... ON TABLES')
}

// Check 9 — Migration 15 narrow-scope guarantees.
{
  const f = MIGRATIONS[15].hardening
  const body = stripComments(read(f))
  const stmts = statements(read(f))
  const problems = []

  // Statement-shape gate: only BEGIN/COMMIT, REVOKE ... ON TABLE, and
  // ALTER TABLE ... ENABLE ALWAYS TRIGGER are allowed.
  for (const s of stmts) {
    const w = firstWord(s)
    if (w === 'BEGIN' || w === 'COMMIT') continue
    if (w === 'REVOKE' && /\bON\s+TABLE\b/i.test(s)) continue
    if (w === 'ALTER' && /\bALTER\s+TABLE\b/i.test(s) && /\bENABLE\s+ALWAYS\s+TRIGGER\b/i.test(s)) continue
    problems.push(`unexpected statement ${w}: ${s.replace(/\s+/g, ' ').slice(0, 70)}…`)
  }

  // Per-REVOKE privilege checks.
  const revokeStmts = stmts.filter((s) => firstWord(s) === 'REVOKE')
  for (const s of revokeStmts) {
    const privClause = (s.match(/REVOKE\s+([\s\S]*?)\s+ON\s+TABLE/i) || [, ''])[1].toUpperCase()
    if (/\bSELECT\b/.test(privClause)) problems.push('revokes SELECT')
    if (/\bINSERT\b/.test(privClause)) problems.push('revokes INSERT')
    if ((/\bUPDATE\b/.test(privClause) || /\bDELETE\b/.test(privClause)) && !/compliance_audit_log/i.test(s)) {
      problems.push('revokes UPDATE/DELETE outside compliance_audit_log')
    }
    if (/\bservice_role\b/i.test(s)) problems.push('revokes from service_role')
  }

  // Exact 20-table target set (from the TRUNCATE/TRIGGER/REFERENCES/MAINTAIN revoke).
  const bigRevoke = stmts.find((s) => /REVOKE\s+TRUNCATE\s*,\s*TRIGGER\s*,\s*REFERENCES\s*,\s*MAINTAIN/i.test(s))
  const tables = bigRevoke
    ? [...new Set([...(bigRevoke.match(/public\.([a-z_]+)/gi) || []).map((t) => t.split('.')[1].toLowerCase())])].sort()
    : []
  const expected = [...EXPECTED_15_TABLES].sort()
  if (JSON.stringify(tables) !== JSON.stringify(expected)) {
    problems.push(`table set mismatch (got ${tables.length}: [${tables.join(', ')}])`)
  }

  // ALTER TABLE only targets compliance_audit_log, ENABLE ALWAYS the two guards.
  const alterStmts = stmts.filter((s) => firstWord(s) === 'ALTER')
  const expectedTriggers = ['compliance_audit_log_no_update_delete', 'compliance_audit_log_no_truncate']
  for (const s of alterStmts) {
    if (!/ALTER\s+TABLE\s+public\.compliance_audit_log/i.test(s)) problems.push('ALTER TABLE targets a table other than compliance_audit_log')
    if (!/ENABLE\s+ALWAYS\s+TRIGGER/i.test(s)) problems.push('ALTER TABLE is not ENABLE ALWAYS TRIGGER')
    if (!expectedTriggers.some((t) => new RegExp(t, 'i').test(s))) problems.push('ALTER TABLE names an unexpected trigger')
  }
  // No DROP/CREATE/GRANT/policy/function anywhere.
  if (/\b(DROP|CREATE|GRANT)\b/i.test(body) || /\bPOLICY\b/i.test(body) || /\bFUNCTION\b/i.test(body)) {
    problems.push('contains DROP/CREATE/GRANT/POLICY/FUNCTION (out of scope)')
  }

  check('Migration 15 narrow scope (no SELECT/INSERT revoke; UPDATE/DELETE only on audit log; no service_role; exact 20 tables; audit-log ENABLE ALWAYS only)',
    problems.length === 0,
    [...new Set(problems)].join(' | '))
}

// Check 10 — Migration 19 farm admin-field self-approval guard (UPDATE + INSERT).
// Fails if: any companion file is missing; the forward migration uses the invalid
// role = 'admin' literal or lacks the canonical is_ddp_admin() guard; the UPDATE
// protected-column set drifts from schema; the trigger does not cover BOTH INSERT
// and UPDATE; the farmer-INSERT branch does not force created_by = auth.uid(),
// force status to its canonical entry value, or neutralise every other protected
// field; the VERIFY script contains COMMIT, omits the farmer/admin INSERT tests, or
// its transaction/residue checks are vacuous; or the ROLLBACK overreaches.
{
  const label = 'Migration 19 farm admin-field guard'
  const missing = ['forward', 'verify', 'rollback'].filter((r) => !existsSync(join(ROOT, FARM_GUARD[r])))
  if (missing.length) {
    fail(`${label}: companion completeness`, `missing file(s): ${missing.map((r) => FARM_GUARD[r]).join(', ')}`)
  } else {
    pass(`${label}: companion completeness (HARDENING + VERIFY + ROLLBACK present)`)

    // Forward migration — comment-stripped so keywords in the header prose (which
    // literally discusses the role = 'admin' bug) are never read as code.
    const fwd = stripComments(read(FARM_GUARD.forward))
    const problems = []
    if (!/is_ddp_admin\s*\(/i.test(fwd)) problems.push('missing canonical is_ddp_admin() guard')
    if (/role\s*=\s*'admin'/i.test(fwd)) problems.push("uses invalid literal role = 'admin'")

    // UPDATE branch: every protected column preserved (new.X := old.X).
    const assigned = [...fwd.matchAll(/new\.([a-z_]+)\s*:=\s*old\./gi)].map((m) => m[1].toLowerCase())
    const assignedSet = [...new Set(assigned)].sort()
    if (JSON.stringify(assignedSet) !== JSON.stringify(FARM_GUARD_PROTECTED_COLUMNS)) {
      problems.push(`UPDATE protected-column drift (got [${assignedSet.join(', ')}], expected [${FARM_GUARD_PROTECTED_COLUMNS.join(', ')}])`)
    }

    // Trigger must fire on BOTH INSERT and UPDATE.
    if (!/create\s+trigger\s+trg_protect_farm_admin_fields\s+before\s+insert\s+or\s+update\s+on\s+public\.farms/is.test(fwd) ||
        !/execute\s+function\s+public\.fn_protect_farm_admin_fields/is.test(fwd)) {
      problems.push('trigger is not BEFORE INSERT OR UPDATE on public.farms')
    }

    // INSERT branch: force created_by to auth.uid(), force status to its canonical
    // entry value, and neutralise every other protected field to NULL.
    if (!/tg_op\s*=\s*'insert'/i.test(fwd)) problems.push('no INSERT branch (tg_op = \'INSERT\')')
    if (!/new\.created_by\s*:=\s*auth\.uid\(\)/i.test(fwd)) problems.push('INSERT does not force created_by := auth.uid() (spoofable ownership)')
    if (!/new\.status\s*:=\s*'submitted to ddp'/i.test(fwd)) problems.push("INSERT does not force status := 'Submitted to DDP'")
    for (const col of FARM_GUARD_PROTECTED_COLUMNS) {
      if (col === 'created_by' || col === 'status') continue
      if (!new RegExp(`new\\.${col}\\s*:=\\s*null`, 'i').test(fwd)) {
        problems.push(`INSERT does not neutralise ${col} (must set new.${col} := null)`)
      }
    }
    check(`${label}: forward migration correctness (canonical guard, no 'admin' literal, INSERT+UPDATE trigger, UPDATE preserves + INSERT sanitises all 7 fields)`,
      problems.length === 0, problems.join(' | '))

    // VERIFY — behavioural, rollback-safe, non-vacuous, and covering INSERT.
    const ver = stripComments(read(FARM_GUARD.verify))
    const residueTail = ver.slice(ver.lastIndexOf('rollback;'))
    const vProblems = []
    if (/\bcommit\b/i.test(ver)) vProblems.push('VERIFY contains COMMIT (must use BEGIN/ROLLBACK only)')
    if (!/\bbegin\b/i.test(ver) || !/\brollback\b/i.test(ver)) vProblems.push('VERIFY lacks BEGIN/ROLLBACK')
    if (!/update\s+public\.farms\s+set/i.test(ver)) vProblems.push('VERIFY has no behavioural UPDATE on farms (vacuous)')
    if (!/insert\s+into\s+public\.farms/i.test(ver)) vProblems.push('VERIFY has no behavioural INSERT on farms (INSERT vector untested)')
    if (!/raise\s+exception/i.test(ver)) vProblems.push('VERIFY has no RAISE assertions (vacuous)')
    if (!/leftover_/i.test(ver) || !/residue/i.test(ver)) vProblems.push('VERIFY has no post-rollback residue check (vacuous)')
    // Farmer INSERT test (self-set fields neutralised, created_by forced) and admin INSERT test.
    if (!/verify b5/i.test(ver) || !/created_by not forced/i.test(ver)) vProblems.push('VERIFY omits the farmer-INSERT test (created_by force / field sanitisation)')
    if (!/verify b6/i.test(ver)) vProblems.push('VERIFY omits the admin-INSERT test')
    for (const col of FARM_GUARD_PROTECTED_COLUMNS) {
      if (!new RegExp(`\\b${col}\\b`, 'i').test(ver)) vProblems.push(`VERIFY does not exercise protected column ${col}`)
    }
    // Residue must cover the INSERT-test rows and the seeded auth.users rows.
    if (!/leftover_auth_users/i.test(residueTail)) vProblems.push('residue check does not cover seeded auth.users rows')
    if (!residueTail.includes('000fa000-0000-0000-0000-000000000003')) vProblems.push('residue check does not cover the farmer-INSERT row')
    if (!residueTail.includes('000fa000-0000-0000-0000-000000000004')) vProblems.push('residue check does not cover the admin-INSERT row')
    check(`${label}: VERIFY covers INSERT+UPDATE, is rollback-safe (no COMMIT), and non-vacuous (residue includes inserted rows)`,
      vProblems.length === 0, vProblems.join(' | '))

    // ROLLBACK — reverses only this migration; must not drop either farmer policy.
    const rb = stripComments(read(FARM_GUARD.rollback))
    const rProblems = []
    if (!/drop\s+trigger\s+if\s+exists\s+trg_protect_farm_admin_fields\s+on\s+public\.farms/i.test(rb)) rProblems.push('does not drop the trigger')
    if (!/drop\s+function\s+if\s+exists\s+public\.fn_protect_farm_admin_fields/i.test(rb)) rProblems.push('does not drop the function')
    if (/drop\s+policy[^;]*farms: farmer (update|insert) own/i.test(rb)) rProblems.push('drops a "farms: farmer …" policy (overreach)')
    check(`${label}: ROLLBACK reverses only this migration (keeps both farmer policies)`,
      rProblems.length === 0, rProblems.join(' | '))
  }
}

// Check 11 — farm guard EXECUTE ACL: revoked from all client roles (19 + 20), and
// NO direct client re-grant ANYWHERE in the SQL corpus (future-proof).
// The trigger-only guard must have EXECUTE revoked from public, anon, AND
// authenticated across the farm-guard migrations, and no migration — INCLUDING any
// added after 20 — may re-grant direct EXECUTE to a client role. Fails if: the
// corrective migration 20 is missing; any of the three roles is not revoked; or a
// GRANT EXECUTE on fn_protect_farm_admin_fields() to public/anon/authenticated
// appears in any root *.sql file (with or without the `public.` qualifier, and
// even if the statement spans multiple lines).
{
  const label = 'Farm guard EXECUTE ACL (corpus-wide)'
  // Comment-stripped AND whitespace-normalised so a statement may span lines and
  // the `public.` schema qualifier is optional. The trailing `;` is optional too
  // (a valid final statement may omit it) — the role list runs to `;` OR end.
  const norm = (file) => stripComments(read(file)).replace(/\s+/g, ' ')
  const REVOKE_RE = /revoke\s+execute\s+on\s+function\s+(?:public\.)?fn_protect_farm_admin_fields\s*\(\s*\)\s+from\s+([^;]+?)\s*(?:;|$)/gi
  const GRANT_RE = /grant\s+execute\s+on\s+function\s+(?:public\.)?fn_protect_farm_admin_fields\s*\(\s*\)\s+to\s+([^;]+?)\s*(?:;|$)/gi
  // A role token may be double-quoted (PostgreSQL: "authenticated" == authenticated).
  // Split on commas, trim, remove ONE surrounding pair of double quotes, lowercase.
  const parseRoles = (list) => list.split(',').map((r) => {
    const t = r.trim()
    const unquoted = (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t
    return unquoted.trim().toLowerCase()
  })

  if (!existsSync(join(ROOT, FARM_GUARD_ACLFIX))) {
    fail(`${label}: corrective migration present`,
      `missing ${FARM_GUARD_ACLFIX} — Supabase default-grants EXECUTE on new public functions to authenticated, so without it authenticated retains direct EXECUTE on the guard`)
  } else if (!existsSync(join(ROOT, FARM_GUARD.forward))) {
    fail(`${label}: forward migration present`, `missing ${FARM_GUARD.forward}`)
  } else {
    pass(`${label}: corrective migration ${FARM_GUARD_ACLFIX} present`)

    // (a) Required revoke end-state across migrations 19 + 20.
    const combined = norm(FARM_GUARD.forward) + ' ' + norm(FARM_GUARD_ACLFIX)
    const revoked = new Set()
    for (const m of combined.matchAll(REVOKE_RE)) {
      for (const r of parseRoles(m[1])) revoked.add(r)
    }
    const revokeProblems = FARM_GUARD_REVOKE_ROLES
      .filter((role) => !revoked.has(role))
      .map((role) => `EXECUTE not revoked from ${role}`)
    check(`${label}: EXECUTE revoked from public + anon + authenticated (migrations 19 + 20)`,
      revokeProblems.length === 0, revokeProblems.join(' | '))

    // (b) No direct client-role re-grant in ANY root *.sql — catches a re-grant in
    // a future migration (e.g. 21_…), regardless of `public.` qualifier, layout,
    // quoted role names, or a missing trailing semicolon.
    const regrants = []
    for (const f of [...rootSql].sort()) {
      for (const g of norm(f).matchAll(GRANT_RE)) {
        for (const r of parseRoles(g[1])) {
          if (FARM_GUARD_REVOKE_ROLES.includes(r)) regrants.push(`${f}: GRANT EXECUTE … TO ${r} (re-opens direct execution)`)
        }
      }
    }
    check(`${label}: no direct client-role EXECUTE re-grant in any root *.sql`,
      regrants.length === 0, regrants.join(' | '))
  }
}

// Check 12 — Migration 23 server-authoritative Buyer Pack issuance.
// The issuance RPC must derive release status from the server decision trail, not
// the client. Fails if any companion is missing; the RPC gates on/stores the
// client p_procurement_decision; the authoritative lookup, same-pack match,
// no-decision block, or hold/reject block is removed; the reason/actor re-checks
// are dropped; the VERIFY contains COMMIT or loses its residue check.
{
  const BP = {
    forward: '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql',
    verify: '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql',
    rollback: '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_ROLLBACK.sql',
  }
  const label = 'Migration 23 buyer-pack authoritative issuance'
  // PL/pgSQL body only (between AS $$ … $$;), so a p_procurement_decision parameter
  // in the signature is not mistaken for a body reference.
  const fnBody = (f) => {
    const m = stripComments(read(f)).match(/as\s+\$\$([\s\S]*?)\$\$\s*;/i)
    return m ? m[1] : ''
  }
  const missing = ['forward', 'verify', 'rollback'].filter((r) => !existsSync(join(ROOT, BP[r])))
  if (missing.length) {
    fail(`${label}: companion completeness`, `missing file(s): ${missing.map((r) => BP[r]).join(', ')}`)
  } else {
    pass(`${label}: companion completeness (HARDENING + VERIFY + ROLLBACK present)`)

    const fwd = stripComments(read(BP.forward))
    const body = fnBody(BP.forward)
    const p = []
    if (!/create\s+or\s+replace\s+function\s+public\.issue_buyer_pack_snapshot/i.test(fwd)) p.push('does not CREATE OR REPLACE issue_buyer_pack_snapshot')
    if (!/procurement_decisions_current/i.test(body)) p.push('does not read the server trail (procurement_decisions_current)')
    if (!/batch_id\s*=\s*p_pack_id/i.test(body)) p.push('does not join the decision to the same pack (batch_id = p_pack_id)')
    if (!/v_decision\s*<>\s*'progress'/i.test(body)) p.push('does not block a non-progress server decision (hold/reject)')
    if (!/v_decision\s+is\s+null/i.test(body)) p.push('does not block a pack with no decision')
    if (!/v_decided_by\s+is\s+null/i.test(body)) p.push('does not re-assert a non-null decision actor')
    if (!/v_reason\s+is\s+null\s+or\s+length\s*\(\s*btrim\s*\(\s*v_reason/i.test(body)) p.push('does not re-assert a non-blank decision reason')
    if (!/is_ddp_admin\s*\(/i.test(body)) p.push('is no longer admin-gated')
    if (!/p_pack_id\s+is\s+null\s+or\s+length\s*\(\s*btrim\s*\(\s*p_pack_id/i.test(body)) p.push('does not require a non-blank pack id')
    // Client value must be neither the gate nor the stored value.
    if (/p_procurement_decision\s*<>\s*'progress'/i.test(fwd)) p.push("re-introduces the client gate (p_procurement_decision <> 'progress')")
    if (/p_procurement_decision/i.test(body)) p.push('function body references p_procurement_decision (client value not ignored / possibly stored)')
    if (!/\bv_decision\b/i.test(body)) p.push('does not store the server-derived decision (v_decision)')
    if (/service_role/i.test(fwd)) p.push('adds a service_role bypass')
    check(`${label}: forward migration is server-authoritative (reads trail, same-pack, blocks non-progress/no-decision, ignores + does not store client value, admin+pack gated)`,
      p.length === 0, p.join(' | '))

    const ver = stripComments(read(BP.verify))
    const residueTail = ver.slice(ver.lastIndexOf('rollback;'))
    const vp = []
    if (/\bcommit\b/i.test(ver)) vp.push('VERIFY contains COMMIT (must be BEGIN/ROLLBACK only)')
    if (!/\bbegin\b/i.test(ver) || !/\brollback\b/i.test(ver)) vp.push('VERIFY lacks BEGIN/ROLLBACK')
    if (!/issue_buyer_pack_snapshot\s*\(/i.test(ver)) vp.push('VERIFY never calls the RPC (vacuous)')
    if (!/raise\s+exception/i.test(ver)) vp.push('VERIFY has no RAISE assertions (vacuous)')
    if (!/leftover_/i.test(residueTail) || !/residue/i.test(residueTail)) vp.push('VERIFY has no post-rollback residue check')
    for (const pk of ['PK-HOLD', 'PK-REJECT', 'PK-NONE', 'PK-STALE-HOLD', 'PK-STALE-REJECT']) {
      if (!ver.includes(pk)) vp.push(`VERIFY does not exercise ${pk}`)
    }
    check(`${label}: VERIFY is behavioural, rollback-safe (no COMMIT), and covers the blocking scenarios`,
      vp.length === 0, vp.join(' | '))

    const rb = stripComments(read(BP.rollback))
    const rp = []
    if (!/create\s+or\s+replace\s+function\s+public\.issue_buyer_pack_snapshot/i.test(rb)) rp.push('does not restore the function')
    if (!/p_procurement_decision\s*<>\s*'progress'/i.test(rb)) rp.push("does not restore migration 10's client gate")
    if (/procurement_decisions_current/i.test(fnBody(BP.rollback))) rp.push('restored body still reads the server trail (not a true reversal)')
    check(`${label}: ROLLBACK restores migration 10's definition`,
      rp.length === 0, rp.join(' | '))
  }
}

// Check 13 — no unexpected redefinition of the farm admin-field guard (DDP audit
// A1/F2). Check 10 validates the CANONICAL guard body and Check 11 scans for
// EXECUTE re-grants, but NEITHER catches a SECOND file that CREATE-OR-REPLACEs the
// guard with a weaker body (invalid role literal, INSERT-vector dropped). Such a
// downgrade would previously have passed CI. The guard may be (re)defined ONLY in
// the canonical file, or in an explicitly-quarantined draft carrying the exemption
// token (itself confined to the known drafts by Check 1). A redefinition anywhere
// else is a downgrade hazard.
{
  const files = rootSql.map((f) => ({ name: f, body: read(f) }))
  const offenders = findUnexpectedGuardRedefinitions(files, {
    canonicalFile: FARM_GUARD.forward,
    exemptionToken: EXEMPTION_TOKEN,
  })
  check(
    'No unexpected redefinition of fn_protect_farm_admin_fields (only the canonical migration or a token-exempt draft may define it)',
    offenders.length === 0,
    `guard redefined in non-canonical, non-exempt file(s): ${offenders.join(', ')} — a downgrade of the farm admin-field guard would otherwise pass CI`,
  )
}

// Check 14 — Migration 27 compliance_audit_log actor is server-authoritative
// (DDP audit client-authz #3). The audit log must stamp the actor from auth.uid(),
// never from a client-supplied value. Fails if any companion is missing; the
// trigger does not force NEW.actor_id := auth.uid(); it is not BEFORE INSERT on
// compliance_audit_log; the function lacks a pinned search_path or is not revoked
// from client roles; the migration widens scope (touches policies/other tables);
// the VERIFY is not behavioural/rollback-safe or omits the forged-actor test; or
// the ROLLBACK does not remove exactly the trigger + function.
{
  const AL = {
    hardening: '27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql',
    verify: '27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_VERIFY.sql',
    rollback: '27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_ROLLBACK.sql',
  }
  const label = 'Migration 27 audit-log actor authoritative'
  const missing = ['hardening', 'verify', 'rollback'].filter((r) => !existsSync(join(ROOT, AL[r])))
  if (missing.length) {
    fail(`${label}: companion completeness`, `missing file(s): ${missing.map((r) => AL[r]).join(', ')}`)
  } else {
    pass(`${label}: companion completeness (HARDENING + VERIFY + ROLLBACK present)`)

    const p = mig25Hardening(read(AL.hardening))
    check(`${label}: HARDENING forces auth.uid(), BEFORE INSERT, pinned search_path, revoked from clients, narrow scope`, p.length === 0, p.join(' | '))

    const vp = mig25Verify(read(AL.verify))
    check(`${label}: VERIFY is behavioural (forged-actor override), rollback-safe (no COMMIT), non-vacuous`, vp.length === 0, vp.join(' | '))

    const rp = mig25Rollback(read(AL.rollback))
    check(`${label}: ROLLBACK removes exactly the trigger + function (no overreach)`, rp.length === 0, rp.join(' | '))
  }
}

// Check 15 — no SECURITY DEFINER function with a mutable search_path (DDP audit
// F1). A definer function whose search_path is not pinned lets a caller shadow an
// unqualified name and run it as the function owner. The applied end-state is
// hardened by migration 3, but replaying an unnumbered baseline file would strip
// the pin and silently re-open the vector — so every definer definition in the
// corpus (excluding throwaway *_VERIFY scaffolding and quarantined drafts) must
// pin search_path.
{
  const files = rootSql.map((f) => ({ name: f, body: read(f) }))
  const offenders = findMutableSearchPathDefiners(files, { exemptionToken: EXEMPTION_TOKEN })
  check(
    'No SECURITY DEFINER function with a mutable search_path (privilege-escalation vector)',
    offenders.length === 0,
    `definer function(s) without a pinned search_path: ${offenders.map((o) => `${o.file}:${o.fn}()`).join(', ')}`,
  )
}

// Check 16 — rollback safety (DDP audit A3/A4).
// (a) Migration 21's rollback must ENFORCE its no-pending-rows precondition with
//     an executable guard, not merely document it — otherwise it fails late at
//     ADD CONSTRAINT with an opaque constraint error.
// (b) No rollback may restore a WRITE privilege on the append-only
//     compliance_audit_log to the UNAUTHENTICATED `anon` role.
{
  const ROLLBACK_21 = '21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql'
  if (!existsSync(join(ROOT, ROLLBACK_21))) {
    fail('Rollback safety: migration 21 rollback present', `missing ${ROLLBACK_21}`)
  } else {
    check(
      'Rollback safety: migration 21 rollback ENFORCES the no-pending-rows precondition (executable guard, not a comment)',
      hasExecutablePendingGuard(read(ROLLBACK_21)),
      `${ROLLBACK_21} documents the pending-row precondition but does not enforce it; the rollback would fail late at ADD CONSTRAINT with an opaque error`,
    )
  }

  const files = rootSql.map((f) => ({ name: f, body: read(f) }))
  const anonGrants = findAnonAuditLogWriteGrants(files)
  check(
    'Rollback safety: no file grants a WRITE privilege on compliance_audit_log to anon',
    anonGrants.length === 0,
    `unauthenticated write path restored by: ${anonGrants.map((g) => `${g.file} (GRANT ${g.privileges})`).join(', ')}`,
  )
}

// Check 17 — replay/rollback fail-closed guards (DDP audit A2 + RLS_ROLLBACK).
// (a) Every file defining handle_new_user with the weaker 'farmer' default must
//     refuse when migration 21's hardened 'pending' version is installed —
//     otherwise an out-of-order replay silently re-opens anonymous
//     self-provisioning. Migration 21's own rollback is exempt (restoring
//     'farmer' is its purpose, and it carries its own guards).
// (b) The RLS full rollback strips tenant isolation from every core table, so it
//     must require an explicit session opt-in rather than running on paste.
{
  const files = rootSql.map((f) => ({ name: f, body: read(f) }))
  const downgrades = findUnguardedHandleNewUserDowngrades(files, {
    allowedRollbackFile: '21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql',
  })
  check(
    'Replay safety: every handle_new_user definition minting \'farmer\' refuses to downgrade the hardened migration-21 version',
    downgrades.length === 0,
    `unguarded downgrade path(s): ${downgrades.join(', ')} — replaying these after migration 21 re-opens anonymous self-provisioning`,
  )

  const RLS_RB = 'RLS_ROLLBACK.sql'
  if (!existsSync(join(ROOT, RLS_RB))) {
    fail('Rollback safety: RLS rollback present', `missing ${RLS_RB}`)
  } else {
    check(
      'Rollback safety: RLS full rollback requires an explicit opt-in before stripping tenant isolation',
      hasRlsFullRollbackOptIn(read(RLS_RB)),
      `${RLS_RB} disables RLS on the core tables without an executable operator opt-in`,
    )
  }
}

// Check 18 — every dangerous rollback path is individually fail-closed.
// (a) Each per-table block in RLS_ROLLBACK's TARGETED section is independently
//     copy-pasteable, so each DISABLE ROW LEVEL SECURITY needs its OWN opt-in
//     guard; a single top-of-file guard is bypassed by pasting one block.
// (b) Rollbacks that DROP an append-only / audit-critical table must refuse while
//     rows exist unless the operator opts in (the migration-24 pattern):
//     10 = issued buyer packs, 17 = the procurement decision trail that migration
//     23 reads to authorise issuance, 24 = evidence records.
{
  const RLS_RB = 'RLS_ROLLBACK.sql'
  if (existsSync(join(ROOT, RLS_RB))) {
    const unguarded = findUnguardedTargetedRlsDisables(read(RLS_RB))
    check(
      'Rollback safety: every targeted per-table RLS disable carries its own opt-in guard',
      unguarded.length === 0,
      `per-table DISABLE without an opt-in guard: ${unguarded.join(', ')} — pasting one block would strip that table's tenant isolation`,
    )
  }

  const files = rootSql.map((f) => ({ name: f, body: read(f) }))
  const DESTRUCTIVE = [
    { file: '10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql', setting: 'buyer_pack.rollback_destructive' },
    { file: '17_PROCUREMENT_DECISIONS_ROLLBACK.sql', setting: 'procurement.rollback_destructive' },
    { file: '24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql', setting: 'evidence.rollback_destructive' },
  ]
  const unguardedDestructive = findUnguardedDestructiveRollbacks(files, DESTRUCTIVE)
  check(
    'Rollback safety: every audit-critical DROP rollback refuses without an explicit destructive opt-in',
    unguardedDestructive.length === 0,
    `rollback(s) that destroy append-only records with no opt-in guard: ${unguardedDestructive.join(', ')}`,
  )
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('')
if (failures > 0) {
  console.log(`RESULT: FAIL — ${failures} check(s) failed.`)
  process.exit(1)
}
console.log('RESULT: PASS — all security-migration assurance checks passed.')
process.exit(0)

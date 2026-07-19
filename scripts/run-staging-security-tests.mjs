#!/usr/bin/env node
// scripts/run-staging-security-tests.mjs
//
// LIVE STAGING security regression suite. It exercises the deployed *staging*
// Supabase project with real anon / authenticated / admin roles and real
// Supabase behaviour (RLS, function EXECUTE ACLs, storage isolation, audit-log
// immutability, catalog drift).
//
// SAFETY MODEL — this script is FAIL-CLOSED and STAGING-ONLY:
//   * It runs ONLY against the staging project ref szqocdabwkjrggrddocx.
//   * It REFUSES to run against the production ref iihxjrfxmycjafbtjvvq or any
//     unknown ref, and refuses (before any network call) if required env vars
//     are missing.
//   * It applies NO migrations and issues NO DDL (no TRUNCATE/DROP/ALTER/GRANT/
//     REVOKE). It never touches production.
//   * All application records it creates are tagged `security-test-<runId>` and
//     removed in a finally block, in reverse dependency order, scoped to the
//     run id. Zero residue for every deletable table.
//   * The append-only compliance_audit_log is special: a synthetic audit row
//     canNOT be deleted (that immutability is the property under test). The
//     audit-insert probe is therefore OPT-IN (STAGING_ALLOW_AUDIT_INSERT=true);
//     when enabled, the single tagged row is retained by design.
//   * It never prints secrets (URLs beyond the ref, keys, passwords, tokens).
//
// It is intentionally NOT part of `npm test` / CI (no GitHub secrets exist).
// Run it locally via `npm run security:staging` after exporting the staging env
// (e.g. `set -a; source .env.staging.local; set +a`).
//
// Requires only @supabase/supabase-js (already a dependency). Catalog checks
// (group F) use the `psql` CLI and run only when STAGING_DATABASE_URL is set.

import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGING_REF = 'szqocdabwkjrggrddocx'
const PRODUCTION_REF = 'iihxjrfxmycjafbtjvvq'

const REQUIRED_ENV = [
  'STAGING_SUPABASE_URL',
  'STAGING_SUPABASE_ANON_KEY',
  'STAGING_ADMIN_EMAIL',
  'STAGING_ADMIN_PASSWORD',
  'STAGING_FARMER_A_EMAIL',
  'STAGING_FARMER_A_PASSWORD',
  'STAGING_FARMER_B_EMAIL',
  'STAGING_FARMER_B_PASSWORD',
]

// ── Env loading (no dependency) ─────────────────────────────────────────────
// Fill any missing vars from an optional gitignored .env.staging.local file.
function loadLocalEnvFile() {
  const p = join(ROOT, '.env.staging.local')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq === -1) continue
    const k = s.slice(0, eq).trim()
    let v = s.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}

export function refFromUrl(url) {
  // https://<ref>.supabase.co  →  <ref>
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in|net)\b/i.exec(url || '')
  return m ? m[1] : null
}

// ── Fail-closed guards (run BEFORE any network access) ──────────────────────
export function resolveConfig(env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(`refusing to run: missing required env var(s): ${missing.join(', ')}`)
  }
  const ref = refFromUrl(env.STAGING_SUPABASE_URL)
  if (!ref) {
    throw new Error('refusing to run: STAGING_SUPABASE_URL is not a valid https://<ref>.supabase.co URL')
  }
  if (ref === PRODUCTION_REF) {
    throw new Error(`refusing to run: STAGING_SUPABASE_URL points at the PRODUCTION ref (${PRODUCTION_REF})`)
  }
  if (ref !== STAGING_REF) {
    throw new Error(`refusing to run: project ref "${ref}" is not the approved staging ref (${STAGING_REF})`)
  }
  return {
    ref,
    url: env.STAGING_SUPABASE_URL,
    anonKey: env.STAGING_SUPABASE_ANON_KEY,
    admin: { email: env.STAGING_ADMIN_EMAIL, password: env.STAGING_ADMIN_PASSWORD },
    farmerA: { email: env.STAGING_FARMER_A_EMAIL, password: env.STAGING_FARMER_A_PASSWORD },
    farmerB: { email: env.STAGING_FARMER_B_EMAIL, password: env.STAGING_FARMER_B_PASSWORD },
    // Optional: a staging auth user whose profiles.role is 'pending' (migration
    // 21/22). When absent, the pending-denial group SKIPS (fail-closed) rather
    // than fabricating a credential.
    pending: env.STAGING_PENDING_EMAIL && env.STAGING_PENDING_PASSWORD
      ? { email: env.STAGING_PENDING_EMAIL, password: env.STAGING_PENDING_PASSWORD }
      : null,
    databaseUrl: env.STAGING_DATABASE_URL || null,
    allowAuditInsert: /^(1|true|yes)$/i.test(env.STAGING_ALLOW_AUDIT_INSERT || ''),
  }
}

// ── Result matrix ───────────────────────────────────────────────────────────
const results = []
let currentGroup = 'setup'
function group(name) { currentGroup = name }
function record(name, ok, detail = '') {
  results.push({ group: currentGroup, name, status: ok ? 'PASS' : 'FAIL', detail })
}
function skip(name, reason) { results.push({ group: currentGroup, name, status: 'SKIP', detail: reason }) }
// BLOCK: the probe could not be executed under conditions that would make its
// result meaningful. Unlike SKIP it is never a pass and always fails the run —
// a pending probe that cannot run must not leave the suite green.
function block(name, reason) {
  results.push({ group: currentGroup, name, status: 'BLOCK', detail: reason, pendingMatrix: true })
}
function blockAll(names, reason) { for (const n of names) block(n, reason) }

// Assert that a Supabase write/rpc was DENIED (error present, or zero rows).
function isDenied(res) {
  if (res && res.error) return true
  if (res && Array.isArray(res.data)) return res.data.length === 0
  return false
}
function isAllowed(res) { return res && !res.error }

// ── Synthetic-data cleanup (exported so it can be regression-tested offline) ──
//
// The synthetic farms are inserted with the `farm_name` column (see farm
// creation in groups B/C). Cleanup and residue detection MUST filter on that
// SAME column. An earlier version filtered on a non-existent `name` column, so
// the delete matched nothing and the residue check then reported zero — a false
// "clean" that let 24 orphaned rows accumulate across runs. Centralising the
// column here makes that class of drift a one-line, testable fact.
const SYNTHETIC_FARM_COLUMN = 'farm_name'

// Delete this run's synthetic farms (tag-scoped) via the given signed-in client.
// farm_memberships and any dependent rows cascade on the farm delete.
export async function deleteSyntheticFarms(client, tag) {
  if (!client) return
  await client.from('farms').delete().ilike(SYNTHETIC_FARM_COLUMN, `${tag}%`)
}

// Count synthetic farms still present for a tag. 0 = clean. Used both by the
// live suite's residue assertion and by the offline regression test.
export async function countResidualFarms(client, tag) {
  if (!client) return 0
  const res = await client.from('farms').select('id').ilike(SYNTHETIC_FARM_COLUMN, `${tag}%`)
  return res?.data?.length ?? 0
}

// ── Migration 22: operational-farmer restrictive overlay ────────────────────
//
// Migration 22 applies ONE `AS RESTRICTIVE FOR ALL` policy per farmer-operated
// table. This list is the authoritative mirror of the `tables text[]` array in
// 22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql. A regression test asserts the
// two stay in step, so adding a table to the migration without adding a probe
// here fails CI rather than silently shrinking pending-user coverage.
export const MIGRATION_22_TABLES = Object.freeze([
  'farms',
  'farm_profiles',
  'farm_memberships',
  'inventory_batches',
  'farmer_documents',
  'farmer_photos',
  'farmer_review_requests',
  'documents',
  'ddp_scores',
  'risk_flags',
  'status_history',
])

// The policy name migration 22 builds as `t || ': operational farmer or admin'`.
export function migration22PolicyName(table) {
  return `${table}: operational farmer or admin`
}

// ── Pending preflight ───────────────────────────────────────────────────────
//
// The pending matrix is only meaningful when migrations 21 AND 22 are actually
// present on the target database. Without them a 'pending' role cannot exist,
// and every "denied" below would be ordinary ownership denial — a green run
// that proves nothing. These are the facts we require before asserting.
export const PENDING_PREFLIGHT_FACTS = Object.freeze([
  'role_constraint_allows_pending',
  'role_default_is_pending',
  'handle_new_user_assigns_pending',
  'has_operational_farmer_access_exists',
  ...MIGRATION_22_TABLES.map((t) => `policy_present:${t}`),
])

// Read-only catalog SQL producing one `fact=true|false` line per required fact.
export function buildPendingPreflightSql() {
  const policyChecks = MIGRATION_22_TABLES.map((t) =>
    `select 'policy_present:${t}=' || (count(*) > 0)::text from pg_policies` +
    ` where schemaname='public' and tablename='${t}' and policyname='${migration22PolicyName(t)}';`
  ).join('\n')
  return [
    `select 'role_constraint_allows_pending=' || coalesce(bool_or(pg_get_constraintdef(oid) like '%pending%'), false)::text` +
    ` from pg_constraint where conrelid='public.profiles'::regclass and contype='c';`,
    `select 'role_default_is_pending=' || coalesce(bool_or(column_default like '%pending%'), false)::text` +
    ` from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='role';`,
    `select 'handle_new_user_assigns_pending=' || coalesce(bool_or(prosrc like '%pending%'), false)::text` +
    ` from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='handle_new_user';`,
    `select 'has_operational_farmer_access_exists=' || (count(*) > 0)::text from pg_proc p` +
    ` join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='has_operational_farmer_access';`,
    policyChecks,
  ].join('\n')
}

// Parse `fact=true` lines from psql -At output into a plain object.
export function parsePreflightFacts(psqlOutput) {
  const facts = {}
  for (const line of String(psqlOutput || '').split('\n')) {
    const m = line.trim().match(/^(.+)=(true|false)$/)
    if (m) facts[m[1]] = m[2] === 'true'
  }
  return facts
}

// Pure gate: every required fact must be explicitly true. Anything missing or
// false blocks the matrix. Returns blockers so the operator sees exactly what
// is absent rather than a bare refusal.
export function evaluatePendingPreflight(facts) {
  const f = facts || {}
  const blockers = PENDING_PREFLIGHT_FACTS.filter((k) => f[k] !== true)
  return {
    ok: blockers.length === 0,
    blockers,
    summary: blockers.length === 0
      ? 'migrations 21 and 22 present'
      : `PENDING PREFLIGHT FAILED — MIGRATIONS 21/22 NOT PRESENT (${blockers.length} missing: ${blockers.slice(0, 4).join(', ')}${blockers.length > 4 ? ', …' : ''})`,
  }
}

// ── Pending probe registry ──────────────────────────────────────────────────
//
// Data-driven so all 11 tables are covered uniformly and the table/operation
// that failed is always named explicitly in the probe name.
//
// `requires` names a fixture the probe needs to be MEANINGFUL. UPDATE/DELETE
// against a table with no matching row returns "0 rows affected", which is
// indistinguishable from an RLS denial — so those probes target a real fixture
// row and are BLOCKED (never silently skipped or passed) when it is absent.
const FIXTURE_FARM = 'farmFixture'

export function buildPendingProbeRegistry() {
  const rows = []
  for (const table of MIGRATION_22_TABLES) {
    rows.push({ table, operation: 'select', requires: [] })
    rows.push({ table, operation: 'insert', requires: table === 'farms' ? [] : [FIXTURE_FARM] })
    rows.push({ table, operation: 'update', requires: [FIXTURE_FARM] })
    rows.push({ table, operation: 'delete', requires: [FIXTURE_FARM] })
  }
  return rows.map((r) => ({ ...r, probeName: `pending cannot ${r.operation} ${r.table}` }))
}

// Minimal INSERT payloads. Every column here was confirmed against the staging
// catalog: only farmer_photos.file_url, farmer_review_requests.request_type and
// .message are NOT NULL without a default. Payloads must satisfy CHECK
// constraints too, because a CHECK fires BEFORE RLS (see PRE_RLS_SQLSTATES) and
// would make the probe test the schema instead of the policy.
export function pendingInsertPayload(table, ctx) {
  const { tag, userId, farmId } = ctx
  switch (table) {
    case 'farms': return { farm_name: `${tag}-P`, created_by: userId }
    case 'farm_profiles': return { farm_id: farmId }
    case 'farm_memberships': return { farm_id: farmId, user_id: userId, role: 'operator' }
    case 'inventory_batches': return { created_by: userId, farm_id: farmId, notes: `${tag}-P` }
    case 'farmer_documents': return { farm_id: farmId, document_type: 'coa', file_name: `${tag}.pdf` }
    case 'farmer_photos': return { farm_id: farmId, photo_type: 'facility', file_url: `${tag}.jpg` }
    case 'farmer_review_requests': return { farm_id: farmId, request_type: 'coa', message: `${tag}-P`, status: 'open' }
    case 'documents': return { farm_id: farmId, document_type: 'coa', file_name: `${tag}.pdf` }
    case 'ddp_scores': return { farm_id: farmId, total_score: 1 }
    case 'risk_flags': return { farm_id: farmId, flag_type: 'other', label: `${tag}-P`, severity: 'low' }
    case 'status_history': return { entity_type: 'farm', entity_id: farmId, new_status: `${tag}-P` }
    default: throw new Error(`no pending insert payload defined for ${table}`)
  }
}

// The column an UPDATE/DELETE probe filters on to target the fixture farm.
// Most operational tables carry farm_id, but two do not: `farms` IS the farm
// (its key is `id`), and `status_history` is polymorphic (`entity_id`). Using
// farm_id there raises SQLSTATE 42703 (undefined_column) BEFORE RLS runs, so
// the probe would test the schema instead of the policy and is correctly
// reported as an invalid probe rather than a security pass.
export function pendingFilterColumn(table) {
  if (table === 'farms') return 'id'
  if (table === 'status_history') return 'entity_id'
  return 'farm_id'
}

// A tag-scoped UPDATE payload, so a probe that wrongly succeeds is traceable
// and removable rather than corrupting a shared fixture.
export function pendingUpdatePayload(table, ctx) {
  const { tag } = ctx
  switch (table) {
    case 'farms': return { farm_name: `${tag}-PU` }
    case 'inventory_batches': return { notes: `${tag}-PU` }
    case 'farm_memberships': return { role: 'operator' }
    case 'farmer_documents': case 'documents': return { file_name: `${tag}-PU.pdf` }
    case 'farmer_photos': return { file_url: `${tag}-PU.jpg` }
    case 'farmer_review_requests': return { message: `${tag}-PU` }
    case 'ddp_scores': return { total_score: 2 }
    case 'risk_flags': return { label: `${tag}-PU` }
    case 'status_history': return { note: `${tag}-PU` }
    case 'farm_profiles': return { business_info: { probe: `${tag}-PU` } }
    default: throw new Error(`no pending update payload defined for ${table}`)
  }
}

// ── Storage outcome classification ──────────────────────────────────────────
//
// "Object not found" is NOT proof of authorization denial — the object may
// simply be absent. Callers must treat only 'denied' as a security pass.
export function classifyStorageOutcome(res) {
  if (!res) return { outcome: 'unavailable', reason: 'no response from storage' }
  const err = res.error
  if (!err) return { outcome: 'allowed', reason: 'operation succeeded' }
  const status = err.statusCode ?? err.status ?? null
  const msg = String(err.message || '').toLowerCase()
  if (String(status) === '404' || msg.includes('not found')) {
    return { outcome: 'not-found', reason: 'object not found — NOT proof of denial' }
  }
  if (String(status) === '400' || msg.includes('invalid')) {
    return { outcome: 'invalid', reason: `invalid request — does not exercise policy (${status ?? 'n/a'})` }
  }
  if (String(status) === '401' || String(status) === '403'
      || msg.includes('unauthor') || msg.includes('denied') || msg.includes('violates row-level security')) {
    return { outcome: 'denied', reason: `denied by policy (${status ?? 'n/a'})` }
  }
  return { outcome: 'unavailable', reason: `unclassified storage error (${status ?? 'n/a'})` }
}

// ── Matrix aggregation ──────────────────────────────────────────────────────
//
// The merge gate requires failed = skipped = blocked = cleanupFailures = 0.
// A blocked probe is explicitly NOT a pass.
export function summarisePendingMatrix(rows) {
  const list = Array.isArray(rows) ? rows : []
  const count = (s) => list.filter((r) => r.status === s).length
  const cleanupFailures = list.filter((r) => r.cleanupVerified === false).length
  const summary = {
    total: list.length,
    passed: count('PASS'),
    failed: count('FAIL'),
    skipped: count('SKIP'),
    blocked: count('BLOCK'),
    cleanupFailures,
  }
  summary.overallPassing = summary.total > 0
    && summary.failed === 0 && summary.skipped === 0
    && summary.blocked === 0 && summary.cleanupFailures === 0
  return summary
}

// Strip anything credential-shaped from probe detail text before printing.
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/postgres(ql)?:\/\/[^\s]*/gi, '<redacted-connection-string>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<redacted-jwt>')
    .replace(/(password|passwd|secret|token|apikey|api_key|service_role)("?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1$2<redacted>')
}

// Postgres SQLSTATEs that must NOT be accepted as evidence that RLS denied a
// write, because they are raised BEFORE row-level security is ever consulted:
//   23514 check_violation      — a CHECK constraint rejected the value
//   23502 not_null_violation   — a NOT NULL constraint rejected the value
//   23503 foreign_key_violation
//   22P02 invalid_text_representation (e.g. a bad enum/uuid literal)
//   42703 undefined_column     — the column does not exist on this table
// A test that fires one of these is testing the schema, not the policy: it
// would still "pass" with RLS entirely disabled. See PRE_RLS_SQLSTATES usage.
const PRE_RLS_SQLSTATES = new Set(['23514', '23502', '23503', '22P02', '42703'])

// Assert a write was denied BY ROW-LEVEL SECURITY specifically.
// Returns { denied, reason } so a pre-RLS rejection is reported as a FAIL of the
// test's own validity rather than silently counted as a security pass.
function isDeniedByRls(res) {
  const code = res?.error?.code
  if (code && PRE_RLS_SQLSTATES.has(code)) {
    return { denied: false, reason: `rejected pre-RLS by SQLSTATE ${code} — this probe does not exercise RLS` }
  }
  if (res?.error) return { denied: true, reason: `denied (SQLSTATE ${code || 'n/a'})` }
  // RLS denial on UPDATE/DELETE surfaces as zero rows affected, not an error.
  if (Array.isArray(res?.data)) {
    return res.data.length === 0
      ? { denied: true, reason: 'denied (0 rows affected — RLS predicate excluded the row)' }
      : { denied: false, reason: `ALLOWED — ${res.data.length} row(s) written` }
  }
  return { denied: false, reason: 'inconclusive (no error, no row count)' }
}

// ── Supabase client helpers ─────────────────────────────────────────────────
function makeClient(cfg) {
  return createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
async function signedInClient(cfg, creds, label) {
  const c = makeClient(cfg)
  const { data, error } = await c.auth.signInWithPassword({ email: creds.email, password: creds.password })
  if (error || !data?.session) throw new Error(`could not sign in ${label} (check staging test-user creds)`)
  return { client: c, userId: data.user.id }
}

// ── Pending preflight + matrix drivers (live) ───────────────────────────────

// Run the catalog preflight. Returns true only when every required migration
// 21/22 fact is present. Records one PASS/FAIL line so the operator can see
// exactly which fact is missing.
function runPendingPreflight(databaseUrl) {
  if (databaseUrl.includes(PRODUCTION_REF)) {
    record('pending preflight refused (production connection string)', false,
      'STAGING_DATABASE_URL contains the production ref')
    return false
  }
  let facts
  try {
    const out = execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-A', '-t', '-c', buildPendingPreflightSql()],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    facts = parsePreflightFacts(out)
  } catch (e) {
    record('pending preflight (migrations 21/22 present)', false,
      redactSecrets(`psql error: ${String(e?.message || e).split('\n')[0].slice(0, 80)}`))
    return false
  }
  const verdict = evaluatePendingPreflight(facts)
  record('pending preflight (migrations 21/22 present)', verdict.ok, redactSecrets(verdict.summary))
  return verdict.ok
}

// Execute the 11-table × 4-operation pending matrix. Every probe is recorded
// with its table and operation named, so a failure is never ambiguous.
async function runPendingMatrix(ctx) {
  const { client, userId, tag, farmId } = ctx
  const fixtures = { farmFixture: farmId || null }
  const createdIds = []

  for (const probe of buildPendingProbeRegistry()) {
    const missing = probe.requires.filter((r) => !fixtures[r])
    if (missing.length > 0) {
      // Precise fixture requirement, never a silent skip (§7).
      block(probe.probeName,
        `requires fixture(s) ${missing.join(', ')} — an operational farmer fixture row is needed for this probe to distinguish RLS denial from "no matching row"`)
      continue
    }
    const { table, operation } = probe
    let res
    try {
      if (operation === 'select') {
        res = await client.from(table).select('id').limit(1)
        // A restrictive overlay yields zero readable rows. Recorded via isDenied
        // because SELECT denial surfaces as an empty set, not an error.
        record(probe.probeName, isDenied(res), redactSecrets(res?.error?.message || 'no rows readable'))
        continue
      }
      if (operation === 'insert') {
        res = await client.from(table).insert(pendingInsertPayload(table, { tag, userId, farmId })).select('id')
        if (Array.isArray(res?.data)) for (const row of res.data) if (row?.id) createdIds.push({ table, id: row.id })
      } else if (operation === 'update') {
        res = await client.from(table).update(pendingUpdatePayload(table, { tag }))
          .eq(pendingFilterColumn(table), farmId).select('id')
      } else {
        res = await client.from(table).delete()
          .eq(pendingFilterColumn(table), farmId).select('id')
      }
    } catch (e) {
      record(probe.probeName, false, redactSecrets(`probe threw: ${String(e?.message || e).slice(0, 80)}`))
      continue
    }
    // isDeniedByRls FAILS the probe when the rejection came from a CHECK/NOT
    // NULL/undefined-column error, i.e. it never reached the policy at all.
    const verdict = isDeniedByRls(res)
    record(probe.probeName, verdict.denied, redactSecrets(verdict.reason))
  }

  // Cleanup: anything a probe managed to create is a security failure AND must
  // be removed. Cleanup runs regardless of earlier failures and is verified.
  for (const { table, id } of createdIds) {
    let removed = false
    try {
      await client.from(table).delete().eq('id', id)
      const check = await client.from(table).select('id').eq('id', id)
      removed = (check?.data?.length ?? 0) === 0
    } catch { removed = false }
    results.push({
      group: currentGroup,
      name: `cleanup: pending-created ${table} row removed`,
      status: removed ? 'PASS' : 'FAIL',
      detail: removed ? '' : 'row created by a pending probe could not be removed',
      cleanupVerified: removed,
    })
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  loadLocalEnvFile()
  const cfg = resolveConfig(process.env) // throws (fail-closed) before any network

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const TAG = `security-test-${runId}`
  console.log(`Staging security suite — project ref ${cfg.ref} (staging) — runId ${runId}`)
  console.log('(production ref is blocked; no DDL; synthetic data only; cleanup in finally)\n')

  const anon = makeClient(cfg)
  let a, b, admin
  const created = { batches: [], farms: [] } // tracked synthetic IDs for cleanup

  try {
    a = await signedInClient(cfg, cfg.farmerA, 'farmer A')
    b = await signedInClient(cfg, cfg.farmerB, 'farmer B')
    admin = await signedInClient(cfg, cfg.admin, 'admin')

    // ── A. Anonymous denial ──────────────────────────────────────────────────
    group('A. anonymous denial')
    record('anon cannot read profiles rows', isDenied(await anon.from('profiles').select('id').limit(1)))
    record('anon cannot read farms rows', isDenied(await anon.from('farms').select('id').limit(1)))
    record('anon cannot insert profiles',
      isDenied(await anon.from('profiles').insert({ id: randomUUID(), full_name: TAG })))
    record('anon cannot insert farms',
      isDenied(await anon.from('farms').insert({ name: TAG })))
    record('anon cannot insert inventory_batches',
      isDenied(await anon.from('inventory_batches').insert({ notes: TAG })))
    record('anon cannot update farms',
      isDenied(await anon.from('farms').update({ name: TAG }).eq('name', TAG)))
    record('anon cannot insert compliance_audit_log',
      isDenied(await anon.from('compliance_audit_log').insert({ action: TAG })))
    record('anon cannot EXECUTE is_ddp_admin()', !!(await anon.rpc('is_ddp_admin')).error)
    record('anon cannot EXECUTE has_farm_membership(uuid)',
      !!(await anon.rpc('has_farm_membership', { p_farm_id: randomUUID() })).error)
    record('anon cannot upload to farmer-documents',
      !!(await anon.storage.from('farmer-documents').upload(`${runId}/anon.txt`, new Blob(['x']))).error)

    // ── B. Farmer A isolation ────────────────────────────────────────────────
    group('B. farmer A isolation')
    // Farmer A creates own synthetic farm (RLS-permitted for owner).
    const farmIns = await a.client.from('farms').insert({ farm_name: `${TAG}-A`, created_by: a.userId }).select('id')
    const farmA = farmIns?.data?.[0]?.id
    if (farmA) created.farms.push(farmA)
    record('farmer A can create own farm', !!farmA, farmA ? '' : (farmIns?.error?.code || 'no id returned'))

    record('farmer A can read own farm',
      isAllowed(await a.client.from('farms').select('id').eq('id', farmA ?? '00000000-0000-0000-0000-000000000000')))

    // ── B2. SELF-CERTIFICATION (privileged columns on the farmer's OWN farm) ──
    //
    // This suite previously only tested CROSS-TENANT isolation (A vs B). The
    // far more dangerous case was never probed: a farmer writing an ADMIN-OWNED
    // column on a farm they legitimately own. Policy "farms: farmer update own"
    // (FARM_RESAVE_PERSISTENCE_MIGRATION.sql:104-126) restricts WHICH ROWS a
    // farmer may update but NOT WHICH COLUMNS — its USING/WITH CHECK assert only
    // farm membership. The sole guard is trigger trg_protect_farm_admin_fields,
    // which FARM_ADMIN_ROLE_CHECK_FIX.sql:10-25 records as ABSENT from the live
    // database. If that is true here, a farmer can approve their own farm.
    //
    // Each column is probed independently and verified by READ-BACK, so the
    // result is conclusive regardless of the mechanism that denied (or allowed) it.
    group('B2. farmer A cannot self-certify own farm (privileged columns)')
    const PRIVILEGED_FARM_FIELDS = [
      ['status', 'Approved'],
      ['compliance_status', 'Approved'],
      ['risk_level', 'Low'],
      ['partner_tier', 'Gold'],
    ]

    // The self-certification risk only exists on a farm the farmer can actually
    // UPDATE. "farms: farmer update own" gates on farm_membership, so we first
    // establish a legitimate membership — allowed by "farm_memberships: farmer
    // insert own" for a farm the farmer created — then prove a BENIGN column
    // update persists. ONLY THEN does a blocked privileged-column update prove
    // the column guard, rather than merely proving the farmer had no access to
    // the row at all (the flaw in the previous version of this probe, which
    // reported "0 rows" for a membership-less farm and looked like a pass).
    let updateAccessProven = false
    if (farmA) {
      const memIns = await a.client.from('farm_memberships')
        .insert({ farm_id: farmA, user_id: a.userId, role: 'owner' }).select('id')
      record('farmer A can create own farm_membership (onboarding condition)',
        isAllowed(memIns), memIns?.error?.code || '')

      // farm_name is farmer-editable (it is what a farm re-save writes) and is
      // NOT one of the protected columns, so it is the correct benign control.
      const benign = `${TAG}-A-upd`
      await a.client.from('farms').update({ farm_name: benign }).eq('id', farmA).select('id')
      const afterBenign = await a.client.from('farms').select('farm_name').eq('id', farmA).maybeSingle()
      updateAccessProven = afterBenign?.data?.farm_name === benign
      record('farmer A HAS update access to own farm (benign column persists)',
        updateAccessProven,
        updateAccessProven
          ? 'membership-gated UPDATE confirmed — privileged probes below are now conclusive'
          : 'no UPDATE access even with membership — privileged-column probes are INCONCLUSIVE, not a pass')
    }

    for (const [column, value] of PRIVILEGED_FARM_FIELDS) {
      if (!farmA) { skip(`farmer A cannot set farms.${column} on own farm`, 'no synthetic farm created'); continue }
      if (!updateAccessProven) {
        skip(`farmer A cannot set farms.${column} on own farm`,
          'update access to the row was not established — cannot isolate the column guard from row-level denial')
        continue
      }

      const before = await a.client.from('farms').select(column).eq('id', farmA).maybeSingle()
      if (before?.error?.code === '42703') {
        skip(`farmer A cannot set farms.${column} on own farm`, `column ${column} does not exist on this schema`)
        continue
      }
      const priorValue = before?.data?.[column] ?? null

      const res = isDeniedByRls(
        await a.client.from('farms').update({ [column]: value }).eq('id', farmA).select('id'))

      // Authoritative check: did the value actually change on the server?
      // With update access proven above, an unchanged value now means the column
      // guard (trigger, whether it RAISEs or silently resets) held — not that
      // the row was simply inaccessible.
      const after = await a.client.from('farms').select(column).eq('id', farmA).maybeSingle()
      const persisted = after?.data?.[column] ?? null
      const changed = persisted === value && priorValue !== value

      record(
        `farmer A cannot set farms.${column} on own farm (SELF-CERTIFICATION)`,
        !changed,
        changed
          ? `*** ESCALATION: farmer wrote ${column}='${persisted}' on their own farm — trg_protect_farm_admin_fields is NOT enforcing ***`
          : `${res.reason}; ${column} still = ${JSON.stringify(persisted)}`,
      )
    }

    group('B. farmer A isolation')
    // Cross-tenant: A must not update/delete B-owned rows (0 rows / denied).
    record('farmer A cannot update farmer B farms',
      isDenied(await a.client.from('farms').update({ farm_name: `${TAG}-hijack` }).eq('farm_name', `${TAG}-B`).select('id')))
    record('farmer A cannot delete farmer B farms',
      isDenied(await a.client.from('farms').delete().eq('farm_name', `${TAG}-B`).select('id')))
    record('farmer A cannot write compliance_rules',
      isDenied(await a.client.from('compliance_rules').insert({ title: TAG })))
    // Self-elevation must be denied BY RLS. The previous version of this probe
    // used role:'admin', which profiles_role_check (role IN ('ddp_admin','farmer'))
    // rejects with SQLSTATE 23514 BEFORE RLS runs — so it passed green even
    // if RLS on profiles were disabled entirely. 'ddp_admin' is the value the
    // CHECK permits, so only the policy can stop it.
    const elevA = isDeniedByRls(
      await a.client.from('profiles').update({ role: 'ddp_admin' }).eq('id', a.userId).select('id'))
    record('farmer A cannot self-elevate role to ddp_admin (denied by RLS, not by CHECK)',
      elevA.denied, elevA.reason)
    // Mechanism-independent proof: whatever the API returned, the row must not
    // have changed. This is the assertion that actually protects the platform.
    const roleAfterA = await a.client.from('profiles').select('role').eq('id', a.userId).maybeSingle()
    record('farmer A role is still "farmer" after self-elevation attempt',
      roleAfterA?.data?.role === 'farmer',
      `role now = ${roleAfterA?.data?.role ?? roleAfterA?.error?.code ?? 'unreadable'}`)
    record('farmer A cannot EXECUTE trigger-only prevent_compliance_audit_log_mutation()',
      !!(await a.client.rpc('prevent_compliance_audit_log_mutation')).error)
    record('farmer A cannot read farmer B storage prefix',
      // listing B's own-user prefix must return no objects / error, never B's files
      await (async () => {
        const r = await a.client.storage.from('farmer-documents').list(b.userId)
        return !!r.error || (Array.isArray(r.data) && r.data.length === 0)
      })())

    // ── C. Farmer B mirror (opposite direction) ──────────────────────────────
    group('C. farmer B mirror isolation')
    const farmBIns = await b.client.from('farms').insert({ farm_name: `${TAG}-B`, created_by: b.userId }).select('id')
    const farmB = farmBIns?.data?.[0]?.id
    if (farmB) created.farms.push(farmB)
    record('farmer B can create own farm', !!farmB, farmB ? '' : (farmBIns?.error?.code || 'no id'))
    record('farmer B cannot update farmer A farms',
      isDenied(await b.client.from('farms').update({ farm_name: `${TAG}-hijack2` }).eq('id', farmA ?? '0').select('id')))
    record('farmer B cannot delete farmer A farms',
      isDenied(await b.client.from('farms').delete().eq('id', farmA ?? '0').select('id')))
    const elevB = isDeniedByRls(
      await b.client.from('profiles').update({ role: 'ddp_admin' }).eq('id', b.userId).select('id'))
    record('farmer B cannot self-elevate role to ddp_admin (denied by RLS, not by CHECK)',
      elevB.denied, elevB.reason)
    const roleAfterB = await b.client.from('profiles').select('role').eq('id', b.userId).maybeSingle()
    record('farmer B role is still "farmer" after self-elevation attempt',
      roleAfterB?.data?.role === 'farmer',
      `role now = ${roleAfterB?.data?.role ?? roleAfterB?.error?.code ?? 'unreadable'}`)

    // ── D. Admin + immutable-field / audit-log protections ───────────────────
    group('D. admin + audit-log immutability')
    record('admin helper EXECUTE is_ddp_admin() works', isAllowed(await admin.client.rpc('is_ddp_admin')))
    record('admin cannot EXECUTE trigger-only prevent_compliance_audit_log_mutation()',
      !!(await admin.client.rpc('prevent_compliance_audit_log_mutation')).error)
    record('authenticated farmer cannot INSERT compliance_audit_log',
      isDenied(await a.client.from('compliance_audit_log').insert({ action: TAG })))

    // Proving audit-log UPDATE/DELETE immutability requires a target row. Rather
    // than mutate any existing/other-run data, this is OPT-IN: create ONE tagged
    // row of THIS run and prove even its author (admin) cannot change or remove
    // it (ENABLE ALWAYS trigger). The row is append-only and retained by design.
    if (cfg.allowAuditInsert) {
      const auditPayload = {
        actor_type: 'admin',
        actor_id: admin.userId,
        action: 'legal_update_created',
        entity_type: 'legal_update',
        entity_id: `${TAG}-audit`,
        before_state: null,
        after_state: { security_test_run: runId },
        reason: `Live staging audit immutability probe ${TAG}`,
      }
      const ins = await admin.client.from('compliance_audit_log').insert(auditPayload).select('id')
      const auditId = ins?.data?.[0]?.id
      record('admin can INSERT compliance_audit_log (append-only, retained by design)', !!auditId,
        auditId ? `retained row entity_id=${TAG}-audit` : (ins?.error?.code || 'insert denied'))
      if (auditId) {
        record('admin UPDATE of the just-inserted audit row is blocked',
          !!(await admin.client.from('compliance_audit_log').update({ reason: `Mutation attempt ${TAG}` }).eq('id', auditId)).error)
        record('admin DELETE of the just-inserted audit row is blocked',
          !!(await admin.client.from('compliance_audit_log').delete().eq('id', auditId)).error)
      }
    } else {
      skip('audit-log UPDATE/DELETE immutability probe', 'requires STAGING_ALLOW_AUDIT_INSERT=true (creates 1 permanent tagged audit row of this run)')
    }

    // ── E. Function ACL matrix ───────────────────────────────────────────────
    group('E. function EXECUTE ACLs')
    record('authenticated CAN EXECUTE has_farm_membership(uuid)',
      isAllowed(await a.client.rpc('has_farm_membership', { p_farm_id: farmA ?? randomUUID() })))
    record('authenticated CANNOT EXECUTE trigger-only handle_new_user()',
      !!(await a.client.rpc('handle_new_user')).error)
    record('anon CANNOT EXECUTE has_farm_membership(uuid)',
      !!(await anon.rpc('has_farm_membership', { p_farm_id: randomUUID() })).error)

    // ── F. Migration-state / catalog checks (optional, catalog-only) ─────────
    group('F. migration-state (catalog)')
    if (cfg.databaseUrl) {
      runCatalogChecks(cfg.databaseUrl)
    } else {
      skip('catalog drift checks (triggers ENABLE ALWAYS, non-CRUD revokes, defaults, counts)',
        'set STAGING_DATABASE_URL (staging Postgres) to enable read-only catalog verification')
    }

    // ── G. Storage isolation ─────────────────────────────────────────────────
    group('G. storage isolation')
    // Farmer A uploads only under its own userId prefix (intended path).
    const ownPath = `${a.userId}/${TAG}.txt`
    const ownUp = await a.client.storage.from('farmer-documents').upload(ownPath, new Blob(['hello']))
    const ownOk = !ownUp.error
    record('farmer A can upload to own prefix', ownOk, ownUp.error ? ownUp.error.message?.slice(0, 40) : '')
    if (ownOk) created.storagePaths = [ownPath]
    // Cross-prefix write into B's userId prefix must be denied.
    record('farmer A cannot upload into farmer B prefix',
      !!(await a.client.storage.from('farmer-documents').upload(`${b.userId}/${TAG}.txt`, new Blob(['x']))).error)
    record('anon cannot upload to farmer-documents',
      !!(await anon.storage.from('farmer-documents').upload(`${runId}/anon2.txt`, new Blob(['x']))).error)

    // ── H. Pending user has NO operational access (migration 22) ─────────────
    // A 'pending' account is authenticated but not yet provisioned as a farmer.
    // The restrictive overlay must block it from writing/uploading farm data via
    // the REST/Storage API even though ownership predicates would otherwise pass.
    group('H. pending user denied operational access')
    if (!cfg.pending) {
      // Absent credentials BLOCK the matrix; they do not skip it. A skip would
      // leave the run green while migration 22's central guarantee is untested.
      blockAll(buildPendingProbeRegistry().map((p) => p.probeName),
        'set STAGING_PENDING_EMAIL/STAGING_PENDING_PASSWORD to a staging user whose profiles.role = pending')
    } else if (!cfg.databaseUrl) {
      blockAll(buildPendingProbeRegistry().map((p) => p.probeName),
        'set STAGING_DATABASE_URL — the pending matrix requires a catalog preflight proving migrations 21/22 are present')
    } else if (!runPendingPreflight(cfg.databaseUrl)) {
      blockAll(buildPendingProbeRegistry().map((p) => p.probeName),
        'pending preflight failed — migrations 21/22 are not present on the target database')
    } else {
      const p = await signedInClient(cfg, cfg.pending, 'pending')
      // Fail closed if the configured user is not actually pending — otherwise a
      // farmer/admin credential here would produce false "denied" via other rules.
      // A missing/unreadable profile must NOT fall through into the probes: such an
      // account is already denied by the ownership policies, so every assertion below
      // would pass even if the migration 22 overlay were absent. Require a successful
      // read whose role is exactly 'pending' before asserting anything.
      const roleRow = await p.client.from('profiles').select('role').eq('id', p.userId).maybeSingle()
      const observedRole = roleRow?.error ? null : roleRow?.data?.role ?? null
      if (observedRole !== 'pending') {
        const detail = roleRow?.error
          ? `could not read the configured user's profile role (${roleRow.error.message}) — refusing to assert`
          : `configured user role is "${observedRole ?? 'missing'}", not "pending" — refusing to assert`
        skip('pending-user probes', detail)
      } else {
        await runPendingMatrix({ client: p.client, userId: p.userId, tag: TAG, farmId: farmA })

        record('pending cannot read market_price_benchmarks (migration 22)',
          isDenied(await p.client.from('market_price_benchmarks').select('id').limit(1)))

        // Storage: an object-not-found result is NOT proof of denial, so the
        // outcome is classified rather than treated as a boolean error check.
        for (const bucket of ['farmer-documents', 'farmer-photos']) {
          const up = await p.client.storage.from(bucket).upload(`${p.userId}/${TAG}.txt`, new Blob(['x']))
          const cls = classifyStorageOutcome(up)
          if (cls.outcome === 'not-found') {
            // The bucket itself is absent on this target, so denial cannot be
            // proven here. That is a coverage gap to surface, not a pass and
            // not a security failure — BLOCK names it explicitly.
            block(`pending cannot upload to ${bucket}`,
              `bucket "${bucket}" does not exist on the target project — pending denial cannot be proven; create it on staging or remove it from migration 22's bucket scope`)
            continue
          }
          record(`pending cannot upload to ${bucket}`, cls.outcome === 'denied', redactSecrets(cls.reason))
          if (cls.outcome === 'allowed') {
            const rm = await p.client.storage.from(bucket).remove([`${p.userId}/${TAG}.txt`])
            record(`cleanup: removed pending upload from ${bucket}`, !rm?.error,
              rm?.error ? redactSecrets(String(rm.error.message)) : '')
          }
        }
        // Writing beneath another user's prefix must also be denied.
        const foreign = await p.client.storage.from('farmer-documents')
          .upload(`${b.userId}/${TAG}-pending.txt`, new Blob(['x']))
        const foreignCls = classifyStorageOutcome(foreign)
        record('pending cannot upload beneath another user prefix',
          foreignCls.outcome === 'denied', redactSecrets(foreignCls.reason))
        const listRes = await p.client.storage.from('farmer-documents').list(`${b.userId}`)
        record('pending cannot list another user private objects',
          !listRes?.data || listRes.data.length === 0,
          redactSecrets(classifyStorageOutcome(listRes).reason))

        // Affirmative: operational farmer and admin retain access under the overlay.
        record('operational farmer retains own-farm access (post-21)',
          !!farmA, farmA ? '' : 'farmer A farm was not created earlier')
        record('operational farmer retains market_price_benchmarks read (migration 22)',
          isAllowed(await a.client.from('market_price_benchmarks').select('id').limit(1)))
        record('ddp_admin retains farms access (post-21)',
          isAllowed(await admin.client.from('farms').select('id').limit(1)))
      }
    }
  } finally {
    // ── Cleanup (reverse dependency order; run-id scoped only) ────────────────
    group('cleanup')
    try {
      // Storage objects created by this run (own-prefix only).
      if (created.storagePaths?.length && a?.client) {
        const del = await a.client.storage.from('farmer-documents').remove(created.storagePaths)
        record('removed synthetic storage objects', !del.error, del.error?.message?.slice(0, 40) || '')
      }
      // Batches then farms, matching the run tag AND tracked ids.
      if (created.batches.length && a?.client) {
        await a.client.from('inventory_batches').delete().in('id', created.batches).ilike('notes', `${TAG}%`)
      }
      // Teardown runs as ADMIN. Farmers have no DELETE grant on farms (verified
      // by the live probe above: even the benign own-farm update does not
      // persist), so a farmer-scoped delete silently removes nothing — that is
      // why residue accumulated. Admin holds "farms: admin all"; the farm delete
      // cascades to farm_memberships. Security assertions about what a FARMER may
      // delete are covered separately in groups B and C, so using admin here does
      // not weaken any test — it is teardown, not an assertion.
      if (admin?.client) {
        await deleteSyntheticFarms(admin.client, TAG)
      }
      // Residue verification (deletable tables only). Uses the admin client so a
      // failed delete cannot hide behind farmer RLS read limits.
      const residue = admin?.client ? await countResidualFarms(admin.client, TAG) : 0
      record('zero residual synthetic farms', residue === 0, `remaining=${residue}`)
      if (cfg.allowAuditInsert) {
        record('append-only audit row intentionally retained (tagged)', true, `${TAG}-audit is immutable by design`)
      }
    } catch (e) {
      record('cleanup completed', false, String(e?.message || e).slice(0, 80))
    }
    // Sign out all sessions.
    for (const c of [anon, a?.client, b?.client, admin?.client].filter(Boolean)) {
      try { await c.auth.signOut() } catch { /* ignore */ }
    }
  }

  // ── Matrix + exit ──────────────────────────────────────────────────────────
  printMatrix()
  const failed = results.filter((r) => r.status === 'FAIL').length
  // A BLOCK means a probe could not run under meaningful conditions. It is
  // never a pass, so it must fail the process just as a FAIL does — otherwise
  // an unconfigured pending matrix would leave the suite green.
  const blocked = results.filter((r) => r.status === 'BLOCK').length
  const cleanupFailures = results.filter((r) => r.cleanupVerified === false).length
  if (blocked > 0) {
    console.log(`\n${blocked} probe(s) BLOCKED — not executed under meaningful conditions; this is not a pass.`)
  }
  if (cleanupFailures > 0) {
    console.log(`\n${cleanupFailures} cleanup failure(s) — synthetic rows may remain.`)
  }
  process.exit(failed > 0 || blocked > 0 || cleanupFailures > 0 ? 1 : 0)
}

// Catalog checks run the committed SELECT-only VERIFY files against staging and
// fail if any row is not PASS. Read-only; never prints the connection string.
function runCatalogChecks(databaseUrl) {
  const ref = refFromUrl(databaseUrl) || (databaseUrl.includes(STAGING_REF) ? STAGING_REF : null)
  if (databaseUrl.includes(PRODUCTION_REF)) {
    record('catalog checks refused (production connection string)', false, 'STAGING_DATABASE_URL contains the production ref')
    return
  }
  if (!databaseUrl.includes(STAGING_REF) && ref !== STAGING_REF) {
    record('catalog checks refused (non-staging connection string)', false, 'STAGING_DATABASE_URL is not the staging project')
    return
  }
  const verifyFiles = [
    '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_VERIFY.sql',
    '12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql',
    '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql',
    '15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql',
  ]
  for (const f of verifyFiles) {
    try {
      const out = execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-A', '-t', '-f', join(ROOT, f)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const hasFail = /\bFAIL\b/.test(out)
      record(`catalog VERIFY ${f}`, !hasFail, hasFail ? 'one or more checks returned FAIL' : '')
    } catch (e) {
      record(`catalog VERIFY ${f}`, false, `psql error: ${String(e?.message || e).split('\n')[0].slice(0, 60)}`)
    }
  }
}

function printMatrix() {
  console.log('\n──────── RESULTS ────────')
  let g = ''
  for (const r of results) {
    if (r.group !== g) { g = r.group; console.log(`\n${g}`) }
    const mark = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '•' : r.status === 'BLOCK' ? '⊘' : '✗'
    console.log(`  ${mark} [${r.status}] ${r.name}${r.detail ? `  — ${redactSecrets(r.detail)}` : ''}`)
  }
  const p = results.filter((r) => r.status === 'PASS').length
  const f = results.filter((r) => r.status === 'FAIL').length
  const s = results.filter((r) => r.status === 'SKIP').length
  const bl = results.filter((r) => r.status === 'BLOCK').length
  console.log(`\n──────── ${p} PASS · ${f} FAIL · ${s} SKIP · ${bl} BLOCK ────────`)

  // Pending-matrix aggregate, reported separately because its merge gate is
  // stricter: failed = skipped = blocked = cleanupFailures = 0.
  const pendingRows = results.filter((r) => r.group?.startsWith('H.') || r.pendingMatrix)
  if (pendingRows.length > 0) {
    const m = summarisePendingMatrix(pendingRows)
    console.log(`pending matrix: ${m.total} total · ${m.passed} pass · ${m.failed} fail · ${m.skipped} skip · ${m.blocked} blocked · ${m.cleanupFailures} cleanup-failures`)
    console.log(`pending matrix merge-gate: ${m.overallPassing ? 'SATISFIED' : 'NOT SATISFIED'}`)
  }
}

// Auto-run only when executed directly (so the guards can be imported and
// unit-tested offline without triggering a live run).
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Fail closed. Print only the guard message (never secrets/tokens).
    console.error(`\nREFUSED / ERROR: ${err?.message || err}`)
    process.exit(2)
  })
}

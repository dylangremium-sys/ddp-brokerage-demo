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
// Structured outcome of the run-scoped storage teardown (evaluateStorageCleanup).
// Held separately from the result rows so the exit rule can read the residual
// count directly rather than re-deriving it from printed text.
let storageCleanupVerdict = null
let currentGroup = 'setup'
function group(name) { currentGroup = name }
function record(name, ok, detail = '') {
  results.push({ group: currentGroup, name, status: ok ? 'PASS' : 'FAIL', detail })
}
// Teardown results carry an explicit `kind: 'cleanup'` so the exit rule can see
// them. The previous design derived cleanup failures from `r.cleanupVerified ===
// false`, a property `record()` never set — so a storage teardown failure was
// structurally incapable of being counted, and `0 cleanup-failures` was printed
// alongside genuine residue.
function recordCleanup(name, ok, detail = '') {
  results.push({ group: currentGroup, name, status: ok ? 'PASS' : 'FAIL', detail, kind: 'cleanup' })
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
// `requires` names a fixture the probe needs to be MEANINGFUL.
//
// SELECT/UPDATE/DELETE against a table with NO MATCHING ROW returns an empty
// result — "0 rows" — which is indistinguishable from an RLS denial. Such a
// probe reports PASS while proving nothing.
//
// A farm id alone does NOT establish that: the suite creates rows only in
// `farms` and `farm_memberships`, so for the other nine tables a probe filtered
// on farm_id = <fixture farm> matched nothing and passed vacuously. Each of
// those probes therefore requires a fixture ROW IN ITS OWN TABLE, seeded by the
// admin client and read back before the matrix runs. When that row is absent the
// probe is BLOCKED (never silently skipped or passed).
//
// INSERT is the exception: it is self-evidencing. It either succeeds (a security
// failure) or is rejected, with no empty-result ambiguity — so it needs only the
// parent farm to satisfy foreign keys.
const FIXTURE_FARM = 'farmFixture'

/** Fixture key for "a row exists in <table> matching this table's probe filter". */
export function tableFixtureKey(table) {
  return `row:${table}`
}

export function buildPendingProbeRegistry() {
  const rows = []
  for (const table of MIGRATION_22_TABLES) {
    const row = tableFixtureKey(table)
    rows.push({ table, operation: 'select', requires: [row] })
    rows.push({ table, operation: 'insert', requires: table === 'farms' ? [] : [FIXTURE_FARM] })
    rows.push({ table, operation: 'update', requires: [row] })
    rows.push({ table, operation: 'delete', requires: [row] })
  }
  return rows.map((r) => ({ ...r, probeName: `pending cannot ${r.operation} ${r.table}` }))
}

// ── Pending-matrix fail-closed gate ─────────────────────────────────────────
//
// Classify the configured pending account's profile-role read. The pending
// matrix is only meaningful when the account is PROVEN to be 'pending': a
// farmer/admin credential would be denied by ownership rules, and a missing or
// unreadable profile is denied by them too, so in every such case the probes
// would "pass" even if the migration 22 overlay were absent.
//   proven === false  =>  the whole probe registry is BLOCKed and no
//                         pending-user database operation is attempted.
export function resolvePendingRoleGate(roleRow) {
  const observedRole = roleRow?.error ? null : roleRow?.data?.role ?? null
  if (observedRole === 'pending') return { proven: true, observedRole, detail: null }
  return {
    proven: false,
    observedRole,
    detail: roleRow?.error
      ? `could not read the configured user's profile role (${roleRow.error.message}) — refusing to assert`
      : `configured user role is "${observedRole ?? 'missing'}", not "pending" — refusing to assert`,
  }
}

// The gate ACTION used by group H. Kept here (rather than inline in main) so the
// real production branch — not a copy of it — is exercised by the regression
// test. An unproven account records EVERY registry probe as BLOCK, which the
// exit rule counts as a non-pass; it must never record a SKIP, because SKIP is
// counted by neither `failed` nor `blocked` and would leave the suite green
// while migration 22's central guarantee went untested.
//   block:     (name, reason) => void   — records one BLOCK row
//   runMatrix: () => Promise|any        — the pending-user probes; only invoked
//                                         when the account is proven pending
export async function applyPendingGate(roleRow, { block, runMatrix }) {
  const gate = resolvePendingRoleGate(roleRow)
  if (!gate.proven) {
    for (const probe of buildPendingProbeRegistry()) block(probe.probeName, gate.detail)
    return { ran: false, gate }
  }
  return { ran: true, gate, result: await runMatrix() }
}

// The suite's exit rule. A BLOCK is never a pass — it must fail the process just
// as a FAIL does, otherwise an unconfigured or unprovable pending matrix would
// leave the suite green. Pure and exported so that rule is directly testable.
export function computeExitCode({ failed = 0, blocked = 0, cleanupFailures = 0, storageResidue = 0 } = {}) {
  return computeSecurityHarnessExitCode({ failed, blocked, cleanupFailures, storageResidue })
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
    // business_info carries the run tag so an ambiguous INSERT can be located
    // by admin readback: farm_id alone also matches the seeded fixture row.
    case 'farm_profiles': return { farm_id: farmId, business_info: { probe: `${tag}-P` } }
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

// ── Pending-matrix fixture seeding ──────────────────────────────────────────
//
// Guarantees that every table a SELECT/UPDATE/DELETE probe targets actually
// CONTAINS a row matching that probe's filter. Without this, "0 rows" means
// "nothing was there" and the probe passes without exercising any policy.
//
// Seeded with the ADMIN client. An admin satisfies both the pre-existing
// permissive admin policies and the migration 22 restrictive overlay (via
// is_ddp_admin()), so seeding succeeds on every table without depending on the
// farmer's narrower write policies — and, importantly, a row the ADMIN can
// create but the PENDING user cannot see or modify is exactly the subject the
// probes need.
//
// Uniform adopt-or-seed per table:
//   1. adopt an existing row matching the probe's filter (groups B/B2 already
//      create the fixture farm and the farmer's own membership);
//   2. otherwise insert one and READ IT BACK THROUGH THE PROBE'S OWN FILTER —
//      confirming the row is matched by what the probe will actually query,
//      not merely that an insert returned an id;
//   3. `farms` is never seeded: its probe filter is the fixture farm's own id,
//      so either that farm exists or the whole matrix has no subject.
//
// A fixture that cannot be confirmed is reported ABSENT, which BLOCKS its probes.
// Blocking is a non-pass at the exit rule, so an unseedable table fails the run
// instead of silently reporting a vacuous PASS.
export async function seedPendingFixtureRows(adminClient, ctx) {
  const { tag, farmId, farmerUserId } = ctx
  const fixtures = {}
  const created = []
  const notes = []

  if (!farmId) {
    return { fixtures, created, notes: ['no fixture farm was created — every pending probe is blocked'] }
  }
  fixtures[FIXTURE_FARM] = farmId

  for (const table of MIGRATION_22_TABLES) {
    const column = pendingFilterColumn(table)
    try {
      const existing = await adminClient.from(table).select('id').eq(column, farmId).limit(1)
      if (!existing?.error && (existing?.data?.length ?? 0) > 0) {
        fixtures[tableFixtureKey(table)] = existing.data[0].id
        continue
      }
      if (table === 'farms') {
        notes.push(`farms: the fixture farm ${farmId} is not readable by the admin — probes blocked`)
        continue
      }

      const ins = await adminClient
        .from(table)
        .insert(pendingInsertPayload(table, { tag: `${tag}-FX`, userId: farmerUserId, farmId }))
        .select('id')
      const id = ins?.data?.[0]?.id
      if (ins?.error || !id) {
        notes.push(`${table}: admin could not seed a fixture row (${ins?.error?.code || ins?.error?.message || 'no id returned'})`)
        continue
      }
      created.push({ table, id })

      const back = await adminClient.from(table).select('id').eq(column, farmId).limit(1)
      if (back?.error || (back?.data?.length ?? 0) === 0) {
        notes.push(`${table}: seeded row is not matched by ${column} = fixture farm — fixture unconfirmed`)
        continue
      }
      fixtures[tableFixtureKey(table)] = id
    } catch (e) {
      notes.push(`${table}: fixture seeding threw (${String(e?.message || e).slice(0, 60)})`)
    }
  }
  return { fixtures, created, notes }
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

// The private buckets proven by differential, each with a payload that
// satisfies its own MIME allowlist. farmer-photos accepts image/* only (see
// FARMER_MVP_MIGRATION.sql), so a text blob would be rejected by content-type
// validation BEFORE any policy ran and would prove nothing.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%%EOF\n')
export const STORAGE_ATTRIBUTION_BUCKETS = Object.freeze([
  { bucket: 'farmer-documents', ext: 'pdf', contentType: 'application/pdf', bytes: PDF_BYTES },
  { bucket: 'farmer-photos', ext: 'jpg', contentType: 'image/jpeg', bytes: JPEG_BYTES },
])

// ── Storage policy attribution ──────────────────────────────────────────────
//
// A 403 for the pending user proves nothing on its own. If NO permissive policy
// exists for a bucket, PostgreSQL denies everyone — pending, farmer and anon
// alike — and the run would score that 403 as a security pass. That exact
// false-positive was live on staging: the farmer-photos bucket had zero
// permissive policies, so migration 22's overlay was never the deciding factor.
//
// The only sound proof is a differential: an operational farmer's own-scope
// request must be ALLOWED while the pending user's structurally identical
// request is DENIED. Then the restrictive overlay is the sole differing
// condition. This is pure so it can be regression-tested offline.
//
// obs: { bucketExists, farmerControl, pendingSubject, crossPrefix, cleanupVerified }
// where each outcome is a classifyStorageOutcome() result string.
export function evaluateStorageAttribution(obs) {
  const o = obs || {}
  const blocked = (reason) => ({ status: 'BLOCK', attributable: false, reason })
  const failed = (reason) => ({ status: 'FAIL', attributable: false, reason })

  if (o.bucketExists === false) {
    return blocked('bucket does not exist on the target project — denial would be absence, not policy')
  }
  // A pending write that SUCCEEDS is a security failure even if cleanup works.
  if (o.pendingSubject === 'ALLOWED') {
    return failed('SECURITY FAILURE: pending user completed an operational storage write')
  }
  if (o.crossPrefix === 'ALLOWED') {
    return failed('SECURITY FAILURE: cross-prefix write succeeded — path ownership is not enforced')
  }
  // The control must genuinely succeed, or there is nothing to attribute to.
  if (o.farmerControl !== 'ALLOWED') {
    return blocked(`operational-farmer control was ${o.farmerControl ?? 'not run'} — with no permissive grant every actor is denied, so the pending denial cannot be attributed to the migration 22 overlay`)
  }
  // The subject's denial must come from the authorization layer, not from MIME
  // validation, a malformed path, or a missing object.
  if (o.pendingSubject !== 'DENIED-BY-POLICY' && o.pendingSubject !== 'denied') {
    return blocked(`pending denial classified as "${o.pendingSubject ?? 'unknown'}" — only an authorization-layer denial proves the overlay`)
  }
  // NOTE: teardown is deliberately NOT part of this verdict. Cleanup and access
  // control are separate result categories — folding them together meant a
  // teardown defect was reported as a policy failure (and, worse, that cleanup
  // "success" read as evidence the overlay enforced). Residue is asserted
  // independently by the run-scoped storage sweep.
  return {
    status: 'PASS',
    attributable: true,
    reason: 'operational farmer allowed, pending denied on an identical request — denial attributable to the migration 22 restrictive overlay',
  }
}

// ── Storage fixture teardown ────────────────────────────────────────────────
//
// WHY THIS EXISTS. Storage teardown used to be a farmer-client `remove()` whose
// result was accepted whenever `error` was falsy. Farmers hold no permissive
// DELETE policy on either farmer bucket (only "<bucket>: admin all" grants it),
// so those deletes matched zero rows; Supabase Storage answers an RLS no-op with
// `{ data: [], error: null }`, which the old check read as success. Only one of
// the four objects a healthy run creates was ever registered, and only one was
// ever read back — so 36 synthetic objects accumulated while runs reported clean.
//
// The rules below are the contract. Each helper is pure (or takes an injected
// list function) so every failure mode is provable offline, without a live
// project.

// Every bucket the harness may create an object in. The post-cleanup sweep must
// enumerate all of them — a residue check that inspects one bucket is how
// farmer-photos residue went unreported.
export const STORAGE_CLEANUP_BUCKETS = Object.freeze(['farmer-documents', 'farmer-photos'])

// A. ONE run-scoped registry. Append-only and deduplicated; never assignment.
// `created.storageObjects = [path]` (the previous form) silently discarded every
// earlier entry, which is why three of four objects were untracked.
export function registerStorageFixture(registry, entry) {
  if (!Array.isArray(registry)) throw new TypeError('storage registry must be an array')
  const { bucket, path, scenario, createdBy } = entry || {}
  if (!bucket || !path) throw new TypeError('a storage fixture requires both bucket and path')
  if (registry.some((e) => e.bucket === bucket && e.path === path)) return registry
  registry.push({
    bucket,
    path,
    scenario: scenario || 'unspecified',
    createdBy: createdBy || 'unknown',
  })
  return registry
}

// B. Teardown identity. Only `is_ddp_admin()` satisfies the farmer buckets'
// permissive ALL policy, so cleanup MUST hold the admin session. This is checked
// before any remove() call rather than after, so a misconfigured run fails loudly
// instead of silently deleting nothing.
export function assertAdminCleanupClient(session) {
  if (!session || !session.client) {
    return { ok: false, reason: 'storage cleanup requires an authenticated admin session; none was supplied' }
  }
  if (session.label !== 'admin') {
    return {
      ok: false,
      reason: `storage cleanup must run as the DDP admin session, not "${session.label ?? 'unknown'}" — farmers hold no DELETE grant on the farmer buckets, so a farmer-scoped delete removes nothing and reports no error`,
    }
  }
  return { ok: true, reason: '' }
}

// B2. THE AUTHORITATIVE cleanup-authority check.
//
// `label` above is assigned locally at the call site — `signedInClient(cfg,
// cfg.admin, 'admin')` — so it is a naming convention, not a proven role. If
// STAGING_ADMIN_* pointed at any other account that can sign in, a label-only
// check would pass, the delete would silently no-op, AND the residue sweep would
// go blind: under "farmer read own" a farmer sees only its own prefix and gets an
// empty list with no error for every other prefix. That is precisely the original
// false-clean condition, so authority must come from the database, not from us.
//
// Asks the database once, immediately before the cleanup phase. Fails closed on
// anything that is not a literal `true`.
export async function verifyAdminCleanupAuthority(session) {
  const deny = (kind, reason) => ({ ok: false, kind, reason })

  if (!session || !session.client) {
    return deny('invalid-session', 'storage cleanup requires an authenticated admin session; none was supplied')
  }
  if (!session.userId) {
    return deny('invalid-session', 'the cleanup session carries no user id — it is not a completed sign-in')
  }

  let res
  try {
    res = await session.client.rpc('is_ddp_admin')
  } catch (e) {
    return deny('rpc-failure', `is_ddp_admin() threw: ${String(e?.message || e).slice(0, 60)} — cleanup authority is unproven`)
  }
  if (!res || typeof res !== 'object') {
    return deny('inconclusive', 'is_ddp_admin() returned an unrecognised response shape — cleanup authority is unproven')
  }
  if (res.error) {
    return deny('rpc-failure', `is_ddp_admin() failed: ${String(res.error.message || res.error).slice(0, 60)} — cleanup authority is unproven`)
  }
  if (res.data === true) {
    return { ok: true, kind: 'verified-admin', reason: '' }
  }
  if (res.data === false) {
    return deny('not-admin', `is_ddp_admin() returned false for the configured cleanup account (label "${session.label ?? 'unknown'}") — it cannot delete from the farmer buckets, and its residue sweep would be blind`)
  }
  return deny('inconclusive', `is_ddp_admin() returned ${res.data === null ? 'null' : typeof res.data} rather than a boolean — cleanup authority is unproven`)
}

// C. DIAGNOSTIC ONLY — never a verdict.
//
// The pinned client documents a SUCCESSFUL remove() as `{ data: [], error: null }`
// (@supabase/storage-js 2.108.x, StorageFileApi.remove JSDoc; the declared success
// type is `FileObject[]`, which may be empty). An RLS no-op produces the very same
// shape. The payload therefore proves NOTHING in either direction: requiring it to
// echo the requested paths would fail every genuinely successful cleanup, and
// trusting a non-empty payload would re-introduce the original false "clean".
//
// This helper is retained only so the run can print what the API reported. It must
// never influence cleanup pass/fail, the cleanup failure count, the residue count,
// or the exit code. Deletion is proved solely by the paginated absence sweep.
export function compareRequestedAndDeletedPaths(requested, data) {
  const req = [...new Set((Array.isArray(requested) ? requested : []).filter(Boolean))]
  const rows = Array.isArray(data) ? data : []
  const deleted = new Set(
    rows
      .map((r) => (typeof r === 'string' ? r : (r?.name ?? r?.path ?? null)))
      .filter(Boolean),
  )
  const missing = req.filter((p) => !deleted.has(p))
  return {
    requested: req.length,
    deleted: req.length - missing.length,
    missing,
    ok: missing.length === 0,
  }
}

// D. Absence must be proven by an explicitly paginated sweep. The storage client
// defaults to limit:100 with no paging; because the residue check is a negative
// ("the tag is absent"), a truncated first page silently reads as clean — and
// these very prefixes are where residue accumulates.
export async function collectPaginatedRunObjects(listFn, opts = {}) {
  const { bucket = null, prefix = '', tag = null, pageSize = 100, maxPages = 200 } = opts
  if (typeof listFn !== 'function') throw new TypeError('collectPaginatedRunObjects requires a list function')
  const found = []
  let pages = 0
  for (let offset = 0; pages < maxPages; offset += pageSize) {
    const res = await listFn({ bucket, prefix, limit: pageSize, offset })
    pages += 1
    if (res?.error) return { error: res.error, found, pages, truncated: false }
    const rows = Array.isArray(res?.data) ? res.data : []
    for (const row of rows) {
      const name = typeof row === 'string' ? row : row?.name
      if (!name) continue
      if (tag && !name.includes(tag)) continue
      found.push({ bucket, name, path: prefix ? `${prefix}/${name}` : name })
    }
    // A short page is the end of the listing. Anything else means keep going.
    if (rows.length < pageSize) return { error: null, found, pages, truncated: false }
  }
  // Ran out of pages before the listing ended: report truncation rather than
  // claiming a clean sweep.
  return { error: null, found, pages, truncated: true }
}

// E/F. The cleanup verdict, as an explicit structure rather than an optional
// property bolted onto an ordinary result row. `cleanupFailures` used to be
// derived from `r.cleanupVerified === false`, a field `record()` never set — so
// storage cleanup failures were structurally invisible to the exit rule.
export function evaluateStorageCleanup(obs) {
  const o = obs || {}
  const created = Number(o.created ?? 0)
  const requested = Number(o.requested ?? 0)
  const deleted = Number(o.deleted ?? 0)
  const missing = Array.isArray(o.missing) ? o.missing : []
  const residual = Array.isArray(o.residual) ? o.residual : []
  const errors = Array.isArray(o.errors) ? o.errors : []
  const truncated = o.truncated === true
  const configError = o.configError || null

  // The verdict rests on the absence sweep, an explicit API error, a failed
  // identity check, or an incomplete listing — never on the remove() payload.
  // `deleted` and `missing` are carried for reporting only (see
  // compareRequestedAndDeletedPaths) and are deliberately absent from `problems`.
  const problems = []
  if (configError) problems.push(configError)
  if (errors.length) problems.push(`${errors.length} deletion/listing error(s): ${errors.slice(0, 3).join('; ')}`)
  if (truncated) problems.push('the post-cleanup listing was truncated — absence could not be proven')
  if (residual.length) problems.push(`${residual.length} current-run object(s) remain: ${residual.slice(0, 3).map((r) => `${r.bucket}/${r.path}`).join(', ')}`)

  return {
    ok: problems.length === 0,
    created,
    requested,
    residual,
    residualCount: residual.length,
    errors,
    truncated,
    // Non-authoritative diagnostics.
    reportedDeleted: deleted,
    notEchoed: missing,
    // Success is stated in sweep-derived terms only. The API response count is
    // carried as an explicitly non-authoritative aside — it is never called
    // "deleted", and it never decides anything.
    reason: problems.length === 0
      ? `cleanup verified: created=${created} requested=${requested} remaining=0 absenceSweep=clean (apiResponseItems=${deleted}, non-authoritative)`
      : problems.join(' | '),
  }
}

// The suite's exit rule, extended so current-run storage residue fails the run.
// A residual object is not a cosmetic problem: it means teardown did not do what
// the suite reported it did.
export function computeSecurityHarnessExitCode({ failed = 0, blocked = 0, cleanupFailures = 0, storageResidue = 0 } = {}) {
  return failed > 0 || blocked > 0 || cleanupFailures > 0 || storageResidue > 0 ? 1 : 0
}

// ── Matrix aggregation ──────────────────────────────────────────────────────
//
// The merge gate requires failed = skipped = blocked = cleanupFailures = 0.
// A blocked probe is explicitly NOT a pass.
export function summarisePendingMatrix(rows) {
  const list = Array.isArray(rows) ? rows : []
  const count = (s) => list.filter((r) => r.status === s).length
  const cleanupFailures = list.filter((r) => (r.kind === 'cleanup' && r.status === 'FAIL') || r.cleanupVerified === false).length
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

// ── SELECT-specific outcome classification ──────────────────────────────────
//
// SELECT is NOT a write. isDenied()/isDeniedByRls() were designed for writes,
// where an error is normally the policy talking. For SELECT that reasoning is
// unsound in BOTH directions:
//
//   * isAllowed(res) === !res.error accepts an EMPTY result as proof of access.
//     An RLS-denied SELECT returns `{ data: [], error: null }` — no error at
//     all — so an affirmative "farmer retains access" control passes at the
//     exact moment access is lost. It also passes against an empty table.
//   * isDenied(res) treats ANY error as denial. An expired JWT, a dropped
//     connection, a 500, or a typo in a column name would all be scored as
//     "RLS denied it" — a green probe that never reached the policy.
//
// The only sound reading of a SELECT is against a KNOWN EXISTING SUBJECT ROW
// whose id the admin has confirmed:
//   no error + subject returned  → visible
//   no error + subject absent    → denied by RLS/visibility
//   any error                    → the probe did not run; never a pass.
//
// SQLSTATEs/status codes that mean "this query never reached row-level
// security", so neither branch may score them.
const SELECT_SCHEMA_SQLSTATES = new Set(['42703', '42P01', '42601', '22P02', 'PGRST100', 'PGRST102'])
const SELECT_AUTH_SQLSTATES = new Set(['PGRST301', 'PGRST302', '42501'])

/**
 * Classify why a SELECT errored. Returns a `kind` that is NEVER 'policy':
 * an error is by definition not the empty-result signature of RLS denial.
 */
export function classifySelectError(error) {
  if (!error) return null
  const code = String(error.code ?? '')
  const status = String(error.status ?? error.statusCode ?? '')
  const msg = String(error.message || '').toLowerCase()
  if (SELECT_SCHEMA_SQLSTATES.has(code) || msg.includes('does not exist') || msg.includes('syntax error')) {
    return { kind: 'schema', reason: `malformed/pre-RLS query error (${code || status || 'n/a'}) — the probe is invalid, not denied` }
  }
  if (SELECT_AUTH_SQLSTATES.has(code) || status === '401' || status === '403'
      || msg.includes('jwt') || msg.includes('expired') || msg.includes('unauthor')) {
    return { kind: 'auth', reason: `authentication/authorization transport error (${code || status || 'n/a'}) — session invalid, policy never evaluated` }
  }
  if (/^5\d\d$/.test(status) || msg.includes('internal server error')) {
    return { kind: 'server', reason: `server error (${status || code || 'n/a'}) — the probe did not complete` }
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('econn') || msg.includes('timeout')) {
    return { kind: 'transport', reason: `network/transport error (${code || status || 'n/a'}) — the probe did not reach the database` }
  }
  return { kind: 'unknown', reason: `unclassified SELECT error (${code || status || 'n/a'}) — never counted as denial` }
}

// Normalise a Supabase SELECT response into a plain row array, or null when the
// response carried no row set at all (which is itself inconclusive).
function selectRows(res) {
  if (!res || res.error) return null
  const d = res.data
  if (Array.isArray(d)) return d
  if (d && typeof d === 'object') return [d]
  if (d === null) return []
  return null
}

/**
 * AFFIRMATIVE control: `subjectId` MUST come back.
 * Passing requires no error AND the exact expected row present. An empty result
 * is a FAIL (access lost), and a different row is a FAIL (wrong subject).
 */
export function classifyAffirmativeSelect(res, subjectId) {
  if (!subjectId) {
    return { status: 'BLOCK', ok: false, reason: 'no confirmed subject row id — an unfiltered SELECT cannot evidence retained access' }
  }
  const err = classifySelectError(res?.error)
  if (err) return { status: 'BLOCK', ok: false, reason: err.reason }
  const rows = selectRows(res)
  if (rows === null) return { status: 'BLOCK', ok: false, reason: 'SELECT returned no row set — inconclusive' }
  if (rows.length === 0) {
    return { status: 'FAIL', ok: false, reason: `ACCESS LOST: subject row ${subjectId} was not returned (RLS denies by returning an empty set, with no error)` }
  }
  if (!rows.some((r) => r?.id === subjectId)) {
    return { status: 'FAIL', ok: false, reason: `wrong row returned — expected subject ${subjectId}, got ${rows.map((r) => r?.id).slice(0, 3).join(', ')}` }
  }
  return { status: 'PASS', ok: true, reason: `subject row ${subjectId} returned — access retained` }
}

/**
 * DENIAL probe: `subjectId` is a row the ADMIN has confirmed exists and which
 * the identity under test must NOT be able to read.
 */
export function classifySelectDenial(res, subjectId) {
  if (!subjectId) {
    return { status: 'BLOCK', ok: false, reason: 'no confirmed subject row id — an empty result would mean "nothing was there", not "RLS denied it"' }
  }
  const err = classifySelectError(res?.error)
  if (err) return { status: 'BLOCK', ok: false, reason: err.reason }
  const rows = selectRows(res)
  if (rows === null) return { status: 'BLOCK', ok: false, reason: 'SELECT returned no row set — inconclusive' }
  if (rows.some((r) => r?.id === subjectId)) {
    return { status: 'FAIL', ok: false, reason: `SECURITY FAILURE: the protected subject row ${subjectId} was returned to an unauthorized identity` }
  }
  if (rows.length > 0) {
    return { status: 'FAIL', ok: false, reason: `SECURITY FAILURE: ${rows.length} protected row(s) were readable under a restrictive policy` }
  }
  return { status: 'PASS', ok: true, reason: `denied — the confirmed subject row ${subjectId} is not visible (empty result, no error)` }
}

// Record a classifier verdict, mapping BLOCK onto the block() channel so it is
// never counted as a pass.
function recordSelectVerdict(name, verdict) {
  if (verdict.status === 'BLOCK') block(name, redactSecrets(verdict.reason))
  else record(name, verdict.ok, redactSecrets(verdict.reason))
}

// ── market_price_benchmarks fixture (SELECT-only protected table) ────────────
//
// Migration 22 protects this table with a RESTRICTIVE **FOR SELECT** policy —
// deliberately NOT the FOR ALL overlay the other 11 tables get, because the
// table has no farmer write path (22_..._HARDENING.sql:174-189). It therefore
// gets a SELECT subject fixture and NO insert/update/delete probes; adding them
// would test the admin-only write policy, not the migration 22 control.
//
// Both benchmark probes previously ran unfiltered (`select('id').limit(1)`), so
// on an empty table the pending denial AND the farmer control passed
// simultaneously while proving nothing at all.
export const BENCHMARK_TABLE = 'market_price_benchmarks'

// The permissive farmer policy is USING (visible_to_farmers = true AND
// auth.uid() IS NOT NULL). A fixture with visible_to_farmers = false would be
// invisible to the farmer for reasons unrelated to migration 22, so the control
// would fail for the wrong reason. It MUST be visible.
export function benchmarkFixturePayload(tag) {
  return {
    product_type: `${tag}-bench`,
    thc_range: null,
    price_min: 1,
    price_max: 2,
    unit: 'kg',
    visible_to_farmers: true,
  }
}

/**
 * Create a tag-scoped, farmer-visible benchmark row as admin and CONFIRM it by
 * reading it back by its exact id. Returns { id, created, note }.
 * `id` null ⇒ no confirmed subject ⇒ callers must BLOCK, never pass.
 */
export async function seedBenchmarkFixture(adminClient, tag) {
  if (!adminClient) return { id: null, created: false, note: 'no admin client — benchmark fixture unavailable' }
  try {
    const ins = await adminClient.from(BENCHMARK_TABLE).insert(benchmarkFixturePayload(tag)).select('id')
    const id = ins?.data?.[0]?.id
    if (ins?.error || !id) {
      return { id: null, created: false, note: `admin could not create a benchmark fixture (${ins?.error?.code || ins?.error?.message || 'no id returned'})` }
    }
    // Confirm through the SAME shape the probes use: exact id, and visible.
    const back = await adminClient.from(BENCHMARK_TABLE)
      .select('id, visible_to_farmers').eq('id', id).maybeSingle()
    if (back?.error || back?.data?.id !== id) {
      return { id: null, created: true, createdId: id, note: `benchmark fixture ${id} could not be read back (${back?.error?.code || 'not returned'}) — unconfirmed` }
    }
    if (back.data.visible_to_farmers !== true) {
      return { id: null, created: true, createdId: id, note: `benchmark fixture ${id} is not visible_to_farmers — the farmer control would fail for the wrong reason` }
    }
    return { id, created: true, createdId: id, note: null }
  } catch (e) {
    return { id: null, created: false, note: `benchmark fixture seeding threw (${String(e?.message || e).slice(0, 60)})` }
  }
}

// ── Ambiguous-INSERT resolution ─────────────────────────────────────────────
//
// `insert(...).select('id')` returns an EMPTY array in two completely different
// situations:
//   (a) the INSERT was rejected — nothing was written; or
//   (b) the INSERT SUCCEEDED and the RETURNING clause could not read the new
//       row back, because the SELECT policy hides it from the inserting user.
// (b) is a silent security failure that the write classifier scores as "denied
// (0 rows affected)" — a green probe over a row that is actually in the table.
//
// So an empty non-error INSERT result is AMBIGUOUS and must be resolved by an
// ADMIN readback against deterministic, tag-scoped criteria.

/**
 * Deterministic lookup criteria locating the row a pending INSERT probe would
 * have written. farmId alone is NOT sufficient — the fixture seeder already put
 * a row with that farm_id in most of these tables, so a farm-only lookup would
 * report a leak that is really the fixture. Each entry is a list of eq filters
 * chosen to match the probe's own payload.
 */
export function pendingInsertLookup(table, ctx) {
  const { tag, userId, farmId } = ctx
  switch (table) {
    case 'farms': return [['farm_name', `${tag}-P`]]
    case 'farm_profiles': return [['farm_id', farmId], ['business_info->>probe', `${tag}-P`]]
    case 'farm_memberships': return [['farm_id', farmId], ['user_id', userId]]
    case 'inventory_batches': return [['notes', `${tag}-P`]]
    case 'farmer_documents': return [['farm_id', farmId], ['file_name', `${tag}.pdf`]]
    case 'farmer_photos': return [['farm_id', farmId], ['file_url', `${tag}.jpg`]]
    case 'farmer_review_requests': return [['farm_id', farmId], ['message', `${tag}-P`]]
    case 'documents': return [['farm_id', farmId], ['file_name', `${tag}.pdf`]]
    case 'ddp_scores': return [['farm_id', farmId], ['total_score', 1]]
    case 'risk_flags': return [['farm_id', farmId], ['label', `${tag}-P`]]
    case 'status_history': return [['entity_id', farmId], ['new_status', `${tag}-P`]]
    default: throw new Error(`no pending insert lookup defined for ${table}`)
  }
}

// Apply the criteria to a client and return matching ids (or an error marker).
export async function findInsertedRowIds(client, table, criteria) {
  let q = client.from(table).select('id')
  for (const [column, value] of criteria) q = q.eq(column, value)
  const res = await q
  if (res?.error) return { ok: false, ids: [], error: res.error }
  return { ok: true, ids: (res.data ?? []).map((r) => r?.id).filter(Boolean), error: null }
}

/**
 * Resolve an ambiguous (no-error, empty) pending INSERT via admin readback.
 * `knownIds` are rows that already matched the criteria BEFORE the probe ran,
 * so only genuinely new rows count as a leak.
 *
 *   leak      → FAIL, and the id must be registered for cleanup
 *   absent    → the denial stands (PASS)
 *   readback failed → BLOCK; an unverifiable insert must never pass
 */
export function classifyAmbiguousInsert(readback, knownIds = []) {
  if (!readback || readback.ok !== true) {
    return {
      status: 'BLOCK', ok: false, leakedIds: [],
      reason: `admin readback failed (${readback?.error?.code || readback?.error?.message || 'no response'}) — cannot distinguish "denied" from "written but hidden"`,
    }
  }
  const known = new Set(knownIds)
  const leaked = readback.ids.filter((id) => !known.has(id))
  if (leaked.length > 0) {
    return {
      status: 'FAIL', ok: false, leakedIds: leaked,
      reason: `SECURITY FAILURE: the INSERT SUCCEEDED but was hidden from the inserting user — admin found row(s) ${leaked.join(', ')}`,
    }
  }
  return {
    status: 'PASS', ok: true, leakedIds: [],
    reason: 'denied — admin readback confirms no row was written',
  }
}

// ── Pending storage-list differential ───────────────────────────────────────
//
// Listing another user's prefix and finding it empty proves NOTHING when no
// object exists there: "empty by policy" and "empty because the prefix is bare"
// are the same response. The probe must run against a prefix that provably
// CONTAINS an object the owner can see.
export function evaluatePendingListProbe(obs) {
  const o = obs || {}
  if (!o.controlObjectName) {
    return { status: 'BLOCK', ok: false, reason: 'no control object was created under the owner prefix — an empty pending listing would be vacuous' }
  }
  if (o.ownerCanSeeControl !== true) {
    return { status: 'BLOCK', ok: false, reason: `the owner could not list its own control object ${o.controlObjectName} — the prefix is not proven non-empty` }
  }
  const err = classifySelectError(o.pendingError)
  if (err && err.kind !== 'unknown') {
    return { status: 'BLOCK', ok: false, reason: err.reason }
  }
  const names = Array.isArray(o.pendingNames) ? o.pendingNames : []
  if (names.includes(o.controlObjectName)) {
    return { status: 'FAIL', ok: false, reason: `SECURITY FAILURE: the pending identity listed another user's object ${o.controlObjectName}` }
  }
  // Teardown is asserted separately by the run-scoped storage sweep; a cleanup
  // defect must not be reported as a listing-policy failure.
  return {
    status: 'PASS', ok: true,
    reason: `denied by policy — the owner sees ${o.controlObjectName} at this prefix while the pending identity sees ${names.length} object(s), none of them the control`,
  }
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
  // `label` is retained so teardown can prove it holds the admin session before
  // attempting a storage delete (see assertAdminCleanupClient).
  return { client: c, userId: data.user.id, label }
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
  const { client, adminClient, userId, tag, farmId, fixtures = {} } = ctx
  const createdIds = []

  for (const probe of buildPendingProbeRegistry()) {
    const missing = probe.requires.filter((r) => !fixtures[r])
    if (missing.length > 0) {
      // Precise fixture requirement, never a silent skip (§7).
      block(probe.probeName,
        `requires fixture(s) ${missing.join(', ')} — without a row that this probe's filter actually matches, `
        + `an empty result means "nothing was there", not "RLS denied it", and the probe would pass vacuously`)
      continue
    }
    const { table, operation } = probe
    let res
    try {
      if (operation === 'select') {
        // Probe the EXACT fixture row the admin confirmed exists. A restrictive
        // overlay yields an empty set with NO error, so denial is proven only by
        // "this specific, known-present row did not come back". classifySelectDenial
        // refuses to score any error as denial — an expired JWT, a 500 or a bad
        // column would otherwise read as a security pass.
        const subjectId = fixtures[tableFixtureKey(table)]
        res = await client.from(table).select('id').eq('id', subjectId)
        recordSelectVerdict(probe.probeName, classifySelectDenial(res, subjectId))
        continue
      }
      if (operation === 'insert') {
        const criteria = pendingInsertLookup(table, { tag, userId, farmId })
        // Snapshot matching rows BEFORE the probe so only genuinely new rows can
        // be attributed to it.
        const before = adminClient ? await findInsertedRowIds(adminClient, table, criteria) : null
        res = await client.from(table).insert(pendingInsertPayload(table, { tag, userId, farmId })).select('id')
        const returned = Array.isArray(res?.data) ? res.data.filter((r) => r?.id) : []
        for (const row of returned) createdIds.push({ table, id: row.id })

        // A no-error EMPTY result is AMBIGUOUS: the row may have been written and
        // merely hidden by the SELECT policy. Resolve it by admin readback rather
        // than scoring it as denied.
        if (!res?.error && returned.length === 0) {
          if (!adminClient) {
            block(probe.probeName, 'no admin client available to resolve an ambiguous empty INSERT result')
            continue
          }
          const after = await findInsertedRowIds(adminClient, table, criteria)
          const verdict = classifyAmbiguousInsert(after, before?.ok ? before.ids : [])
          // A leaked row is a security failure AND residue — register it so
          // cleanup removes it from whichever table it landed in.
          for (const id of verdict.leakedIds) createdIds.push({ table, id })
          if (verdict.status === 'BLOCK') block(probe.probeName, redactSecrets(verdict.reason))
          else record(probe.probeName, verdict.ok, redactSecrets(verdict.reason))
          continue
        }
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
  // Removal runs as ADMIN, not as the pending user. A row that leaked through an
  // ambiguous INSERT is by definition one the pending identity cannot see, so a
  // pending-scoped delete would match nothing and the read-back would then be
  // empty for the wrong reason — reporting "removed" over a row still in the
  // table. The admin can see and delete rows in every tested table.
  const cleaner = adminClient || client
  for (const { table, id } of createdIds) {
    let removed = false
    try {
      await cleaner.from(table).delete().eq('id', id)
      const check = await cleaner.from(table).select('id').eq('id', id)
      removed = !check?.error && (check?.data?.length ?? 0) === 0
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
  // Tracked synthetic state for cleanup. `storageObjects` is declared here — not
  // attached ad hoc later — so it can never be clobbered by assignment, and every
  // successful upload is appended via registerStorageFixture().
  const created = { batches: [], farms: [], pendingFixtures: [], benchmarks: [], storageObjects: [] }

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
    // Tag-scoped path: an untagged filename would escape the run-scoped residue
    // sweep entirely if this denial ever regressed into a success.
    const anonProbePath = `${TAG}-anon.txt`
    const anonProbeUp = await anon.storage.from('farmer-documents').upload(anonProbePath, new Blob(['x']))
    record('anon cannot upload to farmer-documents', !!anonProbeUp.error)
    if (!anonProbeUp.error) {
      registerStorageFixture(created.storageObjects,
        { bucket: 'farmer-documents', path: anonProbePath, scenario: 'A anon upload (unexpected success)', createdBy: 'anon' })
    }

    // ── B. Farmer A isolation ────────────────────────────────────────────────
    group('B. farmer A isolation')
    // Farmer A creates own synthetic farm (RLS-permitted for owner).
    const farmIns = await a.client.from('farms').insert({ farm_name: `${TAG}-A`, created_by: a.userId }).select('id')
    const farmA = farmIns?.data?.[0]?.id
    if (farmA) created.farms.push(farmA)
    record('farmer A can create own farm', !!farmA, farmA ? '' : (farmIns?.error?.code || 'no id returned'))

    // Affirmative control: the farm just created must actually come back. A bare
    // "no error" check passes on an empty result, i.e. at the moment access is lost.
    recordSelectVerdict('farmer A can read own farm',
      classifyAffirmativeSelect(
        await a.client.from('farms').select('id').eq('id', farmA ?? ''), farmA))

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
    if (ownOk) {
      registerStorageFixture(created.storageObjects,
        { bucket: 'farmer-documents', path: ownPath, scenario: 'G own-prefix upload', createdBy: 'farmer A' })
    }
    // Cross-prefix write into B's userId prefix must be denied. Registered when it
    // unexpectedly SUCCEEDS: that is a security failure, and the object it leaves
    // behind must still be torn down rather than orphaned.
    const crossOwnPath = `${b.userId}/${TAG}-cross.txt`
    const crossOwnUp = await a.client.storage.from('farmer-documents').upload(crossOwnPath, new Blob(['x']))
    record('farmer A cannot upload into farmer B prefix', !!crossOwnUp.error)
    if (!crossOwnUp.error) {
      registerStorageFixture(created.storageObjects,
        { bucket: 'farmer-documents', path: crossOwnPath, scenario: 'G cross-prefix upload (unexpected success)', createdBy: 'farmer A' })
    }
    // The anon path carries the full run tag so a tag-scoped sweep can find it if
    // it ever lands; a bare-runId filename would be invisible to that sweep.
    const anonPath = `${a.userId}/${TAG}-anon2.txt`
    const anonUp = await anon.storage.from('farmer-documents').upload(anonPath, new Blob(['x']))
    record('anon cannot upload to farmer-documents', !!anonUp.error)
    if (!anonUp.error) {
      registerStorageFixture(created.storageObjects,
        { bucket: 'farmer-documents', path: anonPath, scenario: 'G anon upload (unexpected success)', createdBy: 'anon' })
    }

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
      // applyPendingGate records the FULL probe registry as BLOCK and skips the
      // runMatrix body entirely unless the account is proven pending.
      await applyPendingGate(roleRow, {
        block,
        runMatrix: async () => {
        // Seed one row per migration-22 table BEFORE probing. A SELECT/UPDATE/
        // DELETE probe against an empty table returns "0 rows", which is
        // indistinguishable from an RLS denial — so without a real subject the
        // probe passes vacuously. Fixtures that cannot be established block their
        // probes rather than allowing that false pass.
        const seeded = await seedPendingFixtureRows(admin.client, {
          tag: TAG, farmId: farmA, farmerUserId: a.userId,
        })
        created.pendingFixtures = seeded.created
        for (const note of seeded.notes) {
          record(`pending-matrix fixture unavailable: ${note}`, false, 'probes for this table are blocked below')
        }
        record('pending matrix has a real subject row in every migration-22 table',
          MIGRATION_22_TABLES.every((t) => seeded.fixtures[tableFixtureKey(t)]),
          seeded.notes.length ? `${seeded.notes.length} table(s) without a confirmed fixture` : '')

        await runPendingMatrix({
          client: p.client, adminClient: admin.client, userId: p.userId,
          tag: TAG, farmId: farmA, fixtures: seeded.fixtures,
        })

        // market_price_benchmarks is protected by a RESTRICTIVE **FOR SELECT**
        // policy (not the FOR ALL overlay), so it needs its own confirmed subject
        // row and gets SELECT probes only — no insert/update/delete, which would
        // exercise the admin-only write policy instead of migration 22.
        const bench = await seedBenchmarkFixture(admin.client, TAG)
        if (bench.createdId) created.benchmarks.push(bench.createdId)
        if (!bench.id) {
          // No confirmed subject ⇒ BOTH the denial and the farmer control would
          // pass against an empty table. Block rather than assert.
          block('pending cannot read market_price_benchmarks (migration 22)', redactSecrets(bench.note))
          block('operational farmer retains market_price_benchmarks read (migration 22)', redactSecrets(bench.note))
        } else {
          recordSelectVerdict('pending cannot read market_price_benchmarks (migration 22)',
            classifySelectDenial(
              await p.client.from(BENCHMARK_TABLE).select('id').eq('id', bench.id), bench.id))
          recordSelectVerdict('operational farmer retains market_price_benchmarks read (migration 22)',
            classifyAffirmativeSelect(
              await a.client.from(BENCHMARK_TABLE).select('id').eq('id', bench.id), bench.id))
        }

        // Storage: an object-not-found result is NOT proof of denial, so the
        // outcome is classified rather than treated as a boolean error check.
        // Each private bucket is proven by DIFFERENTIAL, never by a bare 403.
        // The payload is shaped to satisfy the bucket's MIME allowlist so the
        // request reaches the authorization layer instead of being rejected by
        // content-type validation first.
        for (const spec of STORAGE_ATTRIBUTION_BUCKETS) {
          const { bucket, ext, contentType, bytes } = spec
          const body = () => new Blob([bytes], { type: contentType })
          const opts = { contentType }
          // Every object that actually lands is registered in the run-scoped
          // registry and torn down centrally as admin in the finally block. The
          // previous per-bucket `cleanups` array was loop-local and discarded,
          // and its deletes ran as the creating farmer — an identity with no
          // DELETE grant, so they removed nothing and reported no error.

          // CONTROL: an operational farmer's own-scope write must succeed.
          const controlPath = `${a.userId}/${TAG}-attrib.${ext}`
          const controlRes = await a.client.storage.from(bucket).upload(controlPath, body(), opts)
          const control = classifyStorageOutcome(controlRes)
          if (control.outcome === 'allowed') {
            registerStorageFixture(created.storageObjects,
              { bucket, path: controlPath, scenario: 'H attribution control', createdBy: 'farmer A' })
          }

          // SUBJECT: the pending user's structurally identical write.
          const subjectPath = `${p.userId}/${TAG}-attrib.${ext}`
          const subjectRes = await p.client.storage.from(bucket).upload(subjectPath, body(), opts)
          const subject = classifyStorageOutcome(subjectRes)
          if (subject.outcome === 'allowed') {
            registerStorageFixture(created.storageObjects,
              { bucket, path: subjectPath, scenario: 'H attribution subject (unexpected success)', createdBy: 'pending' })
          }

          // Cross-prefix: pending writing beneath another user's prefix.
          const crossPath = `${b.userId}/${TAG}-attrib-x.${ext}`
          const crossRes = await p.client.storage.from(bucket).upload(crossPath, body(), opts)
          const cross = classifyStorageOutcome(crossRes)
          if (cross.outcome === 'allowed') {
            registerStorageFixture(created.storageObjects,
              { bucket, path: crossPath, scenario: 'H attribution cross-prefix (unexpected success)', createdBy: 'pending' })
          }

          const bucketExists = control.outcome !== 'not-found' || subject.outcome !== 'not-found'
          const verdict = evaluateStorageAttribution({
            bucketExists,
            farmerControl: control.outcome === 'allowed' ? 'ALLOWED' : control.outcome,
            pendingSubject: subject.outcome === 'denied' ? 'DENIED-BY-POLICY' : subject.outcome,
            crossPrefix: cross.outcome === 'allowed' ? 'ALLOWED' : cross.outcome,
          })
          const name = `pending denied on ${bucket} (attributable to migration 22)`
          if (verdict.status === 'BLOCK') block(name, redactSecrets(verdict.reason))
          else record(name, verdict.status === 'PASS', redactSecrets(verdict.reason))

          record(`operational farmer retains own-scope write on ${bucket}`,
            control.outcome === 'allowed', redactSecrets(control.reason))
          record(`pending cannot write beneath another user prefix on ${bucket}`,
            cross.outcome !== 'allowed', redactSecrets(cross.reason))
          // Teardown for this bucket is asserted once, centrally, by the
          // run-scoped residue sweep in the finally block — not by a per-bucket
          // `!error` check that could never observe an RLS no-op.
        }
        // Writing beneath another user's prefix must also be denied.
        const foreignPath = `${b.userId}/${TAG}-pending.txt`
        const foreign = await p.client.storage.from('farmer-documents')
          .upload(foreignPath, new Blob(['x']))
        const foreignCls = classifyStorageOutcome(foreign)
        record('pending cannot upload beneath another user prefix',
          foreignCls.outcome === 'denied', redactSecrets(foreignCls.reason))
        // If this forbidden write unexpectedly SUCCEEDS the probe above already
        // fails loudly — but the object it created is still this run's to remove.
        // Leaving it unregistered would exclude it from the deletion set AND, when
        // no other registered object shares farmer B's prefix, from the residue
        // sweep's prefix set too — making it invisible to both.
        if (foreignCls.outcome === 'allowed') {
          registerStorageFixture(created.storageObjects,
            { bucket: 'farmer-documents', path: foreignPath, scenario: 'H pending cross-prefix upload (unexpected success)', createdBy: 'pending' })
        }
        // DIFFERENTIAL list probe. Listing B's prefix and finding it empty proves
        // nothing unless an object provably EXISTS there: "empty by policy" and
        // "empty because the prefix is bare" are byte-identical responses. So
        // farmer B first creates a tag-scoped object under its OWN prefix and
        // confirms it can see it; only then is the pending identity's identical
        // listing evidence of anything.
        const listControlName = `${TAG}-listctl.txt`
        const listControlPath = `${b.userId}/${listControlName}`
        const listCtlUp = await b.client.storage.from('farmer-documents')
          .upload(listControlPath, new Blob(['list-control']), { contentType: 'text/plain' })
        const listControlCreated = !listCtlUp?.error
        if (listControlCreated) {
          registerStorageFixture(created.storageObjects,
            { bucket: 'farmer-documents', path: listControlPath, scenario: 'H list-control', createdBy: 'farmer B' })
        }

        let ownerCanSeeControl = false
        if (listControlCreated) {
          const ownerList = await b.client.storage.from('farmer-documents').list(`${b.userId}`)
          ownerCanSeeControl = !ownerList?.error
            && (ownerList?.data ?? []).some((o) => o?.name === listControlName)
        }

        const listRes = await p.client.storage.from('farmer-documents').list(`${b.userId}`)

        // The list-control object is registered above and removed centrally as
        // admin. Farmer B cannot delete it (no DELETE grant), which is precisely
        // why the old inline `b.client...remove()` left it behind every run.
        recordSelectVerdict('pending cannot list another user private objects',
          evaluatePendingListProbe({
            controlObjectName: listControlCreated ? listControlName : null,
            ownerCanSeeControl,
            pendingError: listRes?.error ?? null,
            pendingNames: (listRes?.data ?? []).map((o) => o?.name),
          }))

        // Affirmative: operational farmer and admin retain access under the
        // overlay. Each queries a KNOWN fixture by its exact id and requires that
        // row back — absence of an error is not access (an RLS-denied SELECT
        // returns an empty set with no error at all).
        recordSelectVerdict('operational farmer retains own-farm access (post-21)',
          classifyAffirmativeSelect(
            await a.client.from('farms').select('id').eq('id', farmA ?? ''), farmA))
        recordSelectVerdict('ddp_admin retains farms access (post-21)',
          classifyAffirmativeSelect(
            await admin.client.from('farms').select('id').eq('id', farmA ?? ''), farmA))
        },
      })
    }
  } finally {
    // ── Cleanup (reverse dependency order; run-id scoped only) ────────────────
    group('cleanup')
    try {
      // ── Storage teardown (admin identity; response-checked; residue-swept) ──
      //
      // Runs as ADMIN because only `is_ddp_admin()` satisfies the farmer buckets'
      // permissive ALL policy. Every remove() response is compared against what
      // was requested, and absence is then proven by an explicitly paginated
      // sweep over BOTH buckets scoped to this run's tag.
      {
        // Authority is proven by the DATABASE, once, before any remove() or list().
        // A local `admin` label is descriptive only and can never authorise this
        // phase. Anything short of is_ddp_admin() === true fails closed: no delete
        // is attempted, no sweep is claimed, and the run exits non-zero.
        const authority = await verifyAdminCleanupAuthority(admin)
        const requestedPaths = []
        const deletionErrors = []
        const notEchoedPaths = []  // diagnostic only — see compareRequestedAndDeletedPaths
        let deletedCount = 0

        recordCleanup('storage cleanup authority proven (is_ddp_admin)', authority.ok,
          authority.ok ? 'verified against the database' : redactSecrets(`${authority.kind}: ${authority.reason}`))

        if (authority.ok && created.storageObjects.length) {
          for (const bucket of STORAGE_CLEANUP_BUCKETS) {
            const paths = created.storageObjects.filter((o) => o.bucket === bucket).map((o) => o.path)
            if (!paths.length) continue
            requestedPaths.push(...paths)
            try {
              const del = await admin.client.storage.from(bucket).remove(paths)
              // An explicit API error is a real failure and is recorded. Execution
              // continues so the absence sweep still runs for every bucket.
              if (del?.error) {
                deletionErrors.push(`${bucket}: ${String(del.error.message || del.error).slice(0, 60)}`)
                continue
              }
              // A successful remove() is documented as `{ data: [], error: null }`,
              // and an RLS no-op returns the identical shape. The payload is
              // therefore recorded for reporting only and does NOT decide anything
              // — deletion is proved below, by the paginated absence sweep.
              const cmp = compareRequestedAndDeletedPaths(paths, del?.data)
              deletedCount += cmp.deleted
              notEchoedPaths.push(...cmp.missing.map((p) => `${bucket}/${p}`))
            } catch (e) {
              deletionErrors.push(`${bucket}: ${String(e?.message || e).slice(0, 60)}`)
            }
          }
        }

        // Independent absence proof: paginated, per bucket, per owner prefix,
        // scoped to this run's tag. Historical objects carry other run tags and
        // are neither counted nor touched.
        const residual = []
        let sweepTruncated = false
        const sweepErrors = []
        if (authority.ok) {
          const prefixes = [...new Set(created.storageObjects.map((o) => o.path.includes('/') ? o.path.split('/')[0] : ''))]
          for (const bucket of STORAGE_CLEANUP_BUCKETS) {
            for (const prefix of prefixes) {
              const listFn = ({ prefix: pfx, limit, offset }) =>
                admin.client.storage.from(bucket).list(pfx, { limit, offset })
              const swept = await collectPaginatedRunObjects(listFn, { bucket, prefix, tag: TAG })
              if (swept.error) { sweepErrors.push(`${bucket}/${prefix}: ${String(swept.error.message || swept.error).slice(0, 50)}`); continue }
              if (swept.truncated) sweepTruncated = true
              residual.push(...swept.found)
            }
          }
        }

        const verdict = evaluateStorageCleanup({
          created: created.storageObjects.length,
          requested: requestedPaths.length,
          deleted: deletedCount,
          missing: notEchoedPaths,
          residual,
          errors: [...deletionErrors, ...sweepErrors],
          truncated: sweepTruncated,
          configError: authority.ok ? null : `cleanup authority not proven (${authority.kind}): ${authority.reason}`,
        })
        storageCleanupVerdict = verdict
        recordCleanup('removed synthetic storage objects', verdict.ok, redactSecrets(verdict.reason))
        // Global residue assertion — the storage counterpart of the farms check.
        // "Zero residue" may only be claimed when the sweep actually ran, under a
        // proven admin identity, completely. Otherwise absence is UNPROVEN, which
        // is a failure — never a silent pass.
        const residueProven = authority.ok && !sweepTruncated && sweepErrors.length === 0
        recordCleanup('zero residual current-run storage objects',
          residueProven && verdict.residualCount === 0,
          residueProven
            ? (verdict.residualCount === 0
              ? `requested=${verdict.requested} remaining=0 absenceSweep=clean`
              : redactSecrets(verdict.residual.map((r) => `${r.bucket}/${r.path}`).join(', ')))
            : 'absence UNPROVEN — the paginated sweep did not complete under a proven admin identity')
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
      // Fixture rows seeded for the pending matrix, removed as the admin that
      // created them. Deleted EXPLICITLY rather than relying on a cascade from
      // the farm delete below: not every farm_id foreign key is declared
      // ON DELETE CASCADE, and each removal is verified by read-back, because an
      // unverified teardown is how residue accumulates in the first place.
      if (created.pendingFixtures?.length && admin?.client) {
        let removed = 0
        for (const { table, id } of created.pendingFixtures) {
          try {
            await admin.client.from(table).delete().eq('id', id)
            const check = await admin.client.from(table).select('id').eq('id', id)
            if ((check?.data?.length ?? 0) === 0) removed += 1
          } catch { /* left counted as not removed */ }
        }
        const allGone = removed === created.pendingFixtures.length
        results.push({
          group: currentGroup,
          name: 'cleanup: pending-matrix fixture rows removed',
          status: allGone ? 'PASS' : 'FAIL',
          detail: allGone ? '' : `${created.pendingFixtures.length - removed} fixture row(s) remain`,
          cleanupVerified: allGone,
          kind: 'cleanup',
        })
      }
      // Benchmark fixtures live in a table with no farm_id, so nothing cascades
      // to them from the farm delete — they are removed explicitly, by id, and
      // each removal is verified by read-back.
      if (created.benchmarks?.length && admin?.client) {
        let removed = 0
        for (const id of created.benchmarks) {
          try {
            await admin.client.from(BENCHMARK_TABLE).delete().eq('id', id)
            const check = await admin.client.from(BENCHMARK_TABLE).select('id').eq('id', id)
            if (!check?.error && (check?.data?.length ?? 0) === 0) removed += 1
          } catch { /* left counted as not removed */ }
        }
        const allGone = removed === created.benchmarks.length
        results.push({
          group: currentGroup,
          name: 'cleanup: market_price_benchmarks fixture rows removed',
          status: allGone ? 'PASS' : 'FAIL',
          detail: allGone ? '' : `${created.benchmarks.length - removed} benchmark fixture row(s) remain`,
          cleanupVerified: allGone,
          kind: 'cleanup',
        })
      }
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
  const storageResidue = storageCleanupVerdict?.residualCount ?? 0
  const failed = results.filter((r) => r.status === 'FAIL').length
  // A BLOCK means a probe could not run under meaningful conditions. It is
  // never a pass, so it must fail the process just as a FAIL does (computeExitCode)
  // — otherwise an unconfigured pending matrix would leave the suite green.
  const blocked = results.filter((r) => r.status === 'BLOCK').length
  const cleanupFailures = results.filter((r) => (r.kind === 'cleanup' && r.status === 'FAIL') || r.cleanupVerified === false).length
  if (blocked > 0) {
    console.log(`\n${blocked} probe(s) BLOCKED — not executed under meaningful conditions; this is not a pass.`)
  }
  if (cleanupFailures > 0) {
    console.log(`\n${cleanupFailures} cleanup failure(s) — synthetic records or objects may remain.`)
  }
  if (storageResidue > 0) {
    console.log(`\n${storageResidue} synthetic storage object(s) from THIS run remain:`)
    for (const r of storageCleanupVerdict.residual) console.log(`  ${r.bucket} :: ${r.path}`)
  }
  process.exit(computeExitCode({ failed, blocked, cleanupFailures, storageResidue }))
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

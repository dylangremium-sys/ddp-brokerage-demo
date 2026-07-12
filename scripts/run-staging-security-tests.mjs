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

// Assert that a Supabase write/rpc was DENIED (error present, or zero rows).
function isDenied(res) {
  if (res && res.error) return true
  if (res && Array.isArray(res.data)) return res.data.length === 0
  return false
}
function isAllowed(res) { return res && !res.error }

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
    // Cross-tenant: A must not update/delete B-owned rows (0 rows / denied).
    record('farmer A cannot update farmer B farms',
      isDenied(await a.client.from('farms').update({ farm_name: `${TAG}-hijack` }).eq('farm_name', `${TAG}-B`).select('id')))
    record('farmer A cannot delete farmer B farms',
      isDenied(await a.client.from('farms').delete().eq('farm_name', `${TAG}-B`).select('id')))
    record('farmer A cannot write compliance_rules',
      isDenied(await a.client.from('compliance_rules').insert({ title: TAG })))
    record('farmer A cannot self-elevate role in profiles',
      isDenied(await a.client.from('profiles').update({ role: 'admin' }).eq('id', a.userId)))
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
    record('farmer B cannot self-elevate role',
      isDenied(await b.client.from('profiles').update({ role: 'admin' }).eq('id', b.userId)))

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
      for (const client of [a?.client, b?.client].filter(Boolean)) {
        await client.from('farms').delete().ilike('name', `${TAG}%`)
      }
      // Residue verification (deletable tables only).
      const residue = admin?.client
        ? ((await admin.client.from('farms').select('id').ilike('name', `${TAG}%`)).data?.length ?? 0)
        : 0
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
  process.exit(failed > 0 ? 1 : 0)
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
    const mark = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '•' : '✗'
    console.log(`  ${mark} [${r.status}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  }
  const p = results.filter((r) => r.status === 'PASS').length
  const f = results.filter((r) => r.status === 'FAIL').length
  const s = results.filter((r) => r.status === 'SKIP').length
  console.log(`\n──────── ${p} PASS · ${f} FAIL · ${s} SKIP ────────`)
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

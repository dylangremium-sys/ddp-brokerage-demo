#!/usr/bin/env node
// scripts/check-evidence-schema-readiness.mjs
//
// G4 — CI SCHEMA-READINESS GATE for Evidence Request & Resolution (migration 24).
//
// WHAT THIS IS
//   A deployment PRECONDITION gate. It answers exactly one question:
//     "Does the TARGET database structurally contain the migration-24 objects the
//      Evidence application layer depends on?"
//   It is fail-closed and blocks deployment when the answer is NO or UNKNOWN.
//
// WHAT THIS IS NOT
//   It is NOT a substitute for G2 hosted staging verification. It proves object
//   PRESENCE and structural shape only. It does NOT prove RLS actually denies
//   cross-farm access, that triggers enforce immutability/append-only, that
//   signed-URL/tombstone/size behaviour is correct, or anything else that requires
//   exercising the objects under real non-owner principals. Those belong to
//   24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql (sections A–R) and the role matrix in
//   docs/EVIDENCE_MIGRATION_24_STAGING_VERIFICATION_RUNBOOK.md.
//
// APPLICABILITY (conditional, auditable, hard to bypass accidentally)
//   The gate ACTIVATES only when the deployed source tree under src/ references a
//   migration-24 evidence RPC or the evidence storage bucket id (ground-truth token
//   list below). Functional Evidence app code cannot avoid referencing these, so
//   the gate self-activates when the feature is actually being shipped and is inert
//   otherwise. There is deliberately NO skip/override environment variable: a bypass
//   would have to be a deliberate, git-visible edit to this file or the workflow.
//
// SAFETY
//   * SELECT-only. It issues read-only catalog queries against pg_catalog /
//     information_schema / storage.buckets / pg_policies. It runs every query with
//     default_transaction_read_only=on so the server itself refuses any write.
//   * It applies NO migration and issues NO DDL/DML.
//   * It never prints the connection string, and redacts it from any error text.
//
// EXIT CODES (any non-zero BLOCKS the deployment step that runs this)
//   0  READY            — all required objects present with the required shape
//                         (or NOT APPLICABLE — no Evidence app code in the tree)
//   1  NOT_READY        — at least one required object is absent or wrong
//   2  UNABLE_TO_DETERMINE — missing credential, unreachable/timeout, query error,
//                         psql absent, or ambiguous target. Fail-closed → blocks.
//
// ENVIRONMENT
//   EVIDENCE_SCHEMA_CHECK_DATABASE_URL   (required when applicable) Postgres
//       connection string for the TARGET database (the environment being deployed
//       to). In CI this is a Production ENVIRONMENT secret, readable only by
//       protected-branch runs — same trust boundary as VERCEL_TOKEN. Use a
//       read-only role.
//   EVIDENCE_SCHEMA_CHECK_EXPECTED_REF   (REQUIRED whenever the gate applies) A
//       substring the connection string MUST contain (e.g. the target Supabase
//       project ref). If unset, or set and not matched, the result is
//       UNABLE_TO_DETERMINE — this prevents a mis-pointed check (e.g. a staging URL
//       in the Production secret) from returning a false READY for the wrong DB.
//
// USAGE
//   node scripts/check-evidence-schema-readiness.mjs
//   (also: npm run security:evidence-readiness)

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

// ── Ground truth (mirrors the merged migration-24 SQL family) ────────────────
// Client-invoked RPC surface + the authorization helper. Every one must exist,
// be SECURITY DEFINER, and pin search_path (VERIFY A asserts this shape).
const REQUIRED_FUNCTIONS = [
  'can_operationally_access_farm',
  'create_evidence_request',
  'get_or_create_evidence_response_draft',
  'save_evidence_response_draft',
  'submit_evidence_response',
  'request_evidence_clarification',
  'resolve_evidence_request',
  'reject_evidence_response',
  'cancel_evidence_request',
  'reserve_evidence_attachment',
  'finalize_evidence_attachment',
  'remove_draft_evidence_attachment',
  'link_existing_evidence_document',
  'claim_evidence_response_draft',
]

// Tables that must exist with RLS enabled (relrowsecurity = true).
const REQUIRED_TABLES = [
  'evidence_requests',
  'evidence_request_responses',
  'evidence_request_attachments',
  'evidence_request_history',
]

// Storage substrate (safely checkable from CI via the same DB connection).
const EVIDENCE_BUCKET_ID = 'evidence-request-files'
const EVIDENCE_BUCKET_SIZE_LIMIT = 104857600 // 100 MiB — matches STORAGE §7.10 [v1.4]
const REQUIRED_STORAGE_POLICIES = [
  'evidence-request-files: admin read',
  'evidence-request-files: farmer read own farm',
  'evidence-request-files: farmer insert reserved path',
  'evidence-request-files: farmer delete own draft',
  'evidence-request-files: operational farmer or admin',
]

// Applicability tokens: if any appears in src/, the Evidence app layer is present
// in the deployed tree and the gate MUST run to completion.
const APPLICABILITY_TOKENS = [...REQUIRED_FUNCTIONS.filter((f) => f !== 'can_operationally_access_farm'), EVIDENCE_BUCKET_ID]

// What this gate intentionally does NOT prove (printed on every applicable run).
const NOT_PROVEN = [
  'RLS actually denies cross-farm / non-disclosure access under real principals',
  'triggers enforce append-only history and submitted-evidence immutability',
  'reserve/finalize size + MIME + extension validation at runtime',
  'tombstone (removal_requested_at) two-phase behaviour and post-submission cleanup',
  'signed-URL issuance/authorization for authorized vs unauthorized principals',
  'storage object policies actually enforce (presence != enforcement)',
]

// ── helpers ──────────────────────────────────────────────────────────────────
function redact(s) {
  const url = process.env.EVIDENCE_SCHEMA_CHECK_DATABASE_URL || ''
  let out = String(s == null ? '' : s)
  if (url) out = out.split(url).join('<db-url>')
  // Also scrub anything that looks like a postgres URL.
  return out.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '<db-url>')
}

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
function walkSrc(dir, hits) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkSrc(p, hits)
    } else if (TEXT_EXT.has(extname(name))) {
      let content
      try {
        content = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      for (const tok of APPLICABILITY_TOKENS) {
        if (content.includes(tok)) hits.add(tok)
      }
    }
  }
}

function isApplicable() {
  const hits = new Set()
  walkSrc(SRC, hits)
  return { applicable: hits.size > 0, hits: [...hits] }
}

// Run a SELECT-only query; throws on any psql/connection/query error.
function psql(databaseUrl, sql) {
  return execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '10',
      // Server-enforced read-only: even an accidental write is refused.
      PGOPTIONS: `-c default_transaction_read_only=on ${process.env.PGOPTIONS || ''}`.trim(),
    },
  })
}

function rows(out) {
  return String(out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|'))
}

// ── result plumbing ──────────────────────────────────────────────────────────
const READY = 0
const NOT_READY = 1
const UNABLE = 2

function finish(code, verdict, reasons) {
  console.log(`\n──────── G4 evidence schema-readiness: ${verdict} ────────`)
  if (reasons && reasons.length) for (const r of reasons) console.log(`  • ${redact(r)}`)
  if (code === UNABLE) {
    console.error('::error::G4 schema-readiness UNABLE_TO_DETERMINE — deployment blocked (fail-closed).')
  } else if (code === NOT_READY) {
    console.error('::error::G4 schema-readiness NOT_READY — target database is missing required migration-24 objects. Deployment blocked.')
  }
  process.exit(code)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const { applicable, hits } = isApplicable()
  if (!applicable) {
    console.log('G4 evidence schema-readiness: NOT APPLICABLE')
    console.log('  No migration-24 Evidence app-layer references found under src/.')
    console.log('  (The gate self-activates once Evidence application code is deployed.)')
    return finish(READY, 'NOT APPLICABLE (no Evidence app code deployed)', [])
  }

  console.log('G4 evidence schema-readiness: APPLICABLE')
  console.log(`  Evidence app-layer detected in src/ (markers: ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ', …' : ''}).`)
  console.log('  This gate proves STRUCTURAL readiness only. It does NOT prove, and must not be read as proving:')
  for (const n of NOT_PROVEN) console.log(`    - ${n}`)

  const databaseUrl = (process.env.EVIDENCE_SCHEMA_CHECK_DATABASE_URL || '').trim()
  if (!databaseUrl) {
    return finish(UNABLE, 'UNABLE_TO_DETERMINE', [
      'EVIDENCE_SCHEMA_CHECK_DATABASE_URL is not set. Evidence app code is present in the deployed tree, ' +
        'so a readiness check against the target database is mandatory. Provide the target DB connection string ' +
        '(read-only role) as a Production environment secret.',
    ])
  }

  // Target identity is MANDATORY when the gate applies. Without it, the gate
  // could be pointed at the wrong database (e.g. a staging URL wired into the
  // Production secret) and report a READY that does not describe the environment
  // actually being deployed to — a silent false-PASS. Fail closed instead.
  const expectedRef = (process.env.EVIDENCE_SCHEMA_CHECK_EXPECTED_REF || '').trim()
  if (!expectedRef) {
    return finish(UNABLE, 'UNABLE_TO_DETERMINE', [
      'EVIDENCE_SCHEMA_CHECK_EXPECTED_REF is not set. Target identity cannot be confirmed, so a READY verdict ' +
        'could describe the wrong database. Set it to the deploy target\'s project ref (the connection string must ' +
        'contain it). This is required whenever the gate applies.',
    ])
  }
  if (!databaseUrl.includes(expectedRef)) {
    return finish(UNABLE, 'UNABLE_TO_DETERMINE', [
      `Connection string does not contain the expected target ref "${expectedRef}". ` +
        'Refusing to report readiness for an unverified target.',
    ])
  }

  // Probe. Any error → UNABLE_TO_DETERMINE (fail-closed).
  let tableOut, fnOut, bucketOut, policyOut
  try {
    tableOut = psql(
      databaseUrl,
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname IN (${REQUIRED_TABLES.map((t) => `'${t}'`).join(',')});`,
    )
    fnOut = psql(
      databaseUrl,
      `SELECT p.proname, p.prosecdef,
              COALESCE(array_to_string(p.proconfig, ',') LIKE '%search_path=%', false)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (${REQUIRED_FUNCTIONS.map((f) => `'${f}'`).join(',')});`,
    )
    bucketOut = psql(
      databaseUrl,
      `SELECT public, file_size_limit FROM storage.buckets WHERE id = '${EVIDENCE_BUCKET_ID}';`,
    )
    policyOut = psql(
      databaseUrl,
      `SELECT policyname FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname LIKE '${EVIDENCE_BUCKET_ID}:%';`,
    )
  } catch (e) {
    const first = redact(String(e?.message || e).split('\n').find((l) => l.trim()) || 'psql error').slice(0, 200)
    return finish(UNABLE, 'UNABLE_TO_DETERMINE', [
      'A catalog query failed (unreachable database, missing psql client, permissions, or absent storage schema): ' + first,
    ])
  }

  const failures = []

  // Tables + RLS.
  const tableMap = new Map(rows(tableOut).map((r) => [r[0], r[1]]))
  for (const t of REQUIRED_TABLES) {
    if (!tableMap.has(t)) failures.push(`table missing: public.${t}`)
    else if (tableMap.get(t) !== 't') failures.push(`RLS not enabled: public.${t}`)
  }

  // Functions: present + SECURITY DEFINER + pinned search_path.
  const fnRows = rows(fnOut)
  for (const f of REQUIRED_FUNCTIONS) {
    const matching = fnRows.filter((r) => r[0] === f)
    if (matching.length === 0) {
      failures.push(`function missing: public.${f}()`)
      continue
    }
    const shaped = matching.some((r) => r[1] === 't' && r[2] === 't')
    if (!shaped) failures.push(`function present but not SECURITY DEFINER with pinned search_path: public.${f}()`)
  }

  // Storage bucket.
  const bucketRows = rows(bucketOut)
  if (bucketRows.length === 0) {
    failures.push(`storage bucket missing: ${EVIDENCE_BUCKET_ID}`)
  } else {
    const [pub, size] = bucketRows[0]
    if (pub !== 'f') failures.push(`storage bucket ${EVIDENCE_BUCKET_ID} is not private (public=${pub})`)
    if (String(size) !== String(EVIDENCE_BUCKET_SIZE_LIMIT))
      failures.push(`storage bucket ${EVIDENCE_BUCKET_ID} file_size_limit=${size} (expected ${EVIDENCE_BUCKET_SIZE_LIMIT})`)
  }

  // Storage policies.
  const presentPolicies = new Set(rows(policyOut).map((r) => r[0]))
  for (const name of REQUIRED_STORAGE_POLICIES) {
    if (!presentPolicies.has(name)) failures.push(`storage policy missing on storage.objects: "${name}"`)
  }

  if (failures.length > 0) {
    return finish(NOT_READY, 'NOT_READY', failures)
  }

  return finish(READY, 'READY', [
    `${REQUIRED_TABLES.length} tables (RLS on), ${REQUIRED_FUNCTIONS.length} RPCs (SECURITY DEFINER + search_path), ` +
      `bucket ${EVIDENCE_BUCKET_ID} (private, 100 MiB), and ${REQUIRED_STORAGE_POLICIES.length} storage policies all present.`,
    'Structural readiness only — G2 hosted behavioural verification is still required before/independently of this gate.',
  ])
}

main()

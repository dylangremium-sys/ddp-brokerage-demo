// Fail closed when a HOSTED build has incomplete Supabase configuration.
//
// src/lib/supabase.ts derives the application's entire mode from presence:
//
//   export const isSupabaseConfigured = !!(url && key)
//
// and App.tsx derives authority from that:
//
//   const isDemo      = !isSupabaseConfigured
//   const isSignedIn  = isDemo || currentProfile !== null
//   const isAdminRole = isDemo || currentProfile?.role === 'ddp_admin'
//
// So a hosted build with ONE missing variable does not fail — it silently ships a
// build in which every visitor is a signed-in DDP administrator. Nothing reaches
// real data (there is no client to query with, and db.ts null-guards throughout),
// but the branded public domain would serve the internal admin interface over
// fictional seed data. Vercel builds succeed with missing env vars, and the
// deployment's own post-checks only compare a commit SHA, so nothing downstream
// catches it.
//
// This guard runs in `prebuild`, which npm invokes before `build`. Vercel has no
// buildCommand override in vercel.json, so its Vite preset runs `npm run build`
// for BOTH Git-triggered preview builds and `vercel build --prod` in the deploy
// workflow — one hook covers both, and it aborts before any asset is produced.
//
// Local demo mode is deliberately untouched: with no VERCEL_ENV and no explicit
// enforcement flag, absent configuration stays allowed, so `npm run build` and
// `npm run ci:verify` keep working without secrets.
//
// This validates PRESENCE ONLY. It never prints, logs, truncates or transmits a
// value, and never contacts Supabase — a build must not be able to leak config,
// and a network probe would make builds fail for unrelated reasons.

import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Env var names the application requires in a hosted environment. */
export const REQUIRED_VARS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

/** Opt-in enforcement for contexts that are hosted but set no VERCEL_ENV. */
export const ENFORCE_FLAG = 'DDP_REQUIRE_SUPABASE_CONFIG'

/** Vercel environments that serve a build to somebody other than the builder. */
const HOSTED_VERCEL_ENVS = ['preview', 'production']

/**
 * Is complete configuration mandatory for this build?
 *
 * True for Vercel preview and production builds, or when enforcement is set
 * explicitly. `VERCEL_ENV=development` (`vercel dev`) is NOT hosted — it is a
 * local workflow and keeps demo mode.
 */
export function isConfigRequired(env) {
  if (String(env[ENFORCE_FLAG] ?? '').trim() === '1') return true
  const vercelEnv = String(env.VERCEL_ENV ?? '').trim().toLowerCase()
  return HOSTED_VERCEL_ENVS.includes(vercelEnv)
}

/**
 * A value counts as supplied only if it is a non-whitespace string. Vercel
 * stores an unset variable as an empty string rather than omitting it, and an
 * empty or whitespace-only value is exactly what `!!(url && key)` treats as
 * "not configured" — so both must fail here too.
 */
export function isPresent(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Names of the required variables that are missing/empty. Never their values. */
export function missingVars(env) {
  return REQUIRED_VARS.filter(name => !isPresent(env[name]))
}

/**
 * Pure decision function — the unit under test.
 * Returns { ok, required, missing, message }. `message` is safe to print: it
 * contains variable NAMES and remediation text only, never a value.
 */
export function evaluateHostedSupabaseConfig(env) {
  const required = isConfigRequired(env)
  const missing = missingVars(env)

  if (!required) {
    return {
      ok: true,
      required: false,
      missing,
      message: 'Supabase configuration not required for this non-hosted build; demo mode remains available.',
    }
  }
  if (missing.length === 0) {
    return { ok: true, required: true, missing, message: 'Hosted Supabase configuration present.' }
  }

  const context = String(env.VERCEL_ENV ?? '').trim().toLowerCase() || `${ENFORCE_FLAG}=1`
  return {
    ok: false,
    required: true,
    missing,
    message: [
      `Refusing to build: hosted build (${context}) is missing required Supabase configuration.`,
      `Missing or empty: ${missing.join(', ')}`,
      '',
      'Without both variables the application builds in DEMO mode, in which every',
      'visitor is treated as a signed-in DDP administrator. That must never be',
      'deployed to a hosted DDP domain.',
      '',
      `Set both variables for this environment in the Vercel project settings, then rebuild.`,
    ].join('\n'),
  }
}

// ── CSP / Supabase-origin alignment ─────────────────────────────────────────
//
// vercel.json pins a Content-Security-Policy whose `connect-src` and `img-src`
// name ONE Supabase origin literally, while the client is constructed at runtime
// from VITE_SUPABASE_URL (src/lib/supabase.ts). Vercel does not interpolate
// environment variables into vercel.json, so the policy cannot be derived at
// deploy time — the two can drift.
//
// Today they cannot drift by accident: `vercel env ls` shows a SINGLE
// VITE_SUPABASE_URL entry whose targets are "Preview, Production", so both
// hosted environments resolve the same value (measured 2026-07-28). That is a
// fact about current project configuration, not a property of the system — the
// moment somebody adds a Preview-scoped override, the CSP would silently block
// authentication, PostgREST, realtime and storage on every preview deployment,
// and the only symptom would be a browser console full of CSP violations.
//
// So rather than trusting the coincidence, the build asserts it. A mismatch
// fails the build loudly instead of shipping a broken deployment.
//
// This prints ORIGINS ONLY, and only ones already committed to vercel.json — it
// never echoes the value of VITE_SUPABASE_URL.

/** The `https://host` origin of a URL, or null when it is unparseable. */
export function originOf(url) {
  if (!isPresent(url)) return null
  try {
    return new URL(String(url).trim()).origin
  } catch {
    return null
  }
}

/**
 * The source-expressions listed for one CSP directive.
 * `cspHeaderValue` is the raw header string from vercel.json.
 */
export function cspDirectiveSources(cspHeaderValue, directive) {
  const directives = String(cspHeaderValue ?? '').split(';')
  for (const entry of directives) {
    const parts = entry.trim().split(/\s+/).filter(Boolean)
    if (parts.length && parts[0].toLowerCase() === directive.toLowerCase()) {
      return parts.slice(1)
    }
  }
  return []
}

/**
 * True when `origin` is permitted by the directive. Compares parsed origins so
 * that a trailing slash or an uppercase scheme cannot cause a false mismatch.
 * Keyword sources ('self', 'none', …) never match a concrete origin.
 */
export function directivePermitsOrigin(cspHeaderValue, directive, origin) {
  return cspDirectiveSources(cspHeaderValue, directive).some(source => {
    if (source.startsWith("'")) return false
    const sourceOrigin = originOf(source)
    return sourceOrigin !== null && sourceOrigin === origin
  })
}

/**
 * The directives that must name the Supabase origin, and why.
 * `wss:` is checked separately because realtime uses a WebSocket scheme.
 */
const SUPABASE_CSP_DIRECTIVES = [
  ['connect-src', 'PostgREST, auth and storage requests'],
  ['img-src', 'storage-served images'],
]

/**
 * Pure decision function. Returns { ok, checked, message }.
 * `checked` is false when this build does not require hosted configuration, or
 * when the URL is absent/unparseable (the presence check above owns that case).
 */
export function evaluateCspSupabaseAlignment(env, cspHeaderValue) {
  if (!isConfigRequired(env)) {
    return { ok: true, checked: false, message: 'CSP/Supabase alignment not checked for a non-hosted build.' }
  }
  const origin = originOf(env.VITE_SUPABASE_URL)
  if (origin === null) {
    return { ok: true, checked: false, message: 'CSP/Supabase alignment not checked: no parseable VITE_SUPABASE_URL.' }
  }

  const failures = []
  for (const [directive, why] of SUPABASE_CSP_DIRECTIVES) {
    if (!directivePermitsOrigin(cspHeaderValue, directive, origin)) {
      failures.push({ directive, why, allowed: cspDirectiveSources(cspHeaderValue, directive) })
    }
  }
  // Realtime connects over wss://, which is a distinct origin from https://.
  const wssOrigin = origin.replace(/^https:/, 'wss:')
  if (!directivePermitsOrigin(cspHeaderValue, 'connect-src', wssOrigin)) {
    failures.push({
      directive: 'connect-src (wss)',
      why: 'Supabase realtime WebSocket',
      allowed: cspDirectiveSources(cspHeaderValue, 'connect-src'),
    })
  }

  if (failures.length === 0) {
    return { ok: true, checked: true, message: "This build's Supabase origin is permitted by the vercel.json CSP." }
  }

  return {
    ok: false,
    checked: true,
    message: [
      'Refusing to build: the Content-Security-Policy in vercel.json does not permit',
      "this environment's Supabase origin, so the deployed app could not reach its own",
      'backend. The CSP is a static file; VITE_SUPABASE_URL is per-environment.',
      '',
      ...failures.map(f => `  ${f.directive} — needed for ${f.why}; currently allows: ${f.allowed.join(' ') || '(nothing)'}`),
      '',
      'Either point this environment at the Supabase project the CSP names, or update',
      'the CSP in vercel.json to name this environment\'s origin.',
      '(The offending origin is deliberately not printed here; it is the origin of',
      ' VITE_SUPABASE_URL for this environment.)',
    ].join('\n'),
  }
}

/** Reads the first Content-Security-Policy header value out of vercel.json. */
export function readCspFromVercelJson(vercelJsonPath) {
  const config = JSON.parse(readFileSync(vercelJsonPath, 'utf8'))
  for (const rule of config.headers ?? []) {
    for (const header of rule.headers ?? []) {
      if (String(header.key).toLowerCase() === 'content-security-policy') return header.value
    }
  }
  return null
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Guarded so importing this module in tests never exits the test runner.
// Compare decoded filesystem paths: process.argv[1] is already a decoded path,
// while import.meta.url is a percent-encoded file: URL, so hand-building
// `file://${process.argv[1]}` mismatches whenever the path contains characters
// that get encoded (e.g. a space -> %20). fileURLToPath decodes import.meta.url
// to the same form as process.argv[1].
const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const result = evaluateHostedSupabaseConfig(process.env)
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
  console.log(result.message)

  // Second gate: the static CSP must permit this environment's Supabase origin.
  // Only meaningful once the presence check above has passed.
  const vercelJson = join(dirname(fileURLToPath(import.meta.url)), '..', 'vercel.json')
  let csp = null
  try {
    csp = readCspFromVercelJson(vercelJson)
  } catch (err) {
    console.error(`Refusing to build: vercel.json could not be read or parsed (${err.message}).`)
    process.exit(1)
  }
  if (csp !== null) {
    const alignment = evaluateCspSupabaseAlignment(process.env, csp)
    if (!alignment.ok) {
      console.error(alignment.message)
      process.exit(1)
    }
    console.log(alignment.message)
  }
}

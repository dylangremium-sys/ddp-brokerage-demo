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

// ── CLI ─────────────────────────────────────────────────────────────────────
// Guarded so importing this module in tests never exits the test runner.
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  const result = evaluateHostedSupabaseConfig(process.env)
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
  console.log(result.message)
}

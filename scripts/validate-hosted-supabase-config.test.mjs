// Guard against a hosted build shipping in demo mode.
//
// The decision function is exercised directly for every context/value
// combination, and the CLI is exercised as a real child process so exit codes
// and — critically — the absence of secret values in the output are proven,
// not assumed. A final block asserts the guard is actually wired into the build
// path: a correct script that nothing invokes protects nothing.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  ENFORCE_FLAG,
  REQUIRED_VARS,
  evaluateHostedSupabaseConfig,
  isConfigRequired,
  isPresent,
  missingVars,
  originOf,
  cspDirectiveSources,
  directivePermitsOrigin,
  evaluateCspSupabaseAlignment,
  readCspFromVercelJson,
} from './validate-hosted-supabase-config.mjs'

// fileURLToPath decodes percent-encoding (a space in the path becomes %20 in a
// file: URL) so fs calls work on any checkout whose path contains a space.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/validate-hosted-supabase-config.mjs')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// Obviously synthetic. Never a real project ref or key.
const FAKE_URL = 'https://synthetic-not-a-real-ref.supabase.co'
const FAKE_KEY = 'synthetic-anon-key-value-for-tests-only'

// The Supabase origin the committed CSP permits. Read from vercel.json (which is
// public, tracked configuration — not a secret) so the CLI tests below exercise
// the aligned case without hard-coding a project ref in two places.
const CSP_SUPABASE_ORIGIN = cspDirectiveSources(readCspFromVercelJson(join(ROOT, 'vercel.json')), 'connect-src')
  .find(source => source.startsWith('https://') && source.includes('.supabase.co'))

function ok(env) {
  return evaluateHostedSupabaseConfig(env).ok
}

/** Runs the CLI as a child process. Returns { status, stdout, stderr }. */
function runCli(env) {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('required variables', () => {
  it('requires exactly the two variables the app derives its mode from', () => {
    expect(REQUIRED_VARS).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])
  })
})

describe('presence rules', () => {
  it('accepts a non-empty string', () => {
    expect(isPresent(FAKE_URL)).toBe(true)
  })

  it('rejects missing, empty and whitespace-only values', () => {
    // Vercel stores an unset variable as an empty string, and `!!(url && key)`
    // treats empty/whitespace as unconfigured — so these must fail here too.
    for (const value of [undefined, null, '', '   ', '\t', '\n', '  \t\n ']) {
      expect(isPresent(value)).toBe(false)
    }
  })

  it('reports missing variables by name only', () => {
    expect(missingVars({ VITE_SUPABASE_URL: FAKE_URL })).toEqual(['VITE_SUPABASE_ANON_KEY'])
    expect(missingVars({})).toEqual(REQUIRED_VARS)
    expect(missingVars({ VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toEqual([])
  })
})

describe('when configuration is required', () => {
  it('is required for hosted Vercel environments', () => {
    expect(isConfigRequired({ VERCEL_ENV: 'preview' })).toBe(true)
    expect(isConfigRequired({ VERCEL_ENV: 'production' })).toBe(true)
    expect(isConfigRequired({ VERCEL_ENV: 'PRODUCTION' })).toBe(true) // case-insensitive
    expect(isConfigRequired({ VERCEL_ENV: ' preview ' })).toBe(true)  // padded
  })

  it('is NOT required locally, preserving the demo workflow', () => {
    expect(isConfigRequired({})).toBe(false)
    expect(isConfigRequired({ VERCEL_ENV: '' })).toBe(false)
    // `vercel dev` is a local workflow, not a hosted deployment.
    expect(isConfigRequired({ VERCEL_ENV: 'development' })).toBe(false)
  })

  it('is required when enforcement is set explicitly', () => {
    expect(isConfigRequired({ [ENFORCE_FLAG]: '1' })).toBe(true)
  })

  it('is not triggered by a non-"1" enforcement value', () => {
    expect(isConfigRequired({ [ENFORCE_FLAG]: '0' })).toBe(false)
    expect(isConfigRequired({ [ENFORCE_FLAG]: '' })).toBe(false)
  })
})

describe('non-hosted local context — demo mode preserved', () => {
  it('allows no variables at all', () => {
    expect(ok({})).toBe(true)
  })

  it('allows both variables present', () => {
    expect(ok({ VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toBe(true)
  })

  it('allows a partial configuration (local builds are never blocked)', () => {
    expect(ok({ VITE_SUPABASE_URL: FAKE_URL })).toBe(true)
    expect(ok({ VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toBe(true)
  })

  it('says so without claiming configuration is present', () => {
    const result = evaluateHostedSupabaseConfig({})
    expect(result.required).toBe(false)
    expect(result.message).toContain('demo mode remains available')
  })
})

for (const vercelEnv of ['preview', 'production']) {
  describe(`hosted ${vercelEnv} build`, () => {
    it('passes when both variables are present', () => {
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toBe(true)
    })

    it('fails when the URL is missing', () => {
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toBe(false)
    })

    it('fails when the anon key is missing', () => {
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: FAKE_URL })).toBe(false)
    })

    it('fails when both are missing', () => {
      expect(ok({ VERCEL_ENV: vercelEnv })).toBe(false)
    })

    it('fails on empty-string values', () => {
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' })).toBe(false)
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: '' })).toBe(false)
    })

    it('fails on whitespace-only values', () => {
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: '   ', VITE_SUPABASE_ANON_KEY: '\t' })).toBe(false)
      expect(ok({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: '  ' })).toBe(false)
    })

    it('names every missing variable in the failure', () => {
      const result = evaluateHostedSupabaseConfig({ VERCEL_ENV: vercelEnv })
      expect(result.missing).toEqual(REQUIRED_VARS)
      for (const name of REQUIRED_VARS) expect(result.message).toContain(name)
    })
  })
}

describe('explicit enforcement flag', () => {
  it('passes with both present', () => {
    expect(ok({ [ENFORCE_FLAG]: '1', VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toBe(true)
  })

  it('fails with either missing', () => {
    expect(ok({ [ENFORCE_FLAG]: '1', VITE_SUPABASE_URL: FAKE_URL })).toBe(false)
    expect(ok({ [ENFORCE_FLAG]: '1', VITE_SUPABASE_ANON_KEY: FAKE_KEY })).toBe(false)
    expect(ok({ [ENFORCE_FLAG]: '1' })).toBe(false)
  })
})

describe('secret safety — output never contains a value', () => {
  it('does not echo a supplied value when failing on the other variable', () => {
    // URL supplied, key missing: the failure must not reproduce the URL.
    const result = evaluateHostedSupabaseConfig({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: FAKE_URL })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(FAKE_URL)
    expect(result.message).not.toContain('supabase.co')
  })

  it('does not echo a supplied key', () => {
    const result = evaluateHostedSupabaseConfig({ VERCEL_ENV: 'production', VITE_SUPABASE_ANON_KEY: FAKE_KEY })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(FAKE_KEY)
  })

  it('does not leak even a fragment of a supplied value', () => {
    const result = evaluateHostedSupabaseConfig({
      VERCEL_ENV: 'preview',
      VITE_SUPABASE_URL: 'https://leakcanary123456.supabase.co',
      VITE_SUPABASE_ANON_KEY: '',
    })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('leakcanary')
    expect(result.message).not.toContain('123456')
  })

  it('carries variable names and remediation text only', () => {
    const result = evaluateHostedSupabaseConfig({ VERCEL_ENV: 'production' })
    expect(result.message).toContain('VITE_SUPABASE_URL')
    expect(result.message).toContain('VITE_SUPABASE_ANON_KEY')
    expect(result.message).toContain('Refusing to build')
    expect(result.message).toMatch(/Vercel project settings/i)
  })
})

describe('CLI behaviour (real child process)', () => {
  it('exits 0 for a local build with no configuration', () => {
    expect(runCli({}).status).toBe(0)
  })

  it('exits 0 for a hosted build with complete configuration', () => {
    // The URL must be the origin the committed CSP names, because the CLI now
    // runs a SECOND gate: presence, then CSP alignment. Derived from vercel.json
    // rather than hard-coded so the test follows the policy if it is retargeted.
    const run = runCli({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: CSP_SUPABASE_ORIGIN, VITE_SUPABASE_ANON_KEY: FAKE_KEY })
    expect(run.status).toBe(0)
  })

  it('exits non-zero when configuration is present but the CSP names another project', () => {
    // End-to-end proof of the reviewer's drift scenario: a Preview-scoped
    // VITE_SUPABASE_URL override would produce a deployment whose every backend
    // call is blocked by our own CSP. The build must refuse instead of shipping it.
    const run = runCli({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: FAKE_KEY })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Refusing to build')
    expect(run.stderr).toContain('connect-src')
    // and still never echoes the value it rejected
    expect(`${run.stdout}${run.stderr}`).not.toContain('synthetic-not-a-real-ref')
  })

  it('exits non-zero for a hosted production build with missing configuration', () => {
    const run = runCli({ VERCEL_ENV: 'production' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Refusing to build')
  })

  it('exits non-zero for a hosted preview build with an empty variable', () => {
    const run = runCli({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: '' })
    expect(run.status).not.toBe(0)
  })

  it('prints no supplied value on either stream when it fails', () => {
    const run = runCli({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: FAKE_URL, VITE_SUPABASE_ANON_KEY: '' })
    expect(run.status).not.toBe(0)
    const output = `${run.stdout}${run.stderr}`
    expect(output).not.toContain(FAKE_URL)
    expect(output).not.toContain('synthetic-not-a-real-ref')
  })
})

// ── Build integration ───────────────────────────────────────────────────────
// A correct guard that nothing invokes protects nothing. These assert the wiring
// itself, so deleting the guard from the build path fails the suite.
describe('the guard is wired into the build path', () => {
  it('runs in prebuild, which npm invokes before build', () => {
    expect(PKG.scripts.prebuild).toContain('validate-hosted-supabase-config.mjs')
  })

  it('runs BEFORE version generation, so it aborts before any asset is produced', () => {
    const prebuild = PKG.scripts.prebuild
    expect(prebuild.indexOf('validate-hosted-supabase-config'))
      .toBeLessThan(prebuild.indexOf('generate-version'))
  })

  it('is chained with && so a failure stops the build', () => {
    // `;` or `||` would let the build continue past a refusal.
    expect(PKG.scripts.prebuild).toMatch(/validate-hosted-supabase-config\.mjs\s*&&/)
  })

  it('covers Vercel preview AND production, because Vercel runs npm run build', () => {
    // vercel.json sets no buildCommand, so Vercel's Vite preset runs
    // `npm run build` for Git-triggered previews and for `vercel build --prod`.
    // npm runs `prebuild` before `build` in both cases. If a buildCommand is
    // ever added, this test fails and the coverage claim must be re-established.
    const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))
    expect(vercelConfig.buildCommand).toBeUndefined()
    expect(PKG.scripts.build).toBeTruthy()
  })

  it('does not block ordinary CI, which builds without hosted secrets', () => {
    // ci:verify runs `npm run build` with no VERCEL_ENV set.
    expect(PKG.scripts['ci:verify']).toContain('npm run build')
    expect(isConfigRequired({})).toBe(false)
  })
})

// ─── CSP / Supabase-origin alignment (PR #80 reviewer point) ────────────────
//
// vercel.json names one Supabase origin literally; the client is built from
// VITE_SUPABASE_URL at runtime. Vercel does not interpolate env vars into
// vercel.json, so the policy cannot be derived — instead the build asserts the
// two agree, and refuses rather than shipping a deployment that cannot reach
// its own backend.

describe('CSP directive parsing', () => {
  const CSP = "default-src 'self'; connect-src 'self' https://ref.supabase.co wss://ref.supabase.co; img-src 'self' data: blob: https://ref.supabase.co"

  it('extracts the sources of a named directive', () => {
    expect(cspDirectiveSources(CSP, 'connect-src')).toEqual([
      "'self'", 'https://ref.supabase.co', 'wss://ref.supabase.co',
    ])
  })

  it('is case-insensitive on the directive name and empty-safe', () => {
    expect(cspDirectiveSources(CSP, 'CONNECT-SRC')).toContain('https://ref.supabase.co')
    expect(cspDirectiveSources(CSP, 'font-src')).toEqual([])
    expect(cspDirectiveSources(null, 'connect-src')).toEqual([])
  })

  it('does not confuse a directive with one whose name it prefixes', () => {
    // 'connect-src' must not be satisfied by reading 'default-src'.
    expect(cspDirectiveSources('default-src https://evil.example', 'connect-src')).toEqual([])
  })

  it('matches an origin regardless of trailing slash or scheme case', () => {
    expect(directivePermitsOrigin(CSP, 'connect-src', 'https://ref.supabase.co')).toBe(true)
    expect(directivePermitsOrigin(CSP, 'connect-src', 'wss://ref.supabase.co')).toBe(true)
    expect(directivePermitsOrigin(CSP, 'connect-src', 'https://other.supabase.co')).toBe(false)
  })

  it('never treats a keyword source as permitting a concrete origin', () => {
    // "'self'" must not be read as allowing an arbitrary Supabase host.
    expect(directivePermitsOrigin("connect-src 'self'", 'connect-src', 'https://ref.supabase.co')).toBe(false)
  })

  it('originOf is null-safe and rejects unparseable values', () => {
    expect(originOf('https://ref.supabase.co/rest/v1')).toBe('https://ref.supabase.co')
    expect(originOf('not a url')).toBeNull()
    expect(originOf('')).toBeNull()
    expect(originOf()).toBeNull()
  })
})

describe('the build refuses a CSP that cannot reach this environment Supabase', () => {
  const ALIGNED = "connect-src 'self' https://ref.supabase.co wss://ref.supabase.co; img-src 'self' https://ref.supabase.co"
  const hosted = url => ({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: FAKE_KEY })

  it('passes when the origin is named in connect-src, img-src and wss', () => {
    const result = evaluateCspSupabaseAlignment(hosted('https://ref.supabase.co'), ALIGNED)
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(true)
  })

  it('fails when the environment points at a DIFFERENT project than the CSP names', () => {
    // The exact drift the reviewer raised: a Preview-scoped override would ship
    // a build whose every backend call is blocked by our own policy.
    const result = evaluateCspSupabaseAlignment(hosted('https://preview-ref.supabase.co'), ALIGNED)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Refusing to build/)
    expect(result.message).toMatch(/connect-src/)
  })

  it('fails when realtime wss is missing even though https is allowed', () => {
    const noWss = "connect-src 'self' https://ref.supabase.co; img-src 'self' https://ref.supabase.co"
    const result = evaluateCspSupabaseAlignment(hosted('https://ref.supabase.co'), noWss)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/wss/)
  })

  it('never echoes the VITE_SUPABASE_URL value in its failure message', () => {
    const secretish = 'https://do-not-print-this-ref.supabase.co'
    const result = evaluateCspSupabaseAlignment(hosted(secretish), ALIGNED)
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('do-not-print-this-ref')
  })

  it('does not run for a non-hosted build, so local builds stay unaffected', () => {
    const result = evaluateCspSupabaseAlignment({ VITE_SUPABASE_URL: 'https://x.supabase.co' }, ALIGNED)
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(false)
  })

  it('the CSP actually committed in vercel.json is self-consistent', () => {
    // Reads the real file: connect-src and img-src must name the same Supabase
    // origin, and connect-src must carry its wss counterpart.
    const csp = readCspFromVercelJson(join(ROOT, 'vercel.json'))
    expect(csp).toBeTruthy()
    const supabaseOrigin = cspDirectiveSources(csp, 'connect-src')
      .find(s => s.startsWith('https://') && s.includes('.supabase.co'))
    expect(supabaseOrigin, 'connect-src must name a Supabase origin').toBeTruthy()
    expect(directivePermitsOrigin(csp, 'img-src', supabaseOrigin)).toBe(true)
    expect(directivePermitsOrigin(csp, 'connect-src', supabaseOrigin.replace(/^https:/, 'wss:'))).toBe(true)
  })
})

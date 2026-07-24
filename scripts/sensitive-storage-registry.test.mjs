// Drift guard: every DDP browser storage key must be in the sign-out allowlist.
//
// Sign-out clears SENSITIVE_DDP_KEYS (browserPersistence.ts) — an explicit
// allowlist, deliberately not localStorage.clear(), so unrelated preferences
// survive. The weakness of an allowlist is that a NEW key added later silently
// escapes it, and the data it holds outlives sign-out. Nothing in the type system
// prevents that.
//
// This test scans src/ for every 'ddp_*' string literal and fails if one is not in
// the registry. It lives in scripts/ (.mjs) because reading from disk needs node
// types, which the app tsconfig deliberately does not expose to src/.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// fileURLToPath decodes percent-encoding (e.g. a space in the workspace path
// becomes %20 in a file: URL) and applies platform-correct conversion. Using
// `new URL(...).pathname` here would leave %20 in the path and break fs calls on
// any checkout whose absolute path contains a space.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// `ddp_*` string literals that are NOT browser storage keys. Each needs a reason;
// the list must stay tiny, because anything wrongly excluded here is a key that
// would silently survive sign-out.
const NOT_STORAGE_KEYS = new Set([
  'ddp_admin',  // a UserRole value (services/auth.ts:4), never a storage key
])

// Keys the app actually uses, harvested from source.
function keysInSource() {
  const found = new Set()
  for (const file of walk(join(ROOT, 'src'))) {
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/['"`](ddp_[a-z0-9_]+)['"`]/g)) {
      if (!NOT_STORAGE_KEYS.has(m[1])) found.add(m[1])
    }
  }
  return [...found].sort()
}

// The registry, read as text so this test does not import the app's module graph
// (browserPersistence.ts imports ./supabase, which reads import.meta.env).
function keysInRegistry() {
  const body = readFileSync(join(ROOT, 'src/lib/browserPersistence.ts'), 'utf8')
  // Anchor on `= [` — the type annotation `readonly string[]` contains brackets
  // that would otherwise truncate the slice to nothing.
  const decl = body.indexOf('SENSITIVE_DDP_KEYS')
  const start = body.indexOf('= [', decl) + 2
  const block = body.slice(start, body.indexOf(']', start))
  return [...block.matchAll(/'(ddp_[a-z0-9_]+)'/g)].map(m => m[1]).sort()
}

describe('sign-out allowlist covers every DDP storage key in src/', () => {
  it('registry is not empty (guards against a broken parse silently passing)', () => {
    expect(keysInRegistry().length).toBeGreaterThan(10)
    expect(keysInSource().length).toBeGreaterThan(10)
  })

  it('every ddp_* key used in src/ is cleared on sign-out', () => {
    const registry = new Set(keysInRegistry())
    const missing = keysInSource().filter(k => !registry.has(k))

    // A key here means: data written to the browser under this key would SURVIVE
    // sign-out. Add it to SENSITIVE_DDP_KEYS in src/lib/browserPersistence.ts.
    expect(missing, `keys not cleared on sign-out: ${missing.join(', ')}`).toEqual([])
  })

  it('the registry lists no key that src/ does not use (no dead entries)', () => {
    const source = new Set(keysInSource())
    const stale = keysInRegistry().filter(k => !source.has(k))
    expect(stale, `registry entries no longer used in src/: ${stale.join(', ')}`).toEqual([])
  })
})

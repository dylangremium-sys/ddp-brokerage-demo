import { describe, expect, it } from 'vitest'

/**
 * THE BOUNDARY: nothing in the publishing path may reach internal compliance
 * data.
 *
 * Publishing a regulatory update is a deliberate authored step — a markdown
 * file, reviewed in a pull request. It must never become a read from
 * watchtower_ingestion_items, from supplier licences, from COA rows or from
 * anything else the application holds. The structural guarantee is that the
 * pipeline is a filesystem read with no client and no credential. This test is
 * what proves that guarantee has not quietly eroded.
 *
 * HOW IT WORKS
 *   It starts at the publishing entry points and follows every relative import
 *   transitively through src/, collecting the modules actually reachable. Then
 *   it asserts none of them imports a forbidden specifier.
 *
 * WHY AN IMPORT GRAPH RATHER THAN A GREP OF ONE FILE
 *   The dangerous version of this failure is indirect. Nobody writes
 *   `import { supabase }` into a content module; somebody imports a helper that
 *   looks innocent, and three hops later it holds a client. A grep of the
 *   content directory would pass while the boundary was gone.
 *
 * PROVING IT CAN FAIL
 *   A test that has never been seen red is not evidence of anything. The last
 *   case in this file constructs the exact violation — a publishing module
 *   importing the Supabase client — and asserts the checker reports it. If that
 *   case ever passes trivially, the checker has stopped working and the rest of
 *   this file is decoration.
 */

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Where the publishing path starts. */
const ENTRY_POINTS = [
  '/src/content/regulatoryEntries.ts',
  '/src/content/frontmatter.ts',
  '/src/content/markdown.ts',
  '/src/content/leakCanary.ts',
]

/**
 * Specifiers that mean "this module can reach operational data".
 *
 * Anything that holds a Supabase client, anything in the services layer, and
 * the serverless functions. A publishing module has no business with any of
 * them, whatever it intends to do with them.
 */
const FORBIDDEN = [
  { pattern: /@supabase\/supabase-js/, why: 'the Supabase client library' },
  { pattern: /(^|\/)services\//, why: 'the services layer, which holds operational reads and writes' },
  { pattern: /(^|\/)lib\/supabase(\.|$)/, why: 'the configured Supabase client' },
  { pattern: /(^|\/)api\//, why: 'the serverless functions' },
  { pattern: /watchtower/i, why: 'the internal compliance ingestion system' },
]

const IMPORT_RE = /(?:^|\n)\s*(import|export)(\s+type\b)?[\s\S]*?from\s*['"]([^'"]+)['"]/g

/**
 * The RUNTIME imports of a module.
 *
 * `import type` and `export type` are erased by the compiler — they create no
 * runtime edge and cannot carry a value, let alone a database client. Counting
 * them would make this test wrong in a way that matters: src/types.ts carries
 * `export type { UserRole } from './services/auth.js'`, so every module that
 * needs the Page union would look like a boundary breach. A test that flags
 * correct code gets relaxed, and the relaxation is what removes the guard.
 *
 * A default or named VALUE import of the same module would still be caught,
 * which is the case worth catching.
 */
const importsOf = (source: string): string[] =>
  [...source.matchAll(IMPORT_RE)]
    .filter((m) => m[2] === undefined)
    .map((m) => m[3])

/** Resolves a relative specifier against the importing module's path. */
function resolve(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null

  const base = fromPath.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '.') continue
    else if (part === '..') base.pop()
    else base.push(part)
  }
  const joined = base.join('/')

  for (const candidate of [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`]) {
    if (candidate in SOURCES) return candidate
  }
  return null
}

interface Violation {
  module: string
  specifier: string
  why: string
  via: string[]
}

/**
 * Every forbidden import reachable from `entryPoints`, with the path that got
 * there — so a failure names the chain, not just the endpoint.
 */
function violationsFrom(entryPoints: string[], extraEdges: Record<string, string[]> = {}): Violation[] {
  const violations: Violation[] = []
  const seen = new Set<string>()
  const queue: Array<{ path: string; via: string[] }> = entryPoints.map((path) => ({ path, via: [path] }))

  while (queue.length > 0) {
    const { path, via } = queue.shift()!
    if (seen.has(path)) continue
    seen.add(path)

    const source = SOURCES[path]
    if (source === undefined) continue

    const specifiers = [...importsOf(source), ...(extraEdges[path] ?? [])]

    for (const specifier of specifiers) {
      const forbidden = FORBIDDEN.find((f) => f.pattern.test(specifier))
      if (forbidden) {
        violations.push({ module: path, specifier, why: forbidden.why, via })
        continue
      }
      const next = resolve(path, specifier)
      if (next) queue.push({ path: next, via: [...via, next] })
    }
  }

  return violations
}

describe('the publishing path cannot reach internal compliance data', () => {
  it('reads the source it reasons about, so the assertions are not vacuous', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50)
    for (const entry of ENTRY_POINTS) {
      expect(SOURCES[entry], `${entry} was not read`).toBeDefined()
    }
  })

  it('reaches no Supabase client, services module, api function or watchtower code', () => {
    const violations = violationsFrom(ENTRY_POINTS)

    const detail = violations
      .map((v) => `  ${v.specifier} (${v.why})\n    via ${v.via.join(' → ')}`)
      .join('\n')

    expect(violations, `the publishing path can reach operational data:\n${detail}`).toEqual([])
  })

  /**
   * The publishing path holds no credentials either. Reading process.env is how
   * a module acquires a service-role key, and nothing that turns a markdown file
   * into HTML needs one.
   */
  it('reads no environment variables', () => {
    const reachable = new Set<string>()
    const queue = [...ENTRY_POINTS]
    while (queue.length) {
      const path = queue.shift()!
      if (reachable.has(path) || !(path in SOURCES)) continue
      reachable.add(path)
      for (const specifier of importsOf(SOURCES[path])) {
        const next = resolve(path, specifier)
        if (next) queue.push(next)
      }
    }

    for (const path of reachable) {
      expect(SOURCES[path], `${path} reads process.env`).not.toMatch(/process\.env/)
      expect(SOURCES[path], `${path} reads import.meta.env`).not.toMatch(/import\.meta\.env/)
    }
  })

  /**
   * THE CASE THAT PROVES THE CHECKER WORKS.
   *
   * The violation is injected rather than written into a real file, because
   * breaking a tracked module to prove a test fails leaves the repo one
   * forgotten revert away from shipping the thing being guarded against.
   *
   * `extraEdges` adds the import that a careless change would add for real —
   * the content loader importing the Supabase client — and the checker must
   * report it, name the module, and name the chain.
   */
  it('DETECTS a violation when one exists', () => {
    const violations = violationsFrom(ENTRY_POINTS, {
      '/src/content/regulatoryEntries.ts': ['@supabase/supabase-js'],
    })

    expect(violations.length, 'the checker did not notice an injected Supabase import').toBe(1)
    expect(violations[0].module).toBe('/src/content/regulatoryEntries.ts')
    expect(violations[0].specifier).toBe('@supabase/supabase-js')
  })

  it('DETECTS a violation reached indirectly, several hops away', () => {
    // The realistic version: a content module imports something innocent, which
    // imports something else, which holds a client. A grep of the content
    // directory would pass. This must not.
    const violations = violationsFrom(ENTRY_POINTS, {
      '/src/content/markdown.ts': ['../lib/urlRouting'],
      '/src/lib/urlRouting.ts': ['../services/supabaseAdmin'],
    })

    expect(violations.length).toBe(1)
    expect(violations[0].specifier).toBe('../services/supabaseAdmin')
    expect(violations[0].via).toContain('/src/lib/urlRouting.ts')
  })
})

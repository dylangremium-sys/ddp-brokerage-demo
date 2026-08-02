// Regression guard: Vercel Functions are native Node ESM, and nothing else catches this.
//
// This test exists because a production endpoint shipped completely dead and
// every gate went green on the way. `/api/cron/ingest` returned
// FUNCTION_INVOCATION_FAILED on its first live request:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//   '/var/task/src/lib/complianceSourceConnectorRuntime'
//   imported from /var/task/src/lib/complianceRssConnector.js
//
// Vercel ships api/ as native Node ESM and does NOT bundle it, so a relative
// import must carry an explicit `.js` extension or it resolves to a file that
// does not exist on disk. Vite, vitest and tsc all resolve extensionless
// imports happily — so `npm run ci:verify` passes, the build passes, the deploy
// passes, version.json reports the new commit, and the function is still dead.
// Only a real request reveals it. That is the entire failure mode this guards.
//
// It checks two properties over the TRANSITIVE RUNTIME graph of every api/
// entry point. Both were violated by the same commit.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Matches a whole import/export STATEMENT, including multi-line ones, and
 * captures whether it is type-only plus its specifier.
 *
 * Two earlier versions of this guard were line-based and each missed a real
 * case, so the shape here is deliberate:
 *
 *  1. Anchoring to a line starting with `import` missed the very bug this file
 *     exists for — complianceRssConnector's offending import is multi-line, so
 *     the specifier sits on a line beginning with `}`. Guard green, function dead.
 *  2. Testing `import type` on the line holding `from` then misread multi-line
 *     `import type { A, B }\n from './x'` as a RUNTIME import, and reported a
 *     type-only import (erased at compile time) as a fatal one.
 *
 * Matching the statement is what makes both classifications correct.
 */
const STATEMENT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(type\s+)?(?:[\s\S]*?)from\s*['"]([^'"]+)['"]/g

/** Yields { typeOnly, spec } for every import/export-from in a source file. */
function* importsOf(source) {
  STATEMENT_RE.lastIndex = 0
  let m
  while ((m = STATEMENT_RE.exec(source)) !== null) {
    yield { typeOnly: Boolean(m[1]), spec: m[2] }
  }
}

function resolveSpecifier(importerAbs, spec) {
  const base = resolve(dirname(importerAbs), spec)
  const withoutJs = base.endsWith('.js') ? base.slice(0, -3) : base
  for (const cand of [`${withoutJs}.ts`, `${withoutJs}.tsx`, `${base}.ts`, `${base}.tsx`]) {
    if (existsSync(cand)) return cand
  }
  return null
}

/** Every api/**\/*.ts — each is an independently loaded serverless entry point. */
function apiEntryPoints() {
  return globSync('api/**/*.ts', { cwd: ROOT }).map(p => resolve(ROOT, p))
}

/**
 * Walks the runtime import graph. Returns the visited modules, every relative
 * runtime import lacking a `.js` extension, and every one that resolves to
 * nothing.
 */
function walkRuntimeGraph() {
  const visited = new Set()
  const extensionless = []
  const unresolvable = []
  const queue = apiEntryPoints()

  while (queue.length > 0) {
    const file = queue.pop()
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)

    for (const { typeOnly, spec } of importsOf(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.') || typeOnly) continue
      const target = resolveSpecifier(file, spec)
      if (!spec.endsWith('.js')) extensionless.push(`${relative(ROOT, file)} -> "${spec}"`)
      if (target) queue.push(target)
      else unresolvable.push(`${relative(ROOT, file)} -> "${spec}"`)
    }
  }
  return { visited, extensionless, unresolvable }
}

const { visited, extensionless, unresolvable } = walkRuntimeGraph()

describe('api/ serverless entry points exist and are reachable', () => {
  it('finds the api entry points', () => {
    expect(apiEntryPoints().length).toBeGreaterThan(0)
  })

  it('walks a non-trivial runtime graph', () => {
    // Guards the guard: if the walker silently resolved nothing, every
    // assertion below would pass vacuously.
    expect(visited.size).toBeGreaterThan(apiEntryPoints().length)
  })
})

describe('every relative runtime import under api/ carries a .js extension', () => {
  it('has no extensionless relative runtime imports', () => {
    expect(
      extensionless,
      'Vercel ships api/ as native Node ESM without bundling, so these resolve to ' +
        'nothing at runtime and the function dies at load with ERR_MODULE_NOT_FOUND ' +
        'BEFORE any handler code runs. tsc, vite and vitest all resolve them fine, ' +
        'so no other check catches this. Add the .js extension:\n  ' +
        extensionless.join('\n  '),
    ).toEqual([])
  })

  it('every relative runtime import resolves to a file that exists', () => {
    expect(unresolvable, `unresolvable relative imports:\n  ${unresolvable.join('\n  ')}`).toEqual([])
  })
})

describe('no api/ runtime graph module reads import.meta', () => {
  it('keeps the browser Supabase singleton out of every serverless function', () => {
    // src/lib/supabase.ts builds its client from `import.meta.env.VITE_*` in the
    // MODULE BODY. Under Node ESM `import.meta.env` is undefined, so merely
    // importing it — even transitively, even without calling anything — throws
    // at load. This is how a browser-only repository reaches a Vercel Function:
    // one value import, several modules deep. A type-only import is fine and is
    // why watchtowerIngestionService imports complianceRepository as `import type`.
    const offenders = []
    for (const file of visited) {
      // Comments are stripped first. Several modules in this graph EXPLAIN this
      // hazard in prose, and a guard that fires on its own documentation would
      // be turned off within a week.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (/\bimport\.meta\.(env|url|glob)/.test(code)) {
        offenders.push(relative(ROOT, file))
      }
    }
    expect(
      offenders,
      'these are reachable at RUNTIME from api/ and read import.meta, which is ' +
        'undefined under Node ESM:\n  ' + offenders.join('\n  '),
    ).toEqual([])
  })
})

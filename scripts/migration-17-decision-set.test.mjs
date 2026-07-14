// Regression: the procurement decision set must be identical in the UI type and
// in the database CHECK constraint.
//
// The store previously accepted only progress|hold|reject while the dropdown
// (DDPBuyerPreview.tsx:573) offered all seven values in the ProcurementDecision
// union. Selecting one of the other four wrote the local cache, was rejected by
// the database with SQLSTATE 23514 (check_violation), and was then dropped on
// read — so the decision silently vanished from the UI.
//
// The two halves of that contract live in different languages and cannot be
// type-checked against each other. This test reads both files as text and asserts
// they enumerate the same set, so they cannot drift apart again.
//
// It lives in scripts/ (.mjs) rather than src/ because reading from disk needs
// node types, which the app tsconfig deliberately does not expose to src.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const types = readFileSync(new URL('src/types.ts', root), 'utf8')
const migration = readFileSync(new URL('17_PROCUREMENT_DECISIONS_MVP.sql', root), 'utf8')

// The ProcurementDecision union: `export type ProcurementDecision =` followed by
// `| 'value'` lines, terminated by the first blank line.
function decisionsFromTypes() {
  const start = types.indexOf('export type ProcurementDecision =')
  const block = types.slice(start, types.indexOf('\n\n', start))
  return [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}

// The CHECK clause on the decision column, bounded by the next column definition
// so no value mentioned elsewhere in the file can leak into the match.
function decisionsFromMigration() {
  const start = migration.indexOf('decision      TEXT NOT NULL CHECK')
  const clause = migration.slice(start, migration.indexOf('\n  reason', start))
  return [...clause.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}

describe('procurement decision set — TypeScript union vs migration 17 CHECK', () => {
  it('the UI type declares the seven decisions the dropdown renders', () => {
    expect(decisionsFromTypes()).toEqual([
      'progress', 'hold', 'reject',
      'request_documents', 'request_fresh_coa', 'request_inventory_proof', 'escalate_review',
    ])
  })

  it('the database CHECK accepts every decision the UI type declares', () => {
    // Set comparison: order is irrelevant, membership is not. A value the UI can
    // offer but the CHECK omits is exactly the defect this test exists to catch.
    expect([...decisionsFromMigration()].sort()).toEqual([...decisionsFromTypes()].sort())
  })

  it('the CHECK adds no value the UI cannot offer', () => {
    const extra = decisionsFromMigration().filter(d => !decisionsFromTypes().includes(d))
    expect(extra).toEqual([])
  })
})

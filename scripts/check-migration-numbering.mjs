#!/usr/bin/env node
// Required CI gate: migration ordinals must name exactly one migration each.
//
// Reads only the repository root directory listing. Connects to no database,
// reads no file contents, uses no secrets, and mutates nothing.
//
// Exit 0 = numbering is sound. Exit 1 = a defect that must be fixed before merge.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  findMigrationSplits,
  findNumberCollisions,
  findPaddingInconsistencies,
  nextAvailableNumber,
} from './migration-numbering.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Deliberate stem reuse across ordinals — a later migration that corrects an
 * earlier one and keeps its name on purpose. Each entry is a decision, and the
 * comment is the justification. Do not add an entry to silence a failure that
 * is actually a half-finished renumbering.
 */
const ALLOWED_SPLITS = {
  // 20_FARM_ADMIN_FIELD_GUARD_ACL_FIX corrects the EXECUTE ACL that migration
  // 19 left granted to `authenticated`.
  FARM_ADMIN_FIELD_GUARD: [19, 20],
  // 13_PUBLIC_FUNCTION_EXECUTE_DRIFT_CHECK is a standalone drift detector for
  // the ACL end-state migration 12 establishes.
  PUBLIC_FUNCTION_EXECUTE: [12, 13],
}

const failures = []

function report(headline, detail) {
  failures.push({ headline, detail })
}

const rootFilenames = readdirSync(ROOT).filter((name) => name.toLowerCase().endsWith('.sql'))

// ---------------------------------------------------------------- collisions
const collisions = findNumberCollisions(rootFilenames)
for (const collision of collisions) {
  report(
    `Migration ordinal ${collision.number} is claimed by ${collision.stems.length} different migrations`,
    [
      `  distinct migrations sharing ordinal ${collision.number}:`,
      ...collision.stems.map((stem) => `    - ${stem}`),
      '  files:',
      ...collision.files.map((file) => `    - ${file}`),
      `  FIX: renumber ONE of them to ${nextAvailableNumber(rootFilenames)} or higher, across`,
      '       every companion file, every file header self-reference, every script',
      '       constant, every test fixture and every doc reference.',
    ].join('\n'),
  )
}

// -------------------------------------------------------------------- splits
const splits = findMigrationSplits(rootFilenames, { allowedSplits: ALLOWED_SPLITS })
for (const split of splits) {
  report(
    `Migration ${split.stem} is split across ordinals ${split.numbers.join(' and ')}`,
    [
      '  This is the signature of a half-finished renumbering: some companions',
      '  moved and others did not.',
      '  files:',
      ...split.files.map((file) => `    - ${file}`),
      '  FIX: move every companion to the SAME ordinal. If the reuse is deliberate',
      '       (a later corrective migration), declare it in ALLOWED_SPLITS in',
      '       scripts/check-migration-numbering.mjs with a justification.',
    ].join('\n'),
  )
}

// ------------------------------------------------------------------- padding
for (const drift of findPaddingInconsistencies(rootFilenames)) {
  report(
    `Migration ordinal ${drift.number} is written inconsistently as ${drift.prefixes.join(' and ')}`,
    [
      '  Numeric order and filename order no longer agree, so "apply migrations in',
      '  order" is ambiguous.',
      '  FIX: use one spelling for this ordinal across all its files.',
    ].join('\n'),
  )
}

// -------------------------------------------------------------------- output
const numberedCount = rootFilenames.filter((name) => /^\d+_/.test(name)).length

if (failures.length === 0) {
  console.log(`PASS  Migration numbering: ${numberedCount} numbered root migration files, no ordinal claimed twice`)
  console.log(`PASS  Migration numbering: no migration split across ordinals (${Object.keys(ALLOWED_SPLITS).length} declared corrective pairs)`)
  console.log(`PASS  Migration numbering: ordinal padding is consistent`)
  console.log(`\nRESULT: PASS — next available migration ordinal is ${nextAvailableNumber(rootFilenames)}.`)
  process.exit(0)
}

for (const failure of failures) {
  console.error(`FAIL  ${failure.headline}`)
  console.error(failure.detail)
  console.error('')
}
console.error(`RESULT: FAIL — ${failures.length} migration-numbering defect(s). This is a merge blocker.`)
process.exit(1)

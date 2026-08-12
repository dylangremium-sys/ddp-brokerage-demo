#!/usr/bin/env node
/**
 * Does a migration's ledger row record the file's number, or the number the
 * file claims about itself?
 *
 * It claims its own. The INSERT inside 68_EVIDENCE_DECISION_GATE_HARDENING.sql
 * reads `VALUES (68, 'EVIDENCE_DECISION_GATE', …)` — a literal. Rename the file
 * to 70_ and the ledger still records 68, and `schema_migrations` then certifies
 * a false identity, which is the one thing it exists to prevent.
 *
 * This is not hypothetical. Migrations 62 and 66 were renumbered to 67 and 68 by
 * find-and-replace after CI found both numbers already claimed. A single missed
 * replacement would have left a file called 68 recording itself as 66 — and the
 * ledger would have said so with a timestamp and an actor, which is exactly the
 * kind of confident wrong answer that is worse than no answer.
 *
 * PostgreSQL cannot see the name of the file it is executing, so the check has
 * to be static and at the file level. It runs in `npm run verify:migrations`,
 * before a push, rather than only in CI afterwards.
 *
 * SCOPE: migrations from 67 up. The ledger rule begins there; earlier migrations
 * predate it and are backfilled by probe, marked as such.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const LEDGER_RULE_STARTS_AT = 67
const root = process.cwd()

const problems = []
let checked = 0

const hardening = readdirSync(root)
  .filter(f => /^\d+_.*_HARDENING\.sql$/.test(f))
  .map(f => ({ file: f, number: Number(f.split('_')[0]) }))
  .filter(m => m.number >= LEDGER_RULE_STARTS_AT)
  .sort((a, b) => a.number - b.number)

for (const { file, number } of hardening) {
  const sql = readFileSync(join(root, file), 'utf8')

  // The self-recording INSERT. Matched on the table rather than the whole
  // statement so a reformatted migration still gets checked.
  const insert = sql.match(
    /INSERT\s+INTO\s+public\.schema_migrations\s*\([^)]*\)\s*VALUES\s*\(\s*(\d+)\s*,/i,
  )

  if (!insert) {
    problems.push(
      `${file}\n    does not record itself in public.schema_migrations.\n` +
      `    Every migration from ${LEDGER_RULE_STARTS_AT} up must INSERT its own row as its final\n` +
      `    statement, inside its own transaction — that is what makes a partial or\n` +
      `    misdirected apply leave no trace to be mistaken for a successful one.`,
    )
    continue
  }

  checked += 1
  const claimed = Number(insert[1])
  if (claimed !== number) {
    problems.push(
      `${file}\n    is named ${number} but records itself as ${claimed}.\n` +
      `    The ledger would certify a false identity — the one thing it exists to prevent.\n` +
      `    Fix the number in the INSERT, or rename the file to match it.`,
    )
  }
}

if (problems.length > 0) {
  console.error('\nLedger self-identity check FAILED:\n')
  for (const p of problems) console.error(`  ${p}\n`)
  console.error(`${problems.length} problem(s) found.\n`)
  process.exit(1)
}

console.log(
  `PASS — ${checked} migration(s) from ${LEDGER_RULE_STARTS_AT} up record themselves, ` +
  `and each records the number it is named for.`,
)

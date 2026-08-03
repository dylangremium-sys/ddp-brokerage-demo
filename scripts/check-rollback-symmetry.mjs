#!/usr/bin/env node
// Static rollback create/drop symmetry gate.
//
// For every migration number at or above TRIPLET_FLOOR, checks that each table
// and function created by the HARDENING file is at least NAMED in the matching
// ROLLBACK file. This is the cheap, no-database half of the rollback guarantee.
//
// It catches Defect A (the rollback drops names that were never created, so
// DROP ... IF EXISTS exits 0 having removed nothing). It CANNOT catch Defect B
// (correct name, wrong argument list) — only comparing real catalogs before
// apply and after rollback does that. See scripts/disposable-pg/lib/
// rollback-symmetry.mjs, enforced inside the disposable-PG harness.
//
// --floor=N raises the enforced floor. Numbers below the enforced floor are
// still checked and REPORTED; they just do not fail the gate.

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import {
  listMigrationFilenames,
  parseMigrationFilename,
  TRIPLET_FLOOR,
} from './disposable-pg/lib/migration-numbering.mjs';
import { checkMigrationSymmetry } from './disposable-pg/lib/rollback-safety.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const floorArg = process.argv.find((a) => a.startsWith('--floor='));
const ENFORCED_FLOOR = floorArg ? Number(floorArg.split('=')[1]) : TRIPLET_FLOOR;

// Group files into { number, stem } -> { HARDENING, ROLLBACK }
const sets = new Map();
for (const filename of listMigrationFilenames(REPO_ROOT)) {
  const parsed = parseMigrationFilename(filename);
  if (!parsed || !parsed.stage) continue;
  const key = `${parsed.number}::${parsed.stem}`;
  if (!sets.has(key)) sets.set(key, { number: parsed.number, stem: parsed.stem, files: {} });
  sets.get(key).files[parsed.stage] = join(REPO_ROOT, filename);
}

const results = [];
for (const set of [...sets.values()].sort((a, b) => a.number - b.number || a.stem.localeCompare(b.stem))) {
  const { HARDENING, ROLLBACK } = set.files;
  if (!HARDENING || !ROLLBACK) continue; // triplet completeness is check-migration-numbers' job
  const check = checkMigrationSymmetry(set.number, HARDENING, ROLLBACK);
  results.push({ ...set, ...check });
}

const failures = results.filter((r) => !r.ok);
const blocking = failures.filter((r) => r.number >= ENFORCED_FLOOR);
const belowFloor = failures.filter((r) => r.number < ENFORCED_FLOOR);

const out = [];
out.push(`Checked ${results.length} HARDENING/ROLLBACK pairs; enforcing from migration ${ENFORCED_FLOOR} up.`);

if (belowFloor.length > 0) {
  out.push('', `REPORTED (below the enforced floor, not blocking) — ${belowFloor.length} pair(s):`);
  for (const f of belowFloor) out.push(`  ${f.number} ${f.stem}: ${f.reason}`);
}

if (blocking.length > 0) {
  out.push('', `FAIL — ${blocking.length} pair(s) at or above migration ${ENFORCED_FLOOR} create objects their ROLLBACK never names:`);
  for (const f of blocking) out.push(`  ${f.number} ${f.stem}: ${f.reason}`);
  out.push('', 'A ROLLBACK that names an object it never created exits 0 having removed nothing.');
  process.stderr.write(`${out.join('\n')}\n`);
  process.exit(1);
}

out.push('', `PASS — every migration from ${ENFORCED_FLOOR} up names each created table and function in its ROLLBACK.`);
out.push('NOTE: static name check only. A correct name with the wrong argument list passes here');
out.push('and is caught by the catalog snapshot inside the disposable-PG harness.');
process.stdout.write(`${out.join('\n')}\n`);

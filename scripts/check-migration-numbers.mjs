#!/usr/bin/env node
// Standalone migration-number collision gate.
//
// Runs on EVERY pull request (Security CI, "Static security & build checks"),
// with no PostgreSQL dependency, so a collision is caught at the cheapest
// possible point rather than at apply time against a live database.
//
// See scripts/disposable-pg/lib/migration-numbering.mjs for the rule.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  listMigrationFilenames,
  findNumberCollisions,
  formatCollisionReport,
  findIncompleteMigrationSets,
  formatIncompleteReport,
  TRIPLET_FLOOR,
} from './disposable-pg/lib/migration-numbering.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = listMigrationFilenames(REPO_ROOT);
const collisions = findNumberCollisions(files);

if (collisions.length > 0) {
  process.stderr.write(`FAIL — migration-number collision\n\n${formatCollisionReport(collisions)}\n`);
  process.exit(1);
}

const incomplete = findIncompleteMigrationSets(files);

if (incomplete.length > 0) {
  process.stderr.write(`FAIL — incomplete migration set\n\n${formatIncompleteReport(incomplete)}\n`);
  process.exit(1);
}

const numbers = [...new Set(files.map((f) => Number(/^(\d+)_/.exec(f)[1])))].sort((a, b) => a - b);
process.stdout.write(
  `PASS — ${files.length} numbered migration files across ${numbers.length} numbers ` +
    `(${numbers.join(', ')}); no number claimed by two migrations, and every number ` +
    `from ${TRIPLET_FLOOR} up carries HARDENING + VERIFY + ROLLBACK.\n`,
);

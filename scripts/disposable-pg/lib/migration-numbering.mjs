// Migration-number governance.
//
// Root-level migrations are ordered by a leading integer: `NN_STEM_SUFFIX.sql`.
// A migration is a SET of files sharing one number and one stem — typically
// HARDENING + VERIFY + ROLLBACK, sometimes with an extra stage (e.g. 24's
// STORAGE) or an older MVP-suffixed forward file (10, 17).
//
// The failure this guards against is a NUMBER COLLISION: two UNRELATED
// migrations independently claiming the same number on different branches.
// It is invisible in a single branch — each side is internally consistent —
// and only appears once both land. It then breaks apply ordering and makes the
// runtime register ambiguous ("is 25 applied?" has two answers).
//
// This is not hypothetical: PR #48 landed 25_WATCHTOWER_INGESTION_PROVENANCE_*
// on main while PR #44 carried 25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*.
// Both branches were individually green. Nothing in CI noticed.

import { readdirSync } from 'node:fs';

/** Trailing stage tokens that denote a FILE ROLE within one migration, not a
 *  different migration. Only one token is stripped, and only from the end.
 *  Deliberately minimal: a file that is alone at its number never collides, so
 *  this list only needs to cover numbers that legitimately carry >1 file. */
export const STAGE_SUFFIXES = Object.freeze([
  'HARDENING',
  'ROLLBACK',
  'VERIFY',
  'STORAGE',
  'MVP',
]);

const MIGRATION_FILE = /^(\d+)_(.+)\.sql$/;

/** Splits `NN_STEM_SUFFIX.sql` into its number, migration stem, and stage.
 *  Returns null for any filename that is not a numbered root migration
 *  (AUTH_RLS_SCHEMA.sql, SUPABASE_SCHEMA.sql, …), which are unnumbered and
 *  therefore outside the ordering contract. */
export function parseMigrationFilename(filename) {
  const m = MIGRATION_FILE.exec(filename);
  if (!m) return null;

  const number = Number(m[1]);
  if (!Number.isSafeInteger(number)) return null;

  const rest = m[2];
  const lastUnderscore = rest.lastIndexOf('_');
  const tail = lastUnderscore === -1 ? '' : rest.slice(lastUnderscore + 1);

  // Strip the stage token only when it is a recognised role AND something
  // remains — otherwise the whole name IS the stem (e.g. 16_PRODUCTION_SAFETY_VERIFY
  // has no separate forward file, so treating it as stem PRODUCTION_SAFETY is
  // still correct and harmless; it is alone at its number either way).
  const isStage = STAGE_SUFFIXES.includes(tail) && lastUnderscore > 0;

  return {
    filename,
    number,
    stem: isStage ? rest.slice(0, lastUnderscore) : rest,
    stage: isStage ? tail : null,
  };
}

/** Groups parsed migrations by number and reports every number claimed by more
 *  than one distinct stem. Pure — takes filenames, touches no filesystem. */
export function findNumberCollisions(filenames) {
  /** @type {Map<number, Map<string, string[]>>} number -> stem -> files */
  const byNumber = new Map();

  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) continue;

    if (!byNumber.has(parsed.number)) byNumber.set(parsed.number, new Map());
    const byStem = byNumber.get(parsed.number);
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, []);
    byStem.get(parsed.stem).push(filename);
  }

  const collisions = [];
  for (const [number, byStem] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    if (byStem.size < 2) continue;
    collisions.push({
      number,
      stems: [...byStem.keys()].sort().map((stem) => ({
        stem,
        files: [...byStem.get(stem)].sort(),
      })),
    });
  }
  return collisions;
}

/** Reads the repository root and returns every numbered migration filename. */
export function listMigrationFilenames(repoRoot) {
  return readdirSync(repoRoot)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();
}

/** Renders collisions as an operator-readable failure report. */
export function formatCollisionReport(collisions) {
  const lines = [];
  for (const c of collisions) {
    lines.push(`migration number ${c.number} is claimed by ${c.stems.length} unrelated migrations:`);
    for (const s of c.stems) {
      lines.push(`    ${s.stem}`);
      for (const f of s.files) lines.push(`      - ${f}`);
    }
    lines.push(
      `  FIX: renumber ONE of them to the next free number and update every ` +
        `reference (SQL headers, scripts, tests, docs, runtime register).`,
    );
  }
  return lines.join('\n');
}

/** Throws if any migration number is claimed by more than one migration.
 *  Called as harness preflight and as a standalone CI gate. */
export function assertNoNumberCollisions(repoRoot) {
  const collisions = findNumberCollisions(listMigrationFilenames(repoRoot));
  if (collisions.length === 0) return;
  throw new Error(`migration-number collision detected\n${formatCollisionReport(collisions)}`);
}

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

/** The number from which the HARDENING + VERIFY + ROLLBACK convention has been
 *  applied without exception. Everything below it predates the convention and is
 *  grandfathered: 3/4/8/13/20 are lone forward files, 9/10/17 use an `MVP`
 *  forward suffix, 16/18 are VERIFY-only probes, and 23's forward file carries no
 *  stage token at all. Renaming applied migrations to satisfy a check would break
 *  the runbooks, verification documents and freeze record that cite them by name,
 *  so the floor moves forward, never backward. */
export const TRIPLET_FLOOR = 24;

const REQUIRED_STAGES = Object.freeze(['HARDENING', 'VERIFY', 'ROLLBACK']);

/** Reports every number at or above TRIPLET_FLOOR that does not carry all three
 *  required files.
 *
 *  `docs/MIGRATION_NUMBER_REGISTER.md` rule 5 already states that a number IS a
 *  set of three files, but nothing enforced it: the collision check only ever
 *  asked whether two DIFFERENT stems claimed one number. A migration shipped with
 *  a HARDENING file alone therefore passed CI green — no VERIFY to prove it did
 *  what it claims, and no ROLLBACK to undo it if it did something else. Five such
 *  numbers (47–51) were written on 2026-08-02 and the gate reported PASS.
 *
 *  Pure — takes filenames, touches no filesystem. */
export function findIncompleteMigrationSets(filenames, { floor = TRIPLET_FLOOR } = {}) {
  /** @type {Map<number, Map<string, Set<string>>>} number -> stem -> stages */
  const byNumber = new Map();

  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed || parsed.number < floor) continue;

    if (!byNumber.has(parsed.number)) byNumber.set(parsed.number, new Map());
    const byStem = byNumber.get(parsed.number);
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, new Set());
    if (parsed.stage) byStem.get(parsed.stem).add(parsed.stage);
  }

  const incomplete = [];
  for (const [number, byStem] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    for (const stem of [...byStem.keys()].sort()) {
      const stages = byStem.get(stem);
      const missing = REQUIRED_STAGES.filter((s) => !stages.has(s));
      if (missing.length > 0) incomplete.push({ number, stem, missing });
    }
  }
  return incomplete;
}

/** Renders incomplete migration sets as an operator-readable failure report. */
export function formatIncompleteReport(incomplete) {
  const lines = [];
  for (const i of incomplete) {
    lines.push(`migration ${i.number} (${i.stem}) is missing: ${i.missing.join(', ')}`);
    for (const stage of i.missing) lines.push(`      - ${i.number}_${i.stem}_${stage}.sql`);
  }
  lines.push(
    `  FIX: a migration number is a SET of three files (register rule 5). Write the ` +
      `missing companions — a migration with no VERIFY cannot be shown to have done ` +
      `what it claims, and one with no ROLLBACK cannot be undone.`,
  );
  return lines.join('\n');
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

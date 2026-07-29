#!/usr/bin/env node

/**
 * AUDIT-001: Detect migration number collisions across repository branches.
 *
 * Two branches "collide" when they independently claim the same migration
 * number for different migrations. Merging both produces two unrelated
 * migrations numbered N, and the applied order becomes ambiguous.
 *
 * Collision rule
 * --------------
 * For each migration number N, every ref contributes the set of filenames it
 * holds for N. Two refs collide when neither set is a subset of the other —
 * i.e. each holds a file for N that the other does not, so each authored its
 * own migration N.
 *
 * A subset relation is NOT a collision: a branch that adds
 * `23_X_VERIFY.sql` alongside main's `23_X.sql` is extending one migration,
 * not claiming the number a second time.
 *
 * `origin/main` participates as an ordinary ref, so a branch that reuses a
 * number already taken on main is caught by the same rule.
 *
 * Usage: node scripts/audit-001-check-migration-collisions.mjs [--strict]
 *
 *   --strict  Additionally fail when the same filename for a number differs in
 *             content between refs (content drift on an already-numbered
 *             migration), which merges cleanly but changes applied SQL.
 *
 * Exit codes
 *   0  No collisions.
 *   1  Collision detected; details on stdout.
 *   2  The check could not run (git failure, `origin/main` unresolvable).
 *      Never exits 0 on an operational error — a gate that cannot see the
 *      branches must fail loudly rather than report a clean bill of health.
 */

import { execFileSync } from 'node:child_process';
import { isArchivalRef } from './lib/archival-refs.mjs';

const STRICT = process.argv.includes('--strict');
const MAIN_REF = 'origin/main';

/** Migration files are numbered at the repository root: `NN_NAME.sql`. */
const MIGRATION_PATTERN = /^(\d+)[_A-Z][^/]*\.sql$/;

/**
 * Run git with arguments passed as an argv array. execFileSync does not spawn a
 * shell, so a branch name containing shell metacharacters (`origin/HEAD ->
 * origin/main`, `;`, backticks) is passed through as one opaque argument
 * instead of being interpreted.
 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fail(message) {
  console.error(`::error::AUDIT-001: ${message}`);
  process.exit(2);
}

/** git(), but any failure ends the run via fail() rather than returning empty. */
function gitOrFail(args, describe) {
  try {
    return git(args);
  } catch (error) {
    return fail(`${describe}: ${error.message}`);
  }
}

/**
 * Remote branches, excluding the `origin/HEAD -> origin/main` symbolic line and
 * archival snapshots (see lib/archival-refs.mjs — a preserved pre-rebase branch
 * is never merged, so it cannot create the ambiguity this check defends
 * against, but it WAS enough to turn the gate red for the whole repository).
 */
function getRemoteBranches() {
  // for-each-ref emits exact refnames and never the `->` alias line that
  // `git branch -r` produces.
  //
  // Full refnames, not %(refname:short): git shortens refs/remotes/origin/HEAD
  // to plain `origin`, so filtering the short form for 'origin/HEAD' misses it
  // and the symbolic pointer is then scanned as if it were a second branch —
  // double-counting whatever main points at.
  const raw = gitOrFail(
    ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'],
    'could not list remote branches',
  );

  const branches = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((ref) => ref !== 'refs/remotes/origin/HEAD')
    .filter((ref) => !isArchivalRef(ref))
    .map((ref) => ref.replace(/^refs\/remotes\//, ''));

  if (branches.length === 0) {
    fail(
      'no remote branches are visible. The checkout is too shallow for this ' +
        'check — set `fetch-depth: 0` on actions/checkout.',
    );
  }

  return branches;
}

/**
 * For one ref: { byNumber: Map<number, Set<filename>>, blobs: Map<filename, sha> }.
 *
 * `ls-tree` already reports each entry's blob hash, so content comparison for
 * --strict reuses this single call. Resolving hashes lazily with one
 * `git rev-parse` per file per ref pair is O(refs^2 x files) subprocesses —
 * tens of thousands here — and takes long enough to stall the CI job.
 */
function getMigrationsOnRef(ref) {
  const raw = gitOrFail(['ls-tree', '-r', ref], `could not read tree for '${ref}'`);

  const byNumber = new Map();
  const blobs = new Map();
  for (const line of raw.split('\n')) {
    // `<mode> <type> <sha>\t<path>`
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const name = line.slice(tab + 1).trim();
    const match = MIGRATION_PATTERN.exec(name);
    if (!match) continue;
    const sha = line.slice(0, tab).split(/\s+/)[2];
    const number = Number.parseInt(match[1], 10);
    if (!byNumber.has(number)) byNumber.set(number, new Set());
    byNumber.get(number).add(name);
    blobs.set(name, sha);
  }
  return { byNumber, blobs };
}

const isSubset = (a, b) => [...a].every((item) => b.has(item));

console.log('AUDIT-001: checking migration number collisions...\n');

// Resolving main is mandatory. Under the default depth-1, single-ref checkout
// this throws — which is the whole point of failing here instead of comparing
// against an empty set and declaring success.
try {
  git(['rev-parse', '--verify', `${MAIN_REF}^{commit}`]);
} catch {
  fail(
    `'${MAIN_REF}' is not resolvable. The checkout is too shallow for this ` +
      'check — set `fetch-depth: 0` on actions/checkout.',
  );
}

const refs = getRemoteBranches();
const migrationsByRef = new Map(refs.map((ref) => [ref, getMigrationsOnRef(ref)]));

const mainMigrations = migrationsByRef.get(MAIN_REF)?.byNumber;
if (!mainMigrations || mainMigrations.size === 0) {
  fail(`no migration files found on '${MAIN_REF}'. Expected numbered *.sql at the repository root.`);
}

// number -> list of { ref, files, blobs }
const claimsByNumber = new Map();
for (const [ref, { byNumber, blobs }] of migrationsByRef) {
  for (const [number, files] of byNumber) {
    if (!claimsByNumber.has(number)) claimsByNumber.set(number, []);
    claimsByNumber.get(number).push({ ref, files, blobs });
  }
}

const collisions = [];
const drifts = [];

for (const [number, claims] of [...claimsByNumber.entries()].sort((a, b) => a[0] - b[0])) {
  // Refs holding an identical filename set are one claim, not many. Grouping
  // first keeps the report one entry per colliding migration number rather than
  // one per ref pair, which for a widely-branched number is the same finding
  // repeated O(n^2) times.
  const groups = new Map();
  for (const claim of claims) {
    const signature = [...claim.files].sort().join('\n');
    if (!groups.has(signature)) groups.set(signature, { files: claim.files, refs: [] });
    groups.get(signature).refs.push(claim.ref);
  }
  const distinct = [...groups.values()];

  const colliding = distinct.filter((group) =>
    distinct.some(
      (other) =>
        other !== group && !isSubset(group.files, other.files) && !isSubset(other.files, group.files),
    ),
  );

  if (colliding.length > 0) {
    collisions.push({ number, groups: colliding });
  }

  if (!STRICT) continue;

  // Content drift: one filename resolving to more than one blob across refs.
  // Reported per file as "these hashes, held by these refs" — comparing every
  // ref pair restates the same drift O(refs^2) times.
  const versionsByFile = new Map();
  for (const claim of claims) {
    for (const file of claim.files) {
      const sha = claim.blobs.get(file);
      if (!sha) continue;
      if (!versionsByFile.has(file)) versionsByFile.set(file, new Map());
      const versions = versionsByFile.get(file);
      if (!versions.has(sha)) versions.set(sha, []);
      versions.get(sha).push(claim.ref);
    }
  }
  for (const [file, versions] of versionsByFile) {
    if (versions.size > 1) drifts.push({ number, file, versions });
  }
}

const mainNumbers = [...mainMigrations.keys()].sort((x, y) => x - y);
console.log(`  ${MAIN_REF}: ${mainNumbers.length} migrations (${mainNumbers.join(', ')})`);
console.log(`  Compared ${refs.length} refs${STRICT ? ' (--strict: content drift also checked)' : ''}.\n`);

if (collisions.length === 0 && drifts.length === 0) {
  console.log('No migration number collisions detected.');
  process.exit(0);
}

for (const c of collisions) {
  console.log(`COLLISION on migration ${c.number} — ${c.groups.length} independent claims:`);
  for (const group of c.groups) {
    console.log(`   ${[...group.files].sort().join(', ')}`);
    console.log(`      on: ${group.refs.join(', ')}`);
  }
  console.log('');
}

for (const d of drifts) {
  console.log(`CONTENT DRIFT on migration ${d.number}: ${d.file} — ${d.versions.size} versions:`);
  for (const [sha, refs_] of d.versions) {
    const shown = refs_.slice(0, 4).join(', ');
    const more = refs_.length > 4 ? ` (+${refs_.length - 4} more)` : '';
    console.log(`   ${sha.slice(0, 10)}  on: ${shown}${more}`);
  }
  console.log('');
}

const total = collisions.length + drifts.length;
console.log(`${total} problem(s) found. Renumber the newer migration before merging.`);
process.exit(1);

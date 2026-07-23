// fixtures.mjs — load migration-set descriptors and resolve their SQL sources.
//
// A fixture is data. The runner iterates whatever apply/rollback stages it
// declares; nothing is hardcoded to migration 24 (brief §7). The storage-companion
// rollback lives ONLY as a documented comment block inside *_STORAGE.sql, so we
// EXTRACT it from that single source rather than duplicating the DDL (brief §22).

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib/ -> disposable-pg/ -> scripts/ -> <repoRoot>
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');

export class FixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureError';
  }
}

// Extract the `-- ROLLBACK (storage companion)` block from a *_STORAGE.sql file.
// Returns the executable BEGIN;..COMMIT; SQL. Throws loudly if the block is absent
// or malformed — a silently-missing rollback must never be treated as a no-op.
export function extractStorageCompanionRollback(storageSqlText) {
  const lines = String(storageSqlText).split(/\r?\n/);
  const markerIdx = lines.findIndex((l) => /ROLLBACK\s*\(storage companion\)/i.test(l));
  if (markerIdx === -1) {
    throw new FixtureError(
      'storage-companion rollback marker not found in STORAGE sql ' +
        '("-- ROLLBACK (storage companion)")',
    );
  }
  const collected = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    // Stop at a closing delimiter line of only comment "=" rules.
    if (/^--\s*=+\s*$/.test(raw)) break;
    // Strip a leading comment prefix ("--" then up to some spaces).
    const stripped = raw.replace(/^--\s?/, '').replace(/^\s{0,3}/, '');
    collected.push(stripped);
  }
  const text = collected.join('\n');
  const begin = text.indexOf('BEGIN;');
  const commit = text.lastIndexOf('COMMIT;');
  if (begin === -1 || commit === -1 || commit < begin) {
    throw new FixtureError(
      'storage-companion rollback block did not contain a BEGIN;..COMMIT; body',
    );
  }
  const sql = text.slice(begin, commit + 'COMMIT;'.length).trim() + '\n';
  if (!/DROP POLICY/i.test(sql)) {
    throw new FixtureError('storage-companion rollback block dropped no policy — refusing');
  }
  return sql;
}

function migrationFilePath(fixture, relFile) {
  const dir = fixture.migrationDir || '.';
  const base = isAbsolute(dir) ? dir : join(REPO_ROOT, dir);
  return resolve(base, relFile);
}

function fixtureAssetPath(relPath) {
  // Assets like fixtures/sql/*.sql are resolved relative to the fixtures dir's parent.
  return resolve(FIXTURES_DIR, '..', relPath);
}

// Load and normalise a fixture descriptor. Returns the parsed object augmented
// with `_paths` (absolute, verified-readable file paths) and helpers.
export function loadFixture(idOrPath) {
  const path = isAbsolute(idOrPath)
    ? idOrPath
    : idOrPath.endsWith('.json')
      ? resolve(process.cwd(), idOrPath)
      : join(FIXTURES_DIR, `${idOrPath}.json`);

  let fixture;
  try {
    fixture = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FixtureError(`cannot read/parse fixture ${idOrPath}: ${err.message}`);
  }

  for (const req of ['id', 'applyStages']) {
    if (fixture[req] == null) throw new FixtureError(`fixture ${path} missing required field: ${req}`);
  }
  if (!Array.isArray(fixture.applyStages) || fixture.applyStages.length === 0) {
    throw new FixtureError(`fixture ${fixture.id} has no applyStages`);
  }

  // Resolve + verify apply-stage files.
  const applyStages = fixture.applyStages.map((st) => {
    const filePath = migrationFilePath(fixture, st.file);
    readFileSync(filePath, 'utf8'); // throws if missing
    return { label: st.label, file: st.file, path: filePath };
  });

  // Resolve verify file (may be null for negative fixtures).
  let verify = null;
  if (fixture.verify && fixture.verify.file) {
    const vp = migrationFilePath(fixture, fixture.verify.file);
    readFileSync(vp, 'utf8');
    verify = { ...fixture.verify, path: vp };
  } else {
    verify = { ...(fixture.verify || {}), path: null };
  }

  // Resolve rollback stages (file or storage-companion extraction).
  const rollbackStages = ((fixture.rollback && fixture.rollback.stages) || []).map((st) => {
    if (st.source === 'storage-companion-comment') {
      const storagePath = migrationFilePath(fixture, st.file);
      const sql = extractStorageCompanionRollback(readFileSync(storagePath, 'utf8'));
      return { label: st.label, source: st.source, file: st.file, path: storagePath, sql };
    }
    const filePath = migrationFilePath(fixture, st.file);
    const sql = readFileSync(filePath, 'utf8');
    return { label: st.label, source: 'file', file: st.file, path: filePath, sql };
  });

  // Resolve destructive-guard seed SQL.
  let destructiveGuard = null;
  if (fixture.destructiveGuard) {
    const seedPath = fixtureAssetPath(fixture.destructiveGuard.seedSql);
    const seedSql = readFileSync(seedPath, 'utf8');
    destructiveGuard = { ...fixture.destructiveGuard, seedPath, seedSql };
  }

  return {
    ...fixture,
    _paths: { descriptor: path },
    applyStages,
    verify,
    rollbackStages,
    destructiveGuard,
  };
}

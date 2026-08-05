import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { runFixture, computeFixtureCoverage, EXIT } from './run-migration-harness.mjs';
import { resolvePgBin, DEFAULT_PG_MAJOR, PG_MAJOR_OVERRIDE } from './lib/cluster.mjs';
import { FIXTURES_DIR, REPO_ROOT } from './lib/fixtures.mjs';
import { assertNoSecrets } from './lib/evidence.mjs';

const EXPECTED_PG_MAJOR = PG_MAJOR_OVERRIDE ?? DEFAULT_PG_MAJOR;

function pgAvailable() {
  try {
    // Resolve against the pinned major, not the default — see cluster.test.mjs.
    resolvePgBin({ pgMajor: EXPECTED_PG_MAJOR });
    return true;
  } catch {
    return false;
  }
}
// Real-Postgres tests run ONLY when explicitly enabled (PG_BIN set, or
// HARNESS_REQUIRE_PG=1 in ci:runtime) — never merely because a Postgres binary is
// on PATH. Keeps the static `npm test` job's skip structural, not environmental.
const PG_ENABLED = !!(process.env.PG_BIN && process.env.PG_BIN.trim()) || process.env.HARNESS_REQUIRE_PG === '1';
const HAS_PG = PG_ENABLED && pgAvailable();

// Coverage arithmetic needs no cluster, so these run in the static job too. That
// is deliberate: the bug they exist to prevent — a coverage ratio that cannot
// fall — survived for months precisely because checking it meant booting Postgres.
describe('fixture coverage denominator', () => {
  const repoFiles = readdirSync(REPO_ROOT);
  const fixtureIds = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  it('counts every numbered migration, not just the ones named _HARDENING', () => {
    const cov = computeFixtureCoverage(repoFiles, fixtureIds);
    // 43 numbered migrations exist; only 32 are named *_HARDENING.sql. The old
    // denominator was the latter, which is why it could only ever print 32/32.
    const hardeningOnly = new Set(
      repoFiles.map((f) => (f.match(/^(\d+)_.*_HARDENING\.sql$/) || [])[1]).filter(Boolean),
    );
    expect(cov.total).toBeGreaterThan(hardeningOnly.size);
  });

  it('every numbered migration now has a fixture, including the 11 D6 exposed', () => {
    // The eleven that escaped the old denominator by being named _MVP, _VERIFY,
    // _ACL_FIX, _DRIFT_CHECK or nothing at all. Asserted by NAME rather than by
    // count so that adding a migration and forgetting its fixture fails here,
    // rather than quietly moving a ratio nobody reads.
    const cov = computeFixtureCoverage(repoFiles, fixtureIds);
    for (const n of ['3', '4', '8', '9', '10', '13', '16', '17', '18', '20', '23']) {
      expect(cov.uncovered, `migration ${n} lost its fixture`).not.toContain(n);
    }
    expect(cov.uncovered).toEqual([]);
    expect(cov.coveredCount).toBe(cov.total);
    // 10, 17 and 23 ship real ROLLBACKs that had never been executed anywhere.
    // Nothing may be left in that state.
    expect(cov.uncoveredWithRollback).toEqual([]);
  });

  it('FALSIFICATION: removing a fixture drops the numerator', () => {
    // The whole point of A2. Under the old _HARDENING denominator, deleting
    // fixture 44 dropped BOTH numerator and denominator and still printed n/n.
    const before = computeFixtureCoverage(repoFiles, fixtureIds);
    const after = computeFixtureCoverage(
      repoFiles,
      fixtureIds.filter((id) => !id.startsWith('44_')),
    );
    expect(after.coveredCount).toBe(before.coveredCount - 1);
    expect(after.total).toBe(before.total); // denominator must NOT move
    expect(after.uncovered).toContain('44');
  });

  it('FALSIFICATION: adding a migration with no fixture raises the denominator', () => {
    const before = computeFixtureCoverage(repoFiles, fixtureIds);
    const after = computeFixtureCoverage([...repoFiles, '99_SOMETHING_HARDENING.sql'], fixtureIds);
    expect(after.total).toBe(before.total + 1);
    expect(after.coveredCount).toBe(before.coveredCount);
    expect(after.uncovered).toContain('99');
  });
});

describe.skipIf(!HAS_PG)('run-migration-harness end-to-end (real PostgreSQL)', () => {
  it('runs the 24_evidence fixture fully green: apply -> VERIFY 18/18 -> guard -> rollback', { timeout: 120000 }, () => {
    const { code, ev } = runFixture('24_evidence', { verbose: false });
    const r = ev.result;
    expect(code).toBe(EXIT.OK);
    expect(r.outcome).toBe('passed');
    // Apply
    expect(r.applyStages.map((s) => s.status)).toEqual(['PASS', 'PASS']);
    // VERIFY 18/18 A-R
    expect(r.verify.ok).toBe(true);
    expect(r.verify.passed).toHaveLength(18);
    expect(r.verify.failed).toEqual([]);
    // Destructive guard: refused without opt-in, succeeded with opt-in
    expect(r.destructiveGuard.refusal.refused).toBe(true);
    expect(r.destructiveGuard.refusal.dataPreserved).toBe(true);
    expect(r.destructiveGuard.optIn.ok).toBe(true);
    // Rollback STORAGE -> main, objects removed, substrate intact
    expect(r.rollbackStages.map((s) => s.label)).toEqual(['STORAGE-rollback', 'main-rollback']);
    expect(r.postRollback.ok).toBe(true);
    // Teardown clean, real PG version recorded, no secrets in evidence
    expect(r.teardown.ok).toBe(true);
    // Tracks whichever major the lane is pinned to, rather than naming one.
    // This was hardcoded to /^18\./ and stayed that way when the harness moved to
    // 17, so the required CI job failed on `expected '17.10 (Ubuntu ...)' to match
    // /^18\./` while every fixture passed. It survived local verification because
    // this whole describe block is skipped unless PG_BIN or HARNESS_REQUIRE_PG is
    // set — a silent skip, in the run that was supposed to prove the version pin.
    expect(r.pgVersionActual).toMatch(new RegExp(`^${EXPECTED_PG_MAJOR}\\.`));
    expect(() => assertNoSecrets(r)).not.toThrow();
  });

  it('catches a REAL apply failure: negative fixture fails-as-expected', { timeout: 60000 }, () => {
    const { code, ev } = runFixture('negative_broken_apply', { verbose: false });
    // The run itself is "green" (the expected failure was correctly caught).
    expect(code).toBe(EXIT.OK);
    expect(ev.result.outcome).toBe('expected-failure');
    expect(ev.result.applyStages[0].status).toBe('FAIL');
    expect(ev.result.teardown.ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { runFixture, computeFixtureCoverage, EXIT } from './run-migration-harness.mjs';
import { resolvePgBin } from './lib/cluster.mjs';
import { FIXTURES_DIR, REPO_ROOT } from './lib/fixtures.mjs';
import { assertNoSecrets } from './lib/evidence.mjs';

function pgAvailable() {
  try {
    resolvePgBin({});
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
    expect(cov.coveredCount).toBeLessThan(cov.total);
  });

  it('names the migrations it does not cover, including 10, 17 and 23', () => {
    const cov = computeFixtureCoverage(repoFiles, fixtureIds);
    expect(cov.uncovered).toEqual(
      expect.arrayContaining(['3', '4', '8', '9', '10', '13', '16', '17', '18', '20', '23']),
    );
    // 10, 17 and 23 ship a real ROLLBACK no fixture has ever executed — the
    // single most misleading state a migration can be in, so it is called out.
    expect(cov.uncoveredWithRollback).toEqual(expect.arrayContaining(['10', '17', '23']));
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
    expect(r.pgVersionActual).toMatch(/^18\./);
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

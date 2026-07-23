import { describe, it, expect } from 'vitest';
import { runFixture, EXIT } from './run-migration-harness.mjs';
import { resolvePgBin } from './lib/cluster.mjs';
import { assertNoSecrets } from './lib/evidence.mjs';

function pgAvailable() {
  try {
    resolvePgBin({});
    return true;
  } catch {
    return false;
  }
}
const HAS_PG = pgAvailable();

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

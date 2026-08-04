import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from './fixtures.mjs';

// forwardOnly SKIPS the rollback symmetry check. That makes it the single most
// dangerous field in a fixture: set on a migration that HAS a rollback, it runs
// the rollback, checks nothing about the result, prints "NO ROLLBACK EXISTS" —
// which is false — and passes. Reproduced on fixture 44 before the load-time
// guard existed.
//
// These tests assert the invariant over the fixtures actually on disk, so a new
// fixture cannot introduce the combination, and complement the loader's own
// throw (which only fires for a fixture someone runs).
describe('forwardOnly is mutually exclusive with rollback stages', () => {
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')));

  it('no fixture sets forwardOnly while declaring rollback stages', () => {
    const offenders = fixtures
      .filter((d) => d.forwardOnly === true && ((d.rollback || {}).stages || []).length > 0)
      .map((d) => d.id);
    expect(offenders).toEqual([]);
  });

  it('every fixture without rollback stages says why — forwardOnly, or a negative expectFailure', () => {
    const unexplained = fixtures
      .filter((d) => ((d.rollback || {}).stages || []).length === 0)
      .filter((d) => d.forwardOnly !== true && !d.expectFailure)
      .map((d) => d.id);
    expect(unexplained).toEqual([]);
  });

  it('the eight migrations known to ship no rollback are the ONLY forwardOnly fixtures', () => {
    // Pinned by name. forwardOnly spreading to a migration that does have a
    // rollback is the failure mode; a count would not catch a swap.
    const fo = fixtures.filter((d) => d.forwardOnly === true).map((d) => d.id).sort();
    expect(fo).toEqual([
      '13_public_function_execute_drift',
      '16_production_safety_verify',
      '18_synthetic_runtime_verify',
      '20_farm_admin_acl_fix',
      '3_security_search_path_grants',
      '4_rls_enable_remaining',
      '8_coa_upload_storage',
      '9_compliance_watchtower',
    ].sort());
  });

  it('a negative fixture is not quietly marked forwardOnly', () => {
    // It would suppress a check it never reaches, and disguise why it has no
    // rollback stages.
    const bad = fixtures.filter((d) => d.expectFailure && d.forwardOnly === true).map((d) => d.id);
    expect(bad).toEqual([]);
  });
});

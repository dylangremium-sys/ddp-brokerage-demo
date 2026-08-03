import { describe, it, expect } from 'vitest';
import { assertCatalogSymmetry } from './rollback-symmetry.mjs';

// The comparison under test is BASELINE (before the migration is applied)
// vs FINAL (after the rollback has run). Comparing post-apply vs post-rollback
// instead would assert that rollback changes nothing — which passes a rollback
// that drops nothing and fails a correct one.

const SUBSTRATE = [
  { kind: 'table', obj: 'profiles' },
];

describe('rollback-symmetry: baseline vs post-rollback catalog', () => {
  it('a correct rollback returns the catalog to its baseline', () => {
    expect(assertCatalogSymmetry(SUBSTRATE, SUBSTRATE).ok).toBe(true);
  });

  it('DEFECT A — created ai_create_audit_event, rollback dropped log_audit_event: function survives', () => {
    const baseline = SUBSTRATE;
    const final = [
      // DROP FUNCTION IF EXISTS log_audit_event(...) matched nothing and exited 0,
      // so the function the migration actually created is still here.
      { kind: 'function', obj: 'ai_create_audit_event(text, text, uuid, text, jsonb, uuid, text)' },
      ...SUBSTRATE,
    ];

    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    // The diff must NAME the survivor — "length mismatch" alone tells an
    // operator nothing about which object the rollback left behind.
    expect(result.diff).toContain('failed to remove');
    expect(result.leaked).toEqual([
      'function|ai_create_audit_event(text, text, uuid, text, jsonb, uuid, text)',
    ]);
    expect(result.destroyed).toEqual([]);
  });

  it('DEFECT B — right name, wrong signature: only a signature-aware compare catches it', () => {
    // A same-named function already existed at baseline. The migration created an
    // overload with a different signature; the rollback dropped the wrong signature,
    // so the overload survived. Object counts and names match — a name-only check
    // would report success here.
    const baseline = [
      { kind: 'function', obj: 'ai_create_audit_event(text)' },
    ];
    const final = [
      { kind: 'function', obj: 'ai_create_audit_event(text, text, uuid, text, jsonb, uuid, text)' },
    ];

    const nameOf = (e) => e.obj.slice(0, e.obj.indexOf('('));
    expect(nameOf(baseline[0])).toBe(nameOf(final[0]));
    expect(baseline.length).toBe(final.length);

    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('jsonb');
  });

  it('detects an object left behind', () => {
    const result = assertCatalogSymmetry(
      [{ kind: 'table', obj: 'foo' }],
      [{ kind: 'table', obj: 'foo' }, { kind: 'table', obj: 'ai_audit_events' }],
    );
    expect(result.ok).toBe(false);
    expect(result.leaked).toEqual(['table|ai_audit_events']);
  });

  it('reports a rollback that DESTROYS a pre-existing object as over-reach', () => {
    // Migration 36's rollback removing migration 34's table would look like this:
    // the failure is not a leak, and calling it one would send an operator
    // looking for the wrong defect.
    const result = assertCatalogSymmetry(
      [{ kind: 'table', obj: 'farmer_access_requests' }, { kind: 'table', obj: 'foo' }],
      [{ kind: 'table', obj: 'foo' }],
    );
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('over-reach');
    expect(result.destroyed).toEqual(['table|farmer_access_requests']);
    expect(result.leaked).toEqual([]);
  });

  it('detects a policy left behind, not just tables and functions', () => {
    const baseline = [{ kind: 'table', obj: 'ai_jobs' }];
    const final = [
      { kind: 'policy', obj: 'ai_jobs_tenant_isolation' },
      { kind: 'table', obj: 'ai_jobs' },
    ];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('invalid input returns error', () => {
    const result1 = assertCatalogSymmetry(null, []);
    expect(result1.ok).toBe(false);
    expect(result1.diff).toContain('invalid snapshot format');

    const result2 = assertCatalogSymmetry([], 'not an array');
    expect(result2.ok).toBe(false);
    expect(result2.diff).toContain('invalid snapshot format');
  });
});

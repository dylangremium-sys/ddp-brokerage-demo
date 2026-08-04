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

  it('DEFECT C — object restored under the same signature but with the WRONG body', () => {
    // Migration 45 replaces fn_audit_organisation_change() in place and its
    // rollback is meant to restore the previous body. Name and arguments never
    // change, so counts and signatures match and every earlier check is blind.
    const baseline = [{ kind: 'function', obj: 'fn_audit_organisation_change()', detail: '3589c5fd71b0' }];
    const final = [{ kind: 'function', obj: 'fn_audit_organisation_change()', detail: '9b165933a891' }];

    expect(baseline.length).toBe(final.length);
    expect(baseline[0].obj).toBe(final[0].obj);

    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('NOT restored to their prior definition');
    expect(result.redefined).toEqual(['function|fn_audit_organisation_change()']);
    expect(result.leaked).toEqual([]);
    expect(result.destroyed).toEqual([]);
  });

  it('an identical definition is symmetric', () => {
    const snap = [{ kind: 'function', obj: 'f()', detail: 'aaaaaaaaaaaa' }];
    expect(assertCatalogSymmetry(snap, snap).ok).toBe(true);
  });

  it('a storage-schema policy left behind is detected', () => {
    // Migration 38 creates its policies on storage.objects. Scoped to public,
    // the snapshot saw nothing and a rollback removing none of them passed.
    const baseline = [{ kind: 'table', obj: 'profiles', detail: '' }];
    const final = [
      { kind: 'policy', obj: 'storage.objects: farmer-photos: farmer read own', detail: 'true |  | authenticated' },
      { kind: 'table', obj: 'profiles', detail: '' },
    ];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.leaked).toEqual(['policy|storage.objects: farmer-photos: farmer read own']);
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

// ---------------------------------------------------------------------------
// Privilege and row-level-security branches.
//
// Migrations 12, 14, 15 and 51 create and drop nothing whatsoever — they REVOKE,
// GRANT, or switch RLS on. Against a snapshot that records only tables,
// functions, policies and triggers, their rollbacks are invisible: baseline and
// final are byte-identical and the check passes having proved nothing. These
// cases pin the shape of the entries so the branches cannot be quietly dropped
// from the query without a test going red.
// ---------------------------------------------------------------------------
describe('rollback-symmetry: privileges and RLS', () => {
  it('a rollback that leaves a privilege granted is not symmetric', () => {
    const baseline = SUBSTRATE;
    // REVOKE ... FROM the wrong table succeeds and removes nothing, so anon
    // keeps a privilege the migration handed it.
    const final = [
      { kind: 'grant', obj: 'table public.profiles -> anon', detail: 'DELETE' },
      ...SUBSTRATE,
    ];

    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('table public.profiles -> anon');
    expect(result.leaked).toHaveLength(1);
  });

  it('a rollback that fails to restore a revoked privilege is over-reach, not a leak', () => {
    // The direction matters to whoever reads the failure: a privilege present
    // BEFORE and absent after was destroyed by the rollback, which is a
    // different defect from one the rollback failed to remove.
    const baseline = [
      { kind: 'grant', obj: 'function is_ddp_admin() -> PUBLIC', detail: 'EXECUTE' },
      ...SUBSTRATE,
    ];
    const result = assertCatalogSymmetry(baseline, SUBSTRATE);
    expect(result.ok).toBe(false);
    expect(result.destroyed).toHaveLength(1);
    expect(result.diff).toContain('ROLLBACK destroyed');
  });

  it('privileges compare as a SET, so grant order never fails a correct rollback', () => {
    const a = [
      { kind: 'grant', obj: 'table public.farms -> anon', detail: 'INSERT,SELECT' },
      { kind: 'grant', obj: 'table public.farms -> authenticated', detail: 'SELECT' },
    ];
    const b = [a[1], a[0]];
    expect(assertCatalogSymmetry(a, b).ok).toBe(true);
  });

  it('RLS left switched on is reported as a definition change, not a new object', () => {
    // Migration 51's failure mode. The table exists on both sides, so nothing is
    // leaked or destroyed — only the flag moved, which the detail column carries.
    const baseline = [{ kind: 'rls', obj: 'public.profiles', detail: 'disabled' }];
    const final = [{ kind: 'rls', obj: 'public.profiles', detail: 'enabled' }];

    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.redefined).toHaveLength(1);
    expect(result.leaked).toHaveLength(0);
    expect(result.diff).toContain('was disabled, now enabled');
  });

  it('RLS stripped from a table the migration never touched is caught too', () => {
    // The inverted half of migration 51's defect: its rollback disabled RLS on
    // twelve tables that migrations 47-50 had secured.
    const baseline = [{ kind: 'rls', obj: 'public.ai_jobs', detail: 'enabled' }];
    const final = [{ kind: 'rls', obj: 'public.ai_jobs', detail: 'disabled' }];

    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('was enabled, now disabled');
  });
});

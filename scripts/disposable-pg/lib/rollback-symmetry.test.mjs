import { describe, it, expect } from 'vitest';
import { assertCatalogSymmetry, normaliseArrayLiterals } from './rollback-symmetry.mjs';

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

// ---------------------------------------------------------------------------
// Object classes added for defect D7 (2026-08-04).
//
// Every case below produced a byte-identical baseline and final under the
// previous snapshot, because none of these things is a named row in a catalog
// the old query read. The migration applied, the rollback removed none of it,
// and the gate reported the rollback symmetric.
//
// Each test is written as the FALSIFICATION the plan asks for: it constructs the
// exact snapshot pair a broken rollback of that class produces, and asserts the
// comparison now goes red. They are unit tests rather than throwaway-worktree
// runs on purpose — a falsification nobody can afford to re-run is a
// falsification that silently stops being true.
// ---------------------------------------------------------------------------
describe('rollback-symmetry: object classes added for D7', () => {
  it('a CHECK constraint the rollback failed to drop is caught', () => {
    // C1 (migration for D14) will add exactly this. Before D7, its fixture would
    // have gone green whether or not the rollback dropped the constraint.
    const baseline = [{ kind: 'table', obj: 'public.inventory_batches', detail: '' }];
    const final = [
      { kind: 'constraint', obj: 'public.inventory_batches: chk_quantity_kg_bounded',
        detail: 'c CHECK (quantity_kg > 0::numeric AND quantity_kg < 1000000::numeric)' },
      ...baseline,
    ];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.leaked).toEqual([
      'constraint|public.inventory_batches: chk_quantity_kg_bounded',
    ]);
  });

  it('a CHECK restored with a WEAKER predicate is caught as a redefinition', () => {
    // The nastier half. The constraint exists on both sides under the same name,
    // so presence-only comparison passes — but the rollback restored a bound that
    // admits NaN, which is the precise defect D14 exists to prevent.
    const baseline = [{
      kind: 'constraint', obj: 'public.inventory_batches: chk_price',
      detail: 'c CHECK (price_per_kg > 0::numeric AND price_per_kg < 1000000::numeric)',
    }];
    const final = [{
      kind: 'constraint', obj: 'public.inventory_batches: chk_price',
      detail: 'c CHECK (price_per_kg > 0::numeric)',
    }];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.redefined).toEqual(['constraint|public.inventory_batches: chk_price']);
    expect(result.leaked).toEqual([]);
  });

  it('a UNIQUE index the rollback left behind is caught', () => {
    const baseline = [{ kind: 'table', obj: 'public.inventory_batches', detail: '' }];
    const final = [
      { kind: 'index', obj: 'public.uq_batch_number_per_farm',
        detail: 'CREATE UNIQUE INDEX uq_batch_number_per_farm ON public.inventory_batches USING btree (farm_id, batch_number)' },
      ...baseline,
    ];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('an index rebuilt WITHOUT its partial WHERE clause is caught', () => {
    // A partial unique index enforces a conditional invariant; rebuilding it
    // unconditionally silently changes what rows are admissible.
    const baseline = [{
      kind: 'index', obj: 'public.uq_live_invoice',
      detail: 'CREATE UNIQUE INDEX uq_live_invoice ON public.reservations USING btree (batch_id) WHERE (status = \'live\'::text)',
    }];
    const final = [{
      kind: 'index', obj: 'public.uq_live_invoice',
      detail: 'CREATE UNIQUE INDEX uq_live_invoice ON public.reservations USING btree (batch_id)',
    }];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.redefined).toHaveLength(1);
  });

  it('a column the rollback failed to drop is caught', () => {
    // C2 and C3 both ALTER live columns. Under the old snapshot a rollback that
    // dropped none of its added columns was indistinguishable from a correct one.
    const baseline = [{ kind: 'table', obj: 'public.inventory_batches', detail: '' }];
    const final = [
      { kind: 'column', obj: 'public.inventory_batches.currency', detail: 'text NOT NULL DEFAULT \'THB\'::text' },
      ...baseline,
    ];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.leaked).toEqual(['column|public.inventory_batches.currency']);
  });

  it('a column restored with the WRONG TYPE is caught', () => {
    // C3 converts harvest_date TEXT -> DATE. A rollback that restores it as
    // TIMESTAMPTZ, or leaves it DATE, changes what the application can store.
    const baseline = [{ kind: 'column', obj: 'public.inventory_batches.harvest_date', detail: 'text' }];
    const final = [{ kind: 'column', obj: 'public.inventory_batches.harvest_date', detail: 'date' }];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('was text, now date');
  });

  it('a NOT NULL the rollback left in place is caught', () => {
    // Nullability is part of the column's detail, so tightening that a rollback
    // fails to undo shows up as a redefinition rather than passing silently.
    const baseline = [{ kind: 'column', obj: 'public.farms.owner_name', detail: 'text' }];
    const final = [{ kind: 'column', obj: 'public.farms.owner_name', detail: 'text NOT NULL' }];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('a column DEFAULT the rollback failed to remove is caught', () => {
    const baseline = [{ kind: 'column', obj: 'public.inventory_batches.status', detail: 'text' }];
    const final = [{
      kind: 'column', obj: 'public.inventory_batches.status',
      detail: 'text DEFAULT \'draft\'::text',
    }];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('a view the rollback left behind is caught', () => {
    // Views were invisible: the table branch matches relkind r/p only. A leftover
    // view over a restricted table is a read path nobody intended to keep.
    const baseline = [{ kind: 'table', obj: 'public.procurement_decisions', detail: '' }];
    const final = [
      { kind: 'view', obj: 'public.procurement_decisions_current', detail: 'a1b2c3d4e5f6' },
      ...baseline,
    ];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('a view restored with a DIFFERENT body is caught', () => {
    const baseline = [{ kind: 'view', obj: 'public.v_export_ready', detail: 'aaaaaaaaaaaa' }];
    const final = [{ kind: 'view', obj: 'public.v_export_ready', detail: 'bbbbbbbbbbbb' }];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('a sequence orphaned by a rollback that dropped only its table is caught', () => {
    // The practical symptom is the NEXT apply failing on a name clash, reported
    // as a mystery because nothing in the gate ever mentioned the sequence.
    const baseline = [{ kind: 'table', obj: 'public.profiles', detail: '' }];
    const final = [
      { kind: 'sequence', obj: 'public.ai_jobs_id_seq', detail: 'bigint inc 1 min 1' },
      ...baseline,
    ];
    expect(assertCatalogSymmetry(baseline, final).ok).toBe(false);
  });

  it('an enum label added by a migration and not removed is caught', () => {
    // PostgreSQL cannot drop an enum label, so this asymmetry is not a bug in the
    // rollback — it is the gate forcing the author to confront, at review time,
    // that the migration is not actually reversible.
    const baseline = [{ kind: 'type', obj: 'public.batch_status', detail: 'draft,live' }];
    const final = [{ kind: 'type', obj: 'public.batch_status', detail: 'draft,live,reserved' }];
    const result = assertCatalogSymmetry(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('was draft,live, now draft,live,reserved');
  });

  it('a correct rollback across ALL new classes stays green', () => {
    // The counterpart that matters: the added branches must not make a correct
    // rollback fail. A gate that cannot pass is as useless as one that cannot fail.
    const snap = [
      { kind: 'column', obj: 'public.inventory_batches.quantity_kg', detail: 'numeric' },
      { kind: 'constraint', obj: 'public.inventory_batches: inventory_batches_pkey', detail: 'p PRIMARY KEY (id)' },
      { kind: 'index', obj: 'public.inventory_batches_pkey', detail: 'CREATE UNIQUE INDEX inventory_batches_pkey ON public.inventory_batches USING btree (id)' },
      { kind: 'sequence', obj: 'public.s_id_seq', detail: 'bigint inc 1 min 1' },
      { kind: 'type', obj: 'public.batch_status', detail: 'draft,live' },
      { kind: 'view', obj: 'public.v_x', detail: 'aaaaaaaaaaaa' },
    ];
    expect(assertCatalogSymmetry(snap, [...snap].reverse()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ARRAY-literal normalisation.
//
// The point of these is the LAST one: a normaliser that quietly swallowed a real
// change would be worse than the false positive it was written to remove.
// ---------------------------------------------------------------------------
describe('normaliseArrayLiterals', () => {
  it('treats a reordered membership set as identical (migration 39s profiles_role_check)', () => {
    const a = "c CHECK ((role = ANY (ARRAY['pending'::text, 'farmer'::text, 'ddp_admin'::text])))";
    const b = "c CHECK ((role = ANY (ARRAY['ddp_admin'::text, 'farmer'::text, 'pending'::text])))";
    expect(normaliseArrayLiterals(a)).toBe(normaliseArrayLiterals(b));
  });

  it('STILL detects an ADDED value — the false positive fix must not hide a real widening', () => {
    const before = "c CHECK ((action = ANY (ARRAY['a'::text, 'b'::text])))";
    const after = "c CHECK ((action = ANY (ARRAY['b'::text, 'a'::text, 'c'::text])))";
    expect(normaliseArrayLiterals(before)).not.toBe(normaliseArrayLiterals(after));
  });

  it('STILL detects a REMOVED value', () => {
    const before = "c CHECK ((role = ANY (ARRAY['pending'::text, 'farmer'::text])))";
    const after = "c CHECK ((role = ANY (ARRAY['farmer'::text])))";
    expect(normaliseArrayLiterals(before)).not.toBe(normaliseArrayLiterals(after));
  });

  it('leaves definitions without an ARRAY literal untouched', () => {
    const d = 'c CHECK ((quantity_kg > 0::numeric))';
    expect(normaliseArrayLiterals(d)).toBe(d);
    expect(normaliseArrayLiterals('')).toBe('');
    expect(normaliseArrayLiterals(null)).toBe(null);
  });

  it('does not split on a comma inside a string literal', () => {
    // Wrapped in `= ANY (...)` because only a membership test is normalised at
    // all; a bare ARRAY literal keeps its written order by design.
    const a = "CHECK (v = ANY (ARRAY['x,y'::text, 'a'::text]))";
    const b = "CHECK (v = ANY (ARRAY['a'::text, 'x,y'::text]))";
    expect(normaliseArrayLiterals(a)).toBe(normaliseArrayLiterals(b));
    // Two elements, not three — a naive split would produce 'x' and 'y'.
    expect(normaliseArrayLiterals(a)).toContain("'x,y'::text");
  });

  it('normalises every ARRAY literal when a definition contains more than one', () => {
    const a = "CHECK (a = ANY (ARRAY['q'::text, 'p'::text]) AND b = ANY (ARRAY['z'::text, 'y'::text]))";
    const b = "CHECK (a = ANY (ARRAY['p'::text, 'q'::text]) AND b = ANY (ARRAY['y'::text, 'z'::text]))";
    expect(normaliseArrayLiterals(a)).toBe(normaliseArrayLiterals(b));
  });

  it('does NOT sort an ordered ARRAY that is not a membership test', () => {
    // The regression this narrowing exists to prevent. 50_AI_PROMPT_REGISTRY
    // declares `allowed_models TEXT[] DEFAULT ARRAY['claude-opus-5',
    // 'claude-sonnet-5']` — an ordered value, not a set. A rollback restoring it
    // with the elements swapped has changed the default, and the first version of
    // this normaliser reported the two as identical: a false negative introduced
    // by the fix for a false positive.
    const a = "text[] DEFAULT ARRAY['claude-opus-5'::text, 'claude-sonnet-5'::text]";
    const b = "text[] DEFAULT ARRAY['claude-sonnet-5'::text, 'claude-opus-5'::text]";
    expect(normaliseArrayLiterals(a)).not.toBe(normaliseArrayLiterals(b));
  });

  it('normalises ALL(...) as well as ANY(...)', () => {
    const a = "CHECK (r <> ALL (ARRAY['a'::text, 'b'::text]))";
    const b = "CHECK (r <> ALL (ARRAY['b'::text, 'a'::text]))";
    expect(normaliseArrayLiterals(a)).toBe(normaliseArrayLiterals(b));
  });

  it('an unbalanced bracket degrades to returning the input, never throws', () => {
    expect(() => normaliseArrayLiterals("ARRAY['a'::text")).not.toThrow();
  });
});

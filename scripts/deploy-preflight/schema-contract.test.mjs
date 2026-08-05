import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanRequiredTables, missingTables } from './schema-contract.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('scanning the app for the relations it requires', () => {
  it('finds a plain .from() call', () => {
    const r = scanRequiredTables([{ path: 'a.ts', text: "supabase.from('farms').select('*')" }]);
    expect(r.map((x) => x.table)).toContain('farms');
  });

  it('finds an EMBEDDED relation inside a select string', () => {
    // The whole reason this check exists. `batch_internal_notes` never appears in
    // a .from() on the read path — it is embedded in the select, and PostgREST
    // rejects the ENTIRE query when it is missing, not just that field.
    const r = scanRequiredTables([{
      path: 'db.ts',
      text: ".from('inventory_batches').select('*, farms(farm_name), batch_internal_notes(note)')",
    }]);
    expect(r.map((x) => x.table)).toEqual(
      expect.arrayContaining(['inventory_batches', 'farms', 'batch_internal_notes']),
    );
  });

  it('does not mistake PostgREST aggregate syntax for a relation', () => {
    const r = scanRequiredTables([{ path: 'a.ts', text: ".from('farms').select('id, count()')" }]);
    expect(r.map((x) => x.table)).not.toContain('count');
  });

  it('records every file a relation is referenced from, so the report is actionable', () => {
    const r = scanRequiredTables([
      { path: 'a.ts', text: "supabase.from('profiles')" },
      { path: 'b.ts', text: "client.from('profiles')" },
    ]);
    expect(r.find((x) => x.table === 'profiles').sites).toEqual(['a.ts', 'b.ts']);
  });

  it('FALSIFICATION: a relation absent from the target database is reported missing', () => {
    const required = scanRequiredTables([{ path: 'db.ts', text: ".select('*, batch_internal_notes(note)')" }]);
    expect(missingTables(required, new Set(['farms']))).toHaveLength(1);
    expect(missingTables(required, new Set(['batch_internal_notes']))).toHaveLength(0);
  });

  it('the REAL source tree still names batch_internal_notes — the check is not vacuous', () => {
    // If this ever stops being true the preflight has nothing to catch on this
    // path, and its production run proving exit 75 stops meaning anything. Pinned
    // so that a refactor removing the reference is a deliberate, visible change.
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) { if (e !== 'node_modules') walk(full); }
        else if (/\.tsx?$/.test(e) && !/\.(test|spec)\./.test(e)) {
          files.push({ path: relative(REPO_ROOT, full), text: readFileSync(full, 'utf8') });
        }
      }
    };
    walk(join(REPO_ROOT, 'src'));
    const tables = scanRequiredTables(files).map((x) => x.table);
    expect(tables).toContain('batch_internal_notes');
    expect(tables).toContain('inventory_batches');
  });
});

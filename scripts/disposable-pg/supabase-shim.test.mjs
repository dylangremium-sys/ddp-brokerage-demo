import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  stripSqlComments,
  scanForceRls,
  assertNoForceRls,
  scanUndeclaredSubstrate,
  readBootstrapSql,
  ShimError,
} from './lib/supabase-shim.mjs';
import { loadFixture, extractStorageCompanionRollback } from './lib/fixtures.mjs';

describe('stripSqlComments', () => {
  it('removes line and block comments but keeps code', () => {
    expect(stripSqlComments('SELECT 1; -- a comment').trim()).toBe('SELECT 1;');
    expect(stripSqlComments('/* block */ SELECT 2;').trim()).toBe('SELECT 2;');
  });
  it('does NOT strip -- inside a string literal', () => {
    const sql = "SELECT 'a -- not a comment' AS x;";
    expect(stripSqlComments(sql)).toContain("'a -- not a comment'");
  });
  it('handles escaped quotes', () => {
    const sql = "SELECT 'it''s -- fine'; -- gone";
    const out = stripSqlComments(sql);
    expect(out).toContain("'it''s -- fine'");
    expect(out).not.toContain('gone');
  });
});

describe('scanForceRls (K-10(e) drift anchor)', () => {
  it('detects FORCE ROW LEVEL SECURITY', () => {
    expect(scanForceRls([{ label: 'x', text: 'ALTER TABLE t FORCE ROW LEVEL SECURITY;' }])).toEqual(['x']);
  });
  it('ignores a commented mention', () => {
    expect(scanForceRls([{ label: 'x', text: '-- never FORCE ROW LEVEL SECURITY here' }])).toEqual([]);
  });
  it('the real migration-24 files contain NO active FORCE RLS', () => {
    const f = loadFixture('24_evidence');
    const texts = [
      ...f.applyStages.map((s) => ({ label: s.label, text: readFileSync(s.path, 'utf8') })),
      { label: 'VERIFY', text: readFileSync(f.verify.path, 'utf8') },
      ...f.rollbackStages.map((s) => ({ label: s.label, text: s.sql })),
    ];
    expect(() => assertNoForceRls(texts)).not.toThrow();
  });
});

describe('scanUndeclaredSubstrate (fail-on-undeclared, brief §6)', () => {
  const fixture = { declaredSubstrate: { symbols: ['auth.uid', 'storage.objects'] } };
  it('flags a referenced but undeclared auth/storage symbol', () => {
    const out = scanUndeclaredSubstrate(fixture, [{ label: 'x', text: 'SELECT auth.email() FROM storage.buckets' }]);
    expect(out).toContain('auth.email');
    expect(out).toContain('storage.buckets');
  });
  it('does not flag a symbol only mentioned in a comment (e.g. auth.role)', () => {
    const out = scanUndeclaredSubstrate(fixture, [{ label: 'x', text: '-- no auth.role check here\nSELECT auth.uid();' }]);
    expect(out).toEqual([]);
  });
  it('does not flag a symbol the migration itself creates', () => {
    const out = scanUndeclaredSubstrate(fixture, [{ label: 'x', text: 'CREATE TABLE storage.foo(); SELECT * FROM storage.foo;' }]);
    expect(out).toEqual([]);
  });
  it('the 24_evidence fixture declares every auth/storage symbol migration 24 references', () => {
    const f = loadFixture('24_evidence');
    const texts = [
      ...f.applyStages.map((s) => ({ label: s.label, text: readFileSync(s.path, 'utf8') })),
      { label: 'VERIFY', text: readFileSync(f.verify.path, 'utf8') },
    ];
    expect(scanUndeclaredSubstrate(f, texts)).toEqual([]);
  });
});

describe('extractStorageCompanionRollback', () => {
  it('extracts the BEGIN..COMMIT storage rollback matching the operator-proven shape', () => {
    const f = loadFixture('24_evidence');
    const storageStage = f.rollbackStages.find((s) => s.source === 'storage-companion-comment');
    const sql = storageStage.sql;
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trim()).toMatch(/COMMIT;$/);
    // Exactly the five evidence-request-files policies + the guarded bucket delete.
    expect((sql.match(/DROP POLICY IF EXISTS/g) || []).length).toBe(5);
    expect(sql).toMatch(/DELETE FROM storage\.buckets WHERE id = 'evidence-request-files'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM storage\.objects/);
  });
  it('throws loudly when the marker is absent', () => {
    expect(() => extractStorageCompanionRollback('-- no marker here\nBEGIN; COMMIT;')).toThrow();
  });
});

describe('bootstrap substrate declaration', () => {
  it('exposes the roles/schemas/helpers migrations depend on', () => {
    const boot = readBootstrapSql();
    for (const role of ['anon', 'authenticated', 'service_role', 'supabase_storage_admin']) {
      expect(boot).toContain(role);
    }
    expect(boot).toMatch(/CREATE SCHEMA IF NOT EXISTS auth/);
    expect(boot).toMatch(/CREATE SCHEMA IF NOT EXISTS storage/);
    expect(boot).toMatch(/FUNCTION auth\.uid\(\)/);
    expect(boot).toMatch(/is_ddp_admin/);
    expect(boot).toMatch(/has_operational_farmer_access/);
  });
  it('the bootstrap itself introduces no FORCE RLS', () => {
    expect(scanForceRls([{ label: 'bootstrap', text: readBootstrapSql() }])).toEqual([]);
  });
});

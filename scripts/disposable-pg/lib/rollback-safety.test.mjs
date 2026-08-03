import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRollbackSafetyReport, checkMigrationSymmetry } from './rollback-safety.mjs';

// These exercise the real extraction logic against SQL on disk. The tests below
// them only exercise the formatter, which is how an extractor that captured the
// literal word "if" as an object name stayed green.
function withMigration(hardeningSql, rollbackSql, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-safety-'));
  try {
    const h = join(dir, '99_FIXTURE_HARDENING.sql');
    const r = join(dir, '99_FIXTURE_ROLLBACK.sql');
    writeFileSync(h, hardeningSql);
    writeFileSync(r, rollbackSql);
    return fn(h, r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('rollback-safety: checkMigrationSymmetry against real SQL', () => {
  it('a matching create/drop pair passes', () => {
    const result = withMigration(
      `CREATE TABLE IF NOT EXISTS ai_audit_events (id UUID PRIMARY KEY);
       CREATE OR REPLACE FUNCTION ai_create_audit_event(p_type TEXT) RETURNS UUID AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;`,
      `DROP FUNCTION IF EXISTS ai_create_audit_event(TEXT) CASCADE;
       DROP TABLE IF EXISTS ai_audit_events CASCADE;`,
      (h, r) => checkMigrationSymmetry(99, h, r),
    );
    expect(result.ok).toBe(true);
  });

  it('DEFECT A — rollback drops a name that was never created', () => {
    const result = withMigration(
      `CREATE TABLE IF NOT EXISTS ai_audit_events (id UUID PRIMARY KEY);
       CREATE FUNCTION ai_create_audit_event(p_type TEXT) RETURNS UUID AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;`,
      `DROP FUNCTION IF EXISTS log_audit_event(TEXT);
       DROP TABLE IF EXISTS ai_audit_events;`,
      (h, r) => checkMigrationSymmetry(99, h, r),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ai_create_audit_event');
  });

  it('CREATE TABLE IF NOT EXISTS yields the table name, not the word "if"', () => {
    const result = withMigration(
      'CREATE TABLE IF NOT EXISTS ai_jobs (id UUID PRIMARY KEY);',
      'DROP TABLE IF EXISTS ai_jobs CASCADE;',
      (h, r) => checkMigrationSymmetry(99, h, r),
    );
    expect(result.ok).toBe(true);
  });

  it('a multi-argument DROP FUNCTION is not shredded by its own commas', () => {
    const result = withMigration(
      `CREATE OR REPLACE FUNCTION ai_create_audit_event(a TEXT, b TEXT, c UUID, d JSONB)
         RETURNS UUID AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;`,
      'DROP FUNCTION IF EXISTS ai_create_audit_event(TEXT, TEXT, UUID, JSONB) CASCADE;',
      (h, r) => checkMigrationSymmetry(99, h, r),
    );
    expect(result.ok).toBe(true);
  });

  it('a comment mentioning DROP FUNCTION does not swallow the real statement', () => {
    const result = withMigration(
      `CREATE OR REPLACE FUNCTION ai_create_audit_event(a TEXT) RETURNS UUID AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;`,
      `-- Signature must match the HARDENING file exactly. \`DROP FUNCTION IF
       -- EXISTS\` with a signature matching nothing exits 0 and removes nothing.
       DROP FUNCTION IF EXISTS ai_create_audit_event(TEXT) CASCADE;`,
      (h, r) => checkMigrationSymmetry(99, h, r),
    );
    expect(result.ok).toBe(true);
  });

  it('a function RESTORED by the rollback counts as reversed, not leaked', () => {
    const result = withMigration(
      `CREATE OR REPLACE FUNCTION handle_new_user() RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      `CREATE OR REPLACE FUNCTION handle_new_user() RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      (h, r) => checkMigrationSymmetry(99, h, r),
    );
    expect(result.ok).toBe(true);
  });

  it('an unreadable file is a failure, never a silent pass', () => {
    const result = checkMigrationSymmetry(99, '/nonexistent/H.sql', '/nonexistent/R.sql');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('error reading files');
  });
});

describe('rollback-safety: static name check for migration symmetry', () => {
  it('all pass report', () => {
    const results = [
      { ok: true, number: 47 },
      { ok: true, number: 48 },
      { ok: true, number: 49 },
    ];
    
    const report = formatRollbackSafetyReport(results);
    expect(report).toContain('✓');
    expect(report).toContain('All migrations');
    expect(report).not.toContain('migration 47');
  });

  it('DEFECT A — missing function in ROLLBACK drops', () => {
    const results = [
      { ok: false, number: 49, reason: 'functions/tables created but not dropped: ai_create_audit_event' },
    ];
    
    const report = formatRollbackSafetyReport(results);
    expect(report).toContain('✗');
    expect(report).toContain('migration 49');
    expect(report).toContain('ai_create_audit_event');
    expect(report).toContain('missing drops');
  });

  it('multiple failures listed', () => {
    const results = [
      { ok: false, number: 49, reason: 'functions/tables created but not dropped: ai_create_audit_event' },
      { ok: false, number: 50, reason: 'functions/tables created but not dropped: get_active_prompt, get_model_config' },
      { ok: true, number: 51 },
    ];
    
    const report = formatRollbackSafetyReport(results);
    expect(report).toContain('2 migration(s)');
    expect(report).toContain('migration 49');
    expect(report).toContain('migration 50');
    expect(report).not.toContain('migration 51');
  });

  it('includes note about static check limitations', () => {
    const results = [
      { ok: false, number: 50, reason: 'test' },
    ];
    
    const report = formatRollbackSafetyReport(results);
    expect(report).toContain('static NAME check');
    expect(report).toContain('wrong signature');
  });
});

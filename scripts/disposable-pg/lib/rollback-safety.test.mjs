import { describe, it, expect } from 'vitest';
import { formatRollbackSafetyReport } from './rollback-safety.mjs';

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

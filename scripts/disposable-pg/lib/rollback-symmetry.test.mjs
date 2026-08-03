import { describe, it, expect } from 'vitest';
import { snapshotCatalog, assertCatalogSymmetry } from './rollback-symmetry.mjs';

describe('rollback-symmetry: catalog snapshot comparison', () => {
  it('identical snapshots pass', () => {
    const snapshot = [
      { kind: 'function', obj: 'ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT)' },
      { kind: 'table', obj: 'ai_audit_events' },
    ];
    const result = assertCatalogSymmetry(snapshot, snapshot);
    expect(result.ok).toBe(true);
  });

  it('DEFECT A — missing function name (created as ai_create_audit_event, dropped as log_audit_event)', () => {
    const before = [
      { kind: 'function', obj: 'ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT)' },
      { kind: 'table', obj: 'ai_audit_events' },
    ];
    const after = [
      // ai_create_audit_event still here because drop used wrong name
      { kind: 'function', obj: 'ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT)' },
      { kind: 'table', obj: 'ai_audit_events' },
    ];
    
    const result = assertCatalogSymmetry(before, after);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('ai_create_audit_event');
  });

  it('DEFECT B — wrong function signature (created with 7 args, dropped with 5)', () => {
    const before = [
      { kind: 'function', obj: 'ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT)' },
    ];
    const after = [
      // Still exists because DROP with wrong signature matched nothing
      { kind: 'function', obj: 'ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT)' },
    ];
    
    const result = assertCatalogSymmetry(before, after);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('ai_create_audit_event');
  });

  it('detects length mismatch', () => {
    const before = [{ kind: 'table', obj: 'foo' }];
    const after = [
      { kind: 'table', obj: 'foo' },
      { kind: 'table', obj: 'bar' },
    ];
    const result = assertCatalogSymmetry(before, after);
    expect(result.ok).toBe(false);
    expect(result.diff).toContain('length mismatch');
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

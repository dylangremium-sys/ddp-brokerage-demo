import { describe, it, expect } from 'vitest';
import {
  parseMigrationFilename,
  findNumberCollisions,
  listMigrationFilenames,
  assertNoNumberCollisions,
  formatCollisionReport,
} from './lib/migration-numbering.mjs';
import { REPO_ROOT } from './lib/fixtures.mjs';

describe('parseMigrationFilename', () => {
  it('splits a standard three-stage migration into one stem', () => {
    const files = [
      '25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql',
      '25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql',
      '25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql',
    ];
    const stems = new Set(files.map((f) => parseMigrationFilename(f).stem));
    expect([...stems]).toEqual(['WATCHTOWER_INGESTION_PROVENANCE']);
  });

  it('keeps a four-stage migration (24 adds STORAGE) as one stem', () => {
    const files = [
      '24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql',
      '24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql',
      '24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql',
      '24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql',
    ];
    const stems = new Set(files.map((f) => parseMigrationFilename(f).stem));
    expect([...stems]).toEqual(['EVIDENCE_REQUEST_RESOLUTION']);
  });

  it('treats an unsuffixed forward file as the same migration as its companions', () => {
    // Migration 23's forward file has no stage token.
    const files = [
      '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql',
      '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_ROLLBACK.sql',
      '23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql',
    ];
    const stems = new Set(files.map((f) => parseMigrationFilename(f).stem));
    expect([...stems]).toEqual(['BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE']);
  });

  it('treats an MVP-suffixed forward file as the same migration (10, 17)', () => {
    const stems = new Set(
      [
        '10_BUYER_PACK_SNAPSHOTS_MVP.sql',
        '10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql',
        '10_BUYER_PACK_SNAPSHOTS_VERIFY.sql',
      ].map((f) => parseMigrationFilename(f).stem),
    );
    expect([...stems]).toEqual(['BUYER_PACK_SNAPSHOTS']);
  });

  it('ignores unnumbered schema files, which are outside the ordering contract', () => {
    expect(parseMigrationFilename('AUTH_RLS_SCHEMA.sql')).toBeNull();
    expect(parseMigrationFilename('SUPABASE_SCHEMA.sql')).toBeNull();
    expect(parseMigrationFilename('FARMER_MVP_MIGRATION.sql')).toBeNull();
    expect(parseMigrationFilename('README.md')).toBeNull();
  });
});

describe('findNumberCollisions — negative coverage', () => {
  it('detects the real PR #48 / PR #44 collision on number 25', () => {
    const collisions = findNumberCollisions([
      '25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql',
      '25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql',
      '25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql',
      '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql',
      '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_ROLLBACK.sql',
      '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_VERIFY.sql',
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].number).toBe(25);
    expect(collisions[0].stems.map((s) => s.stem)).toEqual([
      'COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE',
      'WATCHTOWER_INGESTION_PROVENANCE',
    ]);
  });

  it('names both migrations and the fix in its report', () => {
    const report = formatCollisionReport(
      findNumberCollisions([
        '25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql',
        '25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql',
      ]),
    );
    expect(report).toContain('migration number 25');
    expect(report).toContain('WATCHTOWER_INGESTION_PROVENANCE');
    expect(report).toContain('COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE');
    expect(report).toContain('renumber');
  });

  it('does NOT flag the same migration split across stages', () => {
    expect(
      findNumberCollisions([
        '26_WATCHTOWER_SOURCE_GOVERNANCE_HARDENING.sql',
        '26_WATCHTOWER_SOURCE_GOVERNANCE_ROLLBACK.sql',
        '26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql',
      ]),
    ).toEqual([]);
  });

  it('does NOT flag the same stem reused at DIFFERENT numbers (19 guard, 20 ACL fix)', () => {
    expect(
      findNumberCollisions([
        '19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql',
        '19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql',
        '19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql',
        '20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql',
      ]),
    ).toEqual([]);
  });

  it('reports every colliding number, not just the first', () => {
    const collisions = findNumberCollisions([
      '25_A_THING_HARDENING.sql',
      '25_B_THING_HARDENING.sql',
      '30_C_THING_HARDENING.sql',
      '30_D_THING_HARDENING.sql',
    ]);
    expect(collisions.map((c) => c.number)).toEqual([25, 30]);
  });
});

describe('the live repository corpus', () => {
  it('exposes the numbered migrations on disk', () => {
    const files = listMigrationFilenames(REPO_ROOT);
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql');
  });

  it('has no migration-number collision', () => {
    expect(() => assertNoNumberCollisions(REPO_ROOT)).not.toThrow();
  });
});

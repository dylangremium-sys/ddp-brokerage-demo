import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DisposableCluster, resolvePgBin } from './lib/cluster.mjs';

// ─── Migration 35: the PRECONDITION-FAILURE path ────────────────────────────
//
// The migration opens with a DO $precondition$ block that refuses to run when a
// required substrate object is absent. That path had never been executed: it
// built its message with `missing := missing || 'public.status_history'`, where
// `missing` is text[] and the untyped literal resolves to text[] too. Postgres
// therefore parsed the literal as an ARRAY literal and raised
//
//   ERROR: malformed array literal: "public.status_history"
//   DETAIL: Array value must start with "{" or dimension information.
//
// instead of the intended "missing ..." message — precisely when the operator
// most needs to be told which object is missing. It fails closed either way, so
// it was never a safety hole, but the diagnostic was wrong.
//
// These tests execute the REAL block, extracted verbatim from the migration
// file, so a regression cannot hide behind a copy that drifted from the source.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const MIGRATION = join(REPO_ROOT, '35_STATUS_TRANSITION_ATOMIC_HARDENING.sql');
const SUBSTRATE = join(import.meta.dirname, 'bootstrap', '00_supabase_substrate.sql');

/** Extracts the `DO $precondition$ ... $precondition$;` block from the migration. */
function extractPreconditionBlock(sql) {
  const match = sql.match(/DO \$precondition\$[\s\S]*?\$precondition\$;/);
  if (!match) throw new Error('precondition block not found in migration 35');
  return match[0];
}

function pgAvailable() {
  try {
    resolvePgBin({});
    return true;
  } catch {
    return false;
  }
}
const REQUIRE_PG = process.env.HARNESS_REQUIRE_PG === '1';
const PG_ENABLED = Boolean(process.env.PG_BIN?.trim()) || REQUIRE_PG;
const HAS_PG = PG_ENABLED && pgAvailable();

describe('migration 35 precondition block (static)', () => {
  it('never concatenates a bare untyped literal onto the text[] accumulator', () => {
    const block = extractPreconditionBlock(readFileSync(MIGRATION, 'utf8'));
    const appends = [...block.matchAll(/missing := missing \|\| ('[^']*')(::text)?/g)];
    expect(appends.length).toBeGreaterThan(0);
    // Every append must carry an explicit ::text cast, otherwise Postgres reads
    // the literal as an array literal and the error path dies with a parse error.
    for (const [, literal, cast] of appends) {
      expect(cast, `append of ${literal} is missing an explicit ::text cast`).toBe('::text');
    }
  });
});

describe.skipIf(!HAS_PG)('migration 35 precondition block (real PostgreSQL)', () => {
  it('fails with the intended message when the substrate is absent', { timeout: 90000 }, () => {
    const cluster = new DisposableCluster({});
    try {
      cluster.create();
      // A freshly created disposable cluster carries NO Supabase substrate, so
      // every object the block checks for is genuinely missing. This is the
      // exact state the precondition exists to refuse.
      const block = extractPreconditionBlock(readFileSync(MIGRATION, 'utf8'));
      const res = cluster.runInlineSql('m35-precondition-missing', block);

      expect(res.status, 'the precondition must fail closed').not.toBe(0);
      // The regression this guards: a parse error instead of a diagnostic.
      expect(res.combined).not.toMatch(/malformed array literal/i);
      expect(res.combined).toMatch(/migration 35 precondition failed: missing/);
      // and it must name every object it checked, not just the first.
      for (const object of [
        'public.status_history',
        'public.farms',
        'public.inventory_batches',
        'public.is_ddp_admin()',
        'public.has_operational_farmer_access()',
      ]) {
        expect(res.combined).toContain(object);
      }
    } finally {
      cluster.teardown();
    }
  });

  it('passes once the substrate is present', { timeout: 90000 }, () => {
    const cluster = new DisposableCluster({});
    try {
      cluster.create();
      const bootstrap = cluster.runSqlFile(SUBSTRATE);
      expect(bootstrap.status, 'substrate bootstrap must succeed').toBe(0);

      const block = extractPreconditionBlock(readFileSync(MIGRATION, 'utf8'));
      const res = cluster.runInlineSql('m35-precondition-satisfied', block);

      // The other direction: a satisfied precondition must not raise at all, so
      // the guard above can never pass merely because the block always throws.
      expect(res.combined).not.toMatch(/precondition failed/);
      expect(res.status).toBe(0);
    } finally {
      cluster.teardown();
    }
  });
});

import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DisposableCluster, resolvePgBin } from './lib/cluster.mjs';

// ─── The substrate must keep describing production ──────────────────────────
//
// The disposable-PG substrate is a stand-in for the world the numbered
// migrations run against. It was built a column at a time — each addition made
// because one migration failed on one missing column — and that process cannot
// converge. It only ever grows toward what some VERIFY happened to touch, so it
// drifts further from the real database with every migration that does NOT
// fail. By 2026-08-04 production's inventory_batches carried 45 columns and the
// substrate declared 16.
//
// The drift was invisible because it LOOKED covered: fixtures 4, 15 and 22
// apply SUPABASE_SCHEMA.sql and FARMER_MVP_MIGRATION.sql as stages, which reads
// as "build the real base schema first". Both files use
// `CREATE TABLE IF NOT EXISTS`, and the substrate has already created those
// tables by then — so their fuller column lists are a silent no-op and only
// their ALTER TABLE statements land.
//
// What it costs, measured (scripts/disposable-pg/.artifacts, and reproduced in
// the reconciliation commit message): a currency migration written in this
// repository's own guarded idiom — `IF EXISTS (SELECT 1 FROM
// information_schema.columns ...)`, the same shape as 26 and 28's forward files
// — matched nothing against the old substrate, added nothing, and its VERIFY
// reported PASS. A green fixture proving nothing whatever.
//
// So this test compares the substrate the harness actually boots against a
// manifest measured from production, and every legitimate difference has to be
// named in that manifest rather than tolerated silently.
//
// When it fails, it is telling you one of three things:
//   1. production gained or lost a column      -> re-measure, update the manifest
//   2. a numbered migration adds the column    -> add it to
//                                                 columnsAddedByNumberedMigrations
//   3. the substrate drifted                   -> fix the substrate
// "Delete the assertion" is not on that list.

const HERE = import.meta.dirname;
const SUBSTRATE = join(HERE, 'bootstrap', '00_supabase_substrate.sql');
const MANIFEST = join(HERE, 'bootstrap', 'PRODUCTION_SHAPE.json');

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

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** `col type` strings production has on `table`, minus the ones a numbered
 *  migration is responsible for adding, plus the ones the substrate carries
 *  that production does not. That is what the substrate should declare. */
function expectedFor(table) {
  const prod = manifest.productionPublicColumns[table] ?? [];
  const fromMigrations = new Set(Object.keys(manifest.columnsAddedByNumberedMigrations[table] ?? {}));
  const substrateOnly = Object.keys(manifest.columnsInSubstrateOnly[table] ?? {});
  return [...prod.filter((c) => !fromMigrations.has(c)), ...substrateOnly].sort();
}

describe('production shape manifest', () => {
  it('names a measurement date and a reproducible query', () => {
    expect(manifest.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.measuredFrom).toMatch(/production/i);
    expect(manifest.howToRegenerate).toMatch(/pg_attribute/);
  });

  it('gives a reason for every exception, so none is a silent tolerance', () => {
    for (const [table, cols] of Object.entries(manifest.columnsAddedByNumberedMigrations)) {
      for (const [col, why] of Object.entries(cols)) {
        expect(why, `${table}.${col}`).toMatch(/migration \d+/);
      }
    }
    for (const [table, cols] of Object.entries(manifest.columnsInSubstrateOnly)) {
      for (const [col, why] of Object.entries(cols)) {
        expect(String(why).length, `${table}.${col}`).toBeGreaterThan(40);
      }
    }
  });

  it('does not claim a substrate table production has never had', () => {
    for (const table of manifest.substrateDeclaredTables) {
      expect(manifest.productionPublicColumns[table], table).toBeDefined();
    }
  });
});

describe.skipIf(!HAS_PG)('substrate vs production shape (real PostgreSQL)', () => {
  let columnsByTable;

  // Booted ONCE in beforeAll, with an explicit timeout, rather than lazily on
  // first use.
  //
  // Lazily was wrong twice over. It made whichever test ran first carry the cost
  // of an initdb, a server start and the whole substrate — and that test
  // inherited vitest's 5-second default, because this file was the only one
  // under scripts/disposable-pg/ that set no timeout at all (its siblings use
  // 60000-120000). Running alone it passed in ~1.5s; running with the rest of
  // the suite it timed out roughly one run in two.
  //
  // A flaky gate is worse than a missing one. The repo's own note on false
  // positives applies exactly: a gate that cries wolf is a gate someone
  // eventually switches off, taking the true positives with it.
  beforeAll(() => {
    const cluster = new DisposableCluster({});
    try {
      cluster.create();
      const res = cluster.runSqlFile(SUBSTRATE);
      expect(res.status, `substrate failed to apply:\n${res.combined}`).toBe(0);
      const q = cluster.query(`
        select c.relname || '\t' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and a.attnum > 0 and not a.attisdropped
        order by 1`);
      expect(q.status, q.stderr).toBe(0);
      columnsByTable = {};
      for (const line of q.stdout.split('\n').filter(Boolean)) {
        const [table, col] = line.split('\t');
        (columnsByTable[table] ??= []).push(col);
      }
      for (const cols of Object.values(columnsByTable)) cols.sort();
    } finally {
      cluster.teardown();
    }
  }, 120000);

  it('declares exactly the tables the manifest says it declares', () => {
    expect(Object.keys(columnsByTable).sort()).toEqual([...manifest.substrateDeclaredTables].sort());
  });

  // One case per table rather than one big assertion, so a failure names the
  // table instead of dumping fifteen tables' worth of columns.
  for (const table of manifest.substrateDeclaredTables) {
    it(`public.${table} carries production's shape`, () => {
      expect(columnsByTable[table] ?? []).toEqual(expectedFor(table));
    });
  }

  // The column reconciliation covered COLUMNS. It did not cover policies, and a
  // red-team probe found the cost: the substrate declared no policy on profiles
  // at all, so a farmer could set their own role to 'ddp_admin' — which
  // production refuses, verified behaviourally on staging.
  //
  // That is the dangerous direction of drift. A test world STRICTER than
  // production makes a false failure somebody investigates; a test world WEAKER
  // than production makes a false pass nobody looks at. `profiles.role` is the
  // single discriminator between an admin and a farmer in this system, so this
  // one is pinned by name rather than left to the general column check.
  it('pins the profiles policies, because role is what separates an admin from a farmer', () => {
    const sql = readFileSync(SUBSTRATE, 'utf8');
    expect(sql).toMatch(/ALTER TABLE public\.profiles ENABLE ROW LEVEL SECURITY/);
    for (const policy of ['profiles: select own or admin',
                          'profiles: update own no role change',
                          'profiles: admin update role']) {
      expect(sql, `substrate is missing policy "${policy}"`).toContain(policy);
    }
    // The WITH CHECK is the part that actually stops self-promotion. Asserting
    // the policy NAME alone would pass against a policy that had been gutted.
    expect(sql).toMatch(/role = \(SELECT role FROM public\.profiles WHERE id = auth\.uid\(\)\)/);
  });

  it('the tables production has and the substrate does not are only ones migrations create', () => {
    const declared = new Set(manifest.substrateDeclaredTables);
    const undeclared = Object.keys(manifest.productionPublicColumns).filter((t) => !declared.has(t));
    // A pure regression pin. It is not a claim that every one of these SHOULD be
    // migration-created — only that the set does not grow without someone
    // noticing. 33 as at 2026-08-04.
    expect(undeclared.length).toBe(33);
    expect(undeclared).not.toContain('inventory_batches');
    expect(undeclared).not.toContain('farms');
  });
});

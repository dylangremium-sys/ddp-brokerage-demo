import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DisposableCluster, resolvePgBin } from './lib/cluster.mjs';

const execFileAsync = promisify(execFile);

// ─── Migration 36: the throttle must bound CONCURRENT intake ────────────────
//
// The unit tests in src/lib/serverAccessRequestIntake.test.ts prove the HANDLER
// bounds a concurrent burst, but they do it against an in-memory ledger where
// JavaScript's single thread supplies the atomicity for free. That proves the
// algorithm, not the deployment: in production each caller is a separate
// serverless instance on a separate database connection, and nothing in
// JavaScript serialises them.
//
// So this test does the other half — REAL parallel connections against a REAL
// PostgreSQL, each invoking public.reserve_public_intake_slot() exactly as the
// Vercel function does. If the advisory lock or the reserve-before-evaluate
// ordering were removed, the burst would exceed the ceiling here.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SUBSTRATE = join(import.meta.dirname, 'bootstrap', '00_supabase_substrate.sql');
const MIGRATION_34 = join(REPO_ROOT, '34_FARMER_ACCESS_REQUESTS_HARDENING.sql');
const MIGRATION_36 = join(REPO_ROOT, '36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql');

// Must mirror THROTTLE_RULES in src/lib/serverAccessRequestIntake.ts. The
// application passes these in; the function holds no policy of its own.
const RULES = JSON.stringify([
  { scope: 'client', windowSeconds: 600, max: 3 },
  { scope: 'client', windowSeconds: 86400, max: 10 },
  { scope: 'global', windowSeconds: 3600, max: 60 },
]);
const PER_CLIENT_MAX = 3;
const GLOBAL_MAX = 60;
const GLOBAL_KEY = 'global-intake-ceiling';

function pgAvailable() {
  try {
    resolvePgBin({});
    return true;
  } catch {
    return false;
  }
}
const REQUIRE_PG = process.env.HARNESS_REQUIRE_PG === '1';
const PG_ENABLED = !!(process.env.PG_BIN && process.env.PG_BIN.trim()) || REQUIRE_PG;
const HAS_PG = PG_ENABLED && pgAvailable();

/**
 * Fires N reservations from N SEPARATE connections that all execute at the SAME
 * INSTANT.
 *
 * Simply spawning N psql processes is not enough, and assuming otherwise makes
 * the test VACUOUS. Process startup costs tens of milliseconds, so the calls
 * arrive spread out and a racy implementation passes anyway. That was measured,
 * not assumed: with the advisory lock removed from the migration, a plain
 * spawn-and-await burst still reported exactly 3 admitted — the test looked
 * green while proving nothing.
 *
 * So every session connects first and parks on pg_sleep_until() at a shared
 * wall-clock instant, and the barrier is long enough (9s) to outlast spawning
 * all of them. With that in place the same lock-removed migration admits 7 of 20
 * and the test fails, which is what makes a pass meaningful.
 *
 * Returns the raw verdict of each session.
 */
async function burst(cluster, keys, { barrierMs = 9000 } = {}) {
  const psql = cluster.bin('psql');
  // A single shared start instant, computed by the SERVER so no clock skew
  // between node and postgres can smear the barrier.
  const startAt = cluster.query(
    `SELECT (now() + interval '${barrierMs} milliseconds')::text`,
  ).stdout.trim();

  const args = key => ([
    '-h', cluster.socketDir, '-p', '5432', '-U', cluster.superuser, '-d', cluster.database,
    '-tA',
    '-c', `SELECT pg_sleep_until('${startAt}'::timestamptz)`,
    '-c', `SELECT (public.reserve_public_intake_slot('${key}', '${GLOBAL_KEY}', '${RULES}'::jsonb)->>'allowed')`,
  ]);

  const running = keys.map(key => execFileAsync(psql, args(key)).catch(err => ({ stdout: `ERR ${err.message}` })));
  const results = await Promise.all(running);
  // Each session prints the sleep result (blank) then the verdict; take the last
  // non-empty line.
  return results.map(r => {
    const lines = String(r.stdout).split('\n').map(l => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? 'ERR empty';
  });
}

describe.skipIf(!HAS_PG)('migration 36 throttle under real concurrency', () => {
  /** Brings up a cluster with substrate + migrations 34 and 36 applied. */
  function bootCluster() {
    const cluster = new DisposableCluster({});
    cluster.create();
    for (const [label, file] of [['substrate', SUBSTRATE], ['m34', MIGRATION_34], ['m36', MIGRATION_36]]) {
      const res = cluster.runSqlFile(file);
      if (res.status !== 0) {
        cluster.teardown();
        throw new Error(`${label} failed to apply: ${res.combined.slice(0, 800)}`);
      }
    }
    return cluster;
  }

  it('the global bucket key is actually storable in the ledger', { timeout: 90000 }, () => {
    // Regression guard for a defect the mocks could never see: the ledger
    // declares CHECK (length(bucket_key) BETWEEN 16 AND 128), and the original
    // global key was 'global' — six characters. Every global reservation would
    // have been rejected, and because a ledger failure fails closed, applying
    // migration 36 would have taken the public form offline entirely.
    const cluster = bootCluster();
    try {
      const res = cluster.query(
        `INSERT INTO public.public_intake_attempts (bucket_key) VALUES ('${GLOBAL_KEY}') RETURNING 1`,
      );
      expect(res.stderr).not.toMatch(/violates check constraint/);
      expect(res.status).toBe(0);
    } finally {
      cluster.teardown();
    }
  });

  it('20 concurrent reservations for ONE client admit exactly the ceiling', { timeout: 120000 }, async () => {
    const cluster = bootCluster();
    try {
      const clientKey = 'a'.repeat(64);
      const verdicts = await burst(cluster, Array.from({ length: 20 }, () => clientKey));

      const allowed = verdicts.filter(v => v === 'true').length;
      const denied = verdicts.filter(v => v === 'false').length;

      expect(verdicts.filter(v => v.startsWith('ERR'))).toEqual([]);
      expect(allowed + denied).toBe(20);
      // The whole point: not "roughly 3", exactly 3.
      expect(allowed).toBe(PER_CLIENT_MAX);

      // ...and the ledger holds one reservation per attempt, including refused
      // ones, so a flood cannot reset its own allowance.
      const rows = cluster.query(
        `SELECT count(*) FROM public.public_intake_attempts WHERE bucket_key = '${clientKey}'`,
      ).stdout.trim();
      expect(Number(rows)).toBe(20);
    } finally {
      cluster.teardown();
    }
  });

  it('a distributed burst from many DIFFERENT clients is bounded by the global rule', { timeout: 180000 }, async () => {
    const cluster = bootCluster();
    try {
      // Each caller has its own bucket, so no per-client rule can fire — only the
      // global ceiling stands between the burst and the queue.
      const keys = Array.from({ length: GLOBAL_MAX + 15 }, (_, i) => String(i).padStart(64, '0'));
      const verdicts = await burst(cluster, keys);

      expect(verdicts.filter(v => v.startsWith('ERR'))).toEqual([]);
      expect(verdicts.filter(v => v === 'true').length).toBe(GLOBAL_MAX);
    } finally {
      cluster.teardown();
    }
  });
});

describe.skipIf(!HAS_PG)('migration 36 duplicate lookup is literal, not a pattern', () => {
  it('treats _ and % in an address as characters, not wildcards', { timeout: 90000 }, () => {
    // The defect: `.ilike('email', address)` sent the address to SQL ILIKE as a
    // PATTERN. `_` is legal in an email local part, so a new supplier writing
    // a_b@example.com matched a stored axb@example.com, was judged a duplicate,
    // and got HTTP 200 while nothing was written. Verified on PG 18.4:
    //   SELECT 'axb@example.com' ILIKE 'a_b@example.com';  -- true
    const cluster = new DisposableCluster({});
    try {
      cluster.create();
      for (const file of [SUBSTRATE, MIGRATION_34, MIGRATION_36]) {
        const res = cluster.runSqlFile(file);
        expect(res.status, res.combined.slice(0, 500)).toBe(0);
      }

      cluster.query(`INSERT INTO public.farmer_access_requests
        (full_name, email, phone, province, position, preferred_language, note, status)
        VALUES ('Existing','axb@example.com','+66 81 000 0000','Buriram','Owner','en','', 'new')`);

      const ask = email => cluster.query(
        `SELECT public.has_open_access_request('${email}')`,
      ).stdout.trim();

      // The exact false positive that lost enquiries.
      expect(ask('a_b@example.com')).toBe('f');
      // A % must not match everything either.
      expect(ask('%@example.com')).toBe('f');
      // A backslash must not be an escape that resurrects pattern behaviour.
      expect(ask('a\\_b@example.com')).toBe('f');
      // The genuine duplicate still matches...
      expect(ask('axb@example.com')).toBe('t');
      // ...including case-insensitively, which is the semantics ILIKE provided
      // and which this deliberately preserves.
      expect(ask('AXB@Example.COM')).toBe('t');
    } finally {
      cluster.teardown();
    }
  });
});

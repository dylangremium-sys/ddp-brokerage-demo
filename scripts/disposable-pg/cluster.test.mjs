import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { DisposableCluster, resolvePgBin, DEFAULT_PG_MAJOR, PG_MAJOR_OVERRIDE } from './lib/cluster.mjs';

// The major this lane is pinned to. Named once, so a version change cannot leave
// an assertion behind — which is exactly what happened when the harness moved
// from 18 to 17 and two hardcoded /^18\./ checks stayed put.
const EXPECTED_PG_MAJOR = PG_MAJOR_OVERRIDE ?? DEFAULT_PG_MAJOR;

function pgAvailable() {
  try {
    // Must resolve against the major this lane is pinned to. Passing no pgMajor
    // resolves against the DEFAULT (17), so on the PG-18 lane a perfectly good
    // Postgres 18 looked "unavailable" and the availability gate failed.
    resolvePgBin({ pgMajor: EXPECTED_PG_MAJOR });
    return true;
  } catch {
    return false;
  }
}
const REQUIRE_PG = process.env.HARNESS_REQUIRE_PG === '1';
// Real-Postgres tests run ONLY when explicitly enabled — PG_BIN set (local/CI) or
// HARNESS_REQUIRE_PG=1 (ci:runtime). This makes the static-job skip structural,
// independent of whatever Postgres happens to be on the runner's PATH.
const PG_ENABLED = !!(process.env.PG_BIN && process.env.PG_BIN.trim()) || REQUIRE_PG;
const HAS_PG = PG_ENABLED && pgAvailable();

// In ci:runtime (HARNESS_REQUIRE_PG=1) a missing Postgres is a HARD failure, not
// a skip — the merge gate must never pass by silently skipping real execution.
describe('ci:runtime gate', () => {
  (REQUIRE_PG ? it : it.skip)(`PostgreSQL ${EXPECTED_PG_MAJOR} must be available`, () => {
    expect(HAS_PG).toBe(true);
  });
});

describe.skipIf(!HAS_PG)('DisposableCluster lifecycle (real PostgreSQL)', () => {
  it('creates a socket-only cluster and tears it down with zero residue', { timeout: 60000 }, () => {
    const cluster = new DisposableCluster({});
    let runRoot;
    try {
      const conn = cluster.create();
      runRoot = cluster.runRoot;
      expect(conn.host).toMatch(/^\/tmp\/dpg-/);
      expect(existsSync(runRoot)).toBe(true);
      // No TCP listener.
      expect(cluster.query('SHOW listen_addresses').stdout.trim()).toBe('');
      // Server is queryable and reports the pinned major.
      expect(cluster.serverVersion).toMatch(new RegExp(`^${EXPECTED_PG_MAJOR}\\.`));
      expect(cluster.query('SELECT 1').stdout.trim()).toBe('1');
    } finally {
      const td = cluster.teardown();
      expect(td.ok).toBe(true);
      expect(td.residue).toBe(false);
      expect(td.processAlive).toBe(false);
      if (runRoot) expect(existsSync(runRoot)).toBe(false);
    }
  });

  it('teardown is idempotent', { timeout: 60000 }, () => {
    const cluster = new DisposableCluster({});
    cluster.create();
    const first = cluster.teardown();
    const second = cluster.teardown();
    expect(first.ok).toBe(true);
    expect(second.alreadyDone).toBe(true);
  });

  it('tears down even when a caller aborts mid-use (finally path)', { timeout: 60000 }, () => {
    const cluster = new DisposableCluster({});
    const runRoot = (() => {
      try {
        cluster.create();
        throw new Error('simulated mid-run failure');
      } catch (e) {
        expect(e.message).toMatch(/simulated/);
        return cluster.runRoot;
      } finally {
        cluster.teardown();
      }
    })();
    expect(existsSync(runRoot)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { DisposableCluster, resolvePgBin } from './lib/cluster.mjs';

function pgAvailable() {
  try {
    resolvePgBin({});
    return true;
  } catch {
    return false;
  }
}
const HAS_PG = pgAvailable();
const REQUIRE_PG = process.env.HARNESS_REQUIRE_PG === '1';

// In ci:runtime (HARNESS_REQUIRE_PG=1) a missing Postgres is a HARD failure, not
// a skip — the merge gate must never pass by silently skipping real execution.
describe('ci:runtime gate', () => {
  (REQUIRE_PG ? it : it.skip)('PostgreSQL 18 must be available', () => {
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
      // Server is queryable and reports major 18.
      expect(cluster.serverVersion).toMatch(/^18\./);
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

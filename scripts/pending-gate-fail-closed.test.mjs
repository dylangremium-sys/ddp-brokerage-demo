// Behavioral regression test for the pending-matrix fail-closed gate.
//
// The defect this pins (PR #22 review, P2): when the configured staging account
// could NOT be proven to have profiles.role = 'pending', group H recorded a
// single harmless SKIP. SKIP is counted in neither `failed` nor `blocked` at the
// exit rule, so the entire pending probe registry silently never ran and the
// suite exited 0 — migration 22's central guarantee appeared proven when it had
// never been exercised. The three sibling branches correctly used blockAll().
//
// Why the pre-existing harness test did not catch it: it asserts the registry
// stays in step with the migration's table list (DEFINITION), never that the
// probes are actually recorded after a run (EXECUTION).
//
// These tests drive the REAL exported applyPendingGate — the same function
// group H calls — not a copy of its control flow. Reverting that helper to the
// old skip() behaviour makes them fail. Offline: no network, no staging.
// Importing the script does not trigger a live run; main() is guarded to
// execute only when the file is invoked directly.

import { describe, it, expect } from 'vitest'
import {
  applyPendingGate,
  resolvePendingRoleGate,
  computeExitCode,
  buildPendingProbeRegistry,
  MIGRATION_22_TABLES,
} from './run-staging-security-tests.mjs'

// Mirrors the harness's result-collection contract: block() pushes a BLOCK row,
// and the exit rule counts BLOCK as a non-pass.
function makeRecorder() {
  const results = []
  return {
    results,
    block(name, reason) { results.push({ name, status: 'BLOCK', detail: reason, pendingMatrix: true }) },
    record(name, ok) { results.push({ name, status: ok ? 'PASS' : 'FAIL' }) },
    skip(name, reason) { results.push({ name, status: 'SKIP', detail: reason }) },
    exitCode() {
      return computeExitCode({
        failed: results.filter(r => r.status === 'FAIL').length,
        blocked: results.filter(r => r.status === 'BLOCK').length,
        cleanupFailures: results.filter(r => r.cleanupVerified === false).length,
      })
    },
  }
}

// Stands in for the pending-user probe body. It must never execute when the
// account cannot be proven pending, so it records every invocation.
function makeMatrixSpy() {
  const spy = { invocations: 0 }
  spy.runMatrix = async () => { spy.invocations += 1; return 'matrix-ran' }
  return spy
}

// Invoke the REAL production gate with a recorder and a spy body.
async function runGate(roleRow) {
  const recorder = makeRecorder()
  const spy = makeMatrixSpy()
  const outcome = await applyPendingGate(roleRow, { block: recorder.block, runMatrix: spy.runMatrix })
  return { outcome, recorder, spy }
}

// The four ways an account can fail to be proven pending.
const UNPROVEN_CASES = [
  ['observed role is farmer', { data: { role: 'farmer' }, error: null }],
  ['observed role is ddp_admin', { data: { role: 'ddp_admin' }, error: null }],
  ['profile row is missing', { data: null, error: null }],
  ['role query returns an error', { data: null, error: { message: 'permission denied for table profiles' } }],
]

describe('registry size is asserted so accidental coverage loss is detected', () => {
  it('covers every migration 22 table across 4 operations', () => {
    const registry = buildPendingProbeRegistry()
    expect(MIGRATION_22_TABLES.length).toBe(11)
    expect(registry.length).toBe(MIGRATION_22_TABLES.length * 4)
    // Every table must be represented; a shrunken registry would otherwise let
    // "all probes blocked" pass trivially on a smaller set.
    for (const table of MIGRATION_22_TABLES) {
      expect(registry.some(p => p.table === table)).toBe(true)
    }
    expect(new Set(registry.map(p => p.probeName)).size).toBe(registry.length)
  })
})

describe('an account that cannot be proven pending fails closed', () => {
  for (const [label, roleRow] of UNPROVEN_CASES) {
    describe(label, () => {
      it('classifies the account as unproven and reports it did not run', async () => {
        const { outcome } = await runGate(roleRow)
        expect(outcome.gate.proven).toBe(false)
        expect(outcome.ran).toBe(false)
      })

      it('records the FULL probe registry — no probe is silently omitted', async () => {
        const { recorder } = await runGate(roleRow)
        const expected = buildPendingProbeRegistry().map(p => p.probeName)
        const recorded = recorder.results.map(r => r.name)
        expect(recorded.slice().sort()).toEqual(expected.slice().sort())
        expect(recorded).toHaveLength(expected.length)
      })

      it('records every probe as BLOCK and none as SKIP', async () => {
        const { recorder } = await runGate(roleRow)
        expect(recorder.results.length).toBeGreaterThan(0)
        expect(recorder.results.every(r => r.status === 'BLOCK')).toBe(true)
        expect(recorder.results.some(r => r.status === 'SKIP')).toBe(false)
        expect(recorder.results.filter(r => r.status === 'BLOCK')).toHaveLength(
          buildPendingProbeRegistry().length,
        )
      })

      it('exits non-zero because blocked results exist', async () => {
        const { recorder } = await runGate(roleRow)
        expect(recorder.exitCode()).toBe(1)
        // Attributable to BLOCK specifically, not to incidental FAILs.
        expect(recorder.results.some(r => r.status === 'FAIL')).toBe(false)
      })

      it('attempts no pending-user database or storage probe', async () => {
        const { spy, outcome } = await runGate(roleRow)
        expect(spy.invocations).toBe(0)
        expect(outcome.result).toBeUndefined()
      })

      it('explains why it refused to assert', async () => {
        const { recorder } = await runGate(roleRow)
        expect(resolvePendingRoleGate(roleRow).detail).toMatch(/refusing to assert/)
        expect(recorder.results.every(r => /refusing to assert/.test(r.detail))).toBe(true)
      })
    })
  }
})

describe('a genuinely pending account still runs the matrix', () => {
  // The fix must fail closed WITHOUT disabling the probes it exists to protect.
  it('runs the pending-user probes and blocks nothing', async () => {
    const { outcome, recorder, spy } = await runGate({ data: { role: 'pending' }, error: null })

    expect(outcome.gate.proven).toBe(true)
    expect(outcome.ran).toBe(true)
    expect(outcome.result).toBe('matrix-ran')
    expect(spy.invocations).toBe(1)
    expect(recorder.results).toEqual([])          // nothing blocked
    expect(recorder.exitCode()).toBe(0)
  })
})

describe('the old skip() behaviour would NOT satisfy these assertions', () => {
  // Pins the exact regression shape: a lone SKIP leaves the suite green with
  // zero probes recorded. This is what applyPendingGate must never produce.
  it('a lone SKIP records no probes and exits zero', () => {
    const recorder = makeRecorder()
    recorder.skip('pending-user probes', 'configured user role is "farmer", not "pending"')

    expect(recorder.results).toHaveLength(1)
    expect(recorder.exitCode()).toBe(0)                       // ← the false green
    const recorded = recorder.results.map(r => r.name)
    for (const probe of buildPendingProbeRegistry()) {
      expect(recorded).not.toContain(probe.probeName)         // ← 44 probes never ran
    }
  })

  it('SKIP is not counted by the exit rule, unlike BLOCK', () => {
    expect(computeExitCode({ failed: 0, blocked: 0, cleanupFailures: 0 })).toBe(0)
    expect(computeExitCode({ failed: 0, blocked: 1, cleanupFailures: 0 })).toBe(1)
  })
})

describe('exit rule treats BLOCK as a non-pass', () => {
  it('is zero only when nothing failed, blocked, or leaked', () => {
    expect(computeExitCode({})).toBe(0)
    expect(computeExitCode({ failed: 1 })).toBe(1)
    expect(computeExitCode({ blocked: 1 })).toBe(1)
    expect(computeExitCode({ cleanupFailures: 1 })).toBe(1)
    expect(computeExitCode({ failed: 0, blocked: 44, cleanupFailures: 0 })).toBe(1)
  })
})

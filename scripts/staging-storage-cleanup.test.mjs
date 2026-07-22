// scripts/staging-storage-cleanup.test.mjs
//
// OFFLINE regression coverage for the staging harness's storage teardown.
//
// These tests exist because the previous implementation could report a clean run
// while leaving synthetic objects on staging. The mechanism was a chain of small
// defects, each of which is pinned here:
//
//   * cleanup ran as a farmer client, and farmers hold no permissive DELETE
//     policy on either farmer bucket — so the delete matched zero rows;
//   * Supabase Storage answers an RLS no-op with `{ data: [], error: null }`,
//     and the harness accepted `!error` as proof of deletion;
//   * only one of the four objects a healthy run creates was registered, because
//     the registry was written by assignment rather than append;
//   * the post-cleanup listing inspected one bucket, one prefix, one filename,
//     and used the client's default single page;
//   * `cleanupFailures` was derived from a property ordinary result rows never
//     carry, so storage failures could not reach the exit code.
//
// 36 synthetic objects accumulated on staging as a result. Every test below uses
// mocks only — nothing here contacts a live Supabase project.

import { describe, it, expect } from 'vitest'
import {
  registerStorageFixture,
  assertAdminCleanupClient,
  compareRequestedAndDeletedPaths,
  collectPaginatedRunObjects,
  evaluateStorageCleanup,
  computeSecurityHarnessExitCode,
  computeExitCode,
  STORAGE_CLEANUP_BUCKETS,
} from './run-staging-security-tests.mjs'

const TAG = 'security-test-1784659142065-868ac4ea'
const FARMER_A = '35e521e0-aaae-4474-b835-05f2f92ba948'
const FARMER_B = 'a920a20f-4566-4ed6-9475-503f3aadc8ba'

// A list function backed by a plain array, honouring limit/offset exactly as the
// storage client does.
const listerFor = (byPrefix) => ({ prefix, limit, offset }) => {
  const rows = (byPrefix[prefix] ?? []).map((name) => ({ name }))
  return Promise.resolve({ data: rows.slice(offset, offset + limit), error: null })
}

// ── Test 1 — silent no-op deletion ──────────────────────────────────────────
describe('Test 1 — a silent no-op delete is a cleanup failure', () => {
  it('treats { data: [], error: null } as undeleted, not as success', () => {
    const requested = [`${FARMER_A}/${TAG}.txt`]
    const cmp = compareRequestedAndDeletedPaths(requested, [])
    expect(cmp.ok).toBe(false)
    expect(cmp.deleted).toBe(0)
    expect(cmp.missing).toEqual(requested)

    const verdict = evaluateStorageCleanup({
      created: 1,
      requested: 1,
      deleted: cmp.deleted,
      missing: cmp.missing,
      residual: [{ bucket: 'farmer-documents', path: requested[0] }],
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('not reported deleted')
  })

  it('fails the process exit code', () => {
    expect(computeSecurityHarnessExitCode({ cleanupFailures: 1, storageResidue: 1 })).toBe(1)
  })
})

// ── Test 2 — partial deletion ───────────────────────────────────────────────
describe('Test 2 — a partial delete is a cleanup failure', () => {
  it('identifies exactly which paths were not deleted', () => {
    const requested = ['p/a.txt', 'p/b.txt', 'p/c.txt', 'p/d.txt']
    const cmp = compareRequestedAndDeletedPaths(
      requested,
      [{ name: 'p/a.txt' }, { name: 'p/b.txt' }, { name: 'p/c.txt' }],
    )
    expect(cmp.requested).toBe(4)
    expect(cmp.deleted).toBe(3)
    expect(cmp.missing).toEqual(['p/d.txt'])
    expect(cmp.ok).toBe(false)
  })

  it('produces a non-zero exit code', () => {
    const verdict = evaluateStorageCleanup({ created: 4, requested: 4, deleted: 3, missing: ['p/d.txt'] })
    expect(verdict.ok).toBe(false)
    expect(computeSecurityHarnessExitCode({ cleanupFailures: verdict.ok ? 0 : 1 })).toBe(1)
  })

  it('accepts plain-string rows as well as { name } rows', () => {
    expect(compareRequestedAndDeletedPaths(['x'], ['x']).ok).toBe(true)
  })
})

// ── Test 3 — explicit deletion error ────────────────────────────────────────
describe('Test 3 — an explicit Storage API error is surfaced', () => {
  it('reports the error and still evaluates the remaining buckets', () => {
    const verdict = evaluateStorageCleanup({
      created: 2,
      requested: 2,
      deleted: 1,
      missing: ['farmer-photos/x.jpg'],
      errors: ['farmer-photos: permission denied'],
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('permission denied')
    expect(verdict.reason).toContain('not reported deleted')
    expect(computeSecurityHarnessExitCode({ cleanupFailures: 1 })).toBe(1)
  })
})

// ── Test 4 — complete registry ──────────────────────────────────────────────
describe('Test 4 — every created object is registered exactly once', () => {
  it('registers all four objects a healthy run creates, without overwriting', () => {
    const reg = []
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt`, scenario: 'G own', createdBy: 'farmer A' })
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}-attrib.pdf`, scenario: 'H control', createdBy: 'farmer A' })
    registerStorageFixture(reg, { bucket: 'farmer-photos', path: `${FARMER_A}/${TAG}-attrib.jpg`, scenario: 'H control', createdBy: 'farmer A' })
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: `${FARMER_B}/${TAG}-listctl.txt`, scenario: 'H list-control', createdBy: 'farmer B' })

    expect(reg).toHaveLength(4)
    // The exact regression: assignment used to discard every earlier entry.
    expect(reg.filter((e) => e.bucket === 'farmer-documents')).toHaveLength(3)
    expect(reg.filter((e) => e.bucket === 'farmer-photos')).toHaveLength(1)
    expect(reg.every((e) => e.path.includes(TAG))).toBe(true)
    expect(reg.every((e) => e.scenario && e.createdBy)).toBe(true)
  })

  it('registers an unexpectedly successful upload from a probe expected to fail', () => {
    const reg = []
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: `${FARMER_B}/${TAG}-cross.txt`, scenario: 'cross-prefix (unexpected success)', createdBy: 'farmer A' })
    expect(reg).toHaveLength(1)
    expect(reg[0].scenario).toContain('unexpected success')
  })

  it('deduplicates, and rejects malformed entries', () => {
    const reg = []
    registerStorageFixture(reg, { bucket: 'b', path: 'p' })
    registerStorageFixture(reg, { bucket: 'b', path: 'p' })
    expect(reg).toHaveLength(1)
    expect(() => registerStorageFixture(reg, { bucket: 'b' })).toThrow(/bucket and path/)
    expect(() => registerStorageFixture(null, { bucket: 'b', path: 'p' })).toThrow(/array/)
  })
})

// ── Test 5 — pagination ─────────────────────────────────────────────────────
describe('Test 5 — the residue sweep pages past the first 100 objects', () => {
  it('finds a current-run residual that sits beyond page one', async () => {
    const names = Array.from({ length: 250 }, (_, i) => `security-test-old-${i}.txt`)
    names.push(`${TAG}-listctl.txt`) // index 250 — invisible to a single default page
    const swept = await collectPaginatedRunObjects(listerFor({ [FARMER_B]: names }), {
      bucket: 'farmer-documents', prefix: FARMER_B, tag: TAG,
    })
    expect(swept.error).toBeNull()
    expect(swept.truncated).toBe(false)
    expect(swept.pages).toBeGreaterThan(1)
    expect(swept.found).toHaveLength(1)
    expect(swept.found[0].path).toBe(`${FARMER_B}/${TAG}-listctl.txt`)

    const verdict = evaluateStorageCleanup({ created: 1, requested: 1, deleted: 1, residual: swept.found })
    expect(verdict.ok).toBe(false)
    expect(verdict.residualCount).toBe(1)
  })

  it('reports truncation rather than claiming a clean sweep', async () => {
    const never = () => Promise.resolve({ data: Array.from({ length: 100 }, (_, i) => ({ name: `${TAG}-${i}.txt` })), error: null })
    const swept = await collectPaginatedRunObjects(never, { bucket: 'b', prefix: 'p', tag: TAG, maxPages: 3 })
    expect(swept.truncated).toBe(true)
    expect(evaluateStorageCleanup({ truncated: true }).ok).toBe(false)
  })

  it('surfaces a listing error instead of reporting zero residue', async () => {
    const failing = () => Promise.resolve({ data: null, error: { message: 'boom' } })
    const swept = await collectPaginatedRunObjects(failing, { bucket: 'b', prefix: 'p', tag: TAG })
    expect(swept.error).toBeTruthy()
    expect(swept.found).toHaveLength(0)
  })
})

// ── Test 6 — residue-only run must fail ─────────────────────────────────────
describe('Test 6 — residue alone fails the run', () => {
  it('exits 1 with zero access-control failures and zero blocks', () => {
    expect(computeSecurityHarnessExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 1 })).toBe(1)
  })

  it('is reachable through the legacy computeExitCode entry point too', () => {
    expect(computeExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 1 })).toBe(1)
    expect(computeExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 0 })).toBe(0)
  })
})

// ── Test 7 — wrong cleanup identity ─────────────────────────────────────────
describe('Test 7 — cleanup refuses a non-admin identity before deleting', () => {
  it('rejects a farmer session', () => {
    const r = assertAdminCleanupClient({ client: {}, label: 'farmer A' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('must run as the DDP admin session')
    expect(r.reason).toContain('no DELETE grant')
  })

  it('rejects a missing session and an unlabelled one', () => {
    expect(assertAdminCleanupClient(null).ok).toBe(false)
    expect(assertAdminCleanupClient({ label: 'admin' }).ok).toBe(false) // no client
    expect(assertAdminCleanupClient({ client: {} }).ok).toBe(false)     // no label
  })

  it('accepts the admin session', () => {
    expect(assertAdminCleanupClient({ client: {}, label: 'admin' }).ok).toBe(true)
  })

  it('turns a misconfigured identity into a cleanup failure', () => {
    const guard = assertAdminCleanupClient({ client: {}, label: 'farmer B' })
    const verdict = evaluateStorageCleanup({ created: 1, configError: guard.reason })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('admin session')
  })
})

// ── Test 8 — both buckets ───────────────────────────────────────────────────
describe('Test 8 — cleanup and residue verification cover both farmer buckets', () => {
  it('enumerates farmer-documents and farmer-photos', () => {
    expect([...STORAGE_CLEANUP_BUCKETS]).toEqual(['farmer-documents', 'farmer-photos'])
  })

  it('detects residue that exists only in farmer-photos', async () => {
    const perBucket = {
      'farmer-documents': listerFor({ [FARMER_A]: [] }),
      'farmer-photos': listerFor({ [FARMER_A]: [`${TAG}-attrib.jpg`] }),
    }
    const residual = []
    for (const bucket of STORAGE_CLEANUP_BUCKETS) {
      const swept = await collectPaginatedRunObjects(perBucket[bucket], { bucket, prefix: FARMER_A, tag: TAG })
      residual.push(...swept.found)
    }
    expect(residual).toHaveLength(1)
    expect(residual[0].bucket).toBe('farmer-photos')
    expect(evaluateStorageCleanup({ created: 2, requested: 2, deleted: 2, residual }).ok).toBe(false)
  })
})

// ── Test 9 — historical residue isolation ───────────────────────────────────
describe('Test 9 — historical residue never fails or is deleted by the current run', () => {
  it('ignores objects carrying other run tags', async () => {
    const historical = [
      'security-test-1783898016520-090782de.txt',
      'security-test-1784548700290-04469264.txt',
      'security-test-1784491722762-57d5019f-attrib.pdf',
      'attrib-53e7d9fd.jpg',
      'focused-c8117ba6.txt',
    ]
    const swept = await collectPaginatedRunObjects(listerFor({ [FARMER_A]: historical }), {
      bucket: 'farmer-documents', prefix: FARMER_A, tag: TAG,
    })
    expect(swept.found).toHaveLength(0)

    const verdict = evaluateStorageCleanup({ created: 1, requested: 1, deleted: 1, residual: swept.found })
    expect(verdict.ok).toBe(true)
    expect(verdict.residualCount).toBe(0)
    expect(computeSecurityHarnessExitCode({ storageResidue: verdict.residualCount })).toBe(0)
  })

  it('never lists a historical object as a deletion target', () => {
    // Deletion targets come only from the run registry, which is populated at
    // upload time — historical objects can never enter it.
    const reg = []
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` })
    expect(reg.map((e) => e.path)).toEqual([`${FARMER_A}/${TAG}.txt`])
    expect(reg.some((e) => e.path.includes('1783898016520'))).toBe(false)
  })

  it('separates a current-run residual from historical neighbours', async () => {
    const mixed = ['security-test-1783898016520-090782de.txt', `${TAG}-attrib.pdf`, 'attrib-53e7d9fd.jpg']
    const swept = await collectPaginatedRunObjects(listerFor({ [FARMER_A]: mixed }), {
      bucket: 'farmer-documents', prefix: FARMER_A, tag: TAG,
    })
    expect(swept.found.map((f) => f.name)).toEqual([`${TAG}-attrib.pdf`])
  })
})

// ── Test 10 — exact deletion result ─────────────────────────────────────────
describe('Test 10 — a genuinely complete cleanup passes', () => {
  it('passes when every requested path is returned and nothing remains', async () => {
    const requested = [`${FARMER_A}/${TAG}.txt`, `${FARMER_A}/${TAG}-attrib.pdf`]
    const cmp = compareRequestedAndDeletedPaths(requested, requested.map((name) => ({ name })))
    expect(cmp.ok).toBe(true)
    expect(cmp.deleted).toBe(2)
    expect(cmp.missing).toEqual([])

    const swept = await collectPaginatedRunObjects(listerFor({ [FARMER_A]: [] }), {
      bucket: 'farmer-documents', prefix: FARMER_A, tag: TAG,
    })
    const verdict = evaluateStorageCleanup({
      created: 2, requested: cmp.requested, deleted: cmp.deleted, missing: cmp.missing, residual: swept.found,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.residualCount).toBe(0)
    expect(verdict.reason).toBe('created=2 requested=2 deleted=2 remaining=0')
    expect(computeSecurityHarnessExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 0 })).toBe(0)
  })

  it('a run that created no storage objects is trivially clean', () => {
    const verdict = evaluateStorageCleanup({ created: 0, requested: 0, deleted: 0, residual: [] })
    expect(verdict.ok).toBe(true)
    expect(compareRequestedAndDeletedPaths([], []).ok).toBe(true)
  })
})

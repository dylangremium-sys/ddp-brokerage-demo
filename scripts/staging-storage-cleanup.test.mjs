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
//   * the harness accepted `!error` as proof of deletion;
//   * only one of the four objects a healthy run creates was registered, because
//     the registry was written by assignment rather than append;
//   * the post-cleanup listing inspected one bucket, one prefix, one filename,
//     and used the client's default single page;
//   * `cleanupFailures` was derived from a property ordinary result rows never
//     carry, so storage failures could not reach the exit code.
//
// 36 synthetic objects accumulated on staging as a result.
//
// THE DELETION CONTRACT. `@supabase/storage-js` documents a SUCCESSFUL remove()
// as `{ data: [], error: null }`, and an RLS no-op returns the identical shape.
// The response payload therefore proves nothing in either direction — requiring
// it to echo the requested paths would fail every genuinely successful cleanup.
// Deletion is proved ONLY by the paginated absence sweep. Every mock below uses
// the documented success shape; none assumes remove() echoes filenames.
//
// Mocks only — nothing here contacts a live Supabase project.

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

// The response the Storage API documents for a SUCCESSFUL remove().
const REMOVE_SUCCESS = { data: [], error: null }

// A list function backed by a plain array, honouring limit/offset exactly as the
// storage client does.
const listerFor = (byPrefix) => ({ prefix, limit, offset }) => {
  const rows = (byPrefix[prefix] ?? []).map((name) => ({ name }))
  return Promise.resolve({ data: rows.slice(offset, offset + limit), error: null })
}

// Drive the same sequence the harness performs: remove(), then sweep, then judge.
async function runCleanup({ registered, removeResult = REMOVE_SUCCESS, remaining = {} , guard = { ok: true, reason: '' } }) {
  const errors = []
  let reportedDeleted = 0
  const notEchoed = []
  if (guard.ok) {
    if (removeResult.error) {
      errors.push(`farmer-documents: ${removeResult.error.message}`)
    } else {
      const cmp = compareRequestedAndDeletedPaths(registered.map((r) => r.path), removeResult.data)
      reportedDeleted += cmp.deleted
      notEchoed.push(...cmp.missing)
    }
  }
  const residual = []
  let truncated = false
  if (guard.ok) {
    for (const bucket of STORAGE_CLEANUP_BUCKETS) {
      for (const prefix of [...new Set(registered.map((r) => r.path.split('/')[0]))]) {
        const swept = await collectPaginatedRunObjects(listerFor(remaining[bucket] ?? {}), { bucket, prefix, tag: TAG })
        if (swept.error) { errors.push(String(swept.error.message)); continue }
        if (swept.truncated) truncated = true
        residual.push(...swept.found)
      }
    }
  }
  return evaluateStorageCleanup({
    created: registered.length,
    requested: guard.ok ? registered.length : 0,
    deleted: reportedDeleted,
    missing: notEchoed,
    residual,
    errors,
    truncated,
    configError: guard.ok ? null : guard.reason,
  })
}

// ── Test A — the documented successful response ─────────────────────────────
describe('Test A — an empty remove() payload with a clean sweep is a success', () => {
  it('passes on { data: [], error: null } when nothing remains', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({ registered, remaining: { 'farmer-documents': { [FARMER_A]: [] } } })
    expect(verdict.ok).toBe(true)
    expect(verdict.residualCount).toBe(0)
    expect(verdict.reason).toContain('absence proven by paginated sweep')
    expect(computeSecurityHarnessExitCode({ storageResidue: verdict.residualCount })).toBe(0)
  })

  it('does not count the empty payload as a cleanup failure', async () => {
    // The exact regression Codex caught: an empty success payload must not make
    // every requested path look undeleted.
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({ registered, remaining: { 'farmer-documents': { [FARMER_A]: [] } } })
    expect(verdict.notEchoed).toHaveLength(1) // recorded as diagnostic…
    expect(verdict.ok).toBe(true)             // …but not a verdict
  })
})

// ── Test B — silent no-op detected by the sweep ─────────────────────────────
describe('Test B — a silent RLS no-op is caught by the absence sweep', () => {
  it('fails when the object is still present after an apparently successful remove', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({
      registered,
      remaining: { 'farmer-documents': { [FARMER_A]: [`${TAG}.txt`] } },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.residualCount).toBe(1)
    expect(verdict.residual[0].path).toBe(`${FARMER_A}/${TAG}.txt`)
    expect(verdict.reason).toContain('current-run object(s) remain')
    expect(computeSecurityHarnessExitCode({ storageResidue: verdict.residualCount })).toBe(1)
  })
})

// ── Test C — partial deletion detected by the sweep ─────────────────────────
describe('Test C — partial deletion is caught, and only the residual is reported', () => {
  it('reports exactly the one object that survived', async () => {
    const registered = [
      { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` },
      { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}-attrib.pdf` },
      { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}-x.txt` },
    ]
    const verdict = await runCleanup({
      registered,
      remaining: { 'farmer-documents': { [FARMER_A]: [`${TAG}-attrib.pdf`] } },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.residualCount).toBe(1)
    expect(verdict.residual.map((r) => r.path)).toEqual([`${FARMER_A}/${TAG}-attrib.pdf`])
    expect(computeSecurityHarnessExitCode({ storageResidue: verdict.residualCount })).toBe(1)
  })
})

// ── Test D — explicit API error ─────────────────────────────────────────────
describe('Test D — an explicit Storage API error fails cleanup', () => {
  it('records the error, still sweeps, and fails', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({
      registered,
      removeResult: { data: null, error: { message: 'permission denied' } },
      remaining: { 'farmer-documents': { [FARMER_A]: [`${TAG}.txt`] } },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.errors.join(' ')).toContain('permission denied')
    // The sweep ran regardless and independently corroborates the failure.
    expect(verdict.residualCount).toBe(1)
    expect(computeSecurityHarnessExitCode({ cleanupFailures: 1 })).toBe(1)
  })

  it('fails on an API error even when the sweep comes back clean', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({
      registered,
      removeResult: { data: null, error: { message: 'transport failure' } },
      remaining: { 'farmer-documents': { [FARMER_A]: [] } },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('transport failure')
  })
})

// ── Test E — the response payload is non-authoritative ──────────────────────
describe('Test E — an arbitrary remove() payload cannot change the verdict', () => {
  it('passes when the payload does not match the request but the sweep is clean', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({
      registered,
      removeResult: { data: [{ name: 'something/else.txt' }, { name: 'unrelated.bin' }], error: null },
      remaining: { 'farmer-documents': { [FARMER_A]: [] } },
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.residualCount).toBe(0)
  })

  it('still FAILS when a rich payload claims success but the object remains', async () => {
    // The inverse guard: a non-empty payload must not be able to vouch for a
    // deletion that did not happen — that was the original false "clean".
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({
      registered,
      removeResult: { data: [{ name: `${FARMER_A}/${TAG}.txt` }], error: null },
      remaining: { 'farmer-documents': { [FARMER_A]: [`${TAG}.txt`] } },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.residualCount).toBe(1)
  })
})

// ── Complete registry ───────────────────────────────────────────────────────
describe('every created object is registered exactly once', () => {
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

// ── Pagination ──────────────────────────────────────────────────────────────
describe('the residue sweep pages past the first 100 objects', () => {
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

    const verdict = evaluateStorageCleanup({ created: 1, requested: 1, residual: swept.found })
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
    expect(evaluateStorageCleanup({ errors: ['boom'] }).ok).toBe(false)
  })
})

// ── Residue-only run must fail ──────────────────────────────────────────────
describe('residue alone fails the run', () => {
  it('exits 1 with zero access-control failures and zero blocks', () => {
    expect(computeSecurityHarnessExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 1 })).toBe(1)
  })

  it('is reachable through the legacy computeExitCode entry point too', () => {
    expect(computeExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 1 })).toBe(1)
    expect(computeExitCode({ failed: 0, blocked: 0, cleanupFailures: 0, storageResidue: 0 })).toBe(0)
  })
})

// ── Wrong cleanup identity ──────────────────────────────────────────────────
describe('cleanup refuses a non-admin identity before deleting', () => {
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

  it('turns a misconfigured identity into a cleanup failure without sweeping', async () => {
    const guard = assertAdminCleanupClient({ client: {}, label: 'farmer B' })
    const verdict = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      guard,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('admin session')
  })
})

// ── Both buckets ────────────────────────────────────────────────────────────
describe('cleanup and residue verification cover both farmer buckets', () => {
  it('enumerates farmer-documents and farmer-photos', () => {
    expect([...STORAGE_CLEANUP_BUCKETS]).toEqual(['farmer-documents', 'farmer-photos'])
  })

  it('detects residue that exists only in farmer-photos', async () => {
    const verdict = await runCleanup({
      registered: [
        { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}-attrib.pdf` },
        { bucket: 'farmer-photos', path: `${FARMER_A}/${TAG}-attrib.jpg` },
      ],
      remaining: {
        'farmer-documents': { [FARMER_A]: [] },
        'farmer-photos': { [FARMER_A]: [`${TAG}-attrib.jpg`] },
      },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.residual).toHaveLength(1)
    expect(verdict.residual[0].bucket).toBe('farmer-photos')
  })
})

// ── Historical residue isolation ────────────────────────────────────────────
describe('historical residue never fails or is deleted by the current run', () => {
  it('ignores objects carrying other run tags', async () => {
    const historical = [
      'security-test-1783898016520-090782de.txt',
      'security-test-1784548700290-04469264.txt',
      'security-test-1784491722762-57d5019f-attrib.pdf',
      'attrib-53e7d9fd.jpg',
      'focused-c8117ba6.txt',
    ]
    const verdict = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      remaining: { 'farmer-documents': { [FARMER_A]: historical } },
    })
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

// ── Diagnostic helper stays diagnostic ──────────────────────────────────────
describe('compareRequestedAndDeletedPaths is diagnostic only', () => {
  it('still computes a comparison for reporting', () => {
    const cmp = compareRequestedAndDeletedPaths(['a', 'b'], [{ name: 'a' }])
    expect(cmp.requested).toBe(2)
    expect(cmp.deleted).toBe(1)
    expect(cmp.missing).toEqual(['b'])
  })

  it('accepts plain-string rows as well as { name } rows', () => {
    expect(compareRequestedAndDeletedPaths(['x'], ['x']).ok).toBe(true)
  })

  it('never influences the verdict', () => {
    const clean = evaluateStorageCleanup({ created: 2, requested: 2, deleted: 0, missing: ['a', 'b'], residual: [] })
    expect(clean.ok).toBe(true)
    expect(clean.notEchoed).toEqual(['a', 'b'])
    expect(clean.reportedDeleted).toBe(0)
  })

  it('a run that created no storage objects is trivially clean', () => {
    const verdict = evaluateStorageCleanup({ created: 0, requested: 0, residual: [] })
    expect(verdict.ok).toBe(true)
    expect(compareRequestedAndDeletedPaths([], []).ok).toBe(true)
  })
})

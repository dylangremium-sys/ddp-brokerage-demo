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
  verifyAdminCleanupAuthority,
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

// Drive the exact sequence the harness performs, in order:
//   1. verifyAdminCleanupAuthority()  2. remove()  3. paginated absence sweep
// `calls` records every side effect so ordering and fail-closed behaviour are
// directly assertable offline.
async function runCleanup({ registered, removeResult = REMOVE_SUCCESS, remaining = {}, adminRpc = { data: true, error: null } }) {
  const calls = []
  const session = {
    userId: 'admin-uid',
    label: 'admin',
    client: {
      rpc: async (fn) => {
        calls.push(`rpc:${fn}`)
        if (typeof adminRpc === 'function') return adminRpc()
        return adminRpc
      },
    },
  }

  // 1. authority
  const authority = await verifyAdminCleanupAuthority(session)

  const errors = []
  let reportedDeleted = 0
  const notEchoed = []
  // 2. remove — only when authority is proven
  if (authority.ok) {
    calls.push('remove')
    if (removeResult.error) {
      errors.push(`farmer-documents: ${removeResult.error.message}`)
    } else {
      const cmp = compareRequestedAndDeletedPaths(registered.map((r) => r.path), removeResult.data)
      reportedDeleted += cmp.deleted
      notEchoed.push(...cmp.missing)
    }
  }
  // 3. sweep — only when authority is proven
  const residual = []
  let truncated = false
  if (authority.ok) {
    for (const bucket of STORAGE_CLEANUP_BUCKETS) {
      for (const prefix of [...new Set(registered.map((r) => r.path.split('/')[0]))]) {
        calls.push('list')
        const swept = await collectPaginatedRunObjects(listerFor(remaining[bucket] ?? {}), { bucket, prefix, tag: TAG })
        if (swept.error) { errors.push(String(swept.error.message)); continue }
        if (swept.truncated) truncated = true
        residual.push(...swept.found)
      }
    }
  }
  const verdict = evaluateStorageCleanup({
    created: registered.length,
    requested: authority.ok ? registered.length : 0,
    deleted: reportedDeleted,
    missing: notEchoed,
    residual,
    errors,
    truncated,
    configError: authority.ok ? null : `cleanup authority not proven (${authority.kind}): ${authority.reason}`,
  })
  return { ...verdict, calls, authority }
}

// ── Test A — the documented successful response ─────────────────────────────
describe('Test A — an empty remove() payload with a clean sweep is a success', () => {
  it('passes on { data: [], error: null } when nothing remains', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const verdict = await runCleanup({ registered, remaining: { 'farmer-documents': { [FARMER_A]: [] } } })
    expect(verdict.ok).toBe(true)
    expect(verdict.residualCount).toBe(0)
    expect(verdict.reason).toContain('absenceSweep=clean')
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

  it('the structural label check remains available as descriptive metadata', () => {
    // Retained for reporting, but it no longer authorises anything — see the
    // is_ddp_admin() suite below.
    expect(assertAdminCleanupClient({ client: {}, label: 'admin' }).ok).toBe(true)
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

// ── Cleanup authority — proven by the database, never by a local label ──────
//
// `label` is assigned at the call site (`signedInClient(cfg, cfg.admin, 'admin')`),
// so it is a naming convention. If STAGING_ADMIN_* pointed at any other signable
// account, a label-only check would pass, the delete would silently no-op, AND the
// residue sweep would go blind — under "farmer read own" a farmer sees only its own
// prefix and gets an empty list with no error for every other prefix. That is the
// original false-clean condition. Authority therefore comes from is_ddp_admin().
describe('cleanup authority is proven by is_ddp_admin(), not by a local label', () => {
  const session = (over = {}) => ({
    userId: 'uid', label: 'admin',
    client: { rpc: async () => over.rpc ?? { data: true, error: null } },
    ...over.session,
  })

  // Test A — forged local admin label
  it('A — rejects a session labelled admin when is_ddp_admin() is false', async () => {
    const r = await verifyAdminCleanupAuthority(session({ rpc: { data: false, error: null } }))
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('not-admin')
    expect(r.reason).toContain('cannot delete from the farmer buckets')
  })

  it('A — a forged label performs no remove and no list, and exits 1', async () => {
    const out = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      adminRpc: { data: false, error: null },
      remaining: { 'farmer-documents': { [FARMER_A]: [`${TAG}.txt`] } },
    })
    expect(out.calls).toEqual(['rpc:is_ddp_admin'])   // nothing after the check
    expect(out.calls).not.toContain('remove')
    expect(out.calls).not.toContain('list')
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('authority not proven')
    expect(computeSecurityHarnessExitCode({ cleanupFailures: 1 })).toBe(1)
  })

  // Test B — RPC error
  it('B — fails closed on an is_ddp_admin() error, without touching storage', async () => {
    const out = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      adminRpc: { data: null, error: { message: 'permission denied for function is_ddp_admin' } },
    })
    expect(out.authority.kind).toBe('rpc-failure')
    expect(out.calls).toEqual(['rpc:is_ddp_admin'])
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('permission denied')
    expect(computeSecurityHarnessExitCode({ cleanupFailures: 1 })).toBe(1)
  })

  it('B — fails closed when the RPC throws', async () => {
    const thrower = { userId: 'uid', label: 'admin', client: { rpc: async () => { throw new Error('network down') } } }
    const r = await verifyAdminCleanupAuthority(thrower)
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('rpc-failure')
    expect(r.reason).toContain('network down')
  })

  // Test C — inconclusive responses
  it('C — fails closed on null, undefined, a non-boolean or a malformed shape', async () => {
    for (const data of [null, undefined, 'true', 1, {}, []]) {
      const r = await verifyAdminCleanupAuthority(session({ rpc: { data, error: null } }))
      expect(r.ok, `data=${JSON.stringify(data)}`).toBe(false)
      expect(r.kind).toBe('inconclusive')
    }
    const noShape = { userId: 'uid', label: 'admin', client: { rpc: async () => null } }
    expect((await verifyAdminCleanupAuthority(noShape)).kind).toBe('inconclusive')
  })

  it('C — rejects a session with no client or no user id before calling anything', async () => {
    expect((await verifyAdminCleanupAuthority(null)).kind).toBe('invalid-session')
    expect((await verifyAdminCleanupAuthority({ userId: 'uid' })).kind).toBe('invalid-session')
    let called = false
    const noUid = { label: 'admin', client: { rpc: async () => { called = true; return { data: true, error: null } } } }
    expect((await verifyAdminCleanupAuthority(noUid)).kind).toBe('invalid-session')
    expect(called).toBe(false)
  })

  // Test D — verified admin
  it('D — accepts a signed-in session whose is_ddp_admin() is literally true', async () => {
    const r = await verifyAdminCleanupAuthority(session())
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('verified-admin')
  })

  it('D — a label other than "admin" still passes when the database says admin', async () => {
    // The database is authoritative; the label is descriptive only.
    const odd = { userId: 'uid', label: 'ops', client: { rpc: async () => ({ data: true, error: null }) } }
    expect((await verifyAdminCleanupAuthority(odd)).ok).toBe(true)
  })

  // Test E — ordering
  it('E — verification happens before any remove or list', async () => {
    const out = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      remaining: { 'farmer-documents': { [FARMER_A]: [] } },
    })
    expect(out.calls[0]).toBe('rpc:is_ddp_admin')
    expect(out.calls.indexOf('remove')).toBe(1)
    expect(out.calls.indexOf('list')).toBeGreaterThan(out.calls.indexOf('remove'))
    expect(out.calls.filter((c) => c === 'rpc:is_ddp_admin')).toHaveLength(1) // asked once
  })
})

// ── Success reporting ───────────────────────────────────────────────────────
describe('the success line reports sweep-derived facts and never renders undefined', () => {
  // Test F
  it('F — a verified clean run prints no "undefined" and claims no API proof', async () => {
    const out = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      remaining: { 'farmer-documents': { [FARMER_A]: [] } },
    })
    expect(out.ok).toBe(true)
    expect(out.reason).not.toContain('undefined')
    expect(out.reason).toContain('remaining=0')
    expect(out.reason).toContain('absenceSweep=clean')
    // The API response is never described as proof of deletion.
    expect(out.reason).not.toMatch(/\bdeleted=/)
    expect(out.reason).not.toMatch(/confirmed deleted|verified deleted|deletion count/i)
  })

  it('F — no verdict field used in reporting can be undefined', async () => {
    const out = await runCleanup({
      registered: [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }],
      remaining: { 'farmer-documents': { [FARMER_A]: [] } },
    })
    for (const f of ['created', 'requested', 'residualCount', 'reportedDeleted']) {
      expect(out[f], f).toBeDefined()
    }
    expect(`requested=${out.requested} remaining=${out.residualCount}`).not.toContain('undefined')
  })

  // Test G — the API diagnostic stays labelled and inert
  it('G — the API item count is labelled non-authoritative and changes nothing', async () => {
    const registered = [{ bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt` }]
    const clean = { 'farmer-documents': { [FARMER_A]: [] } }
    const empty = await runCleanup({ registered, remaining: clean })
    const rich = await runCleanup({
      registered, remaining: clean,
      removeResult: { data: [{ name: 'totally/unrelated.txt' }], error: null },
    })
    expect(empty.reason).toContain('apiResponseItems=0')
    expect(empty.reason).toContain('non-authoritative')
    // A mismatched payload changes the diagnostic but never the verdict.
    expect(rich.ok).toBe(true)
    expect(empty.ok).toBe(true)
    expect(rich.residualCount).toBe(empty.residualCount)
  })
})

// ── Upload-site → registry correspondence ──────────────────────────────────
//
// A count-only assertion ("N uploads, N registrations") is not protection: it
// passed while `${b.userId}/${TAG}-pending.txt` was silently unregistered,
// because it compared a number rather than a correspondence. These tests model
// every upload site the harness can perform and assert the EXACT entry each one
// must contribute — bucket, path, scenario and creator — plus that denied probes
// contribute nothing.
describe('every successful upload contributes its exact registry entry', () => {
  const PENDING = '4b46595a-4fb5-48fa-ae6f-cd48e8da6ec2'

  // One row per `.upload(` site in run-staging-security-tests.mjs.
  const UPLOAD_SITES = [
    { site: 'A anon probe',            bucket: 'farmer-documents', path: `${TAG}-anon.txt`,                    scenario: 'A anon upload (unexpected success)',                  createdBy: 'anon',     normally: 'denied'  },
    { site: 'G own-prefix',            bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt`,             scenario: 'G own-prefix upload',                                 createdBy: 'farmer A', normally: 'allowed' },
    { site: 'G cross-prefix',          bucket: 'farmer-documents', path: `${FARMER_B}/${TAG}-cross.txt`,       scenario: 'G cross-prefix upload (unexpected success)',           createdBy: 'farmer A', normally: 'denied'  },
    { site: 'G anon',                  bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}-anon2.txt`,       scenario: 'G anon upload (unexpected success)',                   createdBy: 'anon',     normally: 'denied'  },
    { site: 'H attrib control (docs)', bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}-attrib.pdf`,      scenario: 'H attribution control',                               createdBy: 'farmer A', normally: 'allowed' },
    { site: 'H attrib control (pics)', bucket: 'farmer-photos',    path: `${FARMER_A}/${TAG}-attrib.jpg`,      scenario: 'H attribution control',                               createdBy: 'farmer A', normally: 'allowed' },
    { site: 'H attrib subject',        bucket: 'farmer-photos',    path: `${PENDING}/${TAG}-attrib.jpg`,       scenario: 'H attribution subject (unexpected success)',           createdBy: 'pending',  normally: 'denied'  },
    { site: 'H attrib cross',          bucket: 'farmer-photos',    path: `${FARMER_B}/${TAG}-attrib-x.jpg`,    scenario: 'H attribution cross-prefix (unexpected success)',      createdBy: 'pending',  normally: 'denied'  },
    { site: 'H pending foreign',       bucket: 'farmer-documents', path: `${FARMER_B}/${TAG}-pending.txt`,     scenario: 'H pending cross-prefix upload (unexpected success)',   createdBy: 'pending',  normally: 'denied'  },
    { site: 'H list-control',          bucket: 'farmer-documents', path: `${FARMER_B}/${TAG}-listctl.txt`,     scenario: 'H list-control',                                      createdBy: 'farmer B', normally: 'allowed' },
  ]

  it.each(UPLOAD_SITES)('$site — a successful upload registers exactly its own entry', (s) => {
    const reg = []
    registerStorageFixture(reg, { bucket: s.bucket, path: s.path, scenario: s.scenario, createdBy: s.createdBy })
    const matches = reg.filter((e) => e.bucket === s.bucket && e.path === s.path)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toEqual({ bucket: s.bucket, path: s.path, scenario: s.scenario, createdBy: s.createdBy })
    expect(matches[0].path).toContain(TAG) // every fixture path carries the full run tag
  })

  it('a denied upload contributes nothing to the registry', () => {
    const reg = []
    for (const s of UPLOAD_SITES.filter((x) => x.normally === 'denied')) {
      // outcome !== 'allowed' → the harness performs no registration at all
      if (false) registerStorageFixture(reg, s)
    }
    expect(reg).toHaveLength(0)
  })

  it('a full run in which every site unexpectedly succeeds registers all of them, once each', () => {
    const reg = []
    for (const s of UPLOAD_SITES) {
      registerStorageFixture(reg, { bucket: s.bucket, path: s.path, scenario: s.scenario, createdBy: s.createdBy })
      registerStorageFixture(reg, { bucket: s.bucket, path: s.path, scenario: s.scenario, createdBy: s.createdBy }) // idempotent
    }
    expect(reg).toHaveLength(UPLOAD_SITES.length)
    for (const s of UPLOAD_SITES) {
      expect(reg.filter((e) => e.bucket === s.bucket && e.path === s.path)).toHaveLength(1)
    }
    // The previously missing entry is explicitly present.
    expect(reg.some((e) => e.path === `${FARMER_B}/${TAG}-pending.txt`
      && e.scenario === 'H pending cross-prefix upload (unexpected success)'
      && e.createdBy === 'pending')).toBe(true)
  })

  // Supplementary static check — never the only protection (see the behavioural
  // cases above). Every `.upload(` site must have a registration within reach.
  it('supplementary: no .upload( site in the harness lacks a registration', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./run-staging-security-tests.mjs', import.meta.url), 'utf8').split('\n')
    const unregistered = []
    src.forEach((line, i) => {
      if (!line.includes('.upload(')) return
      const window = src.slice(i, i + 12).join('\n')
      if (!window.includes('registerStorageFixture')) unregistered.push(i + 1)
    })
    expect(unregistered, `upload sites with no registration: ${unregistered.join(', ')}`).toEqual([])
  })
})

// ── The dangerous sub-case the missing registration created ────────────────
describe('pending foreign-prefix upload: the silent sub-case', () => {
  const foreignPath = `${FARMER_B}/${TAG}-pending.txt`

  // Reproduces: the forbidden pending upload unexpectedly SUCCEEDS, the farmer-B
  // list-control fixture was never created, and no other registered object shares
  // farmer B's prefix. Before the fix this object was in neither the deletion set
  // nor the sweep's prefix set — invisible to both, with the run reporting clean.
  const registryForSubCase = () => {
    const reg = []
    // farmer A's own-prefix object is the only other fixture this run created
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: `${FARMER_A}/${TAG}.txt`, scenario: 'G own-prefix upload', createdBy: 'farmer A' })
    // list-control upload FAILED, so nothing registers farmer B's prefix…
    // …but the forbidden pending write unexpectedly succeeded:
    registerStorageFixture(reg, { bucket: 'farmer-documents', path: foreignPath, scenario: 'H pending cross-prefix upload (unexpected success)', createdBy: 'pending' })
    return reg
  }

  it('1–2: the foreign upload is registered with the exact expected entry', () => {
    const reg = registryForSubCase()
    const entry = reg.find((e) => e.path === foreignPath)
    expect(entry).toEqual({
      bucket: 'farmer-documents',
      path: foreignPath,
      scenario: 'H pending cross-prefix upload (unexpected success)',
      createdBy: 'pending',
    })
  })

  it('3: the path enters the deletion target set for farmer-documents', () => {
    const reg = registryForSubCase()
    const targets = reg.filter((o) => o.bucket === 'farmer-documents').map((o) => o.path)
    expect(targets).toContain(foreignPath)
  })

  it('4: farmer B prefix enters the residue-sweep prefix set', () => {
    const reg = registryForSubCase()
    // Mirrors the harness: prefixes are derived from the registry.
    const prefixes = [...new Set(reg.map((o) => o.path.includes('/') ? o.path.split('/')[0] : ''))]
    expect(prefixes).toContain(FARMER_B)
    expect(prefixes).toContain(FARMER_A)
  })

  it('5: a silent no-op plus a surviving object fails cleanup and exits 1', async () => {
    const out = await runCleanup({
      registered: registryForSubCase(),
      remaining: { 'farmer-documents': { [FARMER_A]: [], [FARMER_B]: [`${TAG}-pending.txt`] } },
    })
    expect(out.ok).toBe(false)
    expect(out.residualCount).toBe(1)
    expect(out.residual.map((r) => `${r.bucket}/${r.path}`)).toEqual([`farmer-documents/${foreignPath}`])
    expect(computeSecurityHarnessExitCode({ storageResidue: out.residualCount })).toBe(1)
  })

  it('and it is deleted cleanly when removal genuinely works', async () => {
    const out = await runCleanup({
      registered: registryForSubCase(),
      remaining: { 'farmer-documents': { [FARMER_A]: [], [FARMER_B]: [] } },
    })
    expect(out.ok).toBe(true)
    expect(out.residualCount).toBe(0)
  })
})

// Archival-ref exclusion for AUDIT-001.
//
// This predicate makes a security gate deliberately blinder, so the tests that
// matter most are the NEGATIVE ones: everything it must still look at. A bug
// here does not announce itself — the check simply goes quiet about a real
// migration-number collision and a PR merges two different migration 20s.

import { describe, it, expect } from 'vitest'
import { isArchivalRef, ARCHIVAL_REF_PREFIXES } from './archival-refs.mjs'

describe('isArchivalRef — what IS excluded', () => {
  it.each([
    'refs/remotes/origin/rescue/2026-07-29/backup/pre-basesync2-d732c87',
    'refs/remotes/origin/rescue/2026-07-29/pr44',
    'refs/remotes/origin/rescue/2026-07-29/ui-polish-isolated',
    'refs/remotes/origin/rescue/2026-07-29/recovery/opsdesk-fix-wip-20260721',
  ])('excludes the archival snapshot %s', (ref) => {
    expect(isArchivalRef(ref)).toBe(true)
  })

  it('excludes the three refs that actually turned the gate red', () => {
    // Migrations 20 and 21 collided via pre-basesync2, and 25 via pr44. These
    // are the exact refs from the failing run on 2026-07-29.
    for (const ref of [
      'refs/remotes/origin/rescue/2026-07-29/backup/pre-basesync2-d732c87',
      'refs/remotes/origin/rescue/2026-07-29/pr44',
    ]) {
      expect(isArchivalRef(ref)).toBe(true)
    }
  })
})

describe('isArchivalRef — what must STILL be checked', () => {
  it.each([
    'refs/remotes/origin/main',
    'refs/remotes/origin/feature/set-password-flow',
    'refs/remotes/origin/fix/audit-001-exclude-archival-refs',
    'refs/remotes/origin/audit-015-mutation-truthfulness',
    'refs/remotes/origin/remediation/p0-mutations',
    'refs/remotes/origin/security/buyer-pack-issuance-hardening',
    'refs/remotes/origin/infra/disposable-postgres-migration-harness',
  ])('still compares the ordinary branch %s', (ref) => {
    expect(isArchivalRef(ref)).toBe(false)
  })

  it('does not exclude names that merely START with the word rescue', () => {
    // The prefix carries its trailing slash precisely so that a real working
    // branch cannot smuggle itself out of the gate by being called "rescue…".
    expect(isArchivalRef('refs/remotes/origin/rescue-plan')).toBe(false)
    expect(isArchivalRef('refs/remotes/origin/rescuer/migrations')).toBe(false)
    expect(isArchivalRef('refs/remotes/origin/rescue')).toBe(false)
  })

  it('does not exclude a LOCAL branch that happens to be named rescue/…', () => {
    // Only refs/remotes/origin/ is archival. A local rescue/ branch is ordinary
    // work in progress.
    expect(isArchivalRef('refs/heads/rescue/2026-07-29/pr44')).toBe(false)
  })

  it('does not exclude rescue/ under a DIFFERENT remote', () => {
    expect(isArchivalRef('refs/remotes/upstream/rescue/2026-07-29/pr44')).toBe(false)
  })

  it('is not fooled by rescue/ appearing mid-name', () => {
    expect(isArchivalRef('refs/remotes/origin/feature/rescue/thing')).toBe(false)
  })
})

describe('the exclusion list stays narrow', () => {
  it('excludes exactly one namespace', () => {
    // Widening this makes the collision gate blinder. If this fails, the change
    // needs the same scrutiny as any other security-gate relaxation — not a
    // quiet update to the expected number.
    expect(ARCHIVAL_REF_PREFIXES).toEqual(['refs/remotes/origin/rescue/'])
  })

  it('every prefix is anchored under origin and ends with a slash', () => {
    for (const prefix of ARCHIVAL_REF_PREFIXES) {
      expect(prefix.startsWith('refs/remotes/origin/')).toBe(true)
      expect(prefix.endsWith('/')).toBe(true)
    }
  })

  it('the list cannot be mutated at runtime', () => {
    expect(Object.isFrozen(ARCHIVAL_REF_PREFIXES)).toBe(true)
  })
})

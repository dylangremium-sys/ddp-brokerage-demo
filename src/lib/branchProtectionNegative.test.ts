import { describe, expect, it } from 'vitest'

// ─── TEMPORARY — BRANCH-PROTECTION NEGATIVE TEST ─────────────────────────────
//
// This file exists to FAIL, on purpose, exactly once.
//
// Branch protection on `main` has been read-back verified and has been observed
// to permit compliant merges (PRs #9, #10, #11 all went through the required
// check). What has never been proven is the inverse: that a red build is actually
// BLOCKED, including for the sole administrator, and that Vercel creates no
// Production deployment for it.
//
// A control you have only ever seen say "yes" is not a proven control. This test
// makes CI say "no", so the gate can be observed refusing.
//
// This branch must NEVER be merged. It is deleted as soon as the evidence is
// captured. If you are reading this on `main`, something has gone very wrong.

describe('branch protection negative test', () => {
  it('fails deliberately to prove CI blocks merge', () => {
    expect('blocked').toBe('mergeable')
  })
})

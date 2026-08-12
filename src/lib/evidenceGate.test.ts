import { describe, expect, it } from 'vitest'
import { isSubstantiveReason, resolveEvidenceGate } from './evidenceGate'
import { reviewerLabel, reviewerRole } from './reviewerDirectory'

/**
 * The reason floor here must agree with migration 66's
 * `evidence_reason_is_substantive`, which is the enforcement. These cases are
 * the same ones asserted in 66_EVIDENCE_DECISION_GATE_VERIFY.sql, on purpose:
 * if the two drift, one of the two files fails.
 */
describe('isSubstantiveReason mirrors the database predicate', () => {
  it('refuses nine characters and accepts ten', () => {
    expect(isSubstantiveReason('123456789')).toBe(false)
    expect(isSubstantiveReason('1234567890')).toBe(true)
  })

  it('trims before measuring', () => {
    expect(isSubstantiveReason('   1234567890   ')).toBe(true)
    expect(isSubstantiveReason('          ')).toBe(false)
  })

  it('refuses one character repeated, which a length test alone admits', () => {
    expect(isSubstantiveReason('aaaaaaaaaaaaaaa')).toBe(false)
    expect(isSubstantiveReason('..............')).toBe(false)
  })

  it('refuses null and undefined rather than throwing', () => {
    expect(isSubstantiveReason(null)).toBe(false)
    expect(isSubstantiveReason(undefined)).toBe(false)
  })

  it('accepts a real sentence', () => {
    expect(isSubstantiveReason('Cannabinoid figures match the batch record.')).toBe(true)
  })
})

describe('the gate names one missing condition at a time', () => {
  const base = { hasStoredFile: true, opened: true, reason: 'Figures match the batch record.', recording: false }

  it('asks for the document first, however good the reason', () => {
    const gate = resolveEvidenceGate({ ...base, opened: false })
    expect(gate.allowed).toBe(false)
    expect(gate.note).toMatch(/open and read the document/i)
  })

  it('asks for a reason once the document is open', () => {
    const gate = resolveEvidenceGate({ ...base, reason: 'ok' })
    expect(gate.allowed).toBe(false)
    expect(gate.note).toMatch(/more than nine characters/i)
  })

  it('states what the record will contain when it is ready', () => {
    const gate = resolveEvidenceGate(base)
    expect(gate.allowed).toBe(true)
    expect(gate.note).toMatch(/permanent record/i)
    expect(gate.note).toMatch(/fingerprint/i)
  })

  it('does not impose a read condition on an entry with no file', () => {
    const gate = resolveEvidenceGate({ ...base, hasStoredFile: false, opened: false })
    expect(gate.allowed).toBe(true)
    expect(gate.note).toMatch(/no stored file/i)
  })
})

describe('a reviewer is never labelled with an identifier', () => {
  // The live screen renders `adminNames?.get(id) ?? id`, and App passes no map,
  // so every reviewer is a bare UUID today. reviewerLabel cannot do that: there
  // is no code path that returns the id.
  const id = 'ceaa9ccd-ab02-4403-a3c6-7103caf191d7'
  const directory = new Map([[id, { id, name: 'Nattaya S.', role: 'ddp_admin' }]])

  it('uses the name when it is known', () => {
    expect(reviewerLabel(id, directory)).toBe('Nattaya S.')
    expect(reviewerRole(id, directory)).toBe('DDP administrator')
  })

  it('says so in words when the directory is empty — never the UUID', () => {
    expect(reviewerLabel(id, new Map())).not.toContain(id)
    expect(reviewerLabel(id, new Map())).toMatch(/not on file/i)
    expect(reviewerLabel(id, null)).not.toContain(id)
  })

  it('distinguishes an unattributed decision from an unnamed reviewer', () => {
    expect(reviewerLabel(null, directory)).toMatch(/unrecorded/i)
  })

  it('falls back to the email when a profile has no display name', () => {
    const byEmail = new Map([[id, { id, name: 'owner@ddpbrokerage.com', role: 'ddp_admin' }]])
    expect(reviewerLabel(id, byEmail)).toBe('owner@ddpbrokerage.com')
  })
})

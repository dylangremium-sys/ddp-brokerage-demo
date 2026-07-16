import { describe, it, expect } from 'vitest'
import {
  deriveBuyerPackReleaseEligibility,
  prepareBuyerPackSnapshotInput,
  buyerPackApprovalId,
  type BuyerPackSnapshotEvidenceInput,
} from './buyerPackSnapshot'
import type { InventoryItem } from '../types'

// PR-2 — Buyer Pack print gate and print safety.
//
// The defect: handlePrint() called window.print() with no gate at all, while
// Issue was gated. An operator could print a pack that issuance refused and hand
// it to a buyer, and the on-screen sentence forbidding exactly that was stripped
// from the artifact by `.no-print`. Printing a pack and issuing a pack put it in
// front of a buyer identically, so they must answer to one predicate.
//
// These tests pin the PREDICATE and the PARITY, not the wording. A test that
// only asserted `handlePrint` mentions "approved" would pass against a print-only
// lookalike check — the exact failure this PR exists to prevent.

const ITEM = { id: 'batch-1' } as unknown as InventoryItem

function evidence(over: Partial<BuyerPackSnapshotEvidenceInput> = {}): BuyerPackSnapshotEvidenceInput {
  return {
    packId: 'batch-1',
    generatedBy: 'Jane Reviewer',
    approvedBy: 'Jane Reviewer',
    isHumanApproved: true,
    storedDecision: { decision: 'progress', decidedAt: '2026-07-16T09:00:00.000Z' },
    inventory: ITEM,
    coas: { hasCoaFile: false, certFileName: null, coaStoragePath: null },
    complianceSummary: { tier: 'CULTIVATOR_CLAIMED' },
    documentChecks: [],
    risks: [],
    evidenceSummary: [],
    ...over,
  }
}

// The exhaustive set of ways a release may be refused. Each must refuse BOTH
// paths — that is what "parity" means here.
const REFUSALS: Array<{ name: string; over: Partial<BuyerPackSnapshotEvidenceInput> }> = [
  { name: 'not human-approved', over: { isHumanApproved: false } },
  { name: 'no recorded decision', over: { storedDecision: null } },
  { name: 'decision is not "progress"', over: { storedDecision: { decision: 'hold', decidedAt: '2026-07-16T09:00:00.000Z' } } },
  { name: 'approver identity is empty', over: { approvedBy: '' } },
  { name: 'approver identity is whitespace', over: { approvedBy: '   ' } },
]

describe('buyer pack release gate — the shared predicate', () => {
  it('permits release only when every issue prerequisite is met', () => {
    const e = evidence()
    const gate = deriveBuyerPackReleaseEligibility({
      isHumanApproved: e.isHumanApproved, storedDecision: e.storedDecision, approvedBy: e.approvedBy,
    })
    expect(gate.eligible).toBe(true)
  })

  for (const { name, over } of REFUSALS) {
    it(`refuses release when ${name}`, () => {
      const e = evidence(over)
      const gate = deriveBuyerPackReleaseEligibility({
        isHumanApproved: e.isHumanApproved, storedDecision: e.storedDecision, approvedBy: e.approvedBy,
      })
      expect(gate.eligible).toBe(false)
      expect(gate.eligible === false && gate.reason.length).toBeGreaterThan(0)
    })
  }

  it('returns the validated decision so callers never re-assert it', () => {
    const gate = deriveBuyerPackReleaseEligibility({
      isHumanApproved: true,
      storedDecision: { decision: 'progress', decidedAt: '2026-07-16T09:00:00.000Z' },
      approvedBy: 'Jane Reviewer',
    })
    expect(gate.eligible === true && gate.approvalDecision.decision).toBe('progress')
  })
})

describe('print/issue parity — one act, one predicate', () => {
  // The load-bearing test. For EVERY refusal, the print gate and the issue gate
  // must agree, with the same reason. If someone gives print a weaker condition,
  // this fails.
  for (const { name, over } of REFUSALS) {
    it(`print and issue refuse identically, with the same reason: ${name}`, () => {
      const e = evidence(over)
      const printGate = deriveBuyerPackReleaseEligibility({
        isHumanApproved: e.isHumanApproved, storedDecision: e.storedDecision, approvedBy: e.approvedBy,
      })
      const issueGate = prepareBuyerPackSnapshotInput(e)

      expect(printGate.eligible).toBe(false)
      expect(issueGate.eligible).toBe(false)
      // Same refusal, same words — one legal act cannot have two vocabularies.
      expect(printGate.eligible === false && printGate.reason)
        .toBe(issueGate.eligible === false && issueGate.reason)
    })
  }

  it('print and issue permit identically when approved', () => {
    const e = evidence()
    const printGate = deriveBuyerPackReleaseEligibility({
      isHumanApproved: e.isHumanApproved, storedDecision: e.storedDecision, approvedBy: e.approvedBy,
    })
    expect(printGate.eligible).toBe(true)
    expect(prepareBuyerPackSnapshotInput(e).eligible).toBe(true)
  })

  it('issue is not permitted in any case the print gate refuses (no weaker print path)', () => {
    for (const { over } of REFUSALS) {
      const e = evidence(over)
      const printEligible = deriveBuyerPackReleaseEligibility({
        isHumanApproved: e.isHumanApproved, storedDecision: e.storedDecision, approvedBy: e.approvedBy,
      }).eligible
      expect(printEligible).toBe(prepareBuyerPackSnapshotInput(e).eligible)
    }
  })
})

describe('issuance behaviour is unchanged by the extraction', () => {
  it('still derives the same approval identity and timestamp', () => {
    const e = evidence()
    const r = prepareBuyerPackSnapshotInput(e)
    expect(r.eligible).toBe(true)
    if (!r.eligible) return
    expect(r.input.approvalId).toBe('batch-1:2026-07-16T09:00:00.000Z')
    expect(r.input.approvalTimestamp).toBe('2026-07-16T09:00:00.000Z')
    expect(r.input.procurementDecision).toBe('progress')
    expect(r.input.approvedBy).toBe('Jane Reviewer')
  })

  it('shares one approval-id formula with the printed artifact', () => {
    const e = evidence()
    const r = prepareBuyerPackSnapshotInput(e)
    expect(r.eligible).toBe(true)
    if (!r.eligible) return
    // A printout and its snapshot must cite the same approval event.
    expect(r.input.approvalId).toBe(buyerPackApprovalId('batch-1', '2026-07-16T09:00:00.000Z'))
  })
})

import { describe, it, expect } from 'vitest'
import {
  REVIEW_DECISIONS,
  isComplianceReviewDecision,
  legalUpdateStatusForDecision,
  reviewStatusForDecision,
  LEGAL_UPDATE_STATUSES,
} from './complianceRules'
import type { ComplianceReviewDecision } from './complianceRules'

describe('legalUpdateStatusForDecision — W17', () => {
  /**
   * THE DEFECT THIS FIXES. `approve_rule` was never named in the inline
   * ternary, so it fell through to the 'reviewed' default while the rule it
   * created was inserted as 'active'. The strongest decision an operator could
   * take left the update in a weaker state than the lesser one, and a queue
   * filtered on 'rule_suggested' silently omitted every approved rule.
   */
  it('advances the update for approve_rule, exactly as it does for create_rule', () => {
    expect(legalUpdateStatusForDecision('approve_rule')).toBe('rule_suggested')
    expect(legalUpdateStatusForDecision('create_rule')).toBe('rule_suggested')
  })

  it('approve_rule is never weaker than create_rule', () => {
    expect(legalUpdateStatusForDecision('approve_rule'))
      .toBe(legalUpdateStatusForDecision('create_rule'))
  })

  it.each([
    ['send_to_legal', 'sent_to_legal'],
    ['reject', 'rejected'],
    ['archive', 'archived'],
    ['informational', 'reviewed'],
  ] as const)('%s → %s', (decision, expected) => {
    expect(legalUpdateStatusForDecision(decision)).toBe(expected)
  })

  it('never returns a status outside the CHECK vocabulary', () => {
    for (const decision of REVIEW_DECISIONS) {
      expect(LEGAL_UPDATE_STATUSES).toContain(legalUpdateStatusForDecision(decision))
    }
  })

  it('maps every decision in the union — no decision falls through', () => {
    // A decision added to the union without a case is a compile error, but this
    // also catches a case that returns undefined at runtime.
    for (const decision of REVIEW_DECISIONS) {
      expect(legalUpdateStatusForDecision(decision)).toBeTruthy()
      expect(reviewStatusForDecision(decision)).toBeTruthy()
    }
  })
})

describe('reviewStatusForDecision', () => {
  it.each([
    ['send_to_legal', 'sent_to_legal'],
    ['reject', 'rejected'],
    ['archive', 'archived'],
    ['informational', 'reviewed'],
    ['create_rule', 'reviewed'],
    ['approve_rule', 'reviewed'],
  ] as const)('%s → %s', (decision, expected) => {
    expect(reviewStatusForDecision(decision)).toBe(expected)
  })
})

describe('isComplianceReviewDecision', () => {
  it('accepts every member of the union and rejects anything else', () => {
    for (const d of REVIEW_DECISIONS) expect(isComplianceReviewDecision(d)).toBe(true)
    for (const d of ['', 'approve', 'Approve_Rule', 'delete']) {
      expect(isComplianceReviewDecision(d)).toBe(false)
    }
  })

  it('narrows to the union type', () => {
    const raw: string = 'approve_rule'
    if (isComplianceReviewDecision(raw)) {
      const narrowed: ComplianceReviewDecision = raw
      expect(legalUpdateStatusForDecision(narrowed)).toBe('rule_suggested')
    }
  })
})

/**
 * The four inline copies are gone. Two lived on the Supabase path and two on
 * the demo path, which is why the defect existed twice; fixing one would have
 * left the other. Asserted against the source so a future edit cannot quietly
 * reintroduce a local ternary that disagrees with this module.
 */
describe('the decision mapping has exactly one implementation', () => {
  const SRC = Object.values(
    import.meta.glob('../pages/admin/DDPComplianceWatchtower.tsx', {
      query: '?raw', import: 'default', eager: true,
    }) as Record<string, string>,
  )[0] ?? ''

  it('the page source loaded', () => {
    expect(SRC.length).toBeGreaterThan(1000)
  })

  it('no inline decision-to-status ternary remains in the page', () => {
    // Matches the ternary FORM specifically. `decision === 'create_rule'` and
    // `decision === 'approve_rule'` legitimately survive in the rule-creation
    // branch, which decides the RULE's status and the audit action — a
    // different question from the update's status, and not what W17 was about.
    expect(SRC).not.toContain("? 'sent_to_legal'")
    expect(SRC).not.toContain("? 'rule_suggested'")
  })

  it('both call sites use the shared mappings', () => {
    const legal = SRC.split('legalUpdateStatusForDecision(decision)').length - 1
    const review = SRC.split('reviewStatusForDecision(decision)').length - 1
    expect(legal).toBe(2)
    expect(review).toBe(2)
  })
})

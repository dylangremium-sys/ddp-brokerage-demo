import { describe, expect, it } from 'vitest'
import type { ComplianceRule, ComplianceRuleStatus } from '../types'
import { isEnforcedRuleStatus, isRuleEnforced, RULE_STATUSES } from './complianceRules'

function makeRule(status: ComplianceRuleStatus): ComplianceRule {
  return {
    id: `rule-${status}`,
    ruleCode: 'TEST_RULE',
    title: 'Test rule',
    description: 'A rule used only in tests.',
    jurisdiction: null,
    entityType: 'batch',
    severity: 'high',
    isBlocking: true,
    status,
    sourceLegalUpdateId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('isEnforcedRuleStatus / isRuleEnforced', () => {
  it('treats only approved and active as enforced', () => {
    const enforced = RULE_STATUSES.filter(isEnforcedRuleStatus)
    expect(enforced.sort()).toEqual(['active', 'approved'])
  })

  it('never treats draft, suggested, paused, retired, or rejected as enforced', () => {
    const neverEnforced: ComplianceRuleStatus[] = ['draft', 'suggested', 'paused', 'retired', 'rejected']
    for (const status of neverEnforced) {
      expect(isEnforcedRuleStatus(status)).toBe(false)
      expect(isRuleEnforced(makeRule(status))).toBe(false)
    }
  })

  it('treats approved and active rules as enforced', () => {
    expect(isRuleEnforced(makeRule('approved'))).toBe(true)
    expect(isRuleEnforced(makeRule('active'))).toBe(true)
  })

  it('isRuleEnforced delegates to isEnforcedRuleStatus for every status (no divergent logic)', () => {
    for (const status of RULE_STATUSES) {
      expect(isRuleEnforced(makeRule(status))).toBe(isEnforcedRuleStatus(status))
    }
  })
})

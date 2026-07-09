import { describe, expect, it } from 'vitest'
import { getComplianceRuleImpact } from './complianceRuleImpact'
import { makeRule } from './testFixtures'
import type { ComplianceAlert } from '../types'

function makeAlert(overrides: Partial<ComplianceAlert> = {}): ComplianceAlert {
  return {
    id: 'alert-1',
    entityType: 'batch',
    entityId: 'batch-1',
    ruleId: 'rule-1',
    legalUpdateId: null,
    alertTitle: 'Missing evidence',
    alertDetail: 'Detail.',
    severity: 'high',
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    resolutionNotes: null,
    ...overrides,
  }
}

describe('getComplianceRuleImpact — compliance badge / human approval gate', () => {
  it('returns null (No rule impact) when no entityId is given', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved' })
    expect(getComplianceRuleImpact('batch', undefined, [rule], [makeAlert()])).toBeNull()
    expect(getComplianceRuleImpact('batch', null, [rule], [makeAlert()])).toBeNull()
  })

  it('returns null when no rule is enforced (draft/suggested/paused/retired/rejected)', () => {
    const rules = ['draft', 'suggested', 'paused', 'retired', 'rejected'].map(status =>
      makeRule({ id: 'rule-1', status: status as never }),
    )
    const impact = getComplianceRuleImpact('batch', 'batch-1', rules, [makeAlert()])
    expect(impact).toBeNull()
  })

  it('returns null when an enforced rule exists but has no matching unresolved alert', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved' })
    const resolvedAlert = makeAlert({ status: 'resolved' })
    expect(getComplianceRuleImpact('batch', 'batch-1', [rule], [resolvedAlert])).toBeNull()

    const dismissedAlert = makeAlert({ status: 'dismissed' })
    expect(getComplianceRuleImpact('batch', 'batch-1', [rule], [dismissedAlert])).toBeNull()
  })

  it('never surfaces an alert tied to a rule that is not enforced, even if another rule with the same id is enforced elsewhere', () => {
    const unenforced = makeRule({ id: 'rule-1', status: 'suggested' })
    const alert = makeAlert({ ruleId: 'rule-1', status: 'open' })
    expect(getComplianceRuleImpact('batch', 'batch-1', [unenforced], [alert])).toBeNull()
  })

  it('surfaces "blocked pending legal review" for a blocked alert regardless of rule.isBlocking', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved', isBlocking: false })
    const alert = makeAlert({ status: 'blocked' })
    const impact = getComplianceRuleImpact('batch', 'batch-1', [rule], [alert])
    expect(impact?.safeStatusLabel).toBe('blocked pending legal review')
  })

  it('surfaces "missing evidence" for an open alert on a blocking rule', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved', isBlocking: true })
    const alert = makeAlert({ status: 'open' })
    const impact = getComplianceRuleImpact('batch', 'batch-1', [rule], [alert])
    expect(impact?.safeStatusLabel).toBe('missing evidence')
  })

  it('surfaces "needs review" for an in_review alert on a non-blocking rule', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved', isBlocking: false })
    const alert = makeAlert({ status: 'in_review' })
    const impact = getComplianceRuleImpact('batch', 'batch-1', [rule], [alert])
    expect(impact?.safeStatusLabel).toBe('needs review')
  })

  it('never returns a label implying legal/regulatory approval', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved', isBlocking: true })
    const alert = makeAlert({ status: 'open' })
    const impact = getComplianceRuleImpact('batch', 'batch-1', [rule], [alert])
    const forbidden = /compliant|certified|approved|verified|export ready/i
    expect(impact?.safeStatusLabel).not.toMatch(forbidden)
  })

  it('only matches alerts scoped to the requested entityType and entityId', () => {
    const rule = makeRule({ id: 'rule-1', status: 'approved' })
    const wrongEntityType = makeAlert({ entityType: 'farm', entityId: 'batch-1' })
    expect(getComplianceRuleImpact('batch', 'batch-1', [rule], [wrongEntityType])).toBeNull()

    const wrongEntityId = makeAlert({ entityType: 'batch', entityId: 'batch-2' })
    expect(getComplianceRuleImpact('batch', 'batch-1', [rule], [wrongEntityId])).toBeNull()
  })
})

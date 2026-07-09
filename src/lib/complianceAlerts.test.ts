import { describe, expect, it } from 'vitest'
import { deriveRuleBasedComplianceAlerts, mergeComplianceAlerts } from './complianceAlerts'
import { makeFarm, makeInventoryItem, makeRule } from './testFixtures'
import type { ComplianceAlert } from '../types'

describe('deriveRuleBasedComplianceAlerts — rule lifecycle gating', () => {
  it('raises no alerts when no rules are enforced (draft/suggested rules never affect buyers)', () => {
    const farm = makeFarm({ cultivationLicence: '' }) // missing licence evidence
    const rules = [
      makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'draft' }),
      makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'suggested' }),
      makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'paused' }),
      makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'retired' }),
      makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'rejected' }),
    ]
    const alerts = deriveRuleBasedComplianceAlerts([farm], [], rules)
    expect(alerts).toHaveLength(0)
  })

  it('raises an alert once the same rule is approved, with identical evidence gap', () => {
    const farm = makeFarm({
      cultivationLicence: '', processingLicence: '', manufacturingLicence: '',
      medicalCannabisLicence: '', exportLicence: '', importLicence: '',
    })
    const rules = [makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'approved' })]
    const alerts = deriveRuleBasedComplianceAlerts([farm], [], rules)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].entityType).toBe('farm')
    expect(alerts[0].entityId).toBe(farm.id)
  })

  it('active status also enforces a rule (approved and active are both enforced)', () => {
    const farm = makeFarm({ cultivationLicence: '' })
    const rules = [makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'active' })]
    const alerts = deriveRuleBasedComplianceAlerts([farm], [], rules)
    expect(alerts).toHaveLength(1)
  })

  it('does not raise a farm licence alert when licence evidence is present', () => {
    const farm = makeFarm({ cultivationLicence: 'CULT-123' })
    const rules = [makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'approved' })]
    const alerts = deriveRuleBasedComplianceAlerts([farm], [], rules)
    expect(alerts).toHaveLength(0)
  })

  it('raises a batch COA alert only for an enforced BATCH_COA_REQUIRED rule', () => {
    const item = makeInventoryItem({ coaAvailable: false, coaStoragePath: undefined, certFileName: '' })
    const suggestedOnly = deriveRuleBasedComplianceAlerts([], [item], [
      makeRule({ ruleCode: 'BATCH_COA_REQUIRED', status: 'suggested' }),
    ])
    expect(suggestedOnly).toHaveLength(0)

    const approved = deriveRuleBasedComplianceAlerts([], [item], [
      makeRule({ ruleCode: 'BATCH_COA_REQUIRED', status: 'approved' }),
    ])
    expect(approved).toHaveLength(1)
    expect(approved[0].entityType).toBe('batch')
    expect(approved[0].entityId).toBe(item.id)
  })

  it('marks alerts from blocking rules as blocked, non-blocking rules as open', () => {
    const item = makeInventoryItem({ heavyMetalsStatus: undefined })
    const blockingRule = makeRule({ ruleCode: 'HEAVY_METALS_REQUIRED', status: 'approved', isBlocking: true })
    const [blockedAlert] = deriveRuleBasedComplianceAlerts([], [item], [blockingRule])
    expect(blockedAlert.status).toBe('blocked')

    const nonBlockingRule = makeRule({ ruleCode: 'HEAVY_METALS_REQUIRED', status: 'approved', isBlocking: false })
    const [openAlert] = deriveRuleBasedComplianceAlerts([], [item], [nonBlockingRule])
    expect(openAlert.status).toBe('open')
  })
})

describe('mergeComplianceAlerts — alert lifecycle', () => {
  const auto: ComplianceAlert = {
    id: 'auto-1',
    entityType: 'batch',
    entityId: 'batch-1',
    ruleId: 'rule-1',
    legalUpdateId: null,
    alertTitle: 'Auto alert',
    alertDetail: 'Derived automatically.',
    severity: 'high',
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    resolutionNotes: null,
  }

  it('lets a stored alert (e.g. resolved) override the freshly-derived auto alert with the same id', () => {
    const stored: ComplianceAlert = { ...auto, status: 'resolved', resolvedAt: '2026-01-02T00:00:00.000Z' }
    const merged = mergeComplianceAlerts([auto], [stored])
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('resolved')
  })

  it('keeps auto and stored alerts with distinct ids side by side', () => {
    const stored: ComplianceAlert = { ...auto, id: 'stored-1', status: 'dismissed' }
    const merged = mergeComplianceAlerts([auto], [stored])
    expect(merged).toHaveLength(2)
  })

  it('sorts merged alerts newest first', () => {
    const older: ComplianceAlert = { ...auto, id: 'older', createdAt: '2026-01-01T00:00:00.000Z' }
    const newer: ComplianceAlert = { ...auto, id: 'newer', createdAt: '2026-06-01T00:00:00.000Z' }
    const merged = mergeComplianceAlerts([older], [newer])
    expect(merged.map(a => a.id)).toEqual(['newer', 'older'])
  })
})

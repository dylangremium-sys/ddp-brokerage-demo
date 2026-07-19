import { describe, it, expect } from 'vitest'
import { resolveDeskComplianceAlerts } from './operationsDeskComplianceAlerts'
import { deriveRuleBasedComplianceAlerts } from './complianceAlerts'
import { makeFarm, makeRule } from './testFixtures'
import type { ComplianceAlert } from '../types'

const unlicensedFarm = makeFarm({
  cultivationLicence: '', processingLicence: '', manufacturingLicence: '',
  medicalCannabisLicence: '', exportLicence: '', importLicence: '',
})
const enforcedLicenceRule = makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'approved' })
// The deterministic id the derivation assigns to that auto alert.
const AUTO_ID = deriveRuleBasedComplianceAlerts([unlicensedFarm], [], [enforcedLicenceRule])[0].id

function storedAlert(over: Partial<ComplianceAlert> = {}): ComplianceAlert {
  return {
    id: 'stored-1', entityType: 'farm', entityId: 'f-x',
    alertTitle: 'Manual', alertDetail: 'd', severity: 'medium', status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  } as ComplianceAlert
}

describe('resolveDeskComplianceAlerts — Watchtower-equivalent merge', () => {
  it('failed source → null (the desk reports the gap, not an all-clear)', () => {
    expect(resolveDeskComplianceAlerts(true, [unlicensedFarm], [], [enforcedLicenceRule], [])).toBeNull()
  })

  it('rule-derived only: an enforced rule + evidence gap yields the auto alert', () => {
    const out = resolveDeskComplianceAlerts(false, [unlicensedFarm], [], [enforcedLicenceRule], [])!
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(AUTO_ID)
  })

  it('inactive rules: a non-enforced (draft) rule yields no auto alert', () => {
    const draft = makeRule({ ruleCode: 'FARM_LICENSE_REQUIRED', status: 'draft' })
    expect(resolveDeskComplianceAlerts(false, [unlicensedFarm], [], [draft], [])).toEqual([])
  })

  it('persisted only: no enforced rules → just the stored alerts', () => {
    const s = storedAlert()
    expect(resolveDeskComplianceAlerts(false, [unlicensedFarm], [], [], [s])).toEqual([s])
  })

  it('union: rule-derived and persisted both appear with no duplicate rows', () => {
    const s = storedAlert({ id: 'stored-unique' })
    const out = resolveDeskComplianceAlerts(false, [unlicensedFarm], [], [enforcedLicenceRule], [s])!
    const ids = out.map(a => a.id)
    expect(ids).toContain('stored-unique')
    expect(ids).toContain(AUTO_ID)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    expect(out).toHaveLength(2)
  })

  it('overlap/dedup + resolved: a stored row with the auto id overrides it (resolved wins, one row)', () => {
    const resolved = storedAlert({ id: AUTO_ID, status: 'resolved', resolvedAt: '2026-02-01T00:00:00.000Z' })
    const out = resolveDeskComplianceAlerts(false, [unlicensedFarm], [], [enforcedLicenceRule], [resolved])!
    const matches = out.filter(a => a.id === AUTO_ID)
    expect(matches).toHaveLength(1) // deduplicated — not double-counted
    expect(matches[0].status).toBe('resolved') // stored overrides the auto 'blocked'/'open'
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyOperationsDeskPriority,
  PRIORITY_RANK,
  OPERATIONS_DESK_PRIORITIES,
} from './operationsDeskPriority'

describe('Operations Desk priority classifier', () => {
  it('treats a blocker-severity risk as critical', () => {
    expect(classifyOperationsDeskPriority({ riskSeverity: 'blocker' })).toBe('critical')
  })

  it('treats evidence states existing logic already blocks on as critical', () => {
    // rejected/expired are exactly what procurementControl's own buyer gate
    // counts as blockerRequirements.
    expect(classifyOperationsDeskPriority({ evidenceStatus: 'rejected' })).toBe('critical')
    expect(classifyOperationsDeskPriority({ evidenceStatus: 'expired' })).toBe('critical')
  })

  it('treats a critical compliance alert as critical', () => {
    expect(classifyOperationsDeskPriority({ complianceSeverity: 'critical' })).toBe('critical')
  })

  it('treats missing required evidence as high', () => {
    expect(classifyOperationsDeskPriority({ evidenceStatus: 'missing' })).toBe('high')
  })

  it('treats a matter awaiting human review as high', () => {
    expect(classifyOperationsDeskPriority({ awaitingHumanReview: true })).toBe('high')
  })

  it('treats high severities as high', () => {
    expect(classifyOperationsDeskPriority({ riskSeverity: 'high' })).toBe('high')
    expect(classifyOperationsDeskPriority({ complianceSeverity: 'high' })).toBe('high')
  })

  it('falls through to normal for routine and unrecognised signals', () => {
    expect(classifyOperationsDeskPriority({})).toBe('normal')
    expect(classifyOperationsDeskPriority({ riskSeverity: 'low' })).toBe('normal')
    expect(classifyOperationsDeskPriority({ riskSeverity: 'medium' })).toBe('normal')
    expect(classifyOperationsDeskPriority({ complianceSeverity: 'info' })).toBe('normal')
    expect(classifyOperationsDeskPriority({ evidenceStatus: 'documented' })).toBe('normal')
    expect(classifyOperationsDeskPriority({ awaitingHumanReview: false })).toBe('normal')
  })

  it('never escalates on age — the classifier accepts no date input at all', () => {
    // Guard on the contract itself: if a date/age field is ever added to the
    // signal, this test should be revisited deliberately rather than silently.
    const signal = { awaitingHumanReview: true } as Record<string, unknown>
    signal.ageInDays = 4000
    expect(classifyOperationsDeskPriority(signal)).toBe('high')
  })

  it('is deterministic — the same signal always classifies identically', () => {
    const signal = { evidenceStatus: 'missing' as const, complianceSeverity: 'low' as const }
    const runs = Array.from({ length: 5 }, () => classifyOperationsDeskPriority(signal))
    expect(new Set(runs).size).toBe(1)
  })

  it('ranks critical before high before normal', () => {
    expect(PRIORITY_RANK.critical).toBeLessThan(PRIORITY_RANK.high)
    expect(PRIORITY_RANK.high).toBeLessThan(PRIORITY_RANK.normal)
    expect(OPERATIONS_DESK_PRIORITIES).toEqual(['critical', 'high', 'normal'])
  })
})

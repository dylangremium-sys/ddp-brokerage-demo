import { describe, it, expect } from 'vitest'
import type { ComplianceAlert, ComplianceRule, ComplianceRuleStatus } from '../types'
import {
  describeRuleBlock,
  hasEnforcedRuleBlock,
  isRuleBlockingNow,
  isRuleEnforcementUnverified,
  isRuleWithinEffectiveWindow,
  selectBlockingRuleAlerts,
} from './complianceRuleEnforcement'

const AS_OF = new Date('2026-08-06T12:00:00.000Z')

function rule(over: Partial<ComplianceRule> = {}): ComplianceRule {
  return {
    id: 'rule-1',
    ruleCode: 'LEGAL_EXPORT_PERMIT',
    title: 'Export permit required for cannabis flower to CZ',
    description: 'A valid export permit must be on file before issuance.',
    jurisdiction: 'Thailand',
    entityType: 'batch',
    severity: 'critical',
    isBlocking: true,
    status: 'active',
    effectiveFrom: '2026-08-01',
    effectiveTo: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function alert(over: Partial<ComplianceAlert> = {}): ComplianceAlert {
  return {
    id: 'alert-1',
    entityType: 'batch',
    entityId: 'batch-42',
    ruleId: 'rule-1',
    alertTitle: 'No export permit on file',
    alertDetail: '',
    severity: 'critical',
    status: 'open',
    createdAt: '2026-08-06T00:00:00.000Z',
    ...over,
  }
}

describe('isRuleWithinEffectiveWindow', () => {
  it('is in force inside the window', () => {
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: '2026-08-01', effectiveTo: null }, AS_OF)).toBe(true)
  })

  it('is NOT in force before effective_from — a future rule must not block', () => {
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: '2026-09-01', effectiveTo: null }, AS_OF)).toBe(false)
  })

  it('is NOT in force once effective_to has passed', () => {
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: '2026-01-01', effectiveTo: '2026-08-01' }, AS_OF)).toBe(false)
  })

  it('is in force on the effective_from boundary, and out on the effective_to boundary', () => {
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: '2026-08-06', effectiveTo: null }, AS_OF)).toBe(true)
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: '2026-01-01', effectiveTo: '2026-08-06' }, AS_OF)).toBe(false)
  })

  it('treats an ABSENT effective_from as in force, not as "not yet in force"', () => {
    // A projection that omits the column must never quietly stop the gate blocking.
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: null, effectiveTo: null }, AS_OF)).toBe(true)
    expect(isRuleWithinEffectiveWindow({ effectiveFrom: undefined, effectiveTo: undefined }, AS_OF)).toBe(true)
  })
})

describe('isRuleBlockingNow — the status ambiguity, resolved deliberately', () => {
  it('blocks on active', () => {
    expect(isRuleBlockingNow(rule({ status: 'active' }), AS_OF)).toBe(true)
  })

  it('ALSO blocks on approved, even though compliance_rules_currently_enforced() would not', () => {
    // The wider status set is taken on purpose: failing to block is the
    // dangerous direction. See the module header.
    expect(isRuleBlockingNow(rule({ status: 'approved' }), AS_OF)).toBe(true)
  })

  it.each<ComplianceRuleStatus>(['draft', 'suggested', 'paused', 'retired', 'rejected'])(
    'does not block on %s',
    status => {
      expect(isRuleBlockingNow(rule({ status }), AS_OF)).toBe(false)
    },
  )

  it('does not block when the rule is not marked blocking, however severe', () => {
    expect(isRuleBlockingNow(rule({ isBlocking: false, severity: 'critical' }), AS_OF)).toBe(false)
  })

  it('does not block an active blocking rule that is outside its window', () => {
    expect(isRuleBlockingNow(rule({ effectiveFrom: '2026-12-01' }), AS_OF)).toBe(false)
  })
})

describe('selectBlockingRuleAlerts', () => {
  it('returns the alert when an unresolved alert names a rule blocking now', () => {
    const found = selectBlockingRuleAlerts('batch', 'batch-42', [rule()], [alert()], AS_OF)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      alertId: 'alert-1',
      ruleId: 'rule-1',
      ruleCode: 'LEGAL_EXPORT_PERMIT',
      severity: 'critical',
    })
  })

  it.each(['open', 'in_review', 'blocked'] as const)('treats %s as still blocking', status => {
    expect(selectBlockingRuleAlerts('batch', 'batch-42', [rule()], [alert({ status })], AS_OF)).toHaveLength(1)
  })

  it.each(['resolved', 'dismissed'] as const)('releases the block on %s', status => {
    expect(selectBlockingRuleAlerts('batch', 'batch-42', [rule()], [alert({ status })], AS_OF)).toHaveLength(0)
  })

  it('does not block a DIFFERENT batch', () => {
    expect(selectBlockingRuleAlerts('batch', 'batch-99', [rule()], [alert()], AS_OF)).toHaveLength(0)
  })

  it('does not block a different entity type with the same id', () => {
    expect(selectBlockingRuleAlerts('farm', 'batch-42', [rule()], [alert()], AS_OF)).toHaveLength(0)
  })

  it('ignores an alert that names no rule — this gate enforces rules, not free-standing alerts', () => {
    expect(selectBlockingRuleAlerts('batch', 'batch-42', [rule()], [alert({ ruleId: null })], AS_OF)).toHaveLength(0)
  })

  it('ignores an alert naming a rule that is not currently blocking', () => {
    expect(
      selectBlockingRuleAlerts('batch', 'batch-42', [rule({ status: 'suggested' })], [alert()], AS_OF),
    ).toHaveLength(0)
  })

  it('ignores an alert naming a rule that is not present at all', () => {
    expect(selectBlockingRuleAlerts('batch', 'batch-42', [], [alert()], AS_OF)).toHaveLength(0)
  })

  it('returns every distinct blocking rule when several apply', () => {
    const rules = [rule(), rule({ id: 'rule-2', ruleCode: 'LEGAL_THC_LIMIT', title: 'THC limit' })]
    const alerts = [alert(), alert({ id: 'alert-2', ruleId: 'rule-2' })]
    expect(selectBlockingRuleAlerts('batch', 'batch-42', rules, alerts, AS_OF)).toHaveLength(2)
  })
})

describe('hasEnforcedRuleBlock — fail closed', () => {
  it('BLOCKS when the state has not settled (null)', () => {
    expect(hasEnforcedRuleBlock(null)).toBe(true)
  })

  it('BLOCKS when the authoritative read failed (unavailable)', () => {
    expect(hasEnforcedRuleBlock({ blockingAlerts: [], unavailable: true })).toBe(true)
  })

  it('does not block when the state is settled and clean', () => {
    expect(hasEnforcedRuleBlock({ blockingAlerts: [], unavailable: false })).toBe(false)
  })

  it('blocks when a blocking alert stands', () => {
    const alerts = selectBlockingRuleAlerts('batch', 'batch-42', [rule()], [alert()], AS_OF)
    expect(hasEnforcedRuleBlock({ blockingAlerts: alerts, unavailable: false })).toBe(true)
  })

  it('does NOT block for a caller that does not participate in this gate (undefined)', () => {
    // Matches the overrideState convention: undefined means "not a gate-bearing
    // caller", which is different from "read failed".
    expect(hasEnforcedRuleBlock(undefined)).toBe(false)
    expect(isRuleEnforcementUnverified(undefined)).toBe(false)
  })

  it('an unavailable read blocks even though it carries no alerts — the whole point', () => {
    const state = { blockingAlerts: [], unavailable: true }
    expect(state.blockingAlerts).toHaveLength(0)
    expect(hasEnforcedRuleBlock(state)).toBe(true)
  })
})

describe('demo mode (no Supabase) must resolve, not report an outage', () => {
  // The near-miss this guards: the resolvers originally returned
  // `unavailable: true` whenever Supabase was unconfigured. That is the demo
  // build's normal state, so every buyer pack in the demo would have been
  // permanently blocked — and blocked with the wording "we could not read the
  // rules", which would have been false. The rules are readable; they live in
  // localStorage. The procurement override store has always handled this with
  // an explicit "the cache IS the store" branch; these follow it.
  it('resolveEnforcedRuleAlerts settles cleanly instead of failing closed', async () => {
    const { resolveEnforcedRuleAlerts } = await import('./complianceRepository')
    const state = await resolveEnforcedRuleAlerts('batch', 'batch-42')
    expect(state.unavailable).toBe(false)
  })

  it('resolveEnforcedRuleAlertsForBatches settles cleanly for every requested batch', async () => {
    const { resolveEnforcedRuleAlertsForBatches } = await import('./complianceRepository')
    const result = await resolveEnforcedRuleAlertsForBatches(['batch-42', 'batch-43'])
    expect(result.unavailable).toBe(false)
    expect(result.byBatchId.get('batch-42')?.unavailable).toBe(false)
    expect(result.byBatchId.get('batch-43')?.unavailable).toBe(false)
  })

  it('an empty batch list is a settled answer, not an outage', async () => {
    const { resolveEnforcedRuleAlertsForBatches } = await import('./complianceRepository')
    expect((await resolveEnforcedRuleAlertsForBatches([])).unavailable).toBe(false)
  })

  it('an empty entity id IS an outage — we were asked about nothing identifiable', async () => {
    const { resolveEnforcedRuleAlerts } = await import('./complianceRepository')
    expect((await resolveEnforcedRuleAlerts('batch', '')).unavailable).toBe(true)
  })
})

describe('describeRuleBlock', () => {
  it('names the rule rather than reporting a count', () => {
    const alerts = selectBlockingRuleAlerts('batch', 'batch-42', [rule()], [alert()], AS_OF)
    const text = describeRuleBlock(alerts)
    expect(text).toContain('LEGAL_EXPORT_PERMIT')
    expect(text).toContain('Export permit required for cannabis flower to CZ')
  })

  it('is empty when nothing blocks', () => {
    expect(describeRuleBlock([])).toBe('')
  })
})

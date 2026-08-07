import { describe, expect, it } from 'vitest'
import { buildAuditLogInsertPayload } from './complianceRepository'
import { isHumanApprovedRuleStatus } from './complianceRules'

// buildAuditLogInsertPayload is the pure payload builder insertAuditLog()
// sends to Supabase — extracted specifically so actor-type attribution can
// be tested without a live Supabase connection (insertAuditLog itself
// requires requireClient(), which throws unless Supabase is configured, so
// it has no unit-test seam of its own; this repo has no test coverage or
// mock for any other complianceRepository.ts function for the same reason).

const baseEntry = {
  action: 'legal_update_created' as const,
  entityType: 'legal_update',
  entityId: 'legal-123',
  beforeState: null,
  afterState: { title: 'Example' },
  reason: 'Manual regulatory/legal update intake created by admin.',
}

describe('buildAuditLogInsertPayload — actor-type attribution', () => {
  it('defaults actor_type to "admin" when no actorType argument is passed', () => {
    const payload = buildAuditLogInsertPayload(baseEntry, 'local-admin')
    expect(payload.actor_type).toBe('admin')
  })

  it('writes actor_type: "admin" when explicitly passed', () => {
    const payload = buildAuditLogInsertPayload(baseEntry, 'local-admin', 'admin')
    expect(payload.actor_type).toBe('admin')
  })

  it('writes actor_type: "ai_assistant" when explicitly passed', () => {
    const payload = buildAuditLogInsertPayload(baseEntry, null, 'ai_assistant')
    expect(payload.actor_type).toBe('ai_assistant')
  })

  it('maps the rest of the entry through unchanged, and coerces a non-UUID actorId to null', () => {
    const payload = buildAuditLogInsertPayload(baseEntry, 'local-admin', 'ai_assistant')
    expect(payload).toEqual({
      actor_type: 'ai_assistant',
      actor_id: null, // 'local-admin' is not a UUID — asUuidOrNull() coerces it to null
      action: 'legal_update_created',
      entity_type: 'legal_update',
      entity_id: 'legal-123',
      before_state: null,
      after_state: { title: 'Example' },
      reason: 'Manual regulatory/legal update intake created by admin.',
    })
  })

  it('preserves a real UUID actorId', () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    const payload = buildAuditLogInsertPayload(baseEntry, uuid, 'admin')
    expect(payload.actor_id).toBe(uuid)
  })
})

describe('Phase 0C does not change existing rule-enforcement behaviour', () => {
  it('the human-approval predicate is unchanged by the enforcement split', () => {
    expect(isHumanApprovedRuleStatus('draft')).toBe(false)
    expect(isHumanApprovedRuleStatus('suggested')).toBe(false)
    expect(isHumanApprovedRuleStatus('paused')).toBe(false)
    expect(isHumanApprovedRuleStatus('retired')).toBe(false)
    expect(isHumanApprovedRuleStatus('rejected')).toBe(false)
    expect(isHumanApprovedRuleStatus('approved')).toBe(true)
    expect(isHumanApprovedRuleStatus('active')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildAuditLogInsertPayload,
  resolveActorDisplayName,
  shortActorRef,
  UNKNOWN_ACTOR_LABEL,
} from './complianceRepository'
import { isEnforcedRuleStatus } from './complianceRules'

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

// resolveActorDisplayName is the pure attribution rule the audit log and the
// rules table both read through. It replaces an actorNameForId() closure that
// returned the literal 'DDP Admin' for every actor who was not the current
// viewer — so a rule approved by Admin A was displayed to Admin B, and to any
// regulator, as having been approved by "DDP Admin". The actor_id was correct
// in Postgres throughout; only the rendered name was fabricated. These tests
// pin the rule that no unresolved actor may ever borrow a plausible identity.

const ADMIN_A = '11111111-2222-3333-4444-555555555555'
const ADMIN_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('resolveActorDisplayName — audit actor integrity', () => {
  const names: ReadonlyMap<string, string> = new Map([
    [ADMIN_A, 'Somchai Prasert'],
    [ADMIN_B, 'Dylan Murtagh'],
  ])

  it('renders a known actor under their real profile name', () => {
    expect(resolveActorDisplayName(ADMIN_A, names)).toBe('Somchai Prasert')
  })

  it('renders a DIFFERENT operator under their own name, not the viewer\'s and not a placeholder', () => {
    // The regression this PR exists for: previously every non-viewer actor
    // rendered as the literal 'DDP Admin'.
    const rendered = resolveActorDisplayName(ADMIN_B, names)
    expect(rendered).toBe('Dylan Murtagh')
    expect(rendered).not.toBe('DDP Admin')
  })

  it('never renders the fabricated "DDP Admin" label for any input', () => {
    const inputs = [ADMIN_A, ADMIN_B, 'ffffffff-0000-0000-0000-000000000000', null, undefined]
    for (const input of inputs) {
      expect(resolveActorDisplayName(input, names)).not.toBe('DDP Admin')
    }
  })

  it('renders an unresolvable actor honestly, keeping a privacy-safe id fragment', () => {
    const unknown = 'ffffffff-0000-0000-0000-000000000000'
    const rendered = resolveActorDisplayName(unknown, names)
    expect(rendered).toBe(`${UNKNOWN_ACTOR_LABEL} (ffffffff)`)
    // Traceable, but never leaks an email or a full identifier.
    expect(rendered).not.toContain('@')
    expect(rendered).not.toContain(unknown)
  })

  it('falls back honestly when the name map is empty (e.g. the lookup was denied or failed)', () => {
    expect(resolveActorDisplayName(ADMIN_A, new Map())).toBe(`${UNKNOWN_ACTOR_LABEL} (11111111)`)
  })

  it('renders a null actor by its actorType rather than inventing a person', () => {
    expect(resolveActorDisplayName(null, names, 'system')).toBe('System')
    expect(resolveActorDisplayName(null, names, 'ai_assistant')).toBe('AI assistant')
  })

  it('renders a null actor with no actorType as unknown, never as a person', () => {
    expect(resolveActorDisplayName(null, names)).toBe(UNKNOWN_ACTOR_LABEL)
    expect(resolveActorDisplayName(undefined, names)).toBe(UNKNOWN_ACTOR_LABEL)
  })

  it('is viewer-independent: the same actor renders identically regardless of who is looking', () => {
    // resolveActorDisplayName takes no viewer argument by construction. This
    // pins that property — a viewer-relative fallback was the original defect.
    expect(resolveActorDisplayName(ADMIN_A, names)).toBe(resolveActorDisplayName(ADMIN_A, names))
    expect(resolveActorDisplayName(ADMIN_B, names)).toBe('Dylan Murtagh')
  })
})

describe('shortActorRef', () => {
  it('returns only the leading UUID segment', () => {
    expect(shortActorRef(ADMIN_A)).toBe('11111111')
  })

  it('returns a value with no separator unchanged', () => {
    expect(shortActorRef('abcdef')).toBe('abcdef')
  })
})

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
  it('isEnforcedRuleStatus is unchanged', () => {
    expect(isEnforcedRuleStatus('draft')).toBe(false)
    expect(isEnforcedRuleStatus('suggested')).toBe(false)
    expect(isEnforcedRuleStatus('paused')).toBe(false)
    expect(isEnforcedRuleStatus('retired')).toBe(false)
    expect(isEnforcedRuleStatus('rejected')).toBe(false)
    expect(isEnforcedRuleStatus('approved')).toBe(true)
    expect(isEnforcedRuleStatus('active')).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { resolveProvisionDecision } from './accessRequestProvisioning'
import type { InviteFarmerResult } from '../services/adminProvisioning'

/**
 * The rule under test: `markInvited` is true ONLY when an account is known to
 * exist afterwards.
 *
 * This is the guard against the defect it replaces. The Supplier Enquiries page
 * used to offer "Invited" as a plain status button: it wrote status='invited'
 * and created nothing, because the provisioning service was imported by zero
 * components. The queue recorded invitations that had never been sent.
 *
 * So every failure case below asserts `markInvited === false`. A test that only
 * checked the happy path would pass over the entire class of defect — the queue
 * lying about what happened.
 */

describe('resolveProvisionDecision', () => {
  it('marks invited when an account was created', () => {
    const decision = resolveProvisionDecision({ ok: true, userId: 'u-1' })

    expect(decision.kind).toBe('invited')
    expect(decision.markInvited).toBe(true)
    expect(decision.message).toMatch(/invitation email sent/i)
  })

  it('marks invited when the account already existed — the account is real', () => {
    // Common when a supplier was invited by hand before this button existed.
    const decision = resolveProvisionDecision({
      ok: false, error: 'User already registered.', reason: 'user_already_exists',
    })

    expect(decision.kind).toBe('already_exists')
    expect(decision.markInvited).toBe(true)
    expect(decision.message).toMatch(/no second invitation/i)
  })

  it('does NOT mark invited when the user is pending and needs explicit approval', () => {
    const decision = resolveProvisionDecision({
      ok: false,
      error: 'Promotion required.',
      reason: 'promotion_required',
      recovery: 'approve_pending_user_by_id',
      userId: 'u-pending-7',
    })

    expect(decision.kind).toBe('promotion_required')
    expect(decision.markInvited).toBe(false)
    // The admin needs the id, because the server refuses to promote by email.
    expect(decision.message).toContain('u-pending-7')
    expect(decision.message).toMatch(/enquiry is unchanged/i)
  })

  it('still explains itself when a pending user has no id attached', () => {
    const decision = resolveProvisionDecision({
      ok: false, error: 'Promotion required.', reason: 'promotion_required',
    })

    expect(decision.markInvited).toBe(false)
    expect(decision.message).toMatch(/pending account/i)
    expect(decision.message).not.toContain('undefined')
  })

  it('does NOT mark invited when the invitation failed', () => {
    const decision = resolveProvisionDecision({
      ok: false,
      error: 'The invitation could not be sent.',
      stage: 'invite',
      reason: 'invite_failed',
    })

    expect(decision.kind).toBe('failed')
    expect(decision.markInvited).toBe(false)
  })

  it('names deliverability on an invite-stage failure, because the server cannot', () => {
    // A real 502 from production on 2026-07-29: provisioning to an @example.com
    // address returns the same generic string as a genuine outage.
    const decision = resolveProvisionDecision({
      ok: false,
      error: 'The invitation could not be sent. Please retry, or contact support if it persists.',
      stage: 'invite',
      reason: 'invite_failed',
    })

    expect(decision.message).toMatch(/undeliverable domain|can receive mail/i)
    expect(decision.markInvited).toBe(false)
  })

  it('does not add a deliverability hint to failures from other stages', () => {
    const decision = resolveProvisionDecision({
      ok: false, error: 'DDP admin privileges are required.', stage: 'authorize',
    })

    expect(decision.message).toBe('DDP admin privileges are required.')
    expect(decision.message).not.toMatch(/receive mail/i)
    expect(decision.markInvited).toBe(false)
  })

  it('does not mark invited for an unrecognised failure', () => {
    const decision = resolveProvisionDecision({ ok: false, error: 'Something unexpected.' })

    expect(decision.kind).toBe('failed')
    expect(decision.markInvited).toBe(false)
  })

  it('never leaves the message empty, whatever the server sent', () => {
    const decision = resolveProvisionDecision({ ok: false, error: '' })

    expect(decision.message.length).toBeGreaterThan(0)
  })

  it('marks invited in exactly two cases and no others', () => {
    // The whole-space assertion: enumerate every reason the client type allows
    // and confirm only the two account-exists outcomes set the flag.
    const results: InviteFarmerResult[] = [
      { ok: true, userId: 'u' },
      { ok: false, error: 'e', reason: 'user_already_exists' },
      { ok: false, error: 'e', reason: 'promotion_required' },
      { ok: false, error: 'e', reason: 'invite_failed' },
      { ok: false, error: 'e' },
    ]

    const marked = results.filter(r => resolveProvisionDecision(r).markInvited)

    expect(marked).toHaveLength(2)
  })
})

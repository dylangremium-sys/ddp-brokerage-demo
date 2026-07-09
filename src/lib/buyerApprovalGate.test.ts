import { describe, expect, it } from 'vitest'
import { deriveBuyerApprovalGate } from './buyerApprovalGate'

describe('deriveBuyerApprovalGate — buyer visibility / human approval gate', () => {
  it('requires an explicit recorded "progress" decision, not just absence of blockers', () => {
    const result = deriveBuyerApprovalGate(false, false)
    expect(result.isHumanApproved).toBe(false)
    expect(result.packStatusLabel).toBe('No Blocking Issues Detected — Approval Required')
  })

  it('only approves once blockers are absent AND a progress decision is recorded', () => {
    const result = deriveBuyerApprovalGate(false, true)
    expect(result.isHumanApproved).toBe(true)
    expect(result.packStatusLabel).toBe('DDP Reviewed — Human Approved for Buyer Discussion')
  })

  it('never approves while blocking issues are present, even with a recorded progress decision', () => {
    const result = deriveBuyerApprovalGate(true, true)
    expect(result.isHumanApproved).toBe(false)
    expect(result.packStatusLabel).toBe('Decision Required')
  })

  it('never approves when both blockers are present and no decision is recorded', () => {
    const result = deriveBuyerApprovalGate(true, false)
    expect(result.isHumanApproved).toBe(false)
    expect(result.packStatusLabel).toBe('Decision Required')
  })
})

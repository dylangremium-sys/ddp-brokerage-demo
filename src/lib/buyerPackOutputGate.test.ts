import { describe, expect, it } from 'vitest'
import {
  canEmitBuyerPackOutput,
  BUYER_PACK_OUTPUT_BLOCKED_TITLE,
  BUYER_PACK_OUTPUT_BLOCKED_DETAIL,
} from './buyerPackOutputGate'

// The shared authoritative output policy. Buyer-facing output (Print / PDF /
// Copy) is allowed only for a human-approved pack; the audit proved these paths
// were ungated, letting a blocked pack be printed/copied.
describe('canEmitBuyerPackOutput', () => {
  it('denies buyer-facing output when the pack is not human-approved', () => {
    expect(canEmitBuyerPackOutput(false)).toBe(false)
  })

  it('allows buyer-facing output only when the pack is human-approved', () => {
    expect(canEmitBuyerPackOutput(true)).toBe(true)
  })

  it('exposes shared blocked wording for the screen note and the print notice', () => {
    expect(BUYER_PACK_OUTPUT_BLOCKED_TITLE).toMatch(/MUST NOT BE ISSUED TO A BUYER/i)
    expect(BUYER_PACK_OUTPUT_BLOCKED_DETAIL.length).toBeGreaterThan(20)
    expect(BUYER_PACK_OUTPUT_BLOCKED_DETAIL).toMatch(/human-approved/i)
  })
})

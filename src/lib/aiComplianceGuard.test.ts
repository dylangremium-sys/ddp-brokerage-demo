import { describe, expect, it } from 'vitest'
import { assertSafeAiDraftedText, guardAiDraftedText } from './aiComplianceGuard'

describe('guardAiDraftedText — safe AI-drafted text passes', () => {
  it('passes a plain factual summary with no compliance/certification claim', () => {
    const text = "Thailand's Narcotics Control Board published updated cultivation licensing guidance on 2026-01-15, focused on batch traceability requirements for licensed cultivators."
    const result = guardAiDraftedText(text)
    expect(result.isSafe).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('passes "pending review" phrasing (no unsafe term present)', () => {
    expect(guardAiDraftedText('This legal update is pending review by DDP staff.').isSafe).toBe(true)
  })

  it('passes "requires human approval" phrasing ("approval" is a distinct word from "approved")', () => {
    expect(guardAiDraftedText('This change requires human approval before any status update.').isSafe).toBe(true)
  })
})

describe('guardAiDraftedText — safe negations pass', () => {
  const safeNegations = [
    'The batch is not compliant with the updated heavy-metals threshold.',
    'This farm has not been certified under the new scheme.',
    'The submitted document has not been verified by a qualified party.',
    'Outcomes are never guaranteed by this platform.',
    'The shipment is not export-ready pending further documentation.',
    "The rule doesn't apply until it is legally compliant with the amended statute.",
  ]

  it.each(safeNegations)('treats "%s" as safe', text => {
    expect(guardAiDraftedText(text).isSafe).toBe(true)
  })
})

describe('guardAiDraftedText — unqualified overclaims fail', () => {
  const unsafeClaims: Array<[string, string]> = [
    ['This batch is compliant with the new regulation.', 'compliant'],
    ['The farm is certified under GACP.', 'certified'],
    ['This document has been verified by our team.', 'verified'],
    ['Results are guaranteed under this programme.', 'guaranteed'],
    ['The rule has been approved for enforcement.', 'approved'],
    ['This shipment is export-ready.', 'export-ready'],
    ['The supplier is legally compliant in all jurisdictions.', 'legally compliant'],
  ]

  it.each(unsafeClaims)('flags "%s" as unsafe (%s)', (text, expectedTerm) => {
    const result = guardAiDraftedText(text)
    expect(result.isSafe).toBe(false)
    expect(result.findings.some(f => f.term === expectedTerm)).toBe(true)
  })

  it('assertSafeAiDraftedText throws for an unsafe claim and is silent for a safe one', () => {
    expect(() => assertSafeAiDraftedText('This batch is verified.')).toThrow(/unsafe/i)
    expect(() => assertSafeAiDraftedText('This batch is not verified yet — pending review.')).not.toThrow()
  })
})

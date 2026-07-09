import { describe, expect, it } from 'vitest'
import { assertSafeAiDraftedText, guardAiDraftedFields, guardAiDraftedText } from './aiComplianceGuard'

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

// ─── Watchtower intake wiring (Phase 0B) ────────────────────────────────────
// guardAiDraftedFields is the exact function DDPComplianceWatchtower.tsx's
// submitLegalUpdate() calls on title/source/rawText/summary before any
// legal_update, compliance_review, compliance_rule, alert, or audit_log
// write. These tests exercise that same function directly.

describe('guardAiDraftedFields — Watchtower intake fields (title / source / rawText / summary)', () => {
  it('blocks intake when any single field carries an unqualified overclaim', () => {
    const result = guardAiDraftedFields({
      title: 'New cultivation licensing update',
      source: 'Thai Narcotics Control Board',
      rawText: 'This batch is compliant with the new regulation.',
      summary: '',
    })
    expect(result.isSafe).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ field: 'rawText', term: 'compliant' })
  })

  it('blocks intake when the unsafe wording is in the title field specifically', () => {
    const result = guardAiDraftedFields({
      title: 'This farm is now certified',
      source: '',
      rawText: 'Raw pasted text goes here.',
      summary: '',
    })
    expect(result.isSafe).toBe(false)
    expect(result.findings.some(f => f.field === 'title' && f.term === 'certified')).toBe(true)
  })

  it('reports every unsafe field, not just the first', () => {
    const result = guardAiDraftedFields({
      title: 'This shipment is export-ready',
      source: '',
      rawText: 'The farm is guaranteed to pass inspection.',
      summary: 'Fully approved for enforcement.',
    })
    expect(result.isSafe).toBe(false)
    const fields = result.findings.map(f => f.field).sort()
    expect(fields).toEqual(['rawText', 'summary', 'title'])
  })

  it('passes when every field is either empty or uses safe negation/non-claim phrasing', () => {
    const result = guardAiDraftedFields({
      title: 'Cultivation licensing guidance update',
      source: 'Thai Narcotics Control Board',
      rawText: 'The farm has not been verified and is not certified under the new scheme.',
      summary: 'Pending review — requires human approval before any status change.',
    })
    expect(result.isSafe).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('skips empty/whitespace-only fields entirely', () => {
    const result = guardAiDraftedFields({ title: 'Fine', source: '', rawText: '   ', summary: '' })
    expect(result.isSafe).toBe(true)
  })

  it('checks fields independently — a negation at the end of one field never masks an unsafe claim at the start of another', () => {
    const result = guardAiDraftedFields({
      title: 'Status: not applicable',
      source: '',
      rawText: '',
      summary: 'This shipment is compliant.',
    })
    expect(result.isSafe).toBe(false)
    expect(result.findings.some(f => f.field === 'summary' && f.term === 'compliant')).toBe(true)
  })
})

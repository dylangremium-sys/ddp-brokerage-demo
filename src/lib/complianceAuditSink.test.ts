import { describe, expect, it } from 'vitest'

import { resolveAuditSink, type AuditSinkContext } from './complianceAuditSink'

/**
 * The behaviour these tests pin is a REFUSAL, so each one is written to fail
 * against the code as it stood before: logAudit's `else` branch wrote to
 * localStorage for every non-database case, including a hosted build. The
 * third case below is the one that changed.
 */

const HOSTED_ADMIN: AuditSinkContext = { isSupabaseConfigured: true, isSupabaseAdmin: true }
const HOSTED_NOT_ADMIN: AuditSinkContext = { isSupabaseConfigured: true, isSupabaseAdmin: false }
const DEMO: AuditSinkContext = { isSupabaseConfigured: false, isSupabaseAdmin: false }

describe('resolveAuditSink', () => {
  it('sends a hosted admin to the database', () => {
    expect(resolveAuditSink(HOSTED_ADMIN)).toEqual({ kind: 'database' })
  })

  it('keeps the demo build writing locally — there localStorage IS the record', () => {
    expect(resolveAuditSink(DEMO)).toEqual({ kind: 'local-demo' })
  })

  it('REFUSES in a hosted build that cannot write as an admin, rather than filing the entry in a browser', () => {
    const decision = resolveAuditSink(HOSTED_NOT_ADMIN)
    expect(decision.kind).toBe('refuse')
    // The operator has to be able to act on it, so the reason names the cause
    // and the remedy rather than saying "failed".
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/audit log/i)
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/sign in again/i)
  })

  /**
   * The invariant, asserted over the whole input space rather than the three
   * cases above — two booleans is four combinations, so "whole input space" is
   * literal here. A future flag that reintroduced a hosted local write would
   * fail this even if nobody thought to add a case for it.
   */
  it('never writes locally in a hosted build, for ANY combination of inputs', () => {
    const hostedDecisions = [true, false].map(isSupabaseAdmin =>
      resolveAuditSink({ isSupabaseConfigured: true, isSupabaseAdmin }),
    )
    expect(hostedDecisions.map(d => d.kind)).toEqual(['database', 'refuse'])
    expect(hostedDecisions.some(d => d.kind === 'local-demo')).toBe(false)
  })

  it('is exhaustive — every combination resolves to a known sink', () => {
    const kinds = new Set<string>()
    for (const isSupabaseConfigured of [true, false]) {
      for (const isSupabaseAdmin of [true, false]) {
        kinds.add(resolveAuditSink({ isSupabaseConfigured, isSupabaseAdmin }).kind)
      }
    }
    expect([...kinds].sort()).toEqual(['database', 'local-demo', 'refuse'])
  })
})

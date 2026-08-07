import { describe, it, expect } from 'vitest'
import type { InventoryItem } from '../types'
import { SEED_INVENTORY } from '../data'
import {
  RULE_FIELDS,
  describeRuleCondition,
  evaluateRuleCondition,
  parseRuleCondition,
} from './complianceRuleCondition'
import type { RuleCondition } from './complianceRuleCondition'

const AS_OF = new Date('2026-08-07T12:00:00.000Z')

function batch(over: Partial<InventoryItem> = {}): InventoryItem {
  return { ...SEED_INVENTORY[0], ...over }
}

function parsed(input: unknown): RuleCondition {
  const r = parseRuleCondition(input)
  if (!r.ok) throw new Error(`expected valid, got: ${r.errors.join('; ')}`)
  return r.condition
}

describe('parseRuleCondition — validation happens on WRITE, not on the gate', () => {
  it('accepts a well-formed leaf', () => {
    expect(parseRuleCondition({ field: 'thcPct', op: 'gt', value: 0.2 }).ok).toBe(true)
  })

  it('rejects an unknown field and lists the known ones', () => {
    const r = parseRuleCondition({ field: 'sneakyField', op: 'gt', value: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0]).toContain('unknown field')
      expect(r.errors[0]).toContain('thcPct')
    }
  })

  it('rejects an operator that does not belong to the field type', () => {
    // 'before' is a date operator; thcPct is a number.
    const r = parseRuleCondition({ field: 'thcPct', op: 'before', value: '2026-01-01' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('not valid for a number field')
  })

  it('rejects a value of the wrong type', () => {
    expect(parseRuleCondition({ field: 'thcPct', op: 'gt', value: 'lots' }).ok).toBe(false)
    expect(parseRuleCondition({ field: 'qualityGrade', op: 'eq', value: 5 }).ok).toBe(false)
  })

  it('rejects NaN and Infinity, which would otherwise compare as never-matching', () => {
    expect(parseRuleCondition({ field: 'thcPct', op: 'gt', value: NaN }).ok).toBe(false)
    expect(parseRuleCondition({ field: 'thcPct', op: 'gt', value: Infinity }).ok).toBe(false)
  })

  it('rejects an empty all/any branch rather than treating it as vacuously true', () => {
    expect(parseRuleCondition({ all: [] }).ok).toBe(false)
    expect(parseRuleCondition({ any: [] }).ok).toBe(false)
  })

  it('rejects the not-yet-implemented cross-entity escape hatch by name', () => {
    const r = parseRuleCondition({ check: 'licence_expires_before_shipment' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('not implemented yet')
  })

  it('rejects anything that is not an object — no strings to be parsed', () => {
    for (const bad of ['thcPct > 0.2', 42, null, [], true]) {
      expect(parseRuleCondition(bad).ok).toBe(false)
    }
  })

  it('validates nested branches and reports the failing path', () => {
    const r = parseRuleCondition({ all: [{ field: 'thcPct', op: 'gt', value: 0.2 }, { field: 'nope', op: 'eq', value: 'x' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => e.includes('condition.all[1]'))).toBe(true)
  })
})

describe('evaluateRuleCondition — numbers', () => {
  it('matches when the batch exceeds the limit', () => {
    const r = evaluateRuleCondition(parsed({ field: 'thcPct', op: 'gt', value: 0.2 }), batch({ thcPct: 24 }), AS_OF)
    expect(r).toMatchObject({ matched: true, unevaluable: false })
    expect(r.reason).toContain('THC')
    expect(r.reason).toContain('24')
  })

  it('does not match when it does not', () => {
    expect(evaluateRuleCondition(parsed({ field: 'thcPct', op: 'gt', value: 30 }), batch({ thcPct: 24 }), AS_OF))
      .toMatchObject({ matched: false, unevaluable: false })
  })

  it('boundary: gt is strict, gte is not', () => {
    expect(evaluateRuleCondition(parsed({ field: 'thcPct', op: 'gt', value: 24 }), batch({ thcPct: 24 }), AS_OF).matched).toBe(false)
    expect(evaluateRuleCondition(parsed({ field: 'thcPct', op: 'gte', value: 24 }), batch({ thcPct: 24 }), AS_OF).matched).toBe(true)
  })
})

describe('FAIL CLOSED — the outcome that is neither true nor false', () => {
  it('a missing value is UNEVALUABLE, not "no violation"', () => {
    const r = evaluateRuleCondition(
      parsed({ field: 'moisturePct', op: 'gt', value: 12 }),
      batch({ moisturePct: undefined as unknown as number }),
      AS_OF,
    )
    expect(r.unevaluable).toBe(true)
    expect(r.matched).toBe(false)          // a caller checking only `matched` still fails safe
    expect(r.reason).toContain('cannot be decided')
  })

  it('a NaN value is UNEVALUABLE — it must never compare as simply not-matching', () => {
    // NaN > 12 is false, which would read as "compliant". It must not.
    const r = evaluateRuleCondition(parsed({ field: 'thcPct', op: 'gt', value: 12 }), batch({ thcPct: NaN }), AS_OF)
    expect(r.unevaluable).toBe(true)
  })

  it('an unreadable date is UNEVALUABLE', () => {
    const r = evaluateRuleCondition(parsed({ field: 'harvestDate', op: 'olderThanDays', value: 30 }), batch({ harvestDate: 'last spring' }), AS_OF)
    expect(r.unevaluable).toBe(true)
  })

  it('ALL: one unevaluable branch makes the whole condition unevaluable', () => {
    const c = parsed({ all: [{ field: 'thcPct', op: 'gt', value: 1 }, { field: 'moisturePct', op: 'gt', value: 5 }] })
    const r = evaluateRuleCondition(c, batch({ thcPct: 24, moisturePct: NaN }), AS_OF)
    expect(r.unevaluable).toBe(true)
  })

  it('ANY: a definite match wins over an unevaluable sibling — the OR is already decided', () => {
    const c = parsed({ any: [{ field: 'thcPct', op: 'gt', value: 1 }, { field: 'moisturePct', op: 'gt', value: 5 }] })
    const r = evaluateRuleCondition(c, batch({ thcPct: 24, moisturePct: NaN }), AS_OF)
    expect(r).toMatchObject({ matched: true, unevaluable: false })
  })

  it('ANY: with no match, an unevaluable sibling makes the whole thing unevaluable', () => {
    const c = parsed({ any: [{ field: 'thcPct', op: 'gt', value: 90 }, { field: 'moisturePct', op: 'gt', value: 5 }] })
    const r = evaluateRuleCondition(c, batch({ thcPct: 24, moisturePct: NaN }), AS_OF)
    expect(r.unevaluable).toBe(true)
  })

  it('NOT never converts unevaluable into a match', () => {
    const r = evaluateRuleCondition(parsed({ not: { field: 'thcPct', op: 'gt', value: 1 } }), batch({ thcPct: NaN }), AS_OF)
    expect(r.unevaluable).toBe(true)
    expect(r.matched).toBe(false)
  })
})

describe('presence operators — these are decidable when the value is missing', () => {
  it('isAbsent matches a missing COA and does not go unevaluable', () => {
    const r = evaluateRuleCondition(parsed({ field: 'certFileName', op: 'isAbsent' }), batch({ certFileName: '' }), AS_OF)
    expect(r).toMatchObject({ matched: true, unevaluable: false })
  })

  it('isPresent matches when it is there', () => {
    expect(evaluateRuleCondition(parsed({ field: 'certFileName', op: 'isPresent' }), batch({ certFileName: 'coa.pdf' }), AS_OF).matched).toBe(true)
  })
})

describe('dates', () => {
  it('olderThanDays measures against the supplied clock', () => {
    const r = evaluateRuleCondition(parsed({ field: 'harvestDate', op: 'olderThanDays', value: 30 }), batch({ harvestDate: '2026-01-01' }), AS_OF)
    expect(r.matched).toBe(true)
    expect(r.reason).toContain('day(s) ago')
  })

  it('a recent harvest does not match', () => {
    expect(evaluateRuleCondition(parsed({ field: 'harvestDate', op: 'olderThanDays', value: 30 }), batch({ harvestDate: '2026-08-01' }), AS_OF).matched).toBe(false)
  })
})

describe('composition', () => {
  it('a realistic two-clause rule: THC over the limit in a named location', () => {
    const c = parsed({ all: [
      { field: 'thcPct', op: 'gt', value: 0.2 },
      { field: 'location', op: 'eq', value: 'Chiang Mai' },
    ]})
    expect(evaluateRuleCondition(c, batch({ thcPct: 24, location: 'Chiang Mai' }), AS_OF).matched).toBe(true)
    expect(evaluateRuleCondition(c, batch({ thcPct: 24, location: 'Bangkok' }), AS_OF).matched).toBe(false)
  })
})

describe('describeRuleCondition — a rule an operator cannot read is one they cannot challenge', () => {
  it('renders a leaf in plain English with units', () => {
    expect(describeRuleCondition(parsed({ field: 'thcPct', op: 'gt', value: 0.2 }))).toBe('THC (%) is above 0.2')
  })

  it('renders composition', () => {
    const text = describeRuleCondition(parsed({ all: [
      { field: 'thcPct', op: 'gt', value: 0.2 },
      { field: 'certFileName', op: 'isAbsent' },
    ]}))
    expect(text).toBe('THC (%) is above 0.2 AND COA file is missing')
  })

  it('describes every field in the registry without throwing', () => {
    for (const [field, spec] of Object.entries(RULE_FIELDS)) {
      const op = spec.type === 'number' ? 'gt' : spec.type === 'date' ? 'olderThanDays' : 'isPresent'
      const value = spec.type === 'text' ? undefined : 1
      const c = parsed(value === undefined ? { field, op } : { field, op, value })
      expect(describeRuleCondition(c).length).toBeGreaterThan(0)
    }
  })
})

describe('no code execution path exists', () => {
  it('a condition cannot smuggle a function or an expression', () => {
    expect(parseRuleCondition({ field: 'thcPct', op: 'gt', value: '0.2; process.exit(1)' }).ok).toBe(false)
    expect(parseRuleCondition({ field: 'constructor', op: 'eq', value: 'x' }).ok).toBe(false)
    expect(parseRuleCondition({ field: '__proto__', op: 'eq', value: 'x' }).ok).toBe(false)
  })
})

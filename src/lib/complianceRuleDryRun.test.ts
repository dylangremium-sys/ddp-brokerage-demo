import { describe, it, expect } from 'vitest'
import type { InventoryItem } from '../types'
import { SEED_INVENTORY } from '../data'
import { parseRuleCondition } from './complianceRuleCondition'
import type { RuleCondition } from './complianceRuleCondition'
import { describeDryRun, dryRunRuleCondition } from './complianceRuleDryRun'

const AS_OF = new Date('2026-08-07T12:00:00.000Z')

function batch(id: string, over: Partial<InventoryItem> = {}): InventoryItem {
  return { ...SEED_INVENTORY[0], id, batchNumber: id.toUpperCase(), ...over }
}

function cond(input: unknown): RuleCondition {
  const r = parseRuleCondition(input)
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.condition
}

const THC_OVER_20 = cond({ field: 'thcPct', op: 'gt', value: 20 })

describe('dryRunRuleCondition — nothing is written, everything is counted', () => {
  it('separates flagged, undecidable and untouched, and the three sum to the total', () => {
    const batches = [
      batch('a', { thcPct: 24 }),                                 // flagged
      batch('b', { thcPct: 12 }),                                 // untouched
      batch('c', { thcPct: NaN }),                                // undecidable
      batch('d', { thcPct: undefined as unknown as number }),     // undecidable
    ]
    const s = dryRunRuleCondition(THC_OVER_20, batches, AS_OF)

    expect(s.evaluated).toBe(4)
    expect(s.wouldFlag.map(h => h.batchId)).toEqual(['a'])
    expect(s.cannotDecide.map(h => h.batchId).sort()).toEqual(['c', 'd'])
    expect(s.wouldLeaveAlone).toBe(1)
    expect(s.wouldFlag.length + s.cannotDecide.length + s.wouldLeaveAlone).toBe(s.evaluated)
  })

  it('an undecidable batch is NEVER counted as flagged or as untouched', () => {
    // The whole point: undecidable is its own bucket. Folding it into either
    // one is how a rule silently stops gating, or silently blocks everything.
    const s = dryRunRuleCondition(THC_OVER_20, [batch('x', { thcPct: NaN })], AS_OF)
    expect(s.wouldFlag).toHaveLength(0)
    expect(s.wouldLeaveAlone).toBe(0)
    expect(s.cannotDecide).toHaveLength(1)
  })

  it('carries a human-readable reason for every hit', () => {
    const s = dryRunRuleCondition(THC_OVER_20, [batch('a', { thcPct: 24 })], AS_OF)
    expect(s.wouldFlag[0].reason).toContain('THC')
    expect(s.wouldFlag[0].reason).toContain('24')
  })

  it('identifies batches by their batch number, not only an internal id', () => {
    const s = dryRunRuleCondition(THC_OVER_20, [batch('a', { thcPct: 24, batchNumber: 'DDP-0412' })], AS_OF)
    expect(s.wouldFlag[0].batchNumber).toBe('DDP-0412')
  })

  it('handles an empty batch list without pretending it proved anything', () => {
    const s = dryRunRuleCondition(THC_OVER_20, [], AS_OF)
    expect(s).toMatchObject({ evaluated: 0, wouldLeaveAlone: 0 })
    expect(describeDryRun(s)).toContain('has not been tested')
  })

  it('respects the supplied clock for date rules', () => {
    const old = cond({ field: 'harvestDate', op: 'olderThanDays', value: 30 })
    const b = [batch('a', { harvestDate: '2026-07-01' })]
    expect(dryRunRuleCondition(old, b, new Date('2026-08-07T00:00:00Z')).wouldFlag).toHaveLength(1)
    expect(dryRunRuleCondition(old, b, new Date('2026-07-10T00:00:00Z')).wouldFlag).toHaveLength(0)
  })
})

describe('describeDryRun — leads with the number that should worry the author', () => {
  it('reports a rule that decides nothing as BROKEN, not as harmless', () => {
    // "would flag 0" reads like a safe rule. If the rest are undecidable it is
    // the opposite of safe, and the wording has to say so.
    const s = dryRunRuleCondition(THC_OVER_20, [batch('a', { thcPct: NaN }), batch('b', { thcPct: NaN })], AS_OF)
    const text = describeDryRun(s)
    expect(text).toContain('cannot be decided for ANY')
    expect(text).toContain('block nothing')
  })

  it('names the triage cost of undecidable batches rather than hiding it', () => {
    const s = dryRunRuleCondition(THC_OVER_20, [batch('a', { thcPct: 24 }), batch('b', { thcPct: NaN })], AS_OF)
    const text = describeDryRun(s)
    expect(text).toContain('cannot decide 1')
    expect(text).toContain('not a pass')
  })

  it('asks the author to confirm a rule that flags nothing at all', () => {
    const s = dryRunRuleCondition(THC_OVER_20, [batch('a', { thcPct: 1 })], AS_OF)
    expect(describeDryRun(s)).toContain('Confirm that is what you expect')
  })

  it('states the flag count against the total for an ordinary rule', () => {
    const s = dryRunRuleCondition(THC_OVER_20, [batch('a', { thcPct: 24 }), batch('b', { thcPct: 1 })], AS_OF)
    expect(describeDryRun(s)).toContain('Would flag 1 of 2 batches')
  })
})

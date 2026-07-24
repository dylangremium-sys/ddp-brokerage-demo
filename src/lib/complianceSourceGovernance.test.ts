import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import {
  assertNotTier3Authority,
  canActAsDirectAuthority,
  compareSourcesForMonitoring,
  defaultSourceGovernance,
  guardTier3Authority,
  validateSourceGovernance,
} from './complianceSourceGovernance'

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'source-1',
    name: 'Thai FDA',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/narcotics',
    isActive: true,
    lastCheckedAt: null,
    tier: 1,
    authorityType: 'primary_regulator',
    category: 'export_import',
    monitoringMethod: 'rss',
    priority: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('canActAsDirectAuthority', () => {
  it('permits Tier 1 and Tier 2 only', () => {
    expect(canActAsDirectAuthority(1)).toBe(true)
    expect(canActAsDirectAuthority(2)).toBe(true)
    expect(canActAsDirectAuthority(3)).toBe(false)
  })

  it('fails closed on an unclassified (null/undefined) tier', () => {
    expect(canActAsDirectAuthority(null)).toBe(false)
    expect(canActAsDirectAuthority(undefined)).toBe(false)
  })
})

describe('guardTier3Authority', () => {
  it('allows a Tier 1/2 source to drive downstream state', () => {
    expect(guardTier3Authority(makeSource({ tier: 1 }), 'rule activation').allowed).toBe(true)
    expect(guardTier3Authority(makeSource({ tier: 2 }), 'rule activation').allowed).toBe(true)
  })

  it('blocks a Tier 3 signal source from driving downstream state', () => {
    const result = guardTier3Authority(makeSource({ tier: 3 }), 'rule activation')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/Tier 3/)
    expect(result.reason).toMatch(/human review/)
  })

  it('blocks an unclassified source (fail closed)', () => {
    expect(guardTier3Authority(makeSource({ tier: null }), 'export decision').allowed).toBe(false)
  })

  it('blocks an absent source', () => {
    expect(guardTier3Authority(null, 'export decision').allowed).toBe(false)
    expect(guardTier3Authority(undefined, 'export decision').allowed).toBe(false)
  })
})

describe('assertNotTier3Authority', () => {
  it('does not throw for Tier 1/2', () => {
    expect(() => assertNotTier3Authority(makeSource({ tier: 2 }), 'ctx')).not.toThrow()
  })

  it('throws for Tier 3', () => {
    expect(() => assertNotTier3Authority(makeSource({ tier: 3 }), 'ctx')).toThrow(/Tier 3/)
  })

  it('throws for an unclassified source', () => {
    expect(() => assertNotTier3Authority(makeSource({ tier: null }), 'ctx')).toThrow(/unclassified/)
  })
})

describe('validateSourceGovernance', () => {
  const good = {
    tier: 1 as const,
    authorityType: 'primary_regulator' as const,
    category: 'export_import' as const,
    monitoringMethod: 'rss' as const,
    priority: 5,
  }

  it('accepts a well-formed classification', () => {
    expect(validateSourceGovernance(good)).toEqual({ valid: true, errors: [] })
  })

  it('rejects an out-of-range tier', () => {
    const result = validateSourceGovernance({ ...good, tier: 4 as unknown })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('tier'))).toBe(true)
  })

  it('rejects an unknown authority type', () => {
    const result = validateSourceGovernance({ ...good, authorityType: 'wizard' as unknown })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('authorityType'))).toBe(true)
  })

  it('rejects an unknown category', () => {
    const result = validateSourceGovernance({ ...good, category: 'sportsball' as unknown })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('category'))).toBe(true)
  })

  it('rejects an unknown monitoring method', () => {
    const result = validateSourceGovernance({ ...good, monitoringMethod: 'telepathy' as unknown })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('monitoringMethod'))).toBe(true)
  })

  it('rejects a priority outside [1,100] and a non-integer priority', () => {
    expect(validateSourceGovernance({ ...good, priority: 0 }).valid).toBe(false)
    expect(validateSourceGovernance({ ...good, priority: 101 }).valid).toBe(false)
    expect(validateSourceGovernance({ ...good, priority: 3.5 }).valid).toBe(false)
  })

  it('rejects the contradictory Tier 1 + news/aggregator classification', () => {
    expect(validateSourceGovernance({ ...good, authorityType: 'aggregator' }).valid).toBe(false)
    expect(validateSourceGovernance({ ...good, authorityType: 'news_media' }).valid).toBe(false)
  })

  it('allows Tier 3 + aggregator (the normal signal shape)', () => {
    expect(
      validateSourceGovernance({ ...good, tier: 3, authorityType: 'aggregator' }).valid,
    ).toBe(true)
  })
})

describe('defaultSourceGovernance', () => {
  it('is the least-authoritative shape and cannot act as authority', () => {
    const d = defaultSourceGovernance()
    expect(d.tier).toBe(3)
    expect(canActAsDirectAuthority(d.tier)).toBe(false)
    // The default must itself be a valid classification.
    expect(validateSourceGovernance(d).valid).toBe(true)
  })
})

describe('compareSourcesForMonitoring', () => {
  it('orders authoritative tiers first, then by ascending priority, then name', () => {
    const t1 = makeSource({ id: 'a', name: 'Bravo', tier: 1, priority: 10 })
    const t1urgent = makeSource({ id: 'b', name: 'Alpha', tier: 1, priority: 1 })
    const t3 = makeSource({ id: 'c', name: 'Charlie', tier: 3, authorityType: 'news_media', priority: 1 })
    const unclassified = makeSource({ id: 'd', name: 'Delta', tier: null, priority: null })

    const ordered = [t3, unclassified, t1, t1urgent].sort(compareSourcesForMonitoring)
    expect(ordered.map(s => s.id)).toEqual(['b', 'a', 'c', 'd'])
  })
})

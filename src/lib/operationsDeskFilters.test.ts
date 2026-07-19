import { describe, expect, it } from 'vitest'
import type { OperationsDeskItem } from './operationsDesk'
import {
  EMPTY_FILTERS,
  countByPriority,
  filterOperationsDeskItems,
  matchesOperationsDeskSearch,
  presentOperationsDeskItems,
  sortOperationsDeskItems,
  summariseOperationsDeskItems,
} from './operationsDeskFilters'

function item(overrides: Partial<OperationsDeskItem> = {}): OperationsDeskItem {
  return {
    id: 'x',
    category: 'inventory-review',
    priority: 'normal',
    title: 'Batch awaiting review',
    entityLabel: 'Northern Lights · Test Farm',
    reason: 'Batch has been submitted and no review decision has been recorded.',
    statusLabel: 'Pending Review',
    destinationPage: 'ddp-inventory-review',
    actionLabel: 'Review',
    sourceEntityType: 'inventory-batch',
    sourceEntityId: 'batch-1',
    ...overrides,
  }
}

describe('Operations Desk sorting', () => {
  it('orders critical before high before normal', () => {
    const sorted = sortOperationsDeskItems([
      item({ id: 'n', priority: 'normal' }),
      item({ id: 'c', priority: 'critical' }),
      item({ id: 'h', priority: 'high' }),
    ])
    expect(sorted.map(i => i.id)).toEqual(['c', 'h', 'n'])
  })

  it('orders oldest first within a priority', () => {
    const sorted = sortOperationsDeskItems([
      item({ id: 'newer', priority: 'high', occurredAt: '2026-02-01T00:00:00.000Z' }),
      item({ id: 'older', priority: 'high', occurredAt: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(sorted.map(i => i.id)).toEqual(['older', 'newer'])
  })

  it('sorts undated items after dated ones rather than assuming a date', () => {
    const sorted = sortOperationsDeskItems([
      item({ id: 'undated', priority: 'high' }),
      item({ id: 'dated', priority: 'high', occurredAt: '2026-02-01T00:00:00.000Z' }),
    ])
    expect(sorted.map(i => i.id)).toEqual(['dated', 'undated'])
  })

  it('is deterministic regardless of input order', () => {
    const a = item({ id: 'a', priority: 'high', occurredAt: '2026-01-01T00:00:00.000Z' })
    const b = item({ id: 'b', priority: 'high', occurredAt: '2026-01-01T00:00:00.000Z' })
    expect(sortOperationsDeskItems([a, b]).map(i => i.id))
      .toEqual(sortOperationsDeskItems([b, a]).map(i => i.id))
  })

  it('does not mutate the input array', () => {
    const input = [item({ id: 'n', priority: 'normal' }), item({ id: 'c', priority: 'critical' })]
    sortOperationsDeskItems(input)
    expect(input.map(i => i.id)).toEqual(['n', 'c'])
  })

  it('treats an unparseable date as undated rather than throwing', () => {
    const sorted = sortOperationsDeskItems([
      item({ id: 'bad', priority: 'high', occurredAt: 'not-a-date' }),
      item({ id: 'good', priority: 'high', occurredAt: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(sorted.map(i => i.id)).toEqual(['good', 'bad'])
  })
})

describe('Operations Desk search and filtering', () => {
  const items = [
    item({ id: '1', category: 'coa', priority: 'critical', title: 'COA not on file', entityLabel: 'Sour Diesel · Green Valley' }),
    item({ id: '2', category: 'compliance', priority: 'high', title: 'Licence renewal published', entityLabel: 'farm · farm-2' }),
    item({ id: '3', category: 'onboarding', priority: 'normal', title: 'Onboarding incomplete', entityLabel: 'Hilltop Farm' }),
  ]

  it('returns everything when unfiltered', () => {
    expect(filterOperationsDeskItems(items, EMPTY_FILTERS)).toHaveLength(3)
  })

  it('filters by category', () => {
    const result = filterOperationsDeskItems(items, { ...EMPTY_FILTERS, category: 'coa' })
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('filters by priority', () => {
    const result = filterOperationsDeskItems(items, { ...EMPTY_FILTERS, priority: 'normal' })
    expect(result.map(i => i.id)).toEqual(['3'])
  })

  it('combines category and priority filters', () => {
    const result = filterOperationsDeskItems(items, { ...EMPTY_FILTERS, category: 'coa', priority: 'normal' })
    expect(result).toHaveLength(0)
  })

  it('searches across title, entity, reason, status and category label', () => {
    expect(matchesOperationsDeskSearch(items[0], 'sour diesel')).toBe(true)
    expect(matchesOperationsDeskSearch(items[0], 'COA')).toBe(true)
    expect(matchesOperationsDeskSearch(items[0], 'Pending Review')).toBe(true)
    expect(matchesOperationsDeskSearch(items[2], 'Onboarding')).toBe(true)
    expect(matchesOperationsDeskSearch(items[0], 'nonexistent term')).toBe(false)
  })

  it('search is case-insensitive and ignores surrounding whitespace', () => {
    expect(matchesOperationsDeskSearch(items[1], '  LICENCE  ')).toBe(true)
  })

  it('an empty or whitespace-only search hides nothing', () => {
    expect(filterOperationsDeskItems(items, { ...EMPTY_FILTERS, search: '   ' })).toHaveLength(3)
  })

  it('presents filtered results in sorted order', () => {
    const result = presentOperationsDeskItems(items, EMPTY_FILTERS)
    expect(result.map(i => i.priority)).toEqual(['critical', 'high', 'normal'])
  })
})

describe('Operations Desk summary', () => {
  const items = [
    item({ id: '1', category: 'farmer-approval' }),
    item({ id: '2', category: 'inventory-review' }),
    item({ id: '3', category: 'document' }),
    item({ id: '4', category: 'coa' }),
    item({ id: '5', category: 'compliance' }),
    item({ id: '6', category: 'onboarding' }),
    item({ id: '7', category: 'follow-up' }),
  ]

  it('counts each group from real items only', () => {
    const summary = summariseOperationsDeskItems(items)
    const byKey = Object.fromEntries(summary.map(g => [g.key, g.count]))
    expect(byKey.decision).toBe(2)   // farmer-approval + inventory-review
    expect(byKey.evidence).toBe(2)   // document + coa
    expect(byKey.compliance).toBe(1)
    expect(byKey.onboarding).toBe(1)
    expect(byKey.followup).toBe(1)
  })

  it('offers no due-date or Buyer Pack group, since neither has a real source', () => {
    const keys = summariseOperationsDeskItems(items).map(g => g.key)
    expect(keys).not.toContain('due')
    expect(keys).not.toContain('buyerpack')
    const labels = summariseOperationsDeskItems(items).map(g => g.label.toLowerCase()).join(' ')
    expect(labels).not.toContain('due')
    expect(labels).not.toContain('buyer pack')
    expect(labels).not.toContain('overdue')
  })

  it('reports zero counts rather than omitting a group', () => {
    expect(summariseOperationsDeskItems([])).toHaveLength(5)
    expect(summariseOperationsDeskItems([]).every(g => g.count === 0)).toBe(true)
  })

  it('counts by priority', () => {
    expect(countByPriority([item({ priority: 'critical' }), item({ priority: 'high' })], 'critical')).toBe(1)
  })
})

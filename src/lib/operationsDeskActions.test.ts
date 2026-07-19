import { describe, it, expect } from 'vitest'
import { operationsDeskActionAvailable, resolveOperationsDeskRoute } from './operationsDeskActions'
import type { OperationsDeskItem } from './operationsDesk'

function item(over: Partial<OperationsDeskItem> = {}): OperationsDeskItem {
  return {
    id: 'x',
    category: 'follow-up',
    priority: 'medium',
    title: 'Information request still open',
    entityLabel: 'Mango · Calli Krush',
    reason: 'r',
    statusLabel: 'open',
    destinationPage: 'ddp-inventory-review',
    actionLabel: 'Review',
    sourceEntityType: 'review-request',
    sourceEntityId: 'r',
    ...over,
  } as OperationsDeskItem
}

const FARMS = new Set(['farm-1'])
const ITEMS = new Set(['batch-1'])

describe('operationsDeskActionAvailable / resolveOperationsDeskRoute', () => {
  it('existing stock target → enabled, routes to inventory review', () => {
    const it0 = item({ destinationPage: 'ddp-inventory-review', destinationParams: { itemId: 'batch-1' } })
    expect(operationsDeskActionAvailable(it0, FARMS, ITEMS)).toBe(true)
    expect(resolveOperationsDeskRoute(it0, FARMS, ITEMS)).toEqual({ kind: 'open-item', itemId: 'batch-1' })
  })

  it('missing stock target → disabled, route is none (no callback)', () => {
    const it0 = item({ destinationPage: 'ddp-inventory-review', destinationParams: { itemId: 'batch-GONE' } })
    expect(operationsDeskActionAvailable(it0, FARMS, ITEMS)).toBe(false)
    expect(resolveOperationsDeskRoute(it0, FARMS, ITEMS)).toEqual({ kind: 'none' })
  })

  it('existing farm target → enabled, routes to farm review', () => {
    const it0 = item({ destinationPage: 'ddp-farm-review', destinationParams: { farmId: 'farm-1' }, actionLabel: 'Open farm' })
    expect(operationsDeskActionAvailable(it0, FARMS, ITEMS)).toBe(true)
    expect(resolveOperationsDeskRoute(it0, FARMS, ITEMS)).toEqual({ kind: 'open-farm', farmId: 'farm-1' })
  })

  it('missing farm target → disabled, route is none (no callback)', () => {
    const it0 = item({ destinationPage: 'ddp-farm-review', destinationParams: { farmId: 'farm-GONE' }, actionLabel: 'Open farm' })
    expect(operationsDeskActionAvailable(it0, FARMS, ITEMS)).toBe(false)
    expect(resolveOperationsDeskRoute(it0, FARMS, ITEMS)).toEqual({ kind: 'none' })
  })

  it('partial failure: valid half stays actionable while the missing half is disabled', () => {
    // farms loaded, inventory failed (empty set)
    const farmOk = item({ destinationPage: 'ddp-farm-review', destinationParams: { farmId: 'farm-1' } })
    const itemGone = item({ destinationPage: 'ddp-inventory-review', destinationParams: { itemId: 'batch-1' } })
    expect(operationsDeskActionAvailable(farmOk, FARMS, new Set())).toBe(true)
    expect(operationsDeskActionAvailable(itemGone, FARMS, new Set())).toBe(false)
  })

  it('loading/failure (empty sets) never routes a detail action to a missing record', () => {
    for (const page of ['ddp-farm-review', 'ddp-inventory-review'] as const) {
      const it0 = item({ destinationPage: page, destinationParams: page === 'ddp-farm-review' ? { farmId: 'farm-1' } : { itemId: 'batch-1' } })
      expect(resolveOperationsDeskRoute(it0, new Set(), new Set())).toEqual({ kind: 'none' })
    }
  })

  it('a malformed detail request (no target id) is disabled', () => {
    expect(operationsDeskActionAvailable(item({ destinationPage: 'ddp-farm-review', destinationParams: undefined }), FARMS, ITEMS)).toBe(false)
    expect(operationsDeskActionAvailable(item({ destinationPage: 'ddp-inventory-review', destinationParams: undefined }), FARMS, ITEMS)).toBe(false)
  })

  it('non-detail destinations carry no per-record target and stay available', () => {
    for (const page of ['ddp-farms', 'ddp-compliance-watchtower', 'ddp-risk-register'] as const) {
      const it0 = item({ destinationPage: page, destinationParams: undefined })
      expect(operationsDeskActionAvailable(it0, new Set(), new Set())).toBe(true)
      expect(resolveOperationsDeskRoute(it0, new Set(), new Set())).toEqual({ kind: 'go', page })
    }
  })
})

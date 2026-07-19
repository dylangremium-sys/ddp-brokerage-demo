import { describe, expect, it } from 'vitest'
import { buildOperationsDeskItems, type OperationsDeskInput } from './operationsDesk'
import { makeFarm, makeInventoryItem } from './testFixtures'
import type { ComplianceAlert, ReviewRequest } from '../types'
import { REQUIREMENT_OVERRIDE_KEY, RISK_OVERRIDE_KEY } from './procurementControl'

const NOW = new Date('2026-03-01T00:00:00.000Z')

function input(overrides: Partial<OperationsDeskInput> = {}): OperationsDeskInput {
  return {
    farms: [],
    inventory: [],
    reviewRequests: [],
    complianceAlerts: [],
    now: NOW,
    ...overrides,
  }
}

function alert(overrides: Partial<ComplianceAlert> = {}): ComplianceAlert {
  return {
    id: 'alert-1',
    entityType: 'farm',
    entityId: 'farm-1',
    alertTitle: 'Licence renewal published',
    alertDetail: 'A regulatory update affects this farm.',
    severity: 'medium',
    status: 'open',
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  } as ComplianceAlert
}

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: 'req-1',
    requestType: 'coa',
    message: 'Please supply a current COA.',
    status: 'open',
    createdBy: 'admin-1',
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

function categories(result: ReturnType<typeof buildOperationsDeskItems>) {
  return result.items.map(i => i.category)
}

describe('Operations Desk aggregation — inclusion conditions', () => {
  it('queues a farm submitted to DDP for review', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ id: 'farm-9', status: 'Submitted to DDP' })],
    }))
    const item = result.items.find(i => i.category === 'farmer-approval')
    expect(item).toBeDefined()
    expect(item!.priority).toBe('high')
    expect(item!.destinationPage).toBe('ddp-farm-review')
    expect(item!.destinationParams).toEqual({ farmId: 'farm-9' })
  })

  it('queues a farm under review', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Under Review' })],
    }))
    expect(categories(result)).toContain('farmer-approval')
  })

  it('excludes an approved farm with no attention condition', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Approved', completionPct: 100 })],
    }))
    expect(categories(result)).not.toContain('farmer-approval')
    expect(categories(result)).not.toContain('onboarding')
  })

  it('queues an incomplete draft onboarding at normal priority and states the figure factually', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Draft', completionPct: 45 })],
    }))
    const item = result.items.find(i => i.category === 'onboarding')
    expect(item).toBeDefined()
    expect(item!.priority).toBe('normal')
    expect(item!.reason).toContain('45%')
  })

  it('does not queue a complete draft', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Draft', completionPct: 100 })],
    }))
    expect(categories(result)).not.toContain('onboarding')
  })

  it('queues missing documents from the authoritative requirement derivation', () => {
    const result = buildOperationsDeskItems(input({ farms: [makeFarm()] }))
    const docs = result.items.filter(i => i.category === 'document')
    expect(docs.length).toBeGreaterThan(0)
    expect(docs.every(d => d.destinationPage === 'ddp-missing-documents')).toBe(true)
    // A bare farm has no received files, so requirements read missing → high.
    expect(docs.some(d => d.priority === 'high')).toBe(true)
  })

  it('queues a batch awaiting review and links to the authoritative review page', () => {
    const result = buildOperationsDeskItems(input({
      inventory: [makeInventoryItem({ id: 'batch-7', status: 'Pending Review' })],
    }))
    const item = result.items.find(i => i.category === 'inventory-review')
    expect(item).toBeDefined()
    expect(item!.priority).toBe('high')
    expect(item!.destinationPage).toBe('ddp-inventory-review')
    expect(item!.destinationParams).toEqual({ itemId: 'batch-7' })
  })

  it('queues a batch flagged as missing a document', () => {
    const result = buildOperationsDeskItems(input({
      inventory: [makeInventoryItem({ status: 'Missing Document' })],
    }))
    const item = result.items.find(i => i.category === 'inventory-review')
    expect(item!.priority).toBe('high')
  })

  it('excludes an approved batch', () => {
    const result = buildOperationsDeskItems(input({
      inventory: [makeInventoryItem({ status: 'Approved' })],
    }))
    expect(result.items.some(i => i.id.startsWith('inventory-review:batch:'))).toBe(false)
  })

  it('queues a COA matter using deriveCoaIntelligence red flags, not file age', () => {
    const result = buildOperationsDeskItems(input({
      inventory: [makeInventoryItem({ status: 'Approved' })],
    }))
    const coa = result.items.find(i => i.category === 'coa')
    expect(coa).toBeDefined()
    expect(coa!.destinationPage).toBe('ddp-coa-intelligence')
    expect(coa!.reason.length).toBeGreaterThan(0)
  })

  it('treats a failed COA test as a critical blocker via deriveAutoRisks', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm()],
      inventory: [makeInventoryItem({ status: 'Approved', heavyMetalsStatus: 'fail' })],
    }))
    const blocker = result.items.find(i => i.id.startsWith('inventory-review:risk:'))
    expect(blocker).toBeDefined()
    expect(blocker!.priority).toBe('critical')
    expect(blocker!.destinationPage).toBe('ddp-risk-register')
  })

  it('queues unresolved compliance alerts and maps severity to priority', () => {
    const result = buildOperationsDeskItems(input({
      complianceAlerts: [
        alert({ id: 'a-crit', severity: 'critical', status: 'open' }),
        alert({ id: 'a-high', severity: 'high', status: 'in_review' }),
        alert({ id: 'a-low', severity: 'low', status: 'blocked' }),
      ],
    }))
    const compliance = result.items.filter(i => i.category === 'compliance')
    expect(compliance).toHaveLength(3)
    expect(compliance.find(i => i.sourceEntityId === 'a-crit')!.priority).toBe('critical')
    expect(compliance.find(i => i.sourceEntityId === 'a-high')!.priority).toBe('high')
    expect(compliance.find(i => i.sourceEntityId === 'a-low')!.priority).toBe('normal')
    expect(compliance.every(i => i.destinationPage === 'ddp-compliance-watchtower')).toBe(true)
  })

  it('excludes resolved and dismissed compliance alerts', () => {
    const result = buildOperationsDeskItems(input({
      complianceAlerts: [
        alert({ id: 'a-resolved', status: 'resolved' }),
        alert({ id: 'a-dismissed', status: 'dismissed' }),
      ],
    }))
    expect(categories(result)).not.toContain('compliance')
  })

  it('queues open review requests as follow-up and excludes resolved ones', () => {
    const result = buildOperationsDeskItems(input({
      reviewRequests: [
        reviewRequest({ id: 'r-open', status: 'open', stockItemId: 'batch-3' }),
        reviewRequest({ id: 'r-done', status: 'resolved' }),
      ],
    }))
    const followUps = result.items.filter(i => i.category === 'follow-up')
    expect(followUps).toHaveLength(1)
    expect(followUps[0].sourceEntityId).toBe('r-open')
    expect(followUps[0].destinationPage).toBe('ddp-inventory-review')
  })

  it('routes a stock-level follow-up to the inventory review with its item id', () => {
    const result = buildOperationsDeskItems(input({
      // farmProfileId is also present, but a batch-linked request must still
      // open the inventory record — never the farm review.
      reviewRequests: [reviewRequest({ id: 'r-stock', status: 'open', stockItemId: 'batch-9', farmProfileId: 'farm-9' })],
    }))
    const item = result.items.find(i => i.sourceEntityId === 'r-stock')!
    expect(item.destinationPage).toBe('ddp-inventory-review')
    expect(item.destinationParams).toEqual({ itemId: 'batch-9' })
    expect(item.actionLabel).toBe('Review')
  })

  it('routes a farm-level follow-up to that farm’s review, not the generic farm list', () => {
    const result = buildOperationsDeskItems(input({
      // farm-level request: farmProfileId set, no batch — surfaced by the admin loader.
      reviewRequests: [reviewRequest({ id: 'r-farm', status: 'open', stockItemId: undefined, farmProfileId: 'farm-42' })],
    }))
    const item = result.items.find(i => i.sourceEntityId === 'r-farm')!
    expect(item.destinationPage).toBe('ddp-farm-review')
    expect(item.destinationParams).toEqual({ farmId: 'farm-42' })
    expect(item.destinationPage).not.toBe('ddp-farms')
    expect(item.actionLabel).toBe('Open farm')
  })

  it('keeps the safe farm-list fallback for a request with neither identifier', () => {
    const result = buildOperationsDeskItems(input({
      reviewRequests: [reviewRequest({ id: 'r-none', status: 'open', stockItemId: undefined, farmProfileId: undefined })],
    }))
    const item = result.items.find(i => i.sourceEntityId === 'r-none')!
    expect(item.destinationPage).toBe('ddp-farms')
    expect(item.destinationParams).toBeUndefined()
  })

  it('queues a farm awaiting more information as follow-up', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'More Information Required' })],
    }))
    expect(result.items.some(i => i.id.startsWith('follow-up:farm:'))).toBe(true)
  })

  it('produces a human-readable reason for every item', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Submitted to DDP' }), makeFarm({ id: 'f2', status: 'Draft', completionPct: 10 })],
      inventory: [makeInventoryItem({ status: 'Pending Review' })],
      complianceAlerts: [alert()],
      reviewRequests: [reviewRequest()],
    }))
    expect(result.items.length).toBeGreaterThan(0)
    for (const item of result.items) {
      expect(item.reason.trim().length).toBeGreaterThan(10)
      expect(item.title.trim().length).toBeGreaterThan(0)
      expect(item.entityLabel.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('Operations Desk aggregation — safety and integrity', () => {
  it('never yields duplicate ids even when the same record appears twice', () => {
    const farm = makeFarm({ status: 'Submitted to DDP' })
    const item = makeInventoryItem({ status: 'Pending Review' })
    const result = buildOperationsDeskItems(input({
      farms: [farm, { ...farm }],
      inventory: [item, { ...item }],
    }))
    const ids = result.items.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ids are unique across categories when every queue is populated at once', () => {
    // The same farm and the same batch legitimately appear in several queues.
    // Each id is category-prefixed, so those must not collide with each other.
    const result = buildOperationsDeskItems(input({
      farms: [
        makeFarm({ id: 'farm-a', status: 'Submitted to DDP' }),
        makeFarm({ id: 'farm-b', status: 'Draft', completionPct: 20 }),
        makeFarm({ id: 'farm-c', status: 'More Information Required' }),
      ],
      inventory: [
        makeInventoryItem({ id: 'batch-a', farmId: 'farm-a', status: 'Pending Review', heavyMetalsStatus: 'fail' }),
        makeInventoryItem({ id: 'batch-b', farmId: 'farm-b', status: 'Missing Document' }),
      ],
      complianceAlerts: [alert({ id: 'alert-x' })],
      reviewRequests: [reviewRequest({ id: 'req-x', stockItemId: 'batch-a' })],
    }))

    // All seven queues represented, so the check is meaningful.
    expect(new Set(result.items.map(i => i.category)).size).toBe(7)
    const ids = result.items.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)

    // A farm appearing in two queues yields two distinct, category-scoped ids.
    expect(ids).toContain('farmer-approval:farm:farm-a')
    expect(ids.some(id => id.startsWith('document:farm:farm-a:'))).toBe(true)
  })

  it('handles a missing or invalid date without inventing one', () => {
    const result = buildOperationsDeskItems(input({
      farms: [
        makeFarm({ id: 'f-nodate', status: 'Submitted to DDP', submittedAt: '' }),
        makeFarm({ id: 'f-baddate', status: 'Submitted to DDP', submittedAt: 'not-a-date' }),
      ],
    }))
    const items = result.items.filter(i => i.category === 'farmer-approval')
    expect(items).toHaveLength(2)
    for (const item of items) expect(item.ageInDays).toBeUndefined()
  })

  it('never reports a negative age for a future-dated record', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Submitted to DDP', submittedAt: '2027-01-01T00:00:00.000Z' })],
    }))
    expect(result.items[0].ageInDays).toBe(0)
  })

  it('reports age factually from the recorded date', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Submitted to DDP', submittedAt: '2026-02-19T00:00:00.000Z' })],
    }))
    expect(result.items[0].ageInDays).toBe(10)
  })

  it('distinguishes an unavailable compliance source from an empty one', () => {
    const failed = buildOperationsDeskItems(input({ complianceAlerts: null }))
    expect(failed.failures).toHaveLength(1)
    expect(failed.failures[0].category).toBe('compliance')

    const empty = buildOperationsDeskItems(input({ complianceAlerts: [] }))
    expect(empty.failures).toHaveLength(0)
  })

  it('distinguishes an unavailable review-request source from an empty one', () => {
    // null = the admin fetch failed → report the gap, never a silent zero.
    const failed = buildOperationsDeskItems(input({ reviewRequests: null }))
    expect(failed.failures.some(f => f.category === 'follow-up')).toBe(true)
    // No review-request follow-up item is fabricated on failure.
    expect(failed.items.some(i => i.id.startsWith('follow-up:review-request:'))).toBe(false)

    // [] = loaded and genuinely empty → no failure, no follow-up request items.
    const empty = buildOperationsDeskItems(input({ reviewRequests: [] }))
    expect(empty.failures.some(f => f.category === 'follow-up')).toBe(false)
    expect(empty.items.some(i => i.id.startsWith('follow-up:review-request:'))).toBe(false)
  })

  it('still surfaces farm follow-ups and other matters when the review-request source failed', () => {
    // A failed review-request load must not blank the rest of the desk.
    const result = buildOperationsDeskItems(input({
      reviewRequests: null,
      farms: [makeFarm({ status: 'More Information Required' }), makeFarm({ id: 'f2', status: 'Submitted to DDP' })],
    }))
    expect(result.items.some(i => i.id.startsWith('follow-up:farm:'))).toBe(true)
    expect(result.items.some(i => i.category === 'farmer-approval')).toBe(true)
    // The gap is reported alongside the still-usable matters.
    expect(result.failures.some(f => f.category === 'follow-up')).toBe(true)
  })

  it('degrades a throwing queue to a visible failure instead of a silent all-clear', () => {
    // A farm whose getter throws simulates a corrupt record reaching the desk.
    const hostile = makeFarm({ status: 'Approved' })
    Object.defineProperty(hostile, 'tradingName', {
      get() { throw new Error('corrupt farm record') },
    })
    const result = buildOperationsDeskItems(input({ farms: [hostile] }))
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures.some(f => f.message.includes('corrupt farm record'))).toBe(true)
  })

  it('tolerates empty input and reports nothing rather than failing', () => {
    const result = buildOperationsDeskItems(input())
    expect(result.items).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('is deterministic — identical input yields an identical projection', () => {
    const args = input({
      farms: [makeFarm({ status: 'Submitted to DDP' })],
      inventory: [makeInventoryItem({ status: 'Pending Review' })],
      complianceAlerts: [alert()],
    })
    expect(JSON.stringify(buildOperationsDeskItems(args)))
      .toEqual(JSON.stringify(buildOperationsDeskItems(args)))
  })

  it('every destination targets a real authoritative admin page', () => {
    const AUTHORITATIVE: string[] = [
      'ddp-farm-review', 'ddp-missing-documents', 'ddp-coa-intelligence',
      'ddp-inventory-review', 'ddp-risk-register', 'ddp-compliance-watchtower', 'ddp-farms',
    ]
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Submitted to DDP' }), makeFarm({ id: 'f2', status: 'Draft', completionPct: 5 })],
      inventory: [makeInventoryItem({ status: 'Pending Review', heavyMetalsStatus: 'fail' })],
      complianceAlerts: [alert()],
      reviewRequests: [reviewRequest()],
    }))
    expect(result.items.length).toBeGreaterThan(0)
    for (const item of result.items) {
      expect(AUTHORITATIVE).toContain(item.destinationPage)
      // The desk must never point at itself — it resolves nothing.
      expect(item.destinationPage).not.toBe('ddp-operations-desk')
    }
  })

  it('never routes a matter to Buyer Preview or Buyer Pack issuance', () => {
    const result = buildOperationsDeskItems(input({
      farms: [makeFarm({ status: 'Submitted to DDP' })],
      inventory: [makeInventoryItem({ status: 'Pending Review' })],
      complianceAlerts: [alert()],
    }))
    expect(result.items.some(i => i.destinationPage === 'ddp-buyer')).toBe(false)
    expect(result.items.some(i => i.category === ('buyer-pack' as never))).toBe(false)
  })

  it('reads the browser-local override keys only through procurementControl', () => {
    // The desk introduces no storage key of its own — the two it depends on
    // are procurementControl's existing ones, registered there.
    expect(REQUIREMENT_OVERRIDE_KEY).toBe('ddp_requirement_overrides')
    expect(RISK_OVERRIDE_KEY).toBe('ddp_risk_overrides')
  })
})

describe('Operations Desk — unavailable inventory does not fabricate document gaps', () => {
  const INV_DEPENDENT = ['coa', 'batch_number', 'inventory_quantity_proof', 'inventory_photos', 'inventory_video', 'storage_evidence', 'chain_of_custody']

  it('inventory unavailable (null): NO inventory/batch-dependent document requirements', () => {
    const result = buildOperationsDeskItems(input({ farms: [makeFarm({ id: 'f1' })], inventory: null }))
    const docIds = result.items.filter(i => i.category === 'document').map(i => i.id)
    for (const t of INV_DEPENDENT) expect(docIds).not.toContain(`document:farm:f1:${t}`)
  })

  it('inventory unavailable (null): farm-only requirements still appear', () => {
    const result = buildOperationsDeskItems(input({ farms: [makeFarm({ id: 'f1' })], inventory: null }))
    const docIds = result.items.filter(i => i.category === 'document').map(i => i.id)
    expect(docIds).toContain('document:farm:f1:farm_license') // derived from FarmProfile only
  })

  it('inventory genuinely loaded as [] preserves the original requirements (incl. COA missing)', () => {
    const result = buildOperationsDeskItems(input({ farms: [makeFarm({ id: 'f1' })], inventory: [] }))
    const docIds = result.items.filter(i => i.category === 'document').map(i => i.id)
    expect(docIds).toContain('document:farm:f1:farm_license')
    expect(docIds).toContain('document:farm:f1:coa') // genuinely no batches → COA genuinely missing
  })

  it('inventory unavailable (null): farm approval / onboarding / follow-up queues remain', () => {
    expect(buildOperationsDeskItems(input({ farms: [makeFarm({ status: 'Submitted to DDP' })], inventory: null }))
      .items.some(i => i.category === 'farmer-approval')).toBe(true)
    expect(buildOperationsDeskItems(input({ farms: [makeFarm({ status: 'Draft', completionPct: 20 })], inventory: null }))
      .items.some(i => i.category === 'onboarding')).toBe(true)
    expect(buildOperationsDeskItems(input({ farms: [makeFarm({ status: 'More Information Required' })], inventory: null }))
      .items.some(i => i.id.startsWith('follow-up:farm:'))).toBe(true)
  })

  it('inventory unavailable (null): farm-derived risks remain, inventory-derived risks do not', () => {
    // A Watchlist farm produces a HIGH farm-derived risk (surfaced by the risk
    // queue); it must survive an unavailable inventory, while no batch risk exists.
    const result = buildOperationsDeskItems(input({ farms: [makeFarm({ id: 'f1', status: 'Watchlist' })], inventory: null }))
    expect(result.items.some(i => i.id.includes('risk-farm-f1'))).toBe(true) // farm-derived risk kept
    expect(result.items.some(i => i.id.includes(':risk:risk-batch'))).toBe(false) // no batch risk
  })

  it('inventory unavailable (null): no COA or inventory-review rows (no stale inventory leaks)', () => {
    const result = buildOperationsDeskItems(input({ farms: [makeFarm({ id: 'f1' })], inventory: null }))
    expect(result.items.some(i => i.category === 'coa')).toBe(false)
    expect(result.items.some(i => i.id.startsWith('inventory-review:batch:'))).toBe(false)
  })

  it('inventory available with records: full document / COA / inventory-review behaviour remains', () => {
    const item = makeInventoryItem({ id: 'b1', status: 'Pending Review', coaAvailable: false, coaStoragePath: undefined, certFileName: '' })
    const result = buildOperationsDeskItems(input({ farms: [makeFarm({ id: 'f1' })], inventory: [item] }))
    expect(result.items.some(i => i.id === 'inventory-review:batch:b1')).toBe(true)
    expect(result.items.some(i => i.category === 'coa')).toBe(true)
    // batch-dependent document requirements are back when inventory is available
    expect(result.items.some(i => i.id === 'document:farm:f1:coa')).toBe(true)
  })
})

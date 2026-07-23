import { describe, it, expect } from 'vitest'
import {
  buildEvidenceRequestDeskItems,
  evidenceDeskGroupIndex,
  evidenceDeskPriority,
} from './evidenceRequestDesk'
import { buildOperationsDeskItems, CATEGORY_LABEL } from './operationsDesk'
import { presentOperationsDeskItems, EMPTY_FILTERS } from './operationsDeskFilters'
import { resolveOperationsDeskEmptyState } from './operationsDeskEmptyState'
import { operationsDeskActionAvailable, resolveOperationsDeskRoute } from './operationsDeskActions'
import {
  EVIDENCE_REQUEST_STATUSES,
  type EvidenceRequestListItem,
  type EvidenceRequestPriority,
  type EvidenceRequestStatus,
} from '../domain/evidenceRequests'

/**
 * Operations Desk conformance (contract v1.5 §11) and the failure-state rules of
 * §9.6/§11.5 that stop the desk claiming an all-clear on incomplete data.
 */

const NOW = new Date('2026-07-10T12:00:00Z')

function request(over: Partial<EvidenceRequestListItem> = {}): EvidenceRequestListItem {
  return {
    id: 'req-1',
    farmId: 'farm-1',
    target: { type: 'farm_profile', farmProfileId: 'fp-1' },
    category: 'farm_license',
    title: 'Provide the current export licence',
    explanation: 'The licence on file has no visible expiry date.',
    priority: 'normal',
    dueDate: null,
    status: 'open',
    revision: 1,
    createdByUserId: 'admin-1',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    statusChangedAt: '2026-07-01T00:00:00Z',
    closedAt: null,
    targetLabel: 'Farm profile — Green Valley',
    targetAvailable: true,
    ...over,
  }
}

const EMPTY_DESK_INPUT = {
  farms: [],
  inventory: [],
  reviewRequests: [],
  complianceAlerts: [],
  now: NOW,
}

describe('included statuses (§11.2)', () => {
  it.each(['open', 'farmer_submitted', 'clarification_requested'] as EvidenceRequestStatus[])(
    'includes active status %s',
    status => {
      expect(buildEvidenceRequestDeskItems([request({ status })], NOW)).toHaveLength(1)
    },
  )

  it.each(['resolved', 'rejected', 'cancelled'] as EvidenceRequestStatus[])(
    'excludes terminal status %s',
    status => {
      expect(buildEvidenceRequestDeskItems([request({ status })], NOW)).toHaveLength(0)
    },
  )

  it('covers every status — none is silently unhandled', () => {
    const included = EVIDENCE_REQUEST_STATUSES.filter(
      status => buildEvidenceRequestDeskItems([request({ status })], NOW).length === 1,
    )
    expect(included).toEqual(['open', 'farmer_submitted', 'clarification_requested'])
  })
})

describe('canonical row (§11.3)', () => {
  const [row] = buildEvidenceRequestDeskItems(
    [request({ statusChangedAt: '2026-07-05T12:00:00Z', priority: 'high' })],
    NOW,
  )

  it('is filed under the "Evidence requests" queue category', () => {
    expect(row.category).toBe('evidence-request')
    expect(CATEGORY_LABEL['evidence-request']).toBe('Evidence requests')
  })

  it('uses the request title', () => {
    expect(row.title).toBe('Provide the current export licence')
  })

  it('shows the status label in the subtitle and the target as the entity', () => {
    expect(row.statusLabel).toBe('Awaiting farmer response')
    expect(row.entityLabel).toBe('Farm profile — Green Valley')
    expect(row.reason).toContain('Awaiting farmer response')
  })

  it('measures age from status_changed_at, not created_at', () => {
    expect(row.occurredAt).toBe('2026-07-05T12:00:00Z')
    expect(row.ageInDays).toBe(5)
  })

  it('labels the action "Open request" and routes to the detail page', () => {
    expect(row.actionLabel).toBe('Open request')
    expect(row.destinationPage).toBe('admin-evidence-request-detail')
    expect(row.destinationParams).toEqual({ requestId: 'req-1' })
  })

  it('has a stable, namespaced id that cannot collide with another queue', () => {
    expect(row.id).toBe('evidence-request:req-1')
  })
})

describe('target-unavailable behaviour (§11.4)', () => {
  const rows = buildEvidenceRequestDeskItems(
    [request({ targetAvailable: false, targetLabel: null })],
    NOW,
  )

  it('does NOT remove the row', () => {
    expect(rows).toHaveLength(1)
  })

  it('uses the exact contract wording', () => {
    expect(rows[0].entityLabel).toBe('Target unavailable — human review required')
  })

  it('still opens the evidence-request detail page', () => {
    const route = resolveOperationsDeskRoute(rows[0], new Set(), new Set())
    expect(route).toEqual({ kind: 'open-evidence-request', requestId: 'req-1' })
  })

  it('keeps the action enabled — no loaded-target check applies to it', () => {
    expect(operationsDeskActionAvailable(rows[0], new Set(), new Set())).toBe(true)
  })
})

describe('priority ordering (§11.6)', () => {
  const PRIORITIES: EvidenceRequestPriority[] = ['urgent', 'high', 'normal', 'low']

  it('assigns the eight canonical groups in contract order', () => {
    const groups = PRIORITIES.flatMap(priority => [
      { label: `${priority} overdue`, index: evidenceDeskGroupIndex(priority, true) },
      { label: priority, index: evidenceDeskGroupIndex(priority, false) },
    ])
    expect(groups.map(g => g.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('projects priority monotonically onto the desk display priority', () => {
    expect(evidenceDeskPriority('urgent')).toBe('critical')
    expect(evidenceDeskPriority('high')).toBe('high')
    expect(evidenceDeskPriority('normal')).toBe('normal')
    expect(evidenceDeskPriority('low')).toBe('normal')
  })

  it('sorts the full eight-group order end to end through the desk sorter', () => {
    // One request per group, deliberately supplied in reverse contract order so
    // a sorter that preserved input order would fail.
    const requests = PRIORITIES.flatMap(priority =>
      [false, true].map(overdue =>
        request({
          id: `${priority}-${overdue ? 'overdue' : 'ontime'}`,
          priority,
          // Overdue = due before today; on-time = due in the future.
          dueDate: overdue ? '2026-07-01' : '2026-08-01',
          statusChangedAt: '2026-07-01T00:00:00Z',
        }),
      ),
    ).reverse()

    const built = buildEvidenceRequestDeskItems(requests, NOW)
    const sorted = presentOperationsDeskItems(built, EMPTY_FILTERS)

    expect(sorted.map(r => r.sourceEntityId)).toEqual([
      'urgent-overdue',
      'urgent-ontime',
      'high-overdue',
      'high-ontime',
      'normal-overdue',
      'normal-ontime',
      'low-overdue',
      'low-ontime',
    ])
  })

  it('puts the oldest status_changed_at first within one group', () => {
    const built = buildEvidenceRequestDeskItems(
      [
        request({ id: 'newer', statusChangedAt: '2026-07-09T00:00:00Z' }),
        request({ id: 'older', statusChangedAt: '2026-07-02T00:00:00Z' }),
      ],
      NOW,
    )
    const sorted = presentOperationsDeskItems(built, EMPTY_FILTERS)
    expect(sorted.map(r => r.sourceEntityId)).toEqual(['older', 'newer'])
  })
})

describe('desk aggregation and all-clear blocking (§11.5, §9.6)', () => {
  it('adds no evidence failure when the source was never supplied', () => {
    const result = buildOperationsDeskItems(EMPTY_DESK_INPUT)
    expect(result.failures.filter(f => f.category === 'evidence-request')).toHaveLength(0)
  })

  it('records a FAILURE when the evidence source is null (loading/failed/unavailable)', () => {
    const result = buildOperationsDeskItems({ ...EMPTY_DESK_INPUT, evidenceRequests: null })
    expect(result.failures.filter(f => f.category === 'evidence-request')).toHaveLength(1)
  })

  it('surfaces the supplied reason so the operator sees what is missing', () => {
    const result = buildOperationsDeskItems({
      ...EMPTY_DESK_INPUT,
      evidenceRequests: null,
      evidenceRequestsUnavailableReason: 'Evidence requests could not be loaded.',
    })
    expect(result.failures[0].message).toBe('Evidence requests could not be loaded.')
  })

  it('a null evidence source blocks the all-clear even with zero visible rows', () => {
    const result = buildOperationsDeskItems({ ...EMPTY_DESK_INPUT, evidenceRequests: null })
    const emptyState = resolveOperationsDeskEmptyState({
      visibleCount: 0,
      failureCount: result.failures.length,
      hasPendingSources: false,
      isFiltered: false,
    })
    expect(emptyState).toBe('failed')
    expect(emptyState).not.toBe('all-clear')
  })

  it('an EMPTY but successful evidence load permits the all-clear', () => {
    const result = buildOperationsDeskItems({ ...EMPTY_DESK_INPUT, evidenceRequests: [] })
    expect(result.failures).toHaveLength(0)
    expect(
      resolveOperationsDeskEmptyState({
        visibleCount: 0,
        failureCount: 0,
        hasPendingSources: false,
        isFiltered: false,
      }),
    ).toBe('all-clear')
  })

  it('null and [] are never conflated', () => {
    const failed = buildOperationsDeskItems({ ...EMPTY_DESK_INPUT, evidenceRequests: null })
    const empty = buildOperationsDeskItems({ ...EMPTY_DESK_INPUT, evidenceRequests: [] })
    expect(failed.items).toEqual(empty.items)
    expect(failed.failures.length).not.toBe(empty.failures.length)
  })

  it('includes active evidence rows in the aggregated desk', () => {
    const result = buildOperationsDeskItems({
      ...EMPTY_DESK_INPUT,
      evidenceRequests: [request(), request({ id: 'req-2', status: 'resolved' })],
    })
    const evidenceRows = result.items.filter(i => i.category === 'evidence-request')
    expect(evidenceRows).toHaveLength(1)
    expect(evidenceRows[0].sourceEntityId).toBe('req-1')
  })
})

describe('the desk mutates nothing (§11.1)', () => {
  it('produces rows whose only capability is navigation', () => {
    const [row] = buildEvidenceRequestDeskItems([request()], NOW)
    // A row is inert data: no callback, no handler, no mutation affordance —
    // the only outbound edge is a destination page plus its id.
    for (const value of Object.values(row)) {
      expect(typeof value).not.toBe('function')
    }
    expect(row.destinationPage).toBe('admin-evidence-request-detail')
  })

  it('never routes an evidence row anywhere but the authoritative detail page', () => {
    for (const status of ['open', 'farmer_submitted', 'clarification_requested'] as EvidenceRequestStatus[]) {
      const [row] = buildEvidenceRequestDeskItems([request({ status })], NOW)
      expect(row.destinationPage).toBe('admin-evidence-request-detail')
    }
  })
})

describe('existing queues are unaffected by secondaryRank (regression)', () => {
  it('leaves secondaryRank unset on non-evidence rows, preserving their order', () => {
    const result = buildOperationsDeskItems(EMPTY_DESK_INPUT)
    for (const item of result.items) {
      if (item.category !== 'evidence-request') expect(item.secondaryRank).toBeUndefined()
    }
  })
})

describe('no prohibited terminology in desk output (§2.3, §15.7)', () => {
  const PROHIBITED = [
    'fully compliant',
    'legally compliant',
    'approved for export',
    'export-ready',
    'export ready',
    'verified supplier',
    'verified batch',
    'pharmaceutical approved',
    'certified pharmaceutical',
    'ready to buy',
  ]

  it('emits none of the prohibited phrases for any status or priority', () => {
    const rows = EVIDENCE_REQUEST_STATUSES.flatMap(status =>
      (['low', 'normal', 'high', 'urgent'] as EvidenceRequestPriority[]).flatMap(priority =>
        buildEvidenceRequestDeskItems([request({ status, priority, dueDate: '2026-07-01' })], NOW),
      ),
    )
    const text = rows
      .map(r => [r.title, r.entityLabel, r.reason, r.statusLabel, r.actionLabel].join(' '))
      .join(' ')
      .toLowerCase()
    for (const phrase of PROHIBITED) {
      expect(text).not.toContain(phrase)
    }
  })
})

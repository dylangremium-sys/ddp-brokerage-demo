import { describe, it, expect } from 'vitest'
import {
  EVIDENCE_ATTACHMENT_ORIGINS,
  EVIDENCE_HISTORY_EVENT_TYPES,
  EVIDENCE_MAX_AGGREGATE_UPLOAD_BYTES,
  EVIDENCE_MAX_READY_ATTACHMENTS_PER_RESPONSE,
  EVIDENCE_REQUEST_ACTIVE_STATUSES,
  EVIDENCE_REQUEST_CATEGORIES,
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_STATUSES,
  EVIDENCE_REQUEST_STATUS_LABELS,
  EVIDENCE_REQUEST_TARGET_TYPES,
  EVIDENCE_REQUEST_TERMINAL_STATUSES,
  EVIDENCE_RESPONSE_STATES,
  EVIDENCE_TEXT_LIMITS,
  adminActionsForEvidenceStatus,
  canSubmitEvidenceResponse,
  categoriesForEvidenceTarget,
  isActiveEvidenceAttachment,
  isActiveEvidenceRequestStatus,
  isEvidenceCategoryAllowedForTarget,
  isEvidenceRequestOverdue,
  isFarmerActionableEvidenceRequestStatus,
  isTerminalEvidenceRequestStatus,
  isTrimmedLengthWithin,
  type EvidenceAttachment,
  type EvidenceRequestCategory,
  type EvidenceRequestStatus,
  type EvidenceResponseDraft,
} from './evidenceRequests'

/**
 * Contract conformance for the shared domain layer (v1.5 §3, §4, §5, §12).
 *
 * These tests exist to stop the TypeScript vocabulary drifting away from the
 * DATABASE vocabulary. Migration 24 is authoritative; every constant below is
 * additionally asserted against the migration SQL text so a value cannot be
 * added, renamed or dropped on only one side (§17.24, and the §18.5 risk
 * "agent branches independently invent status or category values").
 */


/**
 * Source text is read with Vite's `?raw` glob rather than node:fs — the repo
 * convention (see operationsDeskRouting.test.ts), and the reason `src` compiles
 * without node type definitions.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const MIGRATION = raw(import.meta.glob('../../24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('canonical vocabulary mirrors migration 24', () => {
  it('has exactly the six contract statuses (§19.1)', () => {
    expect([...EVIDENCE_REQUEST_STATUSES]).toEqual([
      'open',
      'farmer_submitted',
      'clarification_requested',
      'resolved',
      'rejected',
      'cancelled',
    ])
  })

  it('does not store under_review (§3.1, §19.2)', () => {
    expect(EVIDENCE_REQUEST_STATUSES).not.toContain('under_review')
    expect(MIGRATION).not.toContain("'under_review'")
  })

  it.each(EVIDENCE_REQUEST_STATUSES)('database accepts status %s', status => {
    expect(MIGRATION).toContain(`'${status}'`)
  })

  it.each(EVIDENCE_REQUEST_CATEGORIES)('database accepts category %s', category => {
    expect(MIGRATION).toContain(`'${category}'`)
  })

  it.each(EVIDENCE_REQUEST_PRIORITIES)('database accepts priority %s', priority => {
    expect(MIGRATION).toContain(`'${priority}'`)
  })

  it.each(EVIDENCE_REQUEST_TARGET_TYPES)('database accepts target type %s', target => {
    expect(MIGRATION).toContain(`'${target}'`)
  })

  it.each(EVIDENCE_ATTACHMENT_ORIGINS)('database accepts origin %s', origin => {
    expect(MIGRATION).toContain(`'${origin}'`)
  })

  it.each(EVIDENCE_HISTORY_EVENT_TYPES)('database accepts history event %s', event => {
    expect(MIGRATION).toContain(`'${event}'`)
  })

  it('has exactly the fourteen contract categories', () => {
    expect(EVIDENCE_REQUEST_CATEGORIES).toHaveLength(14)
  })

  it('response states are draft and submitted only (§4.6)', () => {
    expect([...EVIDENCE_RESPONSE_STATES]).toEqual(['draft', 'submitted'])
  })

  it('labels every status and category — no silent fallback text (§3)', () => {
    for (const status of EVIDENCE_REQUEST_STATUSES) {
      expect(EVIDENCE_REQUEST_STATUS_LABELS[status]).toBeTruthy()
    }
    for (const category of EVIDENCE_REQUEST_CATEGORIES) {
      expect(EVIDENCE_REQUEST_CATEGORY_LABELS[category]).toBeTruthy()
    }
  })

  it('uses the exact required status labels (§3)', () => {
    expect(EVIDENCE_REQUEST_STATUS_LABELS).toEqual({
      open: 'Awaiting farmer response',
      farmer_submitted: 'Submitted for review',
      clarification_requested: 'Clarification requested',
      resolved: 'Reviewed and resolved',
      rejected: 'Evidence rejected',
      cancelled: 'Cancelled',
    })
  })
})

describe('terminal and active status partitions (§4.7, §11.2)', () => {
  it('terminal statuses are exactly resolved, rejected, cancelled', () => {
    expect([...EVIDENCE_REQUEST_TERMINAL_STATUSES]).toEqual(['resolved', 'rejected', 'cancelled'])
  })

  it('active statuses are exactly the three desk statuses', () => {
    expect([...EVIDENCE_REQUEST_ACTIVE_STATUSES]).toEqual([
      'open',
      'farmer_submitted',
      'clarification_requested',
    ])
  })

  it('partitions every status exactly once — none is both, none is neither', () => {
    for (const status of EVIDENCE_REQUEST_STATUSES) {
      const terminal = isTerminalEvidenceRequestStatus(status)
      const active = isActiveEvidenceRequestStatus(status)
      expect(terminal).not.toBe(active)
    }
  })
})

describe('administrator action matrix (§10.4, §5.1, §5.2)', () => {
  it('open permits cancel only', () => {
    expect(adminActionsForEvidenceStatus('open')).toEqual(['cancel'])
  })

  it('clarification_requested permits cancel only', () => {
    expect(adminActionsForEvidenceStatus('clarification_requested')).toEqual(['cancel'])
  })

  it('farmer_submitted permits clarify, resolve, reject and cancel', () => {
    expect(adminActionsForEvidenceStatus('farmer_submitted').sort()).toEqual(
      ['cancel', 'clarify', 'reject', 'resolve'],
    )
  })

  it.each(EVIDENCE_REQUEST_TERMINAL_STATUSES)('terminal status %s permits nothing', status => {
    expect(adminActionsForEvidenceStatus(status)).toEqual([])
  })

  it('never offers resolve or reject from open (§5.2 invalid transitions)', () => {
    for (const status of ['open', 'clarification_requested'] as EvidenceRequestStatus[]) {
      expect(adminActionsForEvidenceStatus(status)).not.toContain('resolve')
      expect(adminActionsForEvidenceStatus(status)).not.toContain('reject')
      expect(adminActionsForEvidenceStatus(status)).not.toContain('clarify')
    }
  })
})

describe('farmer-actionable statuses (§10.6)', () => {
  it('permits editing only in open and clarification_requested', () => {
    expect(isFarmerActionableEvidenceRequestStatus('open')).toBe(true)
    expect(isFarmerActionableEvidenceRequestStatus('clarification_requested')).toBe(true)
  })

  it.each(['farmer_submitted', 'resolved', 'rejected', 'cancelled'] as EvidenceRequestStatus[])(
    'is read-only in %s',
    status => {
      expect(isFarmerActionableEvidenceRequestStatus(status)).toBe(false)
    },
  )
})

describe('category-to-target matrix (§4.5)', () => {
  const FARM_ONLY: EvidenceRequestCategory[] = [
    'farm_identity',
    'farm_license',
    'gacp_evidence',
    'gmp_evidence',
    'responsible_contact',
  ]
  const BATCH_ONLY: EvidenceRequestCategory[] = [
    'coa',
    'batch_identity',
    'inventory_quantity_evidence',
    'inventory_photo',
    'inventory_video',
  ]
  const BOTH: EvidenceRequestCategory[] = [
    'export_supporting_document',
    'storage_evidence',
    'chain_of_custody',
    'other',
  ]

  it('covers every category exactly once across the three groups', () => {
    expect([...FARM_ONLY, ...BATCH_ONLY, ...BOTH].sort()).toEqual([...EVIDENCE_REQUEST_CATEGORIES].sort())
  })

  it.each(FARM_ONLY)('%s is farm-profile only', category => {
    expect(isEvidenceCategoryAllowedForTarget(category, 'farm_profile')).toBe(true)
    expect(isEvidenceCategoryAllowedForTarget(category, 'inventory_batch')).toBe(false)
  })

  it.each(BATCH_ONLY)('%s is inventory-batch only', category => {
    expect(isEvidenceCategoryAllowedForTarget(category, 'farm_profile')).toBe(false)
    expect(isEvidenceCategoryAllowedForTarget(category, 'inventory_batch')).toBe(true)
  })

  it.each(BOTH)('%s is valid for both targets', category => {
    expect(isEvidenceCategoryAllowedForTarget(category, 'farm_profile')).toBe(true)
    expect(isEvidenceCategoryAllowedForTarget(category, 'inventory_batch')).toBe(true)
  })

  it('coa is never offered for a farm-profile request', () => {
    expect(categoriesForEvidenceTarget('farm_profile')).not.toContain('coa')
    expect(categoriesForEvidenceTarget('inventory_batch')).toContain('coa')
  })

  it('offers a non-empty, matrix-consistent list for both targets', () => {
    for (const target of EVIDENCE_REQUEST_TARGET_TYPES) {
      const offered = categoriesForEvidenceTarget(target)
      expect(offered.length).toBeGreaterThan(0)
      for (const category of offered) {
        expect(isEvidenceCategoryAllowedForTarget(category, target)).toBe(true)
      }
    }
  })
})

describe('text limits (§5.3)', () => {
  it('matches the contract table exactly', () => {
    expect(EVIDENCE_TEXT_LIMITS).toEqual({
      title: { min: 3, max: 140 },
      explanation: { min: 20, max: 4_000 },
      responseText: { min: 1, max: 4_000 },
      clarificationReason: { min: 10, max: 2_000 },
      resolutionNote: { min: 10, max: 2_000 },
      rejectionReason: { min: 10, max: 2_000 },
      cancellationReason: { min: 10, max: 2_000 },
    })
  })

  it('rejects whitespace-only values (§5.3)', () => {
    expect(isTrimmedLengthWithin('     ', EVIDENCE_TEXT_LIMITS.title)) .toBe(false)
    expect(isTrimmedLengthWithin('\n\t  \n', EVIDENCE_TEXT_LIMITS.clarificationReason)).toBe(false)
  })

  it('measures the trimmed length, not the raw length', () => {
    // 3 real characters padded to 40 — valid as a title, since trimming applies.
    expect(isTrimmedLengthWithin('   abc   ', EVIDENCE_TEXT_LIMITS.title)).toBe(true)
    // 2 real characters is below the minimum however much padding surrounds it.
    expect(isTrimmedLengthWithin('   ab   ', EVIDENCE_TEXT_LIMITS.title)).toBe(false)
  })

  it('enforces the maximum on the trimmed value', () => {
    expect(isTrimmedLengthWithin('x'.repeat(140), EVIDENCE_TEXT_LIMITS.title)).toBe(true)
    expect(isTrimmedLengthWithin('x'.repeat(141), EVIDENCE_TEXT_LIMITS.title)).toBe(false)
  })
})

describe('attachment limits (§6.4)', () => {
  it('caps ready attachments per response at ten', () => {
    expect(EVIDENCE_MAX_READY_ATTACHMENTS_PER_RESPONSE).toBe(10)
    expect(MIGRATION).toContain('10 ready attachment limit')
  })

  it('caps aggregate uploaded bytes at 150 MB', () => {
    expect(EVIDENCE_MAX_AGGREGATE_UPLOAD_BYTES).toBe(157_286_400)
    expect(MIGRATION).toContain('157286400')
  })
})

// ── Attachment / submission semantics ────────────────────────────────────────

function attachment(over: Partial<EvidenceAttachment> = {}): EvidenceAttachment {
  return {
    id: 'a1',
    requestId: 'r1',
    responseId: 'resp1',
    origin: 'request_upload',
    farmerDocumentId: null,
    inventoryDocumentId: null,
    storageBucket: 'evidence-request-files',
    storageObjectPath: 'farm/req/resp/a1/file.pdf',
    uploadState: 'ready',
    originalFilename: 'file.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    sha256Hex: 'a'.repeat(64),
    createdByUserId: 'u1',
    createdAt: '2026-07-01T00:00:00Z',
    finalizedAt: '2026-07-01T00:00:00Z',
    removalRequestedAt: null,
    ...over,
  }
}

describe('active evidence attachments (§7.8, §7.9)', () => {
  it('counts a ready upload', () => {
    expect(isActiveEvidenceAttachment(attachment())).toBe(true)
  })

  it('excludes a pending upload — unvalidated content is not evidence (§7.4)', () => {
    expect(isActiveEvidenceAttachment(attachment({ uploadState: 'pending_upload' }))).toBe(false)
  })

  it('excludes a tombstone even when otherwise ready (§7.8.3)', () => {
    expect(
      isActiveEvidenceAttachment(attachment({ removalRequestedAt: '2026-07-02T00:00:00Z' })),
    ).toBe(false)
  })

  it('excludes a tombstone regardless of its parent response state (§7.9.4)', () => {
    // §7.9 lets cleanup authority survive submission; the tombstone must still
    // never re-enter the submitted evidence set.
    const tombstone = attachment({
      removalRequestedAt: '2026-07-02T00:00:00Z',
      finalizedAt: '2026-07-01T00:00:00Z',
      uploadState: 'ready',
    })
    expect(isActiveEvidenceAttachment(tombstone)).toBe(false)
  })

  it('counts linked documents, which carry no upload_state (§6.4)', () => {
    const linked = attachment({
      origin: 'existing_farm_document',
      uploadState: null,
      storageBucket: null,
      storageObjectPath: null,
      farmerDocumentId: 'doc1',
      sizeBytes: null,
    })
    expect(isActiveEvidenceAttachment(linked)).toBe(true)
  })
})

describe('submission requirements (§10.6)', () => {
  const draft = (over: Partial<EvidenceResponseDraft> = {}): EvidenceResponseDraft => ({
    response: {
      id: 'resp1',
      requestId: 'r1',
      responseNumber: 1,
      state: 'draft',
      responseText: null,
      supersedesResponseId: null,
      createdByUserId: 'u1',
      draftOwnerUserId: 'u1',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      submittedAt: null,
    },
    attachments: [],
    ...over,
  })

  it('refuses an empty response — no text and no evidence', () => {
    expect(canSubmitEvidenceResponse(draft())).toBe(false)
  })

  it('accepts response text alone', () => {
    const d = draft()
    d.response.responseText = 'Here is the licence number.'
    expect(canSubmitEvidenceResponse(d)).toBe(true)
  })

  it('refuses whitespace-only response text with no evidence', () => {
    const d = draft()
    d.response.responseText = '    \n  '
    expect(canSubmitEvidenceResponse(d)).toBe(false)
  })

  it('accepts a ready attachment alone', () => {
    expect(canSubmitEvidenceResponse(draft({ attachments: [attachment()] }))).toBe(true)
  })

  it('refuses while ANY upload is still pending, even with text (§10.6, §7.4)', () => {
    const d = draft({ attachments: [attachment(), attachment({ id: 'a2', uploadState: 'pending_upload' })] })
    d.response.responseText = 'Explanation provided.'
    expect(canSubmitEvidenceResponse(d)).toBe(false)
  })

  it('ignores a tombstoned pending upload — a removed file does not block (§7.8.3)', () => {
    const d = draft({
      attachments: [
        attachment(),
        attachment({ id: 'a2', uploadState: 'pending_upload', removalRequestedAt: '2026-07-02T00:00:00Z' }),
      ],
    })
    expect(canSubmitEvidenceResponse(d)).toBe(true)
  })

  it('does not treat a tombstone as evidence (§7.8.3)', () => {
    const d = draft({ attachments: [attachment({ removalRequestedAt: '2026-07-02T00:00:00Z' })] })
    expect(canSubmitEvidenceResponse(d)).toBe(false)
  })
})

describe('overdue is derived display only (§3.2)', () => {
  const now = new Date('2026-07-10T12:00:00Z')

  it('is false when no due date is set', () => {
    expect(isEvidenceRequestOverdue({ dueDate: null, status: 'open' }, now)).toBe(false)
  })

  it('is false on the due date itself — a calendar date, not a timestamp', () => {
    expect(isEvidenceRequestOverdue({ dueDate: '2026-07-10', status: 'open' }, now)).toBe(false)
  })

  it('is true the day after the due date', () => {
    expect(isEvidenceRequestOverdue({ dueDate: '2026-07-09', status: 'open' }, now)).toBe(true)
  })

  it('is false for a future due date', () => {
    expect(isEvidenceRequestOverdue({ dueDate: '2026-07-11', status: 'open' }, now)).toBe(false)
  })

  it.each(EVIDENCE_REQUEST_TERMINAL_STATUSES)('is never overdue in terminal status %s', status => {
    expect(isEvidenceRequestOverdue({ dueDate: '2020-01-01', status }, now)).toBe(false)
  })

  it('is false for an unparseable due date rather than throwing', () => {
    expect(isEvidenceRequestOverdue({ dueDate: 'not-a-date', status: 'open' }, now)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_REQUEST_ACTIVE_STATUSES,
  EVIDENCE_REQUEST_CATEGORIES,
  EVIDENCE_REQUEST_STATUSES,
  EVIDENCE_REQUEST_STATUS_LABELS,
  EVIDENCE_REQUEST_TERMINAL_STATUSES,
  categoriesForEvidenceTarget,
  isEvidenceCategoryAllowedForTarget,
  isTerminalEvidenceRequestStatus,
  isTrimmedLengthWithin,
} from './evidenceRequests'
import {
  adminEvidenceRequestCreateRoute,
  adminEvidenceRequestDetailRoute,
  farmerEvidenceRequestDetailRoute,
} from '../lib/evidenceRequestRoutes'

describe('evidence request canonical values', () => {
  it('locks the six request statuses and terminal states', () => {
    expect(EVIDENCE_REQUEST_STATUSES).toEqual([
      'open',
      'farmer_submitted',
      'clarification_requested',
      'resolved',
      'rejected',
      'cancelled',
    ])
    expect(EVIDENCE_REQUEST_ACTIVE_STATUSES).toEqual([
      'open',
      'farmer_submitted',
      'clarification_requested',
    ])
    expect(EVIDENCE_REQUEST_TERMINAL_STATUSES).toEqual([
      'resolved',
      'rejected',
      'cancelled',
    ])
  })

  it('uses workflow-only labels without prohibited approval claims', () => {
    const labels = Object.values(EVIDENCE_REQUEST_STATUS_LABELS).join(' ').toLowerCase()
    for (const prohibited of [
      'fully compliant',
      'legally compliant',
      'approved for export',
      'export-ready',
      'verified supplier',
      'verified batch',
      'pharmaceutical approved',
      'certified pharmaceutical',
      'ready to buy',
    ]) {
      expect(labels).not.toContain(prohibited)
    }
  })
})

describe('evidence request category-to-target matrix', () => {
  it('allows farm-only categories only for farm profiles', () => {
    for (const category of [
      'farm_identity',
      'farm_license',
      'gacp_evidence',
      'gmp_evidence',
      'responsible_contact',
    ] as const) {
      expect(isEvidenceCategoryAllowedForTarget(category, 'farm_profile')).toBe(true)
      expect(isEvidenceCategoryAllowedForTarget(category, 'inventory_batch')).toBe(false)
    }
  })

  it('allows inventory-only categories only for inventory batches', () => {
    for (const category of [
      'coa',
      'batch_identity',
      'inventory_quantity_evidence',
      'inventory_photo',
      'inventory_video',
    ] as const) {
      expect(isEvidenceCategoryAllowedForTarget(category, 'farm_profile')).toBe(false)
      expect(isEvidenceCategoryAllowedForTarget(category, 'inventory_batch')).toBe(true)
    }
  })

  it('allows shared categories for either target', () => {
    for (const category of [
      'export_supporting_document',
      'storage_evidence',
      'chain_of_custody',
      'other',
    ] as const) {
      expect(isEvidenceCategoryAllowedForTarget(category, 'farm_profile')).toBe(true)
      expect(isEvidenceCategoryAllowedForTarget(category, 'inventory_batch')).toBe(true)
    }
  })

  it('returns only canonical categories for each target', () => {
    const canonical = new Set(EVIDENCE_REQUEST_CATEGORIES)
    for (const targetType of ['farm_profile', 'inventory_batch'] as const) {
      const categories = categoriesForEvidenceTarget(targetType)
      expect(categories.length).toBeGreaterThan(0)
      for (const category of categories) expect(canonical.has(category)).toBe(true)
    }
  })
})

describe('evidence request validation helpers', () => {
  it('recognises only terminal request statuses as terminal', () => {
    for (const status of EVIDENCE_REQUEST_STATUSES) {
      expect(isTerminalEvidenceRequestStatus(status)).toBe(
        EVIDENCE_REQUEST_TERMINAL_STATUSES.includes(
          status as (typeof EVIDENCE_REQUEST_TERMINAL_STATUSES)[number],
        ),
      )
    }
  })

  it('validates trimmed text rather than whitespace', () => {
    expect(isTrimmedLengthWithin('  Valid title  ', { min: 3, max: 140 })).toBe(true)
    expect(isTrimmedLengthWithin('   ', { min: 1, max: 4_000 })).toBe(false)
    expect(isTrimmedLengthWithin('ab', { min: 3, max: 140 })).toBe(false)
  })
})

describe('evidence request route payloads', () => {
  it('creates an unscoped admin create route', () => {
    expect(adminEvidenceRequestCreateRoute()).toEqual({
      ok: true,
      data: { page: 'admin-evidence-request-create' },
    })
  })

  it('requires target type and target ID together', () => {
    expect(adminEvidenceRequestCreateRoute('farm_profile')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'targetId' },
    })
    expect(adminEvidenceRequestCreateRoute(undefined, 'target-1')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'targetType' },
    })
  })

  it('normalises detail request IDs and rejects empty IDs', () => {
    expect(adminEvidenceRequestDetailRoute(' request-1 ')).toEqual({
      ok: true,
      data: { page: 'admin-evidence-request-detail', requestId: 'request-1' },
    })
    expect(farmerEvidenceRequestDetailRoute('   ')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'requestId' },
    })
  })
})

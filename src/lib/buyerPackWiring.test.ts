import { beforeEach, describe, expect, it } from 'vitest'
import type { InventoryItem } from '../types'
import {
  prepareBuyerPackSnapshotInput,
  generateNextBuyerPackSnapshot,
  deriveSnapshotStatus,
  type BuyerPackSnapshotEvidenceInput,
  type BuyerPackStoredDecision,
} from './buyerPackSnapshot'
import { createLocalStorageBuyerPackSnapshotRepository } from './buyerPackSnapshotStore'
import { appendBuyerPackAuditEvent, getBuyerPackAuditTrail } from './buyerPackAudit'
import { appendBuyerPackDownload, getBuyerPackDownloadHistory } from './buyerPackDownloads'

// Covers the DDPBuyerPreview "Issue Buyer Pack" wiring: the pure eligibility
// gate + input assembly (prepareBuyerPackSnapshotInput), and the exact
// generate → audit → download sequence the handler performs. Same in-memory
// localStorage stand-in the other buyer-pack tests use (node env has no
// working localStorage).
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  installMemoryLocalStorage()
})

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'batch-1',
    farmerName: 'Test Farmer',
    farmName: 'Test Farm',
    farmId: 'farm-1',
    location: '',
    productName: 'Test Product',
    quantityKg: 10,
    harvestDate: '2026-01-01',
    cureDate: '2026-01-10',
    batchNumber: 'BATCH-001',
    thcPct: 0,
    cbdPct: 0,
    moisturePct: 0,
    waterActivity: '',
    qualityGrade: '',
    pricePerKg: 0,
    certFileName: '',
    photoUrl: '',
    storageConditions: '',
    notes: '',
    status: 'Approved',
    submittedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const PROGRESS: BuyerPackStoredDecision = { decision: 'progress', decidedAt: '2026-01-02T00:00:00.000Z', notes: 'Cleared.' }

function makeEvidence(overrides: Partial<BuyerPackSnapshotEvidenceInput> = {}): BuyerPackSnapshotEvidenceInput {
  return {
    packId: 'batch-1',
    generatedBy: 'DDP Admin',
    approvedBy: 'DDP Admin',
    isHumanApproved: true,
    storedDecision: PROGRESS,
    inventory: makeItem(),
    coas: { hasCoaFile: true, certFileName: 'coa.pdf', coaStoragePath: 'farm-1/batch-1/coa.pdf' },
    complianceSummary: { tier: 'DDP_DOCUMENTED' },
    documentChecks: [
      { key: 'batch', label: 'Batch number assigned', passed: true },
      { key: 'lab', label: 'Lab name recorded', passed: false },
    ],
    risks: [],
    evidenceSummary: [],
    ...overrides,
  }
}

describe('prepareBuyerPackSnapshotInput — the issue gate cannot be bypassed', () => {
  it('is ineligible (button-disabled equivalent) before human approval', () => {
    const result = prepareBuyerPackSnapshotInput(makeEvidence({ isHumanApproved: false }))
    expect(result.eligible).toBe(false)
  })

  it('is ineligible without a recorded "progress" decision, even if flagged approved', () => {
    expect(prepareBuyerPackSnapshotInput(makeEvidence({ storedDecision: null })).eligible).toBe(false)
    expect(prepareBuyerPackSnapshotInput(makeEvidence({ storedDecision: { decision: 'hold', decidedAt: '2026-01-02T00:00:00.000Z' } })).eligible).toBe(false)
  })

  it('is ineligible without a named approver', () => {
    expect(prepareBuyerPackSnapshotInput(makeEvidence({ approvedBy: '   ' })).eligible).toBe(false)
  })

  it('is eligible when approved with a progress decision and a named approver, and assembles the document summary', () => {
    const result = prepareBuyerPackSnapshotInput(makeEvidence())
    expect(result.eligible).toBe(true)
    if (!result.eligible) throw new Error('expected eligible')
    expect(result.input.procurementDecision).toBe('progress')
    expect(result.input.approvedBy).toBe('DDP Admin')
    expect(result.input.documentSummary.passCount).toBe(1)
    expect(result.input.documentSummary.totalChecks).toBe(2)
    // Approval id is derived from packId + decision timestamp.
    expect(result.input.approvalId).toBe('batch-1:2026-01-02T00:00:00.000Z')
    expect(result.input.procurementNotes).toBe('Cleared.')
  })
})

describe('Issue Buyer Pack — snapshot generation after approval', () => {
  it('generates a v1 snapshot with a content hash when eligible', async () => {
    const repo = createLocalStorageBuyerPackSnapshotRepository()
    const prep = prepareBuyerPackSnapshotInput(makeEvidence())
    if (!prep.eligible) throw new Error('expected eligible')

    const { snapshot, previousVersion } = await generateNextBuyerPackSnapshot(repo, prep.input)
    expect(snapshot.manifest.version).toBe(1)
    expect(previousVersion).toBeNull()
    expect(snapshot.manifest.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.immutable).toBe(true)
  })

  it('increments the version and preserves the previous snapshot on re-issue', async () => {
    const repo = createLocalStorageBuyerPackSnapshotRepository()
    const prep = prepareBuyerPackSnapshotInput(makeEvidence())
    if (!prep.eligible) throw new Error('expected eligible')

    const first = await generateNextBuyerPackSnapshot(repo, prep.input)
    const second = await generateNextBuyerPackSnapshot(repo, prep.input)

    expect(first.snapshot.manifest.version).toBe(1)
    expect(second.snapshot.manifest.version).toBe(2)
    expect(second.previousVersion).toBe(1)
    // Previous snapshot still retrievable, unchanged.
    expect(await repo.getVersion('batch-1', 1)).not.toBeNull()
    expect(await repo.getAll('batch-1')).toHaveLength(2)
  })

  it('produces a deterministic content hash for identical evidence (independent of version)', async () => {
    const repo = createLocalStorageBuyerPackSnapshotRepository()
    // Two issues of the same evidence: versions differ, but the content hash
    // deliberately excludes version/bookkeeping, so identical evidence hashes
    // identically.
    const first = await generateNextBuyerPackSnapshot(repo, prepOrThrow(makeEvidence()))
    const second = await generateNextBuyerPackSnapshot(repo, prepOrThrow(makeEvidence()))
    expect(second.snapshot.manifest.version).toBe(first.snapshot.manifest.version + 1)
    expect(second.snapshot.manifest.contentHash).toBe(first.snapshot.manifest.contentHash)
  })
})

describe('Issue Buyer Pack — audit and download events', () => {
  it('records pack_generated on issue, and pack_superseded for the prior version on re-issue', async () => {
    const repo = createLocalStorageBuyerPackSnapshotRepository()
    const prep = prepareBuyerPackSnapshotInput(makeEvidence())
    if (!prep.eligible) throw new Error('expected eligible')

    // Mirror the handler's exact sequence.
    const first = await generateNextBuyerPackSnapshot(repo, prep.input)
    appendBuyerPackAuditEvent({ packId: 'batch-1', snapshotVersion: first.snapshot.manifest.version, action: 'pack_generated', user: 'DDP Admin' })

    const second = await generateNextBuyerPackSnapshot(repo, prep.input)
    appendBuyerPackAuditEvent({ packId: 'batch-1', snapshotVersion: second.snapshot.manifest.version, action: 'pack_generated', user: 'DDP Admin' })
    if (second.previousVersion !== null) {
      appendBuyerPackAuditEvent({ packId: 'batch-1', snapshotVersion: second.previousVersion, action: 'pack_superseded', user: 'DDP Admin' })
    }

    const trail = getBuyerPackAuditTrail('batch-1')
    expect(trail.filter(e => e.action === 'pack_generated')).toHaveLength(2)
    expect(trail.filter(e => e.action === 'pack_superseded')).toHaveLength(1)
    expect(trail.find(e => e.action === 'pack_superseded')?.snapshotVersion).toBe(1)
  })

  it('records a download event tied to the issued snapshot version', async () => {
    const repo = createLocalStorageBuyerPackSnapshotRepository()
    const { snapshot } = await generateNextBuyerPackSnapshot(repo, prepOrThrow(makeEvidence()))

    appendBuyerPackDownload({ packId: 'batch-1', snapshotVersion: snapshot.manifest.version, user: 'DDP Admin', format: 'print-pdf' })
    appendBuyerPackDownload({ packId: 'batch-1', snapshotVersion: snapshot.manifest.version, user: 'DDP Admin', format: 'summary-copy' })

    const downloads = getBuyerPackDownloadHistory('batch-1')
    expect(downloads).toHaveLength(2)
    expect(downloads.map(d => d.format).sort()).toEqual(['print-pdf', 'summary-copy'])
    expect(downloads.every(d => d.snapshotVersion === snapshot.manifest.version)).toBe(true)
  })

  it('reports snapshot status as generated for the latest, superseded once a newer version exists', async () => {
    const repo = createLocalStorageBuyerPackSnapshotRepository()
    await generateNextBuyerPackSnapshot(repo, prepOrThrow(makeEvidence()))
    expect(await deriveSnapshotStatus(repo, getBuyerPackAuditTrail('batch-1'), 'batch-1', 1)).toBe('generated')

    await generateNextBuyerPackSnapshot(repo, prepOrThrow(makeEvidence()))
    expect(await deriveSnapshotStatus(repo, getBuyerPackAuditTrail('batch-1'), 'batch-1', 1)).toBe('superseded')
    expect(await deriveSnapshotStatus(repo, getBuyerPackAuditTrail('batch-1'), 'batch-1', 2)).toBe('generated')
  })
})

function prepOrThrow(evidence: BuyerPackSnapshotEvidenceInput) {
  const prep = prepareBuyerPackSnapshotInput(evidence)
  if (!prep.eligible) throw new Error('expected eligible')
  return prep.input
}

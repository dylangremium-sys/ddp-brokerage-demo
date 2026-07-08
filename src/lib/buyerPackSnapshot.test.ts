import { beforeEach, describe, expect, it } from 'vitest'
import type { DocumentRequirement, InventoryItem, RiskRegisterEntry } from '../types'
import {
  canonicalJsonStringify,
  createBuyerPackSnapshot,
  deriveSnapshotStatus,
  generateNextBuyerPackSnapshot,
  type CreateBuyerPackSnapshotInput,
} from './buyerPackSnapshot'
import { createLocalStorageBuyerPackSnapshotRepository } from './buyerPackSnapshotStore'
import type { BuyerPackAuditEvent } from './buyerPackAudit'

// vitest runs with environment: 'node' (vite.config.ts), where globalThis.localStorage
// exists but is non-functional without an experimental flag. Buyer pack snapshot
// storage genuinely uses localStorage (matching lib/procurementControl.ts's
// convention), so each test installs its own fresh in-memory stand-in — scoped to
// this test file only, no vite.config.ts / build tooling changes involved.
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

function makeInventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
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

function makeInput(overrides: Partial<CreateBuyerPackSnapshotInput> = {}): CreateBuyerPackSnapshotInput {
  return {
    packId: 'pack-1',
    version: 1,
    generatedBy: 'admin-1',
    approvalId: 'pack-1:2026-01-01T00:00:00.000Z',
    approvalTimestamp: '2026-01-01T00:00:00.000Z',
    procurementDecision: 'progress',
    approvedBy: 'Jane Reviewer',
    inventory: makeInventoryItem(),
    coas: { hasCoaFile: true, certFileName: 'coa.pdf', coaStoragePath: 'farm-1/batch-1/coa.pdf' },
    complianceSummary: { tier: 'DDP_DOCUMENTED' },
    procurementNotes: 'Looks good.',
    documentSummary: { passCount: 8, totalChecks: 11, results: [{ key: 'batch', label: 'Batch number assigned', passed: true }] },
    risks: [],
    evidenceSummary: [],
    ...overrides,
  }
}

describe('createBuyerPackSnapshot — approval gating', () => {
  it('rejects creation when procurementDecision is not "progress"', async () => {
    await expect(createBuyerPackSnapshot(makeInput({ procurementDecision: 'hold' }))).rejects.toThrow(
      /progress/i,
    )
  })

  it('rejects creation when approvedBy is empty', async () => {
    await expect(createBuyerPackSnapshot(makeInput({ approvedBy: '' }))).rejects.toThrow(/approver/i)
  })

  it('rejects creation when approvedBy is whitespace only', async () => {
    await expect(createBuyerPackSnapshot(makeInput({ approvedBy: '   ' }))).rejects.toThrow(/approver/i)
  })

  it('succeeds when procurementDecision is "progress" and approvedBy is a real name, and records both on the manifest', async () => {
    const snapshot = await createBuyerPackSnapshot(makeInput({ approvedBy: 'Jane Reviewer' }))
    expect(snapshot.manifest.procurementDecision).toBe('progress')
    expect(snapshot.manifest.approvedBy).toBe('Jane Reviewer')
    expect(snapshot.immutable).toBe(true)
  })
})

describe('createBuyerPackSnapshot — deep immutability', () => {
  it('freezes the returned snapshot, its manifest, and its frozen evidence', async () => {
    const snapshot = await createBuyerPackSnapshot(makeInput())
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.manifest)).toBe(true)
    expect(Object.isFrozen(snapshot.frozenEvidence)).toBe(true)
    expect(Object.isFrozen(snapshot.frozenEvidence.inventory)).toBe(true)
    expect(Object.isFrozen(snapshot.frozenEvidence.evidenceSummary)).toBe(true)
  })

  it('throws in strict mode when attempting to mutate a frozen field', async () => {
    const snapshot = await createBuyerPackSnapshot(makeInput())
    const mutable: { version: number } = snapshot.manifest
    expect(() => {
      mutable.version = 999
    }).toThrow(TypeError)
  })

  it('does not allow mutating a nested frozen array', async () => {
    const risk: RiskRegisterEntry = {
      riskId: 'risk-1',
      severity: 'medium',
      issue: 'Example issue',
      requiredAction: 'Example action',
      owner: 'Unassigned',
      status: 'open',
      evidenceStatus: 'missing',
    }
    const snapshot = await createBuyerPackSnapshot(makeInput({ risks: [risk] }))
    const mutable: RiskRegisterEntry[] = snapshot.frozenEvidence.risks
    expect(() => {
      mutable.push(risk)
    }).toThrow(TypeError)
  })
})

describe('createBuyerPackSnapshot — live data cannot alter the snapshot', () => {
  it('is unaffected by mutating the original inventory object after creation', async () => {
    const inventory = makeInventoryItem({ productName: 'Original Name' })
    const input = makeInput({ inventory })
    const snapshot = await createBuyerPackSnapshot(input)

    inventory.productName = 'Mutated After The Fact'

    expect(snapshot.frozenEvidence.inventory.productName).toBe('Original Name')
  })

  it('is unaffected by mutating the original evidenceSummary array after creation', async () => {
    const evidenceSummary: DocumentRequirement[] = [{ farmId: 'farm-1', type: 'coa', status: 'documented' }]
    const input = makeInput({ evidenceSummary })
    const snapshot = await createBuyerPackSnapshot(input)

    evidenceSummary.push({ farmId: 'farm-1', type: 'gmp_evidence', status: 'missing' })
    evidenceSummary[0].status = 'verified'

    expect(snapshot.frozenEvidence.evidenceSummary).toHaveLength(1)
    expect(snapshot.frozenEvidence.evidenceSummary[0].status).toBe('documented')
  })
})

describe('canonicalJsonStringify — content hash stability', () => {
  it('produces the same string regardless of key insertion order', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: { y: 1, x: 2 } })
    const b = canonicalJsonStringify({ a: 2, c: { x: 2, y: 1 }, b: 1 })
    expect(a).toBe(b)
  })
})

describe('createBuyerPackSnapshot — content hash', () => {
  it('produces the same contentHash for identical evidence and approval context', async () => {
    const snapshotA = await createBuyerPackSnapshot(makeInput())
    const snapshotB = await createBuyerPackSnapshot(makeInput())
    expect(snapshotA.manifest.contentHash).toBe(snapshotB.manifest.contentHash)
  })

  it('produces a different contentHash when frozen evidence differs', async () => {
    const snapshotA = await createBuyerPackSnapshot(makeInput())
    const snapshotB = await createBuyerPackSnapshot(makeInput({ procurementNotes: 'Different notes.' }))
    expect(snapshotA.manifest.contentHash).not.toBe(snapshotB.manifest.contentHash)
  })

  it('produces a different contentHash when the approval context differs', async () => {
    const snapshotA = await createBuyerPackSnapshot(makeInput())
    const snapshotB = await createBuyerPackSnapshot(makeInput({ approvedBy: 'A Different Reviewer' }))
    expect(snapshotA.manifest.contentHash).not.toBe(snapshotB.manifest.contentHash)
  })

  it('is a 64-character hex string (SHA-256)', async () => {
    const snapshot = await createBuyerPackSnapshot(makeInput())
    expect(snapshot.manifest.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('generateNextBuyerPackSnapshot — versioning', () => {
  it('creates version 1 for a new packId with no previous version', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    const { snapshot, previousVersion } = await generateNextBuyerPackSnapshot(repository, makeInput())
    expect(snapshot.manifest.version).toBe(1)
    expect(previousVersion).toBeNull()
  })

  it('creates version 2, then 3, preserving all prior versions untouched and readable', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    const first = await generateNextBuyerPackSnapshot(repository, makeInput())
    const second = await generateNextBuyerPackSnapshot(repository, makeInput({ procurementNotes: 'v2 notes' }))
    const third = await generateNextBuyerPackSnapshot(repository, makeInput({ procurementNotes: 'v3 notes' }))

    expect(first.snapshot.manifest.version).toBe(1)
    expect(second.snapshot.manifest.version).toBe(2)
    expect(second.previousVersion).toBe(1)
    expect(third.snapshot.manifest.version).toBe(3)
    expect(third.previousVersion).toBe(2)

    expect(repository.getVersion('pack-1', 1)?.frozenEvidence.procurementNotes).toBe('Looks good.')
    expect(repository.getVersion('pack-1', 2)?.frozenEvidence.procurementNotes).toBe('v2 notes')
    expect(repository.getVersion('pack-1', 3)?.frozenEvidence.procurementNotes).toBe('v3 notes')
    expect(repository.getAll('pack-1')).toHaveLength(3)
  })

  it('tracks independent version sequences per packId', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    await generateNextBuyerPackSnapshot(repository, makeInput({ packId: 'pack-1' }))
    const { snapshot } = await generateNextBuyerPackSnapshot(repository, makeInput({ packId: 'pack-2' }))
    expect(snapshot.manifest.version).toBe(1)
  })
})

describe('repository append-only behaviour', () => {
  it('rejects saving a snapshot whose (packId, version) already exists', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    const snapshot = await createBuyerPackSnapshot(makeInput({ packId: 'pack-1', version: 1 }))
    repository.save(snapshot)

    const duplicate = await createBuyerPackSnapshot(makeInput({ packId: 'pack-1', version: 1, procurementNotes: 'different' }))
    expect(() => repository.save(duplicate)).toThrow(/already exists/i)

    expect(repository.getAll('pack-1')).toHaveLength(1)
    expect(repository.getVersion('pack-1', 1)?.frozenEvidence.procurementNotes).toBe('Looks good.')
  })

  it('returns null for a pack or version that has never been saved', () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    expect(repository.getLatest('unknown-pack')).toBeNull()
    expect(repository.getVersion('unknown-pack', 1)).toBeNull()
    expect(repository.getAll('unknown-pack')).toEqual([])
  })
})

describe('deriveSnapshotStatus — computed, never stored', () => {
  it('is "generated" for the latest version with no audit events', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    await generateNextBuyerPackSnapshot(repository, makeInput())
    const status = deriveSnapshotStatus(repository, [], 'pack-1', 1)
    expect(status).toBe('generated')
  })

  it('is "issued" once a pack_viewed audit event exists for that version', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    await generateNextBuyerPackSnapshot(repository, makeInput())
    const events: BuyerPackAuditEvent[] = [
      { eventId: 'e1', packId: 'pack-1', snapshotVersion: 1, action: 'pack_viewed', timestamp: '2026-01-02T00:00:00.000Z', user: 'buyer-1' },
    ]
    expect(deriveSnapshotStatus(repository, events, 'pack-1', 1)).toBe('issued')
  })

  it('is "superseded" once a later version has been generated, even without any audit events', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    await generateNextBuyerPackSnapshot(repository, makeInput())
    await generateNextBuyerPackSnapshot(repository, makeInput({ procurementNotes: 'v2' }))
    expect(deriveSnapshotStatus(repository, [], 'pack-1', 1)).toBe('superseded')
    expect(deriveSnapshotStatus(repository, [], 'pack-1', 2)).toBe('generated')
  })

  it('is "archived" once a pack_archived audit event exists for that version, taking priority over other signals', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    await generateNextBuyerPackSnapshot(repository, makeInput())
    const events: BuyerPackAuditEvent[] = [
      { eventId: 'e1', packId: 'pack-1', snapshotVersion: 1, action: 'pack_viewed', timestamp: '2026-01-02T00:00:00.000Z', user: 'buyer-1' },
      { eventId: 'e2', packId: 'pack-1', snapshotVersion: 1, action: 'pack_archived', timestamp: '2026-01-03T00:00:00.000Z', user: 'admin-1' },
    ]
    expect(deriveSnapshotStatus(repository, events, 'pack-1', 1)).toBe('archived')
  })

  it('never mutates the underlying snapshot while deriving status', async () => {
    const repository = createLocalStorageBuyerPackSnapshotRepository()
    const { snapshot } = await generateNextBuyerPackSnapshot(repository, makeInput())
    deriveSnapshotStatus(repository, [], 'pack-1', 1)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(repository.getVersion('pack-1', 1)).not.toBeNull()
  })
})

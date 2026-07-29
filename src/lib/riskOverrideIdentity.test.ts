import { beforeEach, describe, expect, it } from 'vitest'
import {
  deriveAutoRisks,
  applyRiskOverrides,
  saveRiskOverride,
  composeRiskId,
  RISK_OVERRIDE_KEY,
} from './procurementControl'
import { deriveBuyerApprovalGate } from './buyerApprovalGate'
import type { FarmProfile, InventoryItem } from '../types'

/**
 * F1a — resolving one risk must not permanently auto-resolve every future risk
 * on the same batch.
 *
 * The defect: riskId was `risk-batch-${item.id}` — content-independent — while
 * applyRiskOverrides matched on that id alone and overrode `status`. A
 * "Resolved" recorded against a cosmetic gap kept applying after the batch's
 * risk content changed to a failed contaminant test, so the blocker arrived
 * pre-resolved and the buyer-pack issue gate opened.
 */

// node env has no working localStorage; same in-memory stand-in the other
// procurement tests use.
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
    certFileName: 'coa.pdf',
    photoUrl: '',
    storageConditions: '',
    notes: '',
    status: 'Approved',
    submittedAt: '2026-01-01T00:00:00.000Z',
    coaStoragePath: 'farm-1/batch-1/coa.pdf',
    labName: 'Bangkok Analytical',
    reportNumber: 'RPT-1',
    testDate: '2026-01-05',
    ...overrides,
  } as InventoryItem
}

/** The cosmetic-gap state: a documented COA missing only its report number. */
function cosmeticGapItem(): InventoryItem {
  return makeItem({ reportNumber: '' })
}

/** The same batch after a heavy-metals failure is recorded against it. */
function contaminatedItem(): InventoryItem {
  return makeItem({ reportNumber: '', heavyMetalsStatus: 'fail' })
}

const NO_FARMS: FarmProfile[] = []

describe('F1a — risk identity is bound to risk content', () => {
  it('derives a medium risk for a cosmetic gap and lets it be resolved', () => {
    const [risk] = deriveAutoRisks(NO_FARMS, [cosmeticGapItem()])
    expect(risk.severity).toBe('medium')
    saveRiskOverride(risk.riskId, 'resolved')
    const [applied] = applyRiskOverrides(deriveAutoRisks(NO_FARMS, [cosmeticGapItem()]))
    // Content unchanged ⇒ the override still applies. Ordinary triage must work.
    expect(applied.status).toBe('resolved')
  })

  it('re-opens as a blocker when heavy metals flips to fail under an existing resolution', () => {
    // 1. Resolve the cosmetic risk.
    const [cosmetic] = deriveAutoRisks(NO_FARMS, [cosmeticGapItem()])
    saveRiskOverride(cosmetic.riskId, 'resolved')

    // 2. The batch's heavy-metals status flips to 'fail'.
    const risks = applyRiskOverrides(deriveAutoRisks(NO_FARMS, [contaminatedItem()]))
    const batchRisk = risks.find(r => r.batchId === 'batch-1')
    expect(batchRisk).toBeDefined()

    // 3. THE ASSERTION. Pre-fix this was severity 'blocker' with status
    //    'resolved' — a contaminant blocker arriving pre-cleared.
    expect(batchRisk!.severity).toBe('blocker')
    expect(batchRisk!.status).toBe('open')
  })

  it('holds the buyer approval gate shut for that batch even with a recorded progress decision', () => {
    const [cosmetic] = deriveAutoRisks(NO_FARMS, [cosmeticGapItem()])
    saveRiskOverride(cosmetic.riskId, 'resolved')

    const risks = applyRiskOverrides(deriveAutoRisks(NO_FARMS, [contaminatedItem()]))
    const unresolved = risks.filter(r => r.status !== 'resolved' && r.status !== 'accepted')
    const hasBlockingIssues = unresolved.some(r => r.severity === 'blocker')
    expect(hasBlockingIssues).toBe(true)

    // Same call DDPBuyerPreview makes, with a recorded 'progress' decision.
    const { isHumanApproved } = deriveBuyerApprovalGate(hasBlockingIssues, true)
    expect(isHumanApproved).toBe(false)
  })

  it('counts the re-opened risk in the Risk Register "Unresolved Blockers" tile', () => {
    const [cosmetic] = deriveAutoRisks(NO_FARMS, [cosmeticGapItem()])
    saveRiskOverride(cosmetic.riskId, 'resolved')

    // DDPRiskRegister.tsx:45, verbatim.
    const risks = applyRiskOverrides(deriveAutoRisks(NO_FARMS, [contaminatedItem()]))
    const blockerCount = risks.filter(
      r => r.severity === 'blocker' && r.status !== 'resolved' && r.status !== 'accepted',
    ).length
    expect(blockerCount).toBe(1)
  })

  it('renders the superseded override inert rather than migrating or deleting it', () => {
    const [cosmetic] = deriveAutoRisks(NO_FARMS, [cosmeticGapItem()])
    saveRiskOverride(cosmetic.riskId, 'resolved')

    const risks = applyRiskOverrides(deriveAutoRisks(NO_FARMS, [contaminatedItem()]))
    const newId = risks.find(r => r.batchId === 'batch-1')!.riskId
    expect(newId).not.toBe(cosmetic.riskId)

    // The old record survives untouched — an audit trail of what was cleared and
    // when — it simply no longer matches any live risk.
    const stored = JSON.parse(localStorage.getItem(RISK_OVERRIDE_KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(stored)).toContain(cosmetic.riskId)
    expect(Object.keys(stored)).not.toContain(newId)
  })

  it('leaves pre-fix bare-id overrides inert by construction', () => {
    // Exactly what a browser carrying pre-remediation state holds.
    localStorage.setItem(RISK_OVERRIDE_KEY, JSON.stringify({
      'risk-batch-batch-1': { status: 'resolved', updatedAt: '2026-07-01T00:00:00.000Z' },
    }))
    const [risk] = applyRiskOverrides(deriveAutoRisks(NO_FARMS, [contaminatedItem()]))
    expect(risk.riskId).toContain('#')
    expect(risk.status).toBe('open')
  })
})

describe('F1a — composeRiskId fingerprint properties', () => {
  it('is deterministic for identical content', () => {
    expect(composeRiskId('risk-batch-b', 'blocker', 'Heavy metals test failed'))
      .toBe(composeRiskId('risk-batch-b', 'blocker', 'Heavy metals test failed'))
  })

  it('differs when severity changes but the issue text does not', () => {
    expect(composeRiskId('risk-batch-b', 'medium', 'Same issue'))
      .not.toBe(composeRiskId('risk-batch-b', 'blocker', 'Same issue'))
  })

  it('differs when the issue changes but the severity does not', () => {
    expect(composeRiskId('risk-batch-b', 'high', 'No COA on file for this batch'))
      .not.toBe(composeRiskId('risk-batch-b', 'high', 'Recorded expiry date has passed'))
  })

  it('emits a fixed-width hex segment, so ids stay stable and comparable', () => {
    expect(composeRiskId('risk-batch-b', 'low', 'x')).toMatch(/^risk-batch-b#[0-9a-f]{8}$/)
    // A zero-hash input must still be 8 chars, not '0'.
    expect(composeRiskId('b', 'low', '').split('#')[1]).toHaveLength(8)
  })

  it('keeps distinct batches distinct even when their risk content is identical', () => {
    const a = deriveAutoRisks(NO_FARMS, [makeItem({ id: 'batch-a', reportNumber: '' })])[0]
    const b = deriveAutoRisks(NO_FARMS, [makeItem({ id: 'batch-b', reportNumber: '' })])[0]
    expect(a.riskId).not.toBe(b.riskId)
    saveRiskOverride(a.riskId, 'resolved')
    const applied = applyRiskOverrides([a, b])
    expect(applied[0].status).toBe('resolved')
    expect(applied[1].status).toBe('open')
  })
})

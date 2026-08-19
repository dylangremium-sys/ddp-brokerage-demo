// @vitest-environment jsdom
//
// The list-state gate, rendered rather than asserted on a helper.
//
// buyerPreviewApprovedList.test.ts proves the fold. It cannot prove the thing
// that actually matters: that a failed rule-enforcement read puts the WARNING on
// the screen instead of the grey "No batches are currently human approved"
// all-clear. That gap is exactly how the defect shipped — the fold was wrong in
// the component while every unit test around it passed.
//
// So this renders the real DDPBuyerPreview list and asserts on the copy an
// operator would actually read.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { InventoryItem, FarmProfile } from '../../types'
import { SEED_FARMS, SEED_INVENTORY } from '../../data'

const ALL_CLEAR = /No batches are currently human approved/i
const WARNING = /could not be verified against the server/i
const LOADING = /Checking the recorded procurement decisions/i

const FARM: FarmProfile = SEED_FARMS[0]
const ITEM: InventoryItem = { ...SEED_INVENTORY[0], id: 'batch-1', farmId: FARM.id, farmName: FARM.tradingName, status: 'Approved' }

// The two reads that must SUCCEED, so the state under test is attributable to
// the rule read alone. A blanket failure would show the warning even pre-fix.
vi.mock('../../lib/procurementDecisionStore', async (orig) => ({
  ...(await orig<typeof import('../../lib/procurementDecisionStore')>()),
  resolveDecisions: vi.fn(async () => ({ decisions: new Map(), unavailable: false })),
}))
vi.mock('../../lib/procurementOverrideStore', async (orig) => ({
  ...(await orig<typeof import('../../lib/procurementOverrideStore')>()),
  resolveRiskOverrides: vi.fn(async () => ({ overrides: new Map(), unavailable: false })),
  resolveRequirementOverrides: vi.fn(async () => ({ overrides: new Map(), unavailable: false })),
}))
vi.mock('../../lib/complianceRepository', async (orig) => ({
  ...(await orig<typeof import('../../lib/complianceRepository')>()),
  resolveEnforcedRuleAlertsForBatches: vi.fn(),
}))

import DDPBuyerPreview from './DDPBuyerPreview'
import { resolveEnforcedRuleAlertsForBatches } from '../../lib/complianceRepository'

function installLocalStorage() {
  const data = new Map<string, string>()
  const stub: Storage = {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => { data.delete(k) },
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true })
}

const renderList = () => render(<DDPBuyerPreview inventory={[ITEM]} farms={[FARM]} />)

describe('the buyer-preview list, rendered, when the rule-enforcement read fails', () => {
  beforeEach(() => { installLocalStorage(); vi.clearAllMocks() })
  afterEach(cleanup)

  it('shows the UNKNOWN warning, not the all-clear', { timeout: 20000 }, async () => {
    vi.mocked(resolveEnforcedRuleAlertsForBatches).mockResolvedValue({ byBatchId: new Map(), unavailable: true })
    renderList()

    await waitFor(() => expect(screen.getByText(WARNING)).toBeTruthy())
    // THE DEFECT, as an operator would have seen it.
    expect(document.body.textContent).not.toMatch(ALL_CLEAR)
  })

  it('shows the UNKNOWN warning when the read REJECTS', { timeout: 20000 }, async () => {
    vi.mocked(resolveEnforcedRuleAlertsForBatches).mockRejectedValue(new Error('network down'))
    renderList()

    await waitFor(() => expect(screen.getByText(WARNING)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(ALL_CLEAR)
  })

  it('stays on LOADING while the read is still in flight', { timeout: 20000 }, async () => {
    vi.mocked(resolveEnforcedRuleAlertsForBatches).mockReturnValue(new Promise(() => {}))
    renderList()

    await waitFor(() => expect(screen.getByText(LOADING)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(ALL_CLEAR)
  })

  it('CONTROL: still reaches the all-clear when every read settles successfully', { timeout: 20000 }, async () => {
    vi.mocked(resolveEnforcedRuleAlertsForBatches).mockResolvedValue({
      byBatchId: new Map([[ITEM.id, { blockingAlerts: [], unavailable: false }]]),
      unavailable: false,
    })
    renderList()

    // No decision recorded => nothing approved, and that IS a confirmed empty.
    await waitFor(() => expect(screen.getByText(ALL_CLEAR)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(WARNING)
  })
})

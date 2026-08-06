// @vitest-environment jsdom
//
// THE ACCEPTANCE TEST FOR W8, rendered rather than asserted on a helper.
//
// The unit tests in complianceRuleEnforcement.test.ts prove the selection logic.
// They cannot prove the thing that actually matters: that a blocking rule
// reaches the SCREEN and takes the buyer-facing output away. That gap is exactly
// how this feature came to be missing in the first place — compliance_rules had
// a full lifecycle, a UI and two SQL functions, and nothing joined them to the
// gate, while every unit test passed.
//
// So this renders the real BuyerPack and asserts on what an operator would see:
// the blocked heading, the named rule, and disabled Print/Copy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { ComplianceAlert, ComplianceRule, InventoryItem, FarmProfile } from '../../types'

const BATCH_ID = 'batch-under-test'

const BLOCKING_RULE: ComplianceRule = {
  id: 'rule-1',
  ruleCode: 'LEGAL_EXPORT_PERMIT',
  title: 'Export permit required for cannabis flower to CZ',
  description: 'A valid export permit must be on file before issuance.',
  jurisdiction: 'Thailand',
  entityType: 'batch',
  severity: 'critical',
  isBlocking: true,
  status: 'active',
  effectiveFrom: '2020-01-01',
  effectiveTo: null,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
}

const OPEN_ALERT: ComplianceAlert = {
  id: 'alert-1',
  entityType: 'batch',
  entityId: BATCH_ID,
  ruleId: 'rule-1',
  alertTitle: 'No export permit on file',
  alertDetail: '',
  severity: 'critical',
  status: 'open',
  createdAt: '2026-08-06T00:00:00.000Z',
}

const ITEM: InventoryItem = {
  id: BATCH_ID,
  farmId: 'farm-1',
  farmName: 'Test Farm',
  productType: 'flower',
  strain: 'Purple Gelato',
  quantityKg: 10,
  harvestDate: '2026-01-01',
  status: 'Approved',
} as unknown as InventoryItem

const FARM: FarmProfile = {
  id: 'farm-1',
  tradingName: 'Test Farm',
  legalBusinessName: 'Test Farm Co Ltd',
} as unknown as FarmProfile

// Node 25 exposes its own partial `localStorage` global, which shadows jsdom's
// and throws on .clear(). Install a plain in-memory stub, as the other tests in
// this repository do, so the store under test is the one we control.
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

/** Seed the demo store the resolvers read when Supabase is unconfigured. */
function seedLocalStore(rules: ComplianceRule[], alerts: ComplianceAlert[]) {
  localStorage.setItem('ddp_compliance_rules', JSON.stringify(rules))
  localStorage.setItem('ddp_compliance_alerts', JSON.stringify(alerts))
}

async function renderPack() {
  const mod = await import('./DDPBuyerPreview')
  const Component = mod.default as unknown as React.ComponentType<Record<string, unknown>>
  render(<Component inventory={[ITEM]} farms={[FARM]} selectedItem={ITEM} />)
}

function outputButtons() {
  return Array.from(document.querySelectorAll('button')).filter(b =>
    /print|copy/i.test(b.textContent || ''),
  )
}

describe('W8 — an approved compliance rule blocks the buyer pack', () => {
  beforeEach(() => {
    installLocalStorage()
    vi.restoreAllMocks()
  })
  afterEach(cleanup)

  it('names the blocking rule on screen and disables buyer-facing output', async () => {
    seedLocalStore([BLOCKING_RULE], [OPEN_ALERT])
    await renderPack()

    await waitFor(() => {
      expect(screen.getByText(/LEGAL_EXPORT_PERMIT/)).toBeTruthy()
    })

    // The operator is told which rule did it, not merely that something did.
    expect(document.body.textContent).toContain('Export permit required for cannabis flower to CZ')
    expect(document.body.textContent).toMatch(/approved compliance rule in force/i)

    // And the output is actually taken away — the part a screenshot would show.
    const buttons = outputButtons()
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b.disabled).toBe(true)
  })

  it('does NOT block when the same rule is only suggested — approve is what enforces', async () => {
    seedLocalStore([{ ...BLOCKING_RULE, status: 'suggested' }], [OPEN_ALERT])
    await renderPack()

    // Assert the pack actually RENDERED before asserting the rule text is absent
    // — otherwise a component that threw would satisfy this test vacuously.
    await waitFor(() => expect(outputButtons().length).toBeGreaterThan(0))
    expect(document.body.textContent).not.toMatch(/approved compliance rule in force/i)
    expect(document.body.textContent).not.toContain('LEGAL_EXPORT_PERMIT')
  })

  it('does NOT block once the alert is resolved — resolving releases the pack', async () => {
    seedLocalStore([BLOCKING_RULE], [{ ...OPEN_ALERT, status: 'resolved' }])
    await renderPack()

    // Assert the pack actually RENDERED before asserting the rule text is absent
    // — otherwise a component that threw would satisfy this test vacuously.
    await waitFor(() => expect(outputButtons().length).toBeGreaterThan(0))
    expect(document.body.textContent).not.toMatch(/approved compliance rule in force/i)
    expect(document.body.textContent).not.toContain('LEGAL_EXPORT_PERMIT')
  })

  it('does NOT block a rule outside its effective window', async () => {
    seedLocalStore([{ ...BLOCKING_RULE, effectiveFrom: '2099-01-01' }], [OPEN_ALERT])
    await renderPack()

    // Assert the pack actually RENDERED before asserting the rule text is absent
    // — otherwise a component that threw would satisfy this test vacuously.
    await waitFor(() => expect(outputButtons().length).toBeGreaterThan(0))
    expect(document.body.textContent).not.toMatch(/approved compliance rule in force/i)
    expect(document.body.textContent).not.toContain('LEGAL_EXPORT_PERMIT')
  })
})

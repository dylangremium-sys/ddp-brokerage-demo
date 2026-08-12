// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DDPOperationsDeskOrganic from './DDPOperationsDeskOrganic'
import type { ComplianceAlert, FarmProfile, InventoryItem } from '../../types'

/**
 * A row title must never be an identifier — asserted against the SCREEN.
 *
 * #212 and #213 fixed this rule in lib/entityName and in the farm portal, and
 * both were green, and the desk went on printing
 * "farm · b1f4182c-3a2b-419b-b050-84609ac13492" as the title of every compliance
 * matter. Two reasons, and unit tests on the naming module could see neither:
 * the queue glued the entity's type onto its id, so the guard no longer
 * recognised the id; and this screen kept a private copy of the guard, so a fix
 * to the shared one never reached it.
 *
 * Hence these render the real component. The rule is that no full identifier
 * appears anywhere on screen as a name — a shortened one below the title, in
 * mono, is the demotion working as intended.
 */

const FARM_UUID = 'b1f4182c-3a2b-419b-b050-84609ac13492'
const BATCH_UUID = 'c2e5293d-4b3c-52ac-c161-95710bd24503'

const NAMED_FARM: FarmProfile = {
  id: FARM_UUID, tradingName: 'Mae Rim Organics', status: 'Approved',
} as FarmProfile

/** The measured production case: a farm holding neither trading nor legal name. */
const NAMELESS_FARM: FarmProfile = {
  id: FARM_UUID, tradingName: '', legalBusinessName: '', status: 'Approved',
} as FarmProfile

const BATCH: InventoryItem = {
  id: BATCH_UUID, farmId: FARM_UUID, productName: 'Sunrise Mango',
  farmName: 'Mae Rim Organics', quantityKg: 100, status: 'Approved',
} as InventoryItem

function alert(over: Partial<ComplianceAlert> = {}): ComplianceAlert {
  return {
    id: 'alert-1', entityType: 'farm', entityId: FARM_UUID,
    alertTitle: 'Licence renewal published',
    alertDetail: 'A regulatory update affects this entity.',
    severity: 'high', status: 'open',
    createdAt: '2026-02-01T00:00:00.000Z',
    ...over,
  } as ComplianceAlert
}

function renderDesk(over: {
  farms?: FarmProfile[]
  inventory?: InventoryItem[]
  complianceAlerts?: ComplianceAlert[]
} = {}) {
  return render(
    <DDPOperationsDeskOrganic
      farms={over.farms ?? [NAMED_FARM]}
      inventory={over.inventory ?? []}
      reviewRequests={[]}
      complianceAlerts={over.complianceAlerts ?? [alert()]}
      reviewRequestsLoading={false}
      complianceLoading={false}
      farmInventoryLoading={false}
      farmInventoryFailed={false}
      onOpen={() => undefined}
    />,
  )
}

/** Every piece of text the screen renders, so nothing hides in a nested span. */
const screenText = () => document.body.textContent ?? ''

afterEach(cleanup)

describe('the Operations Desk never titles a row with an identifier', () => {
  it('shows the farm name for a compliance matter, not the farm id', () => {
    renderDesk()
    expect(screen.getAllByText('Mae Rim Organics').length).toBeGreaterThan(0)
    expect(screenText()).not.toContain(FARM_UUID)
  })

  it('shows the batch for a batch-level compliance matter', () => {
    renderDesk({
      inventory: [BATCH],
      complianceAlerts: [alert({ entityType: 'batch', entityId: BATCH_UUID })],
    })
    expect(screenText()).toContain('Sunrise Mango')
    expect(screenText()).not.toContain(BATCH_UUID)
  })

  it('says what is wrong when the farm has no name, and demotes the id to a short mono line', () => {
    renderDesk({ farms: [NAMELESS_FARM] })
    expect(screen.getAllByText(/no name on file/i).length).toBeGreaterThan(0)
    // The id is kept as metadata — shortened, never the title, never in full.
    expect(screenText()).not.toContain(FARM_UUID)
    expect(screenText()).toContain(FARM_UUID.slice(0, 8))
  })

  it('does not print the id when the compliance entity is not on file at all', () => {
    renderDesk({ farms: [], complianceAlerts: [alert()] })
    expect(screenText()).not.toContain(FARM_UUID)
  })

  it('never glues an entity type onto an id, whatever the entity type is', () => {
    for (const entityType of ['farm', 'batch', 'coa'] as const) {
      renderDesk({ farms: [], inventory: [], complianceAlerts: [alert({ entityType })] })
      expect(screenText()).not.toContain(`${entityType} · `)
      expect(screenText()).not.toContain(FARM_UUID)
      cleanup()
    }
  })
})

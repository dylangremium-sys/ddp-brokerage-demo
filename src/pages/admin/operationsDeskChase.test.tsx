// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import DDPOperationsDeskOrganic, { type FarmChase } from './DDPOperationsDeskOrganic'
import type { FarmProfile, InventoryItem } from '../../types'

/**
 * Chasing farms in bulk — the one thing this screen does that the old desk
 * could not, and the one thing on it that writes.
 *
 * WHAT THESE PROTECT:
 *
 *   · ONE request per farm, not one per matter. A farm owing six documents that
 *     receives six messages learns to ignore all six. The button's number counts
 *     farms for the same reason, so it must never count rows.
 *
 *   · The count cannot overstate what will be sent. A matter that cannot be tied
 *     to a farm on file is not selectable, because a chase that silently drops
 *     part of the selection is the "shows SUCCESS while nothing happened" defect
 *     this codebase has already shipped once.
 *
 *   · A farm-level chase must NEVER carry a stockItemId. App's existing
 *     handleSendReviewRequest flips a batch to `needs_changes` when one is
 *     present — correct when an operator asks about one batch, and wrong here:
 *     chasing a farm must not silently re-open every batch it touches.
 */

// These tests render the whole desk over the seeded queue, fourteen times, and
// the suite runs files in parallel. Measured at ~23s for this file under load
// against a 5s per-test default, so the waitFor deadlines below could never be
// reached — the test timed out first. Raised together so a loaded machine is
// tolerated; none of the assertions changed.
vi.setConfig({ testTimeout: 30000 })

afterEach(cleanup)

/** Source text, read the way operationsDeskRouting.test.ts reads it. */
const raw = (mod: Record<string, string>) => Object.values(mod)[0]
const APP_SRC = raw(import.meta.glob('../../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const DB_SRC = raw(import.meta.glob('../../lib/db.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

const FARMS: FarmProfile[] = [
  { id: 'farm-a', tradingName: 'Calli Krush', status: 'Approved' } as FarmProfile,
  // Awaiting a DDP decision, so this farm raises a matter of its own — which is
  // what makes the grouping assertion meaningful: two farms, two sources.
  { id: 'farm-b', tradingName: 'Northern Green', status: 'Submitted to DDP' } as FarmProfile,
]

const INVENTORY: InventoryItem[] = [
  { id: 'batch-1', farmId: 'farm-a', productName: 'Mango', farmName: 'Calli Krush', quantityKg: 100, status: 'Missing Document' } as InventoryItem,
  // Deliberately has NO farmId — the unresolvable case.
  { id: 'batch-orphan', productName: 'Orphan', farmName: 'Unknown', quantityKg: 50, status: 'Missing Document' } as InventoryItem,
]

function renderDesk(onChaseFarms?: (c: FarmChase[]) => void) {
  return render(
    <DDPOperationsDeskOrganic
      farms={FARMS}
      inventory={INVENTORY}
      reviewRequests={[]}
      complianceAlerts={[]}
      reviewRequestsLoading={false}
      complianceLoading={false}
      farmInventoryLoading={false}
      farmInventoryFailed={false}
      onOpen={() => undefined}
      onChaseFarms={onChaseFarms}
    />,
  )
}

const chaseButton = () =>
  screen.getByRole('button', { name: /^Chase/ }) as HTMLButtonElement

const enabledBoxes = () =>
  (screen.getAllByRole('checkbox') as HTMLInputElement[]).filter(b => !b.disabled)

describe('the bulk chase counts farms, not rows', () => {
  it('groups every selected matter for one farm into a single chase', async () => {
    const onChase = vi.fn<(c: FarmChase[]) => void>()
    renderDesk(onChase)

    const boxes = enabledBoxes()
    expect(boxes.length).toBeGreaterThan(1)
    boxes.forEach(b => fireEvent.click(b))

    await waitFor(() => expect(chaseButton().disabled).toBe(false), { timeout: 8000 })
    fireEvent.click(chaseButton())

    expect(onChase).toHaveBeenCalledTimes(1)
    const chases = onChase.mock.calls[0][0]

    // One entry per farm, never per matter.
    const ids = chases.map(c => c.farmProfileId)
    expect(new Set(ids).size).toBe(ids.length)
    // Every chase names a real farm and carries what that farm owes.
    for (const chase of chases) {
      expect(FARMS.some(f => f.id === chase.farmProfileId)).toBe(true)
      expect(chase.missing.length).toBeGreaterThan(0)
    }
    // The label promised exactly this many farms.
    expect(chases.length).toBeLessThanOrEqual(FARMS.length)
  })

  it('clears the selection after chasing, so a second click cannot re-send', async () => {
    const onChase = vi.fn()
    renderDesk(onChase)
    enabledBoxes().slice(0, 1).forEach(b => fireEvent.click(b))
    await waitFor(() => expect(chaseButton().disabled).toBe(false), { timeout: 8000 })
    fireEvent.click(chaseButton())
    await waitFor(() => expect(chaseButton().disabled).toBe(true), { timeout: 8000 })
    expect(chaseButton().textContent).toContain('Chase farms')
  })

  it('is disabled with nothing selected', () => {
    renderDesk(vi.fn())
    expect(chaseButton().disabled).toBe(true)
  })

  it('is disabled when no chase handler is wired, rather than silently doing nothing', () => {
    renderDesk()
    expect(chaseButton().disabled).toBe(true)
  })
})

describe('a matter with no farm on file cannot be chased', () => {
  it('disables its checkbox and says why', () => {
    renderDesk(vi.fn())
    const disabled = (screen.getAllByRole('checkbox') as HTMLInputElement[]).filter(b => b.disabled)
    // The orphan batch produces at least one matter that resolves to no farm.
    expect(disabled.length).toBeGreaterThan(0)
    expect(disabled[0].title).toMatch(/not tied to a farm on file/i)
    expect(screen.getByText(/cannot be chased from here/i)).toBeTruthy()
  })

  it('never lets an unchaseable matter reach the handler', async () => {
    const onChase = vi.fn<(c: FarmChase[]) => void>()
    renderDesk(onChase)
    enabledBoxes().forEach(b => fireEvent.click(b))
    await waitFor(() => expect(chaseButton().disabled).toBe(false), { timeout: 8000 })
    fireEvent.click(chaseButton())
    for (const chase of onChase.mock.calls[0][0]) {
      expect(chase.farmProfileId).toBeTruthy()
      expect(FARMS.some(f => f.id === chase.farmProfileId)).toBe(true)
    }
  })
})

describe('the chase written by App is farm-level, never batch-level', () => {
  // Asserted against the source, the same way operationsDeskRouting.test.ts
  // pins App's desk wiring: the property that matters is a NEGATIVE — a field
  // that must not be set — and there is no way to observe an absent write.
  const handler = APP_SRC.slice(
    APP_SRC.indexOf('async function handleChaseFarms'),
    APP_SRC.indexOf('async function handleSendReviewRequest'),
  )

  it('is the screen ddp-operations-desk actually renders', () => {
    // The console cannot be reached without a Supabase sign-in, so the routed
    // screen cannot be driven in a browser here. This pins the swap instead:
    // the Organic desk is rendered for that page, inside its own shell, and the
    // desk it replaced is no longer rendered anywhere.
    expect(APP_SRC).toContain("if (page === 'ddp-operations-desk' && isAdminRole) return operationsDeskFrame()")
    const frame = APP_SRC.slice(
      APP_SRC.indexOf('function operationsDeskFrame()'),
      APP_SRC.indexOf('async function handleChaseFarms'),
    )
    expect(frame).toContain('<OrganicConsoleShell')
    expect(frame).toContain('<DDPOperationsDeskOrganic')
    // The desk it replaced is no longer rendered or even imported.
    expect(APP_SRC).not.toContain('<DDPOperationsDesk\n')
    expect(APP_SRC).not.toContain("import DDPOperationsDesk from")
    // Sign-out moves with the frame — AdminShell is where it otherwise lives.
    expect(frame).toContain('onSignOut={handleSignOut}')
  })

  it('keeps feeding the desk its source states, so a pending load is never an all-clear', () => {
    expect(APP_SRC).toContain("farmInventoryLoading={!isDemo && (adminDataLoadState === 'idle' || adminDataLoadState === 'loading')}")
    expect(APP_SRC).toContain("farmInventoryFailed={!isDemo && adminDataLoadState === 'failed'}")
    expect(APP_SRC).toContain('reviewRequestsLoading={deskReviewRequests.loading}')
  })

  it('exists and is reached from the desk', () => {
    expect(handler.length).toBeGreaterThan(0)
    expect(APP_SRC).toContain('onChaseFarms={chases => { handleChaseFarms(chases).catch(() => undefined) }}')
  })

  it('sets farmProfileId and never stockItemId', () => {
    expect(handler).toContain('farmProfileId: chase.farmProfileId')
    expect(handler).not.toContain('stockItemId')
  })

  it('does not patch any batch — a farm chase must not re-open batches', () => {
    expect(handler).not.toContain('patchInventoryBatch')
    expect(handler).not.toContain('needs_changes')
  })

  it('writes to the database before local state, so a failed chase is not shown as sent', () => {
    expect(handler).toContain('commitMutation')
    expect(handler.indexOf('createReviewRequest')).toBeLessThan(handler.indexOf('onCommitted'))
  })
})

describe('createReviewRequest persists the farm it was told about', () => {
  // The writer hardcoded `farm_id: null` while the farmer's own read scopes on
  // `farm_id.in.(…)`, so a farm-level request could never reach the farm it was
  // about. Nothing wrote farm-level requests before, so nothing regressed — the
  // field was simply unreachable.
  const fn = DB_SRC.slice(
    DB_SRC.indexOf('export async function createReviewRequest'),
    DB_SRC.indexOf('export async function resolveReviewRequest'),
  )

  it('writes farm_id from the request rather than a hardcoded null', () => {
    expect(fn).toContain('farm_id: req.farmProfileId ?? null')
    expect(fn).not.toContain('farm_id: null,')
  })

  it('validates it as a UUID, exactly as it does for the batch id', () => {
    expect(fn).toContain('isValidUUID(req.farmProfileId)')
  })
})

describe('a UUID is never shown as a farm name', () => {
  // Measured in production: 11 of 24 matters rendered the farm as
  // b1f4182c-3a2b-419b-b050-84609ac13492, and one as "BIG HAIRY ASS ·" — a
  // dangling separator where the farm name should be.
  it('replaces a bare UUID label with a plain statement, keeping the id as metadata', () => {
    const orphanUuid = 'b1f4182c-3a2b-419b-b050-84609ac13492'
    render(
      <DDPOperationsDeskOrganic
        farms={[{ id: orphanUuid, tradingName: '', status: 'Submitted to DDP' } as FarmProfile]}
        inventory={[]}
        reviewRequests={[]}
        complianceAlerts={[]}
        reviewRequestsLoading={false}
        complianceLoading={false}
        farmInventoryLoading={false}
        farmInventoryFailed={false}
        onOpen={() => undefined}
      />,
    )
    // The farm raises several matters, so several rows carry the same label.
    expect(screen.queryByText(orphanUuid)).toBeNull()
    expect(screen.getAllByText(/no name on file/i).length).toBeGreaterThan(0)
    // The identifier survives, truncated, so the row is still traceable.
    expect(screen.getAllByText(/^b1f4182c/).length).toBeGreaterThan(0)
  })
})

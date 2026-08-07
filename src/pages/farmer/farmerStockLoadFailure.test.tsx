// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import FarmerMyStock from './FarmerMyStock'
import type { InventoryItem } from '../../types'

/**
 * P1 — a farmer whose data failed to load was told they had no stock.
 *
 * The farmer data fetch in App.tsx catches its failure by setting an EMPTY
 * scope, which makes every derived farmer list compute to `[]`. FarmerMyStock
 * then rendered "No stock yet. Add your first listing above." — so a farm with
 * fifty batches saw a screen saying it had none, with a button inviting it to
 * create the first one. An error rendered as an empty state, and a destructive
 * suggestion on top of it.
 *
 * The admin side already tracked a failed source. The farmer side did not.
 *
 * These assert both directions, because a screen that says "we could not load"
 * whenever a farmer genuinely has no stock would be just as wrong.
 */

afterEach(cleanup)

const EMPTY: InventoryItem[] = []

const NO_STOCK_EN = /No stock yet/iu
const FAILED_EN = /could not load your stock/iu
const ADD_FIRST_EN = /Add First Stock/iu

function renderStock(props: Partial<React.ComponentProps<typeof FarmerMyStock>> = {}) {
  return render(
    <FarmerMyStock
      lang="en"
      inventory={EMPTY}
      onAddNew={vi.fn()}
      onEdit={vi.fn()}
      openRequestCount={0}
      onGoRequests={vi.fn()}
      {...props}
    />,
  )
}

describe('an empty list means two different things', () => {
  it('says "no stock yet" when the farmer genuinely has none', () => {
    renderStock({ loadFailed: false })
    expect(screen.queryByText(NO_STOCK_EN)).not.toBeNull()
    expect(screen.queryByText(FAILED_EN)).toBeNull()
  })

  it('says the load failed when it did — and does NOT claim the farmer has none', () => {
    renderStock({ loadFailed: true })
    expect(screen.queryByText(FAILED_EN)).not.toBeNull()
    expect(screen.queryByText(NO_STOCK_EN)).toBeNull()
  })

  it('announces the failure to assistive technology', () => {
    renderStock({ loadFailed: true })
    expect(screen.queryByRole('alert')).not.toBeNull()
  })

  it('does not mark the ordinary empty state as an alert', () => {
    renderStock({ loadFailed: false })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('what the screen offers to do about it', () => {
  it('offers "add your first stock" to a farmer who really has none', () => {
    renderStock({ loadFailed: false })
    expect(screen.queryByRole('button', { name: ADD_FIRST_EN })).not.toBeNull()
  })

  it('never offers it on a failed load', () => {
    // The farmer may already have stock they cannot see. Inviting them to
    // create "their first" listing risks a duplicate, which is a worse
    // outcome than a screen that admits it does not know.
    renderStock({ loadFailed: true })
    expect(screen.queryByRole('button', { name: ADD_FIRST_EN })).toBeNull()
  })
})

describe('Thai', () => {
  it('reports the failure in Thai, not in English', () => {
    renderStock({ loadFailed: true, lang: 'th' })
    expect(screen.queryByText(/ไม่สามารถโหลดสต็อกของคุณได้/u)).not.toBeNull()
    expect(screen.queryByText(FAILED_EN)).toBeNull()
  })
})

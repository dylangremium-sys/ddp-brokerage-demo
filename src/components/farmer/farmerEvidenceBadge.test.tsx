// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import FarmerNav from './FarmerNav'
import FarmerDashboard from '../../pages/farmer/FarmerDashboard'

// FarmerDashboard reads a locally saved draft on render, which needs storage this
// environment does not provide. Stubbed to the "no draft" case: the profile-draft
// prompt is not what these tests are about, and letting it throw would fail them
// for a reason unrelated to the badge.
vi.mock('../../data', () => ({
  loadFarmDraft: () => null,
  calcCompletion: () => 0,
}))

/**
 * The farmer's evidence surface was reachable ONLY from the dashboard tile, so a
 * farmer working in My Stock — which is where they would go to fix a document —
 * had no route to the question DDP was asking them. These tests pin the two
 * things that close that gap, and the one way the fix could itself mislead.
 *
 * THE NULL-VERSUS-ZERO RULE IS THE POINT. The count is `number | null`, where
 * null means "not known yet, or the read failed". Both render no badge, so they
 * look identical on screen — which is correct, and is exactly why it needs a
 * test: the tempting simplification is `count > 0` on a plain number, and that
 * silently turns a failed read into a confident "nothing is waiting". That is the
 * one statement this surface must never make wrongly, and it is the same rule
 * FarmerEvidence and FarmerMyStock already follow for their empty states.
 */

afterEach(cleanup)

function renderNav(evidenceWaiting: number | null | undefined) {
  return render(
    <FarmerNav lang="en" page="farmer-my-stock" goTo={vi.fn()} evidenceWaiting={evidenceWaiting} />,
  )
}

function renderDashboard(evidenceWaitingCount: number | null | undefined) {
  return render(
    <FarmerDashboard
      lang="en"
      farms={[]}
      currentProfile={null}
      onBuildProfile={vi.fn()}
      onMyStock={vi.fn()}
      onMyActivity={vi.fn()}
      onAdvancedProfile={vi.fn()}
      onRequests={vi.fn()}
      onEvidence={vi.fn()}
      evidenceWaitingCount={evidenceWaitingCount}
    />,
  )
}

describe('the farmer can reach their evidence from anywhere', () => {
  it('offers My Evidence in the navbar, not only on the dashboard', () => {
    renderNav(null)
    expect(screen.queryByRole('button', { name: /my evidence/iu })).not.toBeNull()
  })

  it('navigates to the evidence page when pressed', () => {
    const goTo = vi.fn()
    render(<FarmerNav lang="en" page="farmer-my-stock" goTo={goTo} evidenceWaiting={1} />)
    screen.getByRole('button', { name: /my evidence/iu }).click()
    expect(goTo).toHaveBeenCalledWith('farmer-evidence')
  })

  it('is reachable in Thai too', () => {
    render(<FarmerNav lang="th" page="farmer-my-stock" goTo={vi.fn()} evidenceWaiting={null} />)
    expect(screen.queryByText(/เอกสารของฉัน/u)).not.toBeNull()
  })
})

describe('the badge counts only what DDP is waiting on', () => {
  it('shows the number when documents are waiting', () => {
    renderNav(2)
    expect(screen.queryByText('2')).not.toBeNull()
  })

  it('shows NO badge when nothing is waiting', () => {
    renderNav(0)
    expect(screen.queryByText('0')).toBeNull()
  })

  it('shows NO badge when the count is unknown or the read failed', () => {
    renderNav(null)
    // A failed read must not become a confident "nothing is waiting".
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.queryByRole('button', { name: /my evidence/iu })).not.toBeNull()
  })

  it('defaults to no badge when the prop is not passed at all', () => {
    renderNav(undefined)
    expect(screen.queryByText('0')).toBeNull()
  })
})

describe('the dashboard tile says what is waiting', () => {
  it('states the count instead of the generic description', () => {
    renderDashboard(1)
    expect(screen.queryByText(/DDP is waiting on you for 1/iu)).not.toBeNull()
  })

  it('falls back to the generic description when nothing is waiting', () => {
    renderDashboard(0)
    expect(screen.queryByText(/DDP is waiting on you for/iu)).toBeNull()
    expect(screen.queryByText(/see DDP’s decision on each document/iu)).not.toBeNull()
  })

  it('does not claim anything when the count is unknown', () => {
    renderDashboard(null)
    expect(screen.queryByText(/DDP is waiting on you for/iu)).toBeNull()
  })
})

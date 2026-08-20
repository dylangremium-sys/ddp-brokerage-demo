// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DDPFarmReview from './DDPFarmReview'
import { makeFarm } from '../../lib/testFixtures'
import { isFarmScored, farmTotalScore } from '../../data'

// ─── "Not yet scored" is not the same as "scored zero" ──────────────────────
//
// NOTHING COMPUTES THESE NINE SCORES FOR A REAL FARM. They are hardcoded into
// the demo fixtures in data.ts (78, 80, 55, 92 …) and db.ts sets every one to 0
// when a profile is read back from Supabase — there are no score columns in the
// database and no function anywhere derives one from profile data.
//
// So every real farm rendered `0 / 900` with nine empty bars. An admin reads
// that as "this farm scored zero on everything". On a farm with a complete
// profile it is the screen asserting a commercial judgement nobody made —
// measured on production 2026-08-03, farm `billyboy`, all seven profile sections
// populated, displayed 0/900 across all nine categories.
//
// The risk flags and positive signals on the same panel ARE derived from real
// data, which is why that farm simultaneously showed "Strong production
// capacity". Those must survive.

// vitest is not configured with globals, so @testing-library's automatic
// cleanup does not run. Without this the previous test's DOM stays mounted and
// `screen` queries the accumulated document — which is exactly how the first
// version of this file "failed": test 2 found test 1's "Not yet scored" span.
afterEach(cleanup)

/** Required callback props this suite never exercises. */
const noop = () => undefined

describe('isFarmScored', () => {
  it('is false when every component is zero', () => {
    expect(isFarmScored(makeFarm())).toBe(false)
  })

  it('is true as soon as ANY component is non-zero', () => {
    // Deliberately one category, not all nine: a partially scored farm has been
    // scored, and must not be reported as unassessed.
    expect(isFarmScored(makeFarm({ scoreCommunication: 1 }))).toBe(true)
  })

  it('agrees with the total it is derived from', () => {
    const scored = makeFarm({ scoreCompliance: 40, scoreFacilityQuality: 20 })
    expect(farmTotalScore(scored)).toBe(60)
    expect(isFarmScored(scored)).toBe(true)
  })
})

describe('DDPFarmReview — the score panel tells the truth', () => {
  it('says "Not yet scored" instead of 0 / 900 when nothing has scored it', () => {
    render(<DDPFarmReview farm={makeFarm()} onBack={noop} onAction={noop} />)

    expect(screen.getByText(/not yet scored/i)).toBeTruthy()
    // THE POINT: the misleading numerals must be absent, not merely de-emphasised.
    expect(screen.queryByText('/ 900')).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('still shows the real total once a farm HAS been scored', () => {
    // Guards the obvious over-correction: hiding the score for everyone.
    render(
      <DDPFarmReview
        farm={makeFarm({ scoreCompliance: 78, scoreFacilityQuality: 80 })}
        onBack={noop}
        onAction={noop}
      />,
    )

    expect(screen.getByText('158')).toBeTruthy()
    expect(screen.getByText('/ 900')).toBeTruthy()
    expect(screen.queryByText(/not yet scored/i)).toBeNull()
  })

  it('keeps the risk flags on an unscored farm — those are real', () => {
    // The flags are computed from actual profile data and carry the only genuine
    // assessment on this panel. Suppressing the score must not suppress them.
    render(<DDPFarmReview farm={makeFarm()} onBack={noop} onAction={noop} />)
    expect(screen.getByText(/missing export licence/i)).toBeTruthy()
  })
})

// ─── The same honesty must hold on the OVERVIEW ─────────────────────────────
//
// Flagged by review on the first version of this change: making the review page
// say "Not yet scored" while the Overview still ranked the same farm under
// "Top-Scored Farm Profiles" at 0 / 900 would have left the two screens
// contradicting each other — and presented unranked farms as ranked.
//
// REHOMED FROM DDPOverview TO DDPOverviewOrganic, which is the screen an
// operator actually reaches. The old one has not been routed since the Organic
// rebuild, so these assertions were passing against a page nobody can open.
//
// ONE HALF MOVED AND ONE HALF DID NOT, and the difference is the point. The
// live Overview does not rank farms at all — its own header says "NOTHING HERE
// ASSERTS A SCORE … a 'top-scored' list of unscored farms is a ranking of
// things that were never ranked. The rail says so in words instead." So:
//
//   "never prints 0 / 900 for an unscored farm"  → moved, and now holds by
//                                                  construction rather than by
//                                                  a filter
//   "still ranks a farm that HAS been scored"    → NOT moved. It describes a
//                                                  feature the live screen
//                                                  deliberately dropped, and
//                                                  re-asserting it would demand
//                                                  the ranking come back.
//
// What replaces it is the honest statement the live rail makes instead: the
// count of farms that have been scored, in words.
describe('Overview — unscored farms are not presented as ranked', () => {
  it('prints no /900 ranking for an unscored farm', async () => {
    const { default: DDPOverviewOrganic } = await import('./DDPOverviewOrganic')
    const { container } = render(
      <DDPOverviewOrganic
        farms={[makeFarm({ id: 'f1', tradingName: 'Unscored Farm' })]}
        inventory={[]}
        onReviewFarm={noop}
        onReviewItem={noop}
        onOpenDesk={noop}
      />,
    )
    expect(container.textContent).not.toMatch(/\/\s*900/)
  })

  it('says in words that nothing has been scored, rather than showing a zero', async () => {
    const { default: DDPOverviewOrganic } = await import('./DDPOverviewOrganic')
    const { container } = render(
      <DDPOverviewOrganic
        farms={[makeFarm({ id: 'f1', tradingName: 'Unscored Farm' })]}
        inventory={[]}
        onReviewFarm={noop}
        onReviewItem={noop}
        onOpenDesk={noop}
      />,
    )
    expect(container.textContent).toMatch(/None has been scored/i)
    expect(container.textContent).not.toMatch(/\/\s*900/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  THC_CONVERSION_FACTOR,
  TOTAL_THC_TOLERANCE_PCT,
  checkDateOrder,
  checkTotalThc,
  recomputeTotalThc,
} from './coaIntegrity'

/**
 * Every figure in this file was read out of a real certificate. Nothing is
 * invented, because the point of these tests is that the tolerance and the
 * verdicts are the ones the actual documents require — a fixture with tidy
 * numbers would prove the code runs and nothing else.
 *
 * Eleven certificates: seven TNR Bioscience 2026 reports for Calli Krush
 * (RP-E2602-0191…0197) and four 2025 reports for BIENESTAR T&N (samples
 * EX25-068…071, from pages 11–15 of the combined pack).
 */
const REAL_REPORTS = [
  { id: 'RP-E2602-0191', delta9ThcPct: 2.51, thcaPct: 23.7, statedTotalThcPct: 23.29 },
  { id: 'RP-E2602-0192', delta9ThcPct: 1.24, thcaPct: 22.59, statedTotalThcPct: 21.06 },
  { id: 'RP-E2602-0193', delta9ThcPct: 3.0, thcaPct: 22.27, statedTotalThcPct: 22.52 },
  { id: 'RP-E2602-0194', delta9ThcPct: 2.66, thcaPct: 19.19, statedTotalThcPct: 19.49 },
  { id: 'RP-E2602-0195', delta9ThcPct: 0.93, thcaPct: 25.19, statedTotalThcPct: 23.02 },
  { id: 'RP-E2602-0196', delta9ThcPct: 2.29, thcaPct: 28.02, statedTotalThcPct: 26.86 },
  { id: 'RP-E2602-0197', delta9ThcPct: 0.9, thcaPct: 23.27, statedTotalThcPct: 21.31 },
  { id: 'EX25-068', delta9ThcPct: 1.13, thcaPct: 24.82, statedTotalThcPct: 22.9 },
  { id: 'EX25-069', delta9ThcPct: 1.79, thcaPct: 26.4, statedTotalThcPct: 24.94 },
  { id: 'EX25-070', delta9ThcPct: 1.39, thcaPct: 25.64, statedTotalThcPct: 23.88 },
  { id: 'EX25-071', delta9ThcPct: 1.57, thcaPct: 19.82, statedTotalThcPct: 18.95 },
] as const

describe('total THC recompute', () => {
  it('uses the decarboxylation factor, which is chemistry and not policy', () => {
    expect(THC_CONVERSION_FACTOR).toBe(0.877)
    expect(recomputeTotalThc(0.9, 23.27)).toBeCloseTo(21.3078, 4)
  })

  for (const report of REAL_REPORTS) {
    it(`[${report.id}] agrees with the laboratory's own stated total`, () => {
      expect(checkTotalThc(report).verdict).toBe('consistent')
    })
  }

  /**
   * The reason TOTAL_THC_TOLERANCE_PCT exists and is not zero.
   *
   * If this test ever fails it means the tolerance was tightened toward
   * equality, and two correct reports are about to be rejected.
   */
  it('is never exact on any real report, because the inputs are published rounded', () => {
    const exact = REAL_REPORTS.filter((r) => recomputeTotalThc(r.delta9ThcPct, r.thcaPct) === r.statedTotalThcPct)
    expect(exact).toEqual([])
  })

  it('the largest real disagreement is comfortably inside the tolerance', () => {
    const worst = Math.max(
      ...REAL_REPORTS.map((r) => Math.abs(recomputeTotalThc(r.delta9ThcPct, r.thcaPct) - r.statedTotalThcPct)),
    )
    // RP-E2602-0193, measured at 0.0108.
    expect(worst).toBeLessThan(0.011)
    expect(worst).toBeLessThan(TOTAL_THC_TOLERANCE_PCT)
  })

  it('an equality test would reject two CORRECT reports — the mistake this guards', () => {
    const rejectedByEquality = REAL_REPORTS.filter(
      (r) => Number(recomputeTotalThc(r.delta9ThcPct, r.thcaPct).toFixed(2)) !== r.statedTotalThcPct,
    ).map((r) => r.id)
    expect(rejectedByEquality).toEqual(['RP-E2602-0192', 'RP-E2602-0193'])
    // …and both pass under the real check.
    for (const id of rejectedByEquality) {
      const report = REAL_REPORTS.find((r) => r.id === id)!
      expect(checkTotalThc(report).verdict).toBe('consistent')
    }
  })
})

describe('total THC as a check on the EXTRACTION, not the laboratory', () => {
  /**
   * The measured failure from page 13 of the combined pack.
   *
   * That template's text layer emits whole columns, and the column order is not
   * stable between pages: page 11 ends with the two totals, page 13 begins with
   * them. Pairing page 13's values against the order learned from page 11 gives
   * the reading below — every value individually plausible, all of them wrong.
   */
  it('catches a column-order mis-parse that no per-value check would notice', () => {
    const misparsed = { delta9ThcPct: 0.92, thcaPct: 0.05, statedTotalThcPct: 26.4 }
    const check = checkTotalThc(misparsed)

    expect(check.verdict).toBe('inconsistent')
    expect(check.recomputedPct).toBeCloseTo(0.9639, 4)
    expect(check.differencePct).toBeGreaterThan(25)
    expect(check.warning).toMatch(/disagrees with its components/)
  })

  it('the same page read correctly is consistent', () => {
    expect(checkTotalThc({ delta9ThcPct: 1.79, thcaPct: 26.4, statedTotalThcPct: 24.94 }).verdict).toBe('consistent')
  })

  it('every mis-parsed value is individually plausible — which is the point', () => {
    // 0.92 %w/w d9-THC and 0.05 %w/w THCA are both ordinary readings. Nothing
    // about either number is suspicious on its own.
    const misparsed = { delta9ThcPct: 0.92, thcaPct: 0.05, statedTotalThcPct: 26.4 }
    expect(misparsed.delta9ThcPct).toBeGreaterThan(0)
    expect(misparsed.delta9ThcPct).toBeLessThan(30)
    expect(misparsed.thcaPct).toBeGreaterThan(0)
    expect(misparsed.thcaPct).toBeLessThan(30)
    expect(checkTotalThc(misparsed).verdict).toBe('inconsistent')
  })
})

describe('total THC when it cannot be checked', () => {
  it('distinguishes "no total stated" from "total is wrong"', () => {
    const check = checkTotalThc({ delta9ThcPct: 0.9, thcaPct: 23.27, statedTotalThcPct: null })
    expect(check.verdict).toBe('not_checkable')
    expect(check.recomputedPct).toBeCloseTo(21.3078, 4)
    // The working is shown, so a reviewer can use it without it being passed off
    // as the laboratory's figure.
    expect(check.warning).toMatch(/states no total/)
  })

  it('is not checkable when a component is missing', () => {
    expect(checkTotalThc({ delta9ThcPct: 0.9, thcaPct: null, statedTotalThcPct: 21.31 }).verdict).toBe('not_checkable')
    expect(checkTotalThc({ delta9ThcPct: null, thcaPct: 23.27, statedTotalThcPct: 21.31 }).verdict).toBe(
      'not_checkable',
    )
  })

  it('rejects NaN and Infinity rather than computing with them', () => {
    // NaN sorts above every number, so a comparison-only guard admits it.
    expect(checkTotalThc({ delta9ThcPct: NaN, thcaPct: 23.27, statedTotalThcPct: 21.31 }).verdict).toBe('not_checkable')
    expect(checkTotalThc({ delta9ThcPct: 0.9, thcaPct: Infinity, statedTotalThcPct: 21.31 }).verdict).toBe(
      'not_checkable',
    )
    expect(checkTotalThc({ delta9ThcPct: 0.9, thcaPct: 23.27, statedTotalThcPct: NaN }).verdict).toBe('not_checkable')
  })
})

describe('date ordering', () => {
  it('accepts report RP-E2602-0197 read as the laboratory writes dates', () => {
    // received 11/02/2026, testing start 17/02/2026 — DD/MM throughout.
    expect(
      checkDateOrder([
        { label: 'sample received date', iso: '2026-02-11' },
        { label: 'test date', iso: '2026-02-17' },
      ]),
    ).toEqual([])
  })

  /**
   * The same document read as US format. `17/02/2026` has no month 17 so it
   * cannot flip, but `11/02/2026` becomes 2 November — after the sample was
   * tested. Nine months wrong, and it parses cleanly.
   */
  it('rejects the ordering produced by reading the same report as MM/DD', () => {
    const warnings = checkDateOrder([
      { label: 'sample received date', iso: '2026-11-02' },
      { label: 'test date', iso: '2026-02-17' },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/test date \(2026-02-17\) is before sample received date \(2026-11-02\)/)
  })

  it('skips dates that could not be parsed rather than reporting them twice', () => {
    expect(
      checkDateOrder([
        { label: 'sample received date', iso: null },
        { label: 'test date', iso: '2026-02-17' },
      ]),
    ).toEqual([])
  })

  it('says nothing when there is nothing to compare', () => {
    expect(checkDateOrder([])).toEqual([])
    expect(checkDateOrder([{ label: 'test date', iso: '2026-02-17' }])).toEqual([])
  })

  it('accepts same-day dates — received and tested on one day is ordinary', () => {
    expect(
      checkDateOrder([
        { label: 'sample received date', iso: '2026-02-17' },
        { label: 'test date', iso: '2026-02-17' },
      ]),
    ).toEqual([])
  })
})

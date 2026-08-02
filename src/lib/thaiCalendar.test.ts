import { describe, it, expect } from 'vitest'
import {
  BE_CE_OFFSET,
  EARLIEST_CONVERTIBLE_CE_YEAR,
  LATEST_CONVERTIBLE_CE_YEAR,
  classifyEra,
  ceYearToBe,
  beYearToCe,
  dualDateFrom,
  parseDualDate,
  reconcileDualYear,
  reconcileDualDate,
  formatDualDate,
  formatDualDateBoth,
  isExpiredAsOf,
} from './thaiCalendar'

describe('era classification', () => {
  it('reads a real Thai document year as BE and a Western one as CE', () => {
    expect(classifyEra(2569)).toEqual({ era: 'be', certain: true })
    expect(classifyEra(2026)).toEqual({ era: 'ce', certain: true })
  })

  it('never reports ambiguity, because the CE and BE windows do not overlap', () => {
    // This is the property the module's certainty rests on. If either constant
    // is widened so the windows touch, this fails — which is the point: the
    // alternative is a silent guessing path.
    expect(LATEST_CONVERTIBLE_CE_YEAR).toBeLessThan(EARLIEST_CONVERTIBLE_CE_YEAR + BE_CE_OFFSET)

    for (let year = 1000; year <= 3500; year++) {
      const classified = classifyEra(year)
      if (!classified.certain) expect(classified.reason).toBe('out-of-range')
    }
  })

  it('rejects pre-reform years rather than applying the flat offset to them', () => {
    // Before 1941 the Thai year began on 1 April, so 543 is wrong for roughly a
    // quarter of the calendar. A plausible wrong answer is worse than a refusal.
    expect(classifyEra(1900).certain).toBe(false)
    expect(classifyEra(1940)).toEqual({ era: null, certain: false, reason: 'out-of-range' })
    expect(classifyEra(1941)).toEqual({ era: 'ce', certain: true })
  })

  it('rejects a year that has been converted twice', () => {
    // 2026 → 2569 → 3112. The doubly-converted value is the commonest
    // dual-calendar defect and is invisible without a ceiling.
    expect(classifyEra(ceYearToBe(ceYearToBe(2026)))).toEqual({
      era: null,
      certain: false,
      reason: 'out-of-range',
    })
  })

  it('rejects non-integers', () => {
    expect(classifyEra(2026.5).certain).toBe(false)
    expect(classifyEra(Number.NaN).certain).toBe(false)
  })
})

describe('year conversion', () => {
  it('round-trips', () => {
    expect(ceYearToBe(2026)).toBe(2569)
    expect(beYearToCe(2569)).toBe(2026)
    expect(beYearToCe(ceYearToBe(1999))).toBe(1999)
  })

  it('agrees with the plan: B.E. 2569 is 2026 CE', () => {
    expect(beYearToCe(2569)).toBe(2026)
  })
})

describe('dualDateFrom', () => {
  it('builds both sides from a known-CE date', () => {
    expect(dualDateFrom('2026-12-31', 'ce')).toEqual({ ok: true, value: { ce: '2026-12-31', beYear: 2569 } })
  })

  it('converts a known-BE date to canonical CE', () => {
    // The licence cliff in D4: 31 December 2026 CE, written พ.ศ. 2569 on the
    // Thai document.
    expect(dualDateFrom('2569-12-31', 'be')).toEqual({ ok: true, value: { ce: '2026-12-31', beYear: 2569 } })
  })

  it('does not shift the day across a timezone boundary', () => {
    // The whole module is string arithmetic precisely so that this holds
    // regardless of the host offset. `new Date('2026-01-01')` would be UTC
    // midnight and render as 2025-12-31 anywhere west of Greenwich.
    const parsed = dualDateFrom('2026-01-01', 'ce')
    expect(parsed.ok && parsed.value.ce).toBe('2026-01-01')
    expect(parsed.ok && parsed.value.beYear).toBe(2569)
  })

  it('rejects impossible dates, including a non-leap 29 February', () => {
    expect(dualDateFrom('2026-02-29', 'ce')).toEqual({ ok: false, reason: 'impossible-date' })
    expect(dualDateFrom('2024-02-29', 'ce').ok).toBe(true)
    expect(dualDateFrom('2026-13-01', 'ce')).toEqual({ ok: false, reason: 'impossible-date' })
    expect(dualDateFrom('2026-04-31', 'ce')).toEqual({ ok: false, reason: 'impossible-date' })
  })

  it('applies the leap rule on the CE year, not the BE year', () => {
    // 2024 CE is a leap year; the corresponding BE year 2567 is not divisible
    // by 4. Validating the raw year would reject a real date.
    expect(dualDateFrom('2567-02-29', 'be').ok).toBe(true)
  })

  it('rejects malformed input rather than coercing it', () => {
    expect(dualDateFrom('31/12/2026', 'ce')).toEqual({ ok: false, reason: 'malformed' })
    expect(dualDateFrom('2026-12', 'ce')).toEqual({ ok: false, reason: 'malformed' })
    expect(dualDateFrom('', 'ce')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a BE date mislabelled as CE', () => {
    expect(dualDateFrom('2569-12-31', 'ce')).toEqual({ ok: false, reason: 'era-out-of-range' })
  })
})

describe('parseDualDate', () => {
  it('infers the era for both real-world cases', () => {
    expect(parseDualDate('2569-04-01')).toEqual({ ok: true, value: { ce: '2026-04-01', beYear: 2569 } })
    expect(parseDualDate('2026-04-01')).toEqual({ ok: true, value: { ce: '2026-04-01', beYear: 2569 } })
  })

  it('reports out-of-range for a doubly-converted year', () => {
    expect(parseDualDate('3112-12-31')).toEqual({ ok: false, reason: 'era-out-of-range' })
  })
})

describe('reconciliation', () => {
  it('passes a correct pair', () => {
    expect(reconcileDualYear(2026, 2569)).toEqual({ ok: true })
  })

  it('names the drift when the BE side was never converted', () => {
    expect(reconcileDualYear(2026, 2026)).toEqual({
      ok: false,
      reason: 'offset-mismatch',
      ceYear: 2026,
      beYear: 2026,
      expectedBeYear: 2569,
      drift: -543,
    })
  })

  it('names the drift when the CE side was converted a second time', () => {
    const drifted = reconcileDualYear(2569, 2569)
    expect(drifted.ok).toBe(false)
    expect(drifted.ok === false && drifted.reason === 'offset-mismatch' && drifted.drift).toBe(-543)
  })

  it('reports a broken CE side distinctly from a 543-year error', () => {
    expect(reconcileDualDate({ ce: 'not-a-date', beYear: 2569 })).toEqual({ ok: false, reason: 'malformed-ce' })
    expect(reconcileDualDate({ ce: '2026-12-31', beYear: 2569 })).toEqual({ ok: true })
    const drifted = reconcileDualDate({ ce: '2026-12-31', beYear: 2026 })
    expect(drifted.ok === false && drifted.reason).toBe('offset-mismatch')
  })

  it('does not correct the stored value', () => {
    // Overwriting one side destroys the evidence that they disagreed, and the
    // wrong side is as likely to be the one kept.
    const stored = { ce: '2026-12-31', beYear: 2026 }
    reconcileDualDate(stored)
    expect(stored.beYear).toBe(2026)
  })
})

describe('rendering', () => {
  const cliff = { ce: '2026-12-31', beYear: 2569 } as const

  it('renders BE for Thai and CE for English', () => {
    expect(formatDualDate(cliff, 'th')).toBe('31 ธันวาคม พ.ศ. 2569')
    expect(formatDualDate(cliff, 'en')).toBe('31 December 2026 CE')
  })

  it('always prints the era marker', () => {
    // An unlabelled Thai date is what lets a 543-year error survive review.
    expect(formatDualDate(cliff, 'th')).toContain('พ.ศ.')
    expect(formatDualDate(cliff, 'en')).toContain('CE')
  })

  it('renders both calendars for documents with two audiences', () => {
    expect(formatDualDateBoth(cliff)).toBe('2026-12-31 CE (พ.ศ. 2569)')
  })
})

describe('expiry', () => {
  const cliff = { ce: '2026-12-31', beYear: 2569 } as const

  it('treats the expiry day as still valid and the next day as lapsed', () => {
    expect(isExpiredAsOf(cliff, '2026-12-30')).toBe(false)
    expect(isExpiredAsOf(cliff, '2026-12-31')).toBe(false)
    expect(isExpiredAsOf(cliff, '2027-01-01')).toBe(true)
  })
})

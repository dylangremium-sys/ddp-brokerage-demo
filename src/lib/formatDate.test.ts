import { describe, it, expect } from 'vitest'
import { formatDate } from './formatDate'

/**
 * P1 / W10.4 — row F-U4, "Buddhist-Era date handling".
 *
 * The Thai calendar is not implemented here; `Intl` already has it. What was
 * missing is that the farmer screens formatted dates four different ways and
 * only two of them consulted the app's language — so a Thai farmer could be
 * shown a raw ISO string, a Gregorian year, or a date in whatever language the
 * handset happened to be set to, depending which screen they were on.
 */

// 2026-03-01 is 1 March 2569 in the Buddhist Era.
const ISO_DATE = '2026-03-01'
const ISO_TIMESTAMP = '2026-03-01T09:30:00.000Z'

describe('Thai renders the Buddhist Era', () => {
  it('shows 2569, not 2026', () => {
    const formatted = formatDate(ISO_DATE, 'th')
    expect(formatted).toContain('2569')
    expect(formatted).not.toContain('2026')
  })

  it('does the same for a full timestamp', () => {
    expect(formatDate(ISO_TIMESTAMP, 'th')).toContain('2569')
  })

  it('uses Thai month names, not transliterated English', () => {
    expect(formatDate(ISO_DATE, 'th')).toMatch(/[฀-๿]/u)
  })
})

describe('English renders the Gregorian year', () => {
  it('shows 2026, not 2569', () => {
    const formatted = formatDate(ISO_DATE, 'en')
    expect(formatted).toContain('2026')
    expect(formatted).not.toContain('2569')
  })
})

describe('the app decides, not the machine', () => {
  it('gives different output per language for the same instant', () => {
    // The defect this replaces called toLocaleDateString() with no locale at
    // all, so the output followed the host and ignored the app entirely. If
    // these two ever match, that bug is back.
    expect(formatDate(ISO_DATE, 'th')).not.toBe(formatDate(ISO_DATE, 'en'))
  })

  it('produces the exact expected string in each language', () => {
    // Literal expectations, because the previous version of this test compared
    // the output against a value derived from the same call and passed on both
    // branches — it asserted nothing at all. Pinning the strings makes a
    // locale or option change visible instead of silently accepted.
    expect(formatDate(ISO_DATE, 'en')).toBe('1 Mar 2026')
    expect(formatDate(ISO_DATE, 'th')).toBe('1 มี.ค. 2569')
  })
})

describe('values that are not dates', () => {
  it('returns empty for empty, null and undefined', () => {
    expect(formatDate('', 'en')).toBe('')
    expect(formatDate(null, 'en')).toBe('')
    expect(formatDate(undefined, 'en')).toBe('')
  })

  it('returns the original text rather than "Invalid Date"', () => {
    // A farmer seeing what they typed can fix it. "Invalid Date" tells them
    // nothing, and a thrown error takes the screen with it.
    expect(formatDate('not a date', 'th')).toBe('not a date')
    expect(formatDate('2026-13-45', 'en')).toBe('2026-13-45')
  })

  it('never throws', () => {
    for (const value of ['', '   ', 'x', '0000-00-00', '2026-03-01']) {
      expect(() => formatDate(value, 'th')).not.toThrow()
    }
  })
})

import { describe, it, expect } from 'vitest'
import {
  parseCalendarDate,
  calendarDayNumber,
  localCalendarDate,
  daysUntilCalendarDate,
  formatCalendarDate,
  isExpiredOn,
  isExpiringWithin,
} from './calendarDate'

/**
 * Every `now` here is built with the LOCAL Date constructor — new Date(y, mIdx,
 * d, h) — so "now" is that local wall-clock moment in whatever zone the test
 * machine runs in. That is what makes these assertions timezone-independent:
 * they never depend on the runner sitting at UTC.
 *
 * The times chosen (09:00, 23:00, 00:30) are the ones that broke the old
 * Date.parse comparison: east of UTC the day flips early, west of UTC late.
 */
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h, 0, 0)

describe('parseCalendarDate — structure and safe failure', () => {
  it('parses a well-formed date-only value', () => {
    expect(parseCalendarDate('2026-07-17')).toEqual({ year: 2026, month: 7, day: 17 })
  })

  it('preserves the exact calendar day, with no timezone shift', () => {
    const c = parseCalendarDate('2026-01-01')
    expect(c).toEqual({ year: 2026, month: 1, day: 1 })
  })

  it('accepts a leap day in a leap year', () => {
    expect(parseCalendarDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 })
  })

  it('rejects a leap day in a non-leap year rather than rolling it forward', () => {
    // Date would silently turn this into 1 March. It must fail instead.
    expect(parseCalendarDate('2026-02-29')).toBeNull()
  })

  it('rejects impossible days', () => {
    expect(parseCalendarDate('2026-02-30')).toBeNull()
    expect(parseCalendarDate('2026-04-31')).toBeNull()
    expect(parseCalendarDate('2026-13-01')).toBeNull()
    expect(parseCalendarDate('2026-00-10')).toBeNull()
    expect(parseCalendarDate('2026-07-00')).toBeNull()
  })

  it('fails safely for malformed values', () => {
    for (const v of ['', '   ', 'not-a-date', '17/07/2026', '2026-7-17', '26-07-17', 'null']) {
      expect(parseCalendarDate(v)).toBeNull()
    }
  })

  it('fails safely for null and undefined', () => {
    expect(parseCalendarDate(null)).toBeNull()
    expect(parseCalendarDate(undefined)).toBeNull()
  })

  it('rejects an instant — those are not calendar dates', () => {
    expect(parseCalendarDate('2026-07-17T00:00:00Z')).toBeNull()
  })
})

describe('calendarDayNumber — timezone- and DST-independent', () => {
  it('advances by exactly 1 per calendar day', () => {
    const a = calendarDayNumber({ year: 2026, month: 7, day: 17 })
    const b = calendarDayNumber({ year: 2026, month: 7, day: 18 })
    expect(b - a).toBe(1)
  })

  it('counts a DST-transition day as exactly one day', () => {
    // EU clocks change 2026-03-29; US clocks change 2026-03-08. A local-midnight
    // implementation would produce 0 or 2 here on those days.
    const before = calendarDayNumber({ year: 2026, month: 3, day: 28 })
    const after = calendarDayNumber({ year: 2026, month: 3, day: 29 })
    expect(after - before).toBe(1)
    const usBefore = calendarDayNumber({ year: 2026, month: 3, day: 7 })
    const usAfter = calendarDayNumber({ year: 2026, month: 3, day: 8 })
    expect(usAfter - usBefore).toBe(1)
  })

  it('crosses a month boundary by one day', () => {
    expect(
      calendarDayNumber({ year: 2026, month: 8, day: 1 }) -
      calendarDayNumber({ year: 2026, month: 7, day: 31 }),
    ).toBe(1)
  })

  it('crosses a year boundary by one day', () => {
    expect(
      calendarDayNumber({ year: 2027, month: 1, day: 1 }) -
      calendarDayNumber({ year: 2026, month: 12, day: 31 }),
    ).toBe(1)
  })
})

describe('localCalendarDate — reads the viewer’s own calendar day', () => {
  it('takes the local wall-clock date, not a UTC instant', () => {
    expect(localCalendarDate(at(2026, 7, 17, 23))).toEqual({ year: 2026, month: 7, day: 17 })
    expect(localCalendarDate(at(2026, 7, 17, 0))).toEqual({ year: 2026, month: 7, day: 17 })
  })
})

describe('daysUntilCalendarDate — the classification the review flagged', () => {
  const now = at(2026, 7, 17)

  it('yesterday is -1', () => {
    expect(daysUntilCalendarDate('2026-07-16', now)).toBe(-1)
  })

  it('today is 0 — regardless of the hour, in any timezone', () => {
    // This is the exact defect: Date.parse made today negative east of UTC once
    // the local clock passed midnight.
    expect(daysUntilCalendarDate('2026-07-17', at(2026, 7, 17, 0))).toBe(0)
    expect(daysUntilCalendarDate('2026-07-17', at(2026, 7, 17, 9))).toBe(0)
    expect(daysUntilCalendarDate('2026-07-17', at(2026, 7, 17, 23))).toBe(0)
  })

  it('tomorrow is 1', () => {
    expect(daysUntilCalendarDate('2026-07-18', now)).toBe(1)
  })

  it('exactly 30 days ahead is 30', () => {
    expect(daysUntilCalendarDate('2026-08-16', now)).toBe(30)
  })

  it('31 days ahead is 31', () => {
    expect(daysUntilCalendarDate('2026-08-17', now)).toBe(31)
  })

  it('counts across a month boundary', () => {
    expect(daysUntilCalendarDate('2026-08-01', at(2026, 7, 31))).toBe(1)
  })

  it('counts across a year boundary', () => {
    expect(daysUntilCalendarDate('2027-01-01', at(2026, 12, 31))).toBe(1)
  })

  it('counts across a leap day', () => {
    expect(daysUntilCalendarDate('2028-03-01', at(2028, 2, 28))).toBe(2)
  })

  it('returns null for malformed values rather than a number', () => {
    expect(daysUntilCalendarDate('', now)).toBeNull()
    expect(daysUntilCalendarDate('nonsense', now)).toBeNull()
    expect(daysUntilCalendarDate(undefined, now)).toBeNull()
  })
})

describe('isExpiredOn — a document is valid through its expiry date', () => {
  const now = at(2026, 7, 17)

  it('yesterday is expired', () => {
    expect(isExpiredOn('2026-07-16', now)).toBe(true)
  })

  it('today is NOT expired, at any hour of the day', () => {
    expect(isExpiredOn('2026-07-17', at(2026, 7, 17, 0))).toBe(false)
    expect(isExpiredOn('2026-07-17', at(2026, 7, 17, 12))).toBe(false)
    expect(isExpiredOn('2026-07-17', at(2026, 7, 17, 23))).toBe(false)
  })

  it('tomorrow is not expired', () => {
    expect(isExpiredOn('2026-07-18', now)).toBe(false)
  })

  it('a malformed value asserts nothing', () => {
    expect(isExpiredOn('', now)).toBe(false)
    expect(isExpiredOn('garbage', now)).toBe(false)
    expect(isExpiredOn(undefined, now)).toBe(false)
  })
})

describe('isExpiringWithin — inclusive of today and the final day', () => {
  const now = at(2026, 7, 17)

  it('today counts as expiring', () => {
    expect(isExpiringWithin('2026-07-17', now)).toBe(true)
  })

  it('exactly 30 days ahead counts as expiring', () => {
    expect(isExpiringWithin('2026-08-16', now)).toBe(true)
  })

  it('31 days ahead does not', () => {
    expect(isExpiringWithin('2026-08-17', now)).toBe(false)
  })

  it('an already-expired date is not "expiring"', () => {
    expect(isExpiringWithin('2026-07-16', now)).toBe(false)
  })

  it('a malformed value asserts nothing', () => {
    expect(isExpiringWithin('', now)).toBe(false)
    expect(isExpiringWithin(undefined, now)).toBe(false)
  })
})

describe('formatCalendarDate — the displayed day never shifts', () => {
  // The day and year are asserted exactly — they are the values that shifted.
  // The month abbreviation is matched by prefix: ICU renders en-GB September as
  // "Sept", and pinning that spelling would test the runtime's CLDR data rather
  // than this module.
  it('renders the stored calendar day', () => {
    expect(formatCalendarDate('2026-03-15')).toMatch(/^15 Mar\.? 2026$/)
    expect(formatCalendarDate('2026-09-01')).toMatch(/^01 Sept?\.? 2026$/)
  })

  it('renders 1 January without slipping to the previous year', () => {
    // Formatting UTC midnight in local time west of UTC produced 31 Dec 2025.
    expect(formatCalendarDate('2026-01-01')).toMatch(/^01 Jan\.? 2026$/)
  })

  it('renders a leap day', () => {
    expect(formatCalendarDate('2028-02-29')).toMatch(/^29 Feb\.? 2028$/)
  })

  it('returns null for malformed values instead of a wrong date', () => {
    expect(formatCalendarDate('')).toBeNull()
    expect(formatCalendarDate('2026-02-30')).toBeNull()
    expect(formatCalendarDate(undefined)).toBeNull()
  })
})

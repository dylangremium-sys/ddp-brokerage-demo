/**
 * Date-only ("YYYY-MM-DD") handling.
 *
 * `documentExpiry` is captured by `input type="date"`, so it is a calendar date,
 * not an instant. `Date.parse('2026-07-17')` resolves it to UTC midnight, which
 * produces two defects:
 *
 *   - Classification: for a viewer east of UTC, the moment their local clock
 *     passes midnight the UTC instant is already in the past, so a document
 *     valid *through* today is reported expired — and the overview escalates it
 *     to "Blocked Pending Review" on a date the licence is still valid.
 *   - Display: for a viewer west of UTC, formatting that instant in local time
 *     renders the day before the one the farmer entered.
 *
 * A calendar date has no timezone. Comparisons here happen between integer
 * calendar-day numbers built with Date.UTC on both sides, so the arithmetic
 * cannot be perturbed by the viewer's offset or by a DST transition (Date.UTC
 * has no DST). Formatting is pinned to UTC for the same reason.
 *
 * Instants (`created_at`, `submittedAt`) are NOT calendar dates and must keep
 * using ordinary Date parsing.
 */

/** A calendar date. `month` is 1-12, matching the wire format, not Date's 0-11. */
export interface CalendarDate {
  year: number
  month: number
  day: number
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

/**
 * Parse a strict "YYYY-MM-DD" value. Returns null for anything else — including
 * an instant, an empty string, or a real-looking but impossible date such as
 * 2026-02-30. Never guesses at a malformed value.
 */
export function parseCalendarDate(value: string | null | undefined): CalendarDate | null {
  if (typeof value !== 'string') return null
  const m = DATE_ONLY.exec(value.trim())
  if (!m) return null

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  // Round-trip through Date.UTC to reject days that do not exist in that month
  // (2026-02-30, 2025-02-29). Date would silently roll them forward.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) return null

  return { year, month, day }
}

/**
 * Integer day index for a calendar date. Built with Date.UTC so it is identical
 * in every timezone and unaffected by DST.
 */
export function calendarDayNumber(c: CalendarDate): number {
  return Math.floor(Date.UTC(c.year, c.month - 1, c.day) / MS_PER_DAY)
}

/** The viewer's own current calendar date, read from their local clock. */
export function localCalendarDate(now: Date): CalendarDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
}

/**
 * Whole calendar days from the viewer's today to `value`.
 * Negative = past · 0 = today · positive = future · null = malformed.
 */
export function daysUntilCalendarDate(
  value: string | null | undefined,
  now: Date,
): number | null {
  const target = parseCalendarDate(value)
  if (!target) return null
  return calendarDayNumber(target) - calendarDayNumber(localCalendarDate(now))
}

/**
 * "15 Mar 2026" — rendered from the parsed components in UTC, so the calendar
 * day shown is always the day that was stored. Null for malformed values, so a
 * caller must decide what to say rather than being handed a wrong date.
 */
export function formatCalendarDate(value: string | null | undefined): string | null {
  const c = parseCalendarDate(value)
  if (!c) return null
  return new Date(Date.UTC(c.year, c.month - 1, c.day)).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Expired only once the calendar day has fully passed. A document whose expiry
 * is today is valid through today.
 */
export function isExpiredOn(value: string | null | undefined, now: Date): boolean {
  const days = daysUntilCalendarDate(value, now)
  if (days === null) return false // malformed: assert nothing
  return days < 0
}

/**
 * Expiring within the window, inclusive of today and of the final day.
 * A malformed or absent value is not a claim of expiry.
 */
export function isExpiringWithin(
  value: string | null | undefined,
  now: Date,
  windowDays = 30,
): boolean {
  const days = daysUntilCalendarDate(value, now)
  if (days === null) return false
  return days >= 0 && days <= windowDays
}

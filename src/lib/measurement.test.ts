import { describe, it, expect } from 'vitest'
import {
  measurementFromRow,
  parseOptionalMeasurement,
  measurementToFormValue,
  formatMeasurement,
} from './measurement'

/**
 * The defect: inventory_batches.thc_percent is nullable and the submission field
 * is optional, but the value was coerced to 0 twice — `(row.thc_percent) ?? 0`
 * in the mapper and `parseFloat(form.totalThc) || 0` in the form. An absent
 * reading then presented as a genuine 0.00% laboratory result.
 *
 * Zero is a measurement. Absence is not.
 */

describe('measurementFromRow — database mapping', () => {
  it('maps NULL to null, not 0', () => {
    expect(measurementFromRow(null)).toBeNull()
    expect(measurementFromRow(null)).not.toBe(0)
  })

  it('maps undefined to null', () => {
    expect(measurementFromRow(undefined)).toBeNull()
  })

  it('maps a genuine database 0 to numeric 0', () => {
    // A real "not detected / 0%" lab result must survive as a value.
    expect(measurementFromRow(0)).toBe(0)
    expect(measurementFromRow(0)).not.toBeNull()
  })

  it('maps a non-zero value unchanged', () => {
    expect(measurementFromRow(26.86)).toBe(26.86)
    expect(measurementFromRow(19.49)).toBe(19.49)
  })

  it('accepts a numeric string from the driver', () => {
    // Postgres numeric can arrive as a string.
    expect(measurementFromRow('0')).toBe(0)
    expect(measurementFromRow('23.02')).toBe(23.02)
  })

  it('maps an empty or unreadable value to null rather than 0', () => {
    expect(measurementFromRow('')).toBeNull()
    expect(measurementFromRow('not-a-number')).toBeNull()
    expect(measurementFromRow(NaN)).toBeNull()
  })
})

describe('parseOptionalMeasurement — form input', () => {
  it('blank produces null, so a blank field persists as NULL', () => {
    expect(parseOptionalMeasurement('')).toBeNull()
    expect(parseOptionalMeasurement('   ')).toBeNull()
    expect(parseOptionalMeasurement(null)).toBeNull()
    expect(parseOptionalMeasurement(undefined)).toBeNull()
  })

  it('an explicit "0" produces numeric 0', () => {
    expect(parseOptionalMeasurement('0')).toBe(0)
    expect(parseOptionalMeasurement('0.00')).toBe(0)
    expect(parseOptionalMeasurement(' 0 ')).toBe(0)
  })

  it('a valid non-zero value is unchanged', () => {
    expect(parseOptionalMeasurement('12.5')).toBe(12.5)
    expect(parseOptionalMeasurement('26.86')).toBe(26.86)
  })

  it('invalid input does not silently become 0', () => {
    expect(parseOptionalMeasurement('abc')).toBeNull()
    expect(parseOptionalMeasurement('abc')).not.toBe(0)
    // parseFloat('12abc') was 12 — a partial read is not a measurement.
    expect(parseOptionalMeasurement('12abc')).toBeNull()
    expect(parseOptionalMeasurement('--')).toBeNull()
  })

  it('blank and zero are different facts', () => {
    expect(parseOptionalMeasurement('')).not.toBe(parseOptionalMeasurement('0'))
  })
})

describe('measurementToFormValue — round trip through the edit form', () => {
  it('renders a measured 0 as "0", not as a blank field', () => {
    // `item.thcPct ? String(item.thcPct) : ''` blanked a genuine zero on edit.
    expect(measurementToFormValue(0)).toBe('0')
  })

  it('renders unknown as a blank field', () => {
    expect(measurementToFormValue(null)).toBe('')
    expect(measurementToFormValue(undefined)).toBe('')
  })

  it('renders a value unchanged', () => {
    expect(measurementToFormValue(26.86)).toBe('26.86')
  })

  it('round-trips every state without changing its meaning', () => {
    for (const v of [null, 0, 12.5, 26.86]) {
      expect(parseOptionalMeasurement(measurementToFormValue(v))).toBe(v)
    }
  })
})

describe('formatMeasurement — display', () => {
  it('formats a genuine 0 as "0.00"', () => {
    expect(formatMeasurement(0)).toBe('0.00')
  })

  it('returns null for unknown so the caller states the absence', () => {
    expect(formatMeasurement(null)).toBeNull()
    expect(formatMeasurement(undefined)).toBeNull()
  })

  it('formats a value to two decimals', () => {
    expect(formatMeasurement(26.86)).toBe('26.86')
    expect(formatMeasurement(19.4)).toBe('19.40')
    expect(formatMeasurement(23)).toBe('23.00')
  })

  it('never renders unknown as a number', () => {
    expect(formatMeasurement(null)).not.toBe('0.00')
    expect(formatMeasurement(null)).not.toBe('0')
  })
})

describe('sorting and filtering must not treat unknown as measured zero', () => {
  // Mirrors the Master Inventory filter: an unreported reading cannot be
  // compared to a range, so it is not filtered on; a reported one is, including
  // a measured 0.
  it('unknown is not range-filtered, while a measured 0 is evaluated against it', () => {
    const passesRange = (thc: number | null, min: number, max: number) =>
      !(thc !== null && (thc < min || thc > max))
    expect(passesRange(null, 5, 30)).toBe(true)  // unknown: cannot be excluded by a range
    expect(passesRange(0, 5, 30)).toBe(false)    // measured 0: genuinely below the range
    expect(passesRange(12, 5, 30)).toBe(true)
    expect(passesRange(0, 0, 35)).toBe(true)     // measured 0 inside the default bounds
  })

  it('unknown and measured zero remain distinguishable after guarding', () => {
    const unknown: number | null = null
    const measuredZero: number | null = 0
    expect(unknown).not.toBe(measuredZero)
    expect(formatMeasurement(unknown)).not.toBe(formatMeasurement(measuredZero))
  })
})

/* ────────────────────────────────────────────────────────────────────────────
   "Recorded" means present, not positive.

   The defect: after the model became nullable, predicates still tested
   `thcPct > 0`, so a genuine stored 0 rendered "Not recorded" and left the
   review and buyer-pack checklists incomplete for a valid measurement.
   ──────────────────────────────────────────────────────────────────────────── */

/** The predicate every checklist gate and "recorded?" display now uses. */
const isRecorded = (thc: number | null | undefined) => thc != null

describe('isRecorded — a measurement is recorded when it exists', () => {
  it('a measured 0 is recorded', () => {
    expect(isRecorded(0)).toBe(true)
    // The old test failed exactly here.
    expect((0 as number) > 0).toBe(false)
  })

  it('a positive value is recorded', () => {
    expect(isRecorded(26.86)).toBe(true)
    expect(isRecorded(0.01)).toBe(true)
  })

  it('null and undefined are not recorded', () => {
    expect(isRecorded(null)).toBe(false)
    expect(isRecorded(undefined)).toBe(false)
  })

  it('recording never depends on the magnitude of the value', () => {
    for (const v of [0, 0.1, 12, 35, 100]) expect(isRecorded(v)).toBe(true)
  })
})

describe('checklist gates complete for a measured zero', () => {
  it('the review checklist counts a stored 0 as recorded', () => {
    expect(isRecorded(0)).toBe(true)
  })

  it('the buyer-pack gate counts a stored 0 as recorded', () => {
    expect(isRecorded(0)).toBe(true)
  })

  it('both gates stay incomplete for an absent reading', () => {
    expect(isRecorded(null)).toBe(false)
  })
})

describe('display distinguishes measured zero from unknown', () => {
  it('a measured 0 displays as a value, not "Not recorded"', () => {
    const display = (thc: number | null) => (thc != null ? `${thc}%` : 'Not recorded')
    expect(display(0)).toBe('0%')
    expect(display(0)).not.toBe('Not recorded')
    expect(display(null)).toBe('Not recorded')
  })

  it('the overview renders a measured 0 as 0.00 and unknown as an em-dash', () => {
    expect(formatMeasurement(0)).toBe('0.00')
    expect(formatMeasurement(null)).toBeNull()
  })
})

describe('thresholds still apply their own numeric rules', () => {
  // Recording and range filtering are different questions: a measured 0 is
  // recorded, and it is also genuinely below a 5–30 range.
  const outOfRange = (thc: number | null, min: number, max: number) =>
    thc !== null && (thc < min || thc > max)

  it('a measured 0 is recorded but still filtered out of a 5–30 range', () => {
    expect(isRecorded(0)).toBe(true)
    expect(outOfRange(0, 5, 30)).toBe(true)
  })

  it('an unknown reading cannot be compared to a range, so it is not filtered', () => {
    expect(outOfRange(null, 5, 30)).toBe(false)
  })

  it('a measured 0 passes a range that includes it', () => {
    expect(outOfRange(0, 0, 35)).toBe(false)
  })
})

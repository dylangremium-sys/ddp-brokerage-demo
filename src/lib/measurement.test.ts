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
  // The legacy admin surfaces guard on `(x.thcPct ?? 0) > 0`, which excludes
  // unknown from THC filters and ranks it last — exactly as before the model
  // became nullable, when NULL was already mapped to 0.
  it('unknown is excluded from a THC range filter, a measured 0 is evaluated', () => {
    const inRange = (thc: number | null, min: number, max: number) =>
      thc !== null && thc > 0 && !(thc < min || thc > max)
    expect(inRange(null, 5, 30)).toBe(false)   // unknown: not filtered in
    expect(inRange(0, 5, 30)).toBe(false)      // measured 0: below range
    expect(inRange(12, 5, 30)).toBe(true)
  })

  it('unknown and measured zero remain distinguishable after guarding', () => {
    const unknown: number | null = null
    const measuredZero: number | null = 0
    expect(unknown).not.toBe(measuredZero)
    expect(formatMeasurement(unknown)).not.toBe(formatMeasurement(measuredZero))
  })
})

/**
 * Optional laboratory measurements.
 *
 * `inventory_batches.thc_percent` is nullable and the submission field is
 * explicitly optional ("THC from COA — from your COA, if you have one"), so an
 * absent reading is a real and expected state. It was being erased twice:
 * `batchRowToInventoryItem` mapped a database NULL to `0`, and the form mapped a
 * blank field to `0`. An absent measurement then presented as a genuine 0.00%
 * laboratory result — a value no lab ever produced.
 *
 * Zero is a measurement. Absence is not. They are different facts and the model
 * has to be able to hold both, so `0` is never used as a sentinel for unknown.
 */

/**
 * Read an optional numeric measurement from a database row.
 * NULL/undefined → null (unknown). A stored 0 → 0 (measured).
 */
export function measurementFromRow(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Read an optional numeric measurement from a form field.
 *
 * Blank → null (the farmer did not report one). "0" → 0 (they reported zero).
 * Unparseable → null, never 0: a value we could not read is unknown, and
 * inventing a zero from it would fabricate a lab result. Stricter than the
 * previous `parseFloat(...) || 0`, which turned both blanks and junk into 0 and
 * accepted a partial number like "12abc" as 12.
 */
export function parseOptionalMeasurement(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * Render an optional measurement back into a form field.
 * A measured 0 must appear as "0", not as an empty field — the previous
 * `item.thcPct ? String(item.thcPct) : ''` blanked a genuine zero on edit.
 */
export function measurementToFormValue(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/** Fixed-decimal display. Unknown returns null so the caller states the absence. */
export function formatMeasurement(value: number | null | undefined, digits = 2): string | null {
  if (value === null || value === undefined) return null
  return value.toFixed(digits)
}

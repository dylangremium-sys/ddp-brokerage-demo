/**
 * Field comparison logic for the three-gate COA verification system.
 * Gate 2: Farmer entry vs AI extraction (exact match required for medical compliance)
 */

export interface FieldMismatch {
  fieldName: string
  farmerValue: string | null
  extractedValue: string | null
  severity: 'critical' | 'warning' | 'none'
  reason: string
}

export interface ComparisonResult {
  hasMismatches: boolean
  criticalMismatches: FieldMismatch[]
  warnings: FieldMismatch[]
  summary: string
}

/**
 * Critical fields that must match exactly (no tolerance).
 * These determine whether the farmer can proceed without admin approval.
 */
const CRITICAL_FIELDS = [
  'sample_name',    // Strain name: "Gelato" must == "Gelato"
  'batch_reference', // Batch ID: "F4-122025" must == "F4-122025"
] as const

/**
 * Warning fields that should match but have tolerance.
 * THC/CBD may vary by test precision; timestamps may vary by method.
 */
const WARNING_FIELDS = new Map<string, (f: string | null, e: string | null) => boolean>([
  ['total_thc', (f, e) => numericMatch(f, e, 0.1)],      // ±0.1% tolerance
  ['total_cbd', (f, e) => numericMatch(f, e, 0.1)],      // ±0.1% tolerance
  ['moisture_pct', (f, e) => numericMatch(f, e, 1.0)],   // ±1.0% tolerance
] as const)

/**
 * Compare farmer-entered values against AI-extracted values.
 * Returns structured mismatch information for display to the farmer.
 */
export function compareCoaFields(
  farmerValues: Record<string, string | null>,
  extractedValues: Record<string, string | null>,
): ComparisonResult {
  const criticalMismatches: FieldMismatch[] = []
  const warnings: FieldMismatch[] = []

  // Check critical fields (must match exactly)
  for (const field of CRITICAL_FIELDS) {
    const farmer = farmerValues[field]?.trim() ?? null
    const extracted = extractedValues[field]?.trim() ?? null

    if (farmer !== extracted) {
      criticalMismatches.push({
        fieldName: field,
        farmerValue: farmer,
        extractedValue: extracted,
        severity: 'critical',
        reason:
          field === 'sample_name'
            ? `Strain name mismatch: you entered "${farmer}" but the PDF says "${extracted}"`
            : `Batch reference mismatch: you entered "${farmer}" but the PDF says "${extracted}"`,
      })
    }
  }

  // Check warning fields (numeric tolerance allowed)
  for (const [field, checker] of WARNING_FIELDS) {
    const farmer = farmerValues[field]
    const extracted = extractedValues[field]

    if (!checker(farmer, extracted)) {
      warnings.push({
        fieldName: field,
        farmerValue: farmer ?? null,
        extractedValue: extracted ?? null,
        severity: 'warning',
        reason: `${field} values differ: you entered "${farmer}" but the PDF says "${extracted}"`,
      })
    }
  }

  const hasMismatches = criticalMismatches.length > 0 || warnings.length > 0

  let summary = ''
  if (criticalMismatches.length === 0 && warnings.length === 0) {
    summary = 'No discrepancies detected. Your entries match the PDF.'
  } else if (criticalMismatches.length > 0) {
    summary = `⚠️ Critical mismatch: ${criticalMismatches[0].reason}`
  } else if (warnings.length > 0) {
    summary = `ℹ️ ${warnings.length} field(s) differ by small amounts. Review before continuing.`
  }

  return {
    hasMismatches,
    criticalMismatches,
    warnings,
    summary,
  }
}

/**
 * Parse a numeric value with units and compare within tolerance.
 * Handles formats like "26.86 %w/w", "26.86%", "26.86", etc.
 */
function numericMatch(
  farmerStr: string | null,
  extractedStr: string | null,
  tolerancePercent: number,
): boolean {
  if (!farmerStr || !extractedStr) {
    return farmerStr === extractedStr // Both null or both missing = match
  }

  const farmNum = parseFloat(farmerStr)
  const extractNum = parseFloat(extractedStr)

  if (isNaN(farmNum) || isNaN(extractNum)) {
    return false // Can't parse; treat as mismatch
  }

  const diff = Math.abs(farmNum - extractNum)
  return diff <= tolerancePercent
}

/**
 * Determine whether the farmer should be allowed to proceed.
 * - If zero mismatches: proceed silently
 * - If only warnings: show confirmation; farmer can override
 * - If critical mismatches: require explicit confirmation + warning
 */
export function shouldBlockSubmission(comparison: ComparisonResult): boolean {
  // Critical mismatches must be acknowledged; warnings can be ignored
  return comparison.criticalMismatches.length > 0
}

/**
 * Format a field value for display.
 * Truncates long strings, adds % sign to numeric fields if missing.
 */
export function formatFieldForDisplay(value: string | null): string {
  if (!value) return '—'
  if (value.length > 80) return `${value.substring(0, 77)}…`
  return value
}

// ─── Laboratory profiles — a report's layout is configuration ────────────────
//
// A profile says what is TRUE OF A LABORATORY'S TEMPLATE, not what is true of
// any one document. Nothing found inside a document may change the profile that
// was selected for it; a document that matches no profile is queued for a person
// rather than guessed at.
//
// WHY VERSIONED, AND NOT JUST NAMED. The evidence base is a single laboratory
// producing two incompatible templates:
//
//   TNR Bioscience, 2026 vintage — report numbers like RP-E2602-0197, ~100
//   analytes including terpenes and ~60 pesticides, specification cells read N/A.
//
//   TNR Bioscience, 2025 vintage — report numbers like 2025-A25080, 14 analytes,
//   specification cells read "Nonspecific".
//
// Both cite the same in-house methods, so "which laboratory" is the same answer
// for both and is not enough to select a layout. The key is
// (laboratory, template version).

import type { CoaFieldName } from './coaExtraction'

/** The only date format this system accepts, and it is a property of a profile. */
export type CoaDateFormat = 'DD/MM/YYYY'

export interface LabProfile {
  /** Stable identifier, safe to record against an extraction. */
  id: string
  laboratory: string
  /** Free-form, human-facing. Distinguishes templates from the same laboratory. */
  templateVersion: string
  /**
   * Fixed, never inferred from a document's contents.
   *
   * The validators in coaIntegrity.ts may reject dates read under this format.
   * They may not replace it. See `checkDateOrder`.
   */
  dateFormat: CoaDateFormat
  /** Recognises this template's report numbers. */
  reportNumberPattern: RegExp
  /**
   * Specification-cell values that mean THE LABORATORY STATED NO LIMIT.
   *
   * The 2026 template writes `N/A`; the 2025 template writes `Nonspecific`
   * eleven times on a single page. Both mean the same thing, and code that tests
   * for one would read the other as a limit that HAD been stated — which is
   * precisely the invented threshold the design forbids.
   *
   * Compared case-insensitively after trimming.
   */
  noLimitStatedTokens: readonly string[]
  /**
   * Fields absent from this laboratory's panel.
   *
   * Recorded as warnings, never as blanks. Migration 28 requires it
   * (`field_value_text IS NOT NULL OR extraction_warning IS NOT NULL`), and it is
   * also the honest answer: "this laboratory does not measure it" tells a buyer
   * something, an empty cell does not.
   */
  fieldsNotInPanel: readonly CoaFieldName[]
}

/**
 * TNR Bioscience, 2026 template — the Calli Krush reports.
 *
 * Seven certificates, three pages each, `Specification | Result | Unit | LOD`.
 * Rows extract cleanly one per line.
 */
export const TNR_BIOSCIENCE_2026: LabProfile = {
  id: 'tnr-bioscience-2026',
  laboratory: 'TNR Bioscience Company Limited',
  templateVersion: '2026 (RP-E…)',
  dateFormat: 'DD/MM/YYYY',
  reportNumberPattern: /^RP-[A-Z0-9]+-\d+$/,
  noLimitStatedTokens: ['N/A'],
  // This laboratory reports LOSS ON DRYING, which is not water activity and must
  // never be recorded as it. Neither residual solvents nor an accreditation
  // reference appears anywhere on the report.
  fieldsNotInPanel: ['water_activity', 'residual_solvents_result', 'accreditation_reference'],
}

/**
 * TNR Bioscience, 2025 template — the BIENESTAR T&N reports.
 *
 * Fourteen analytes. Its text layer emits whole columns rather than rows and the
 * column order is not stable between pages, which is why `checkTotalThc` exists.
 */
export const TNR_BIOSCIENCE_2025: LabProfile = {
  id: 'tnr-bioscience-2025',
  laboratory: 'TNR Bioscience Company Limited',
  templateVersion: '2025 (YYYY-A…)',
  dateFormat: 'DD/MM/YYYY',
  reportNumberPattern: /^\d{4}-A\d+$/,
  noLimitStatedTokens: ['N/A', 'Nonspecific'],
  // The 2025 panel is narrower still: no terpenes, no pesticide screen.
  fieldsNotInPanel: [
    'water_activity',
    'residual_solvents_result',
    'accreditation_reference',
    'mycotoxins_result',
    'pesticides_result',
  ],
}

export const LAB_PROFILES: readonly LabProfile[] = [TNR_BIOSCIENCE_2026, TNR_BIOSCIENCE_2025]

/**
 * Selects a profile from a report number.
 *
 * Returns null rather than a default. A DEFAULT PROFILE IS THE BUG THIS WHOLE
 * MODULE EXISTS TO PREVENT: it would apply one laboratory's layout — its date
 * format, its absent-field list, its idea of what "no limit stated" looks like —
 * to a document from somewhere else, and every one of those is silently wrong
 * rather than loudly wrong.
 *
 * A null here means the document goes to a person. That is the correct outcome
 * for the first report from a new supplier, and it will happen the first time
 * Portugal, Canada or South Africa is involved.
 */
export function profileForReportNumber(reportNumber: string | null | undefined): LabProfile | null {
  const value = reportNumber?.trim()
  if (!value) return null
  return LAB_PROFILES.find((p) => p.reportNumberPattern.test(value)) ?? null
}

/**
 * Whether a specification cell means "the laboratory stated no limit".
 *
 * The cell is never parsed for a threshold — this only answers whether a
 * threshold is absent, which is the only question the extractor is allowed to
 * ask about that column.
 */
export function statesNoLimit(specificationCell: string | null | undefined, profile: LabProfile): boolean {
  const value = specificationCell?.trim()
  if (!value) return true
  return profile.noLimitStatedTokens.some((token) => token.toLowerCase() === value.toLowerCase())
}

/**
 * Warning text for a field this laboratory does not measure.
 *
 * Named rather than written at the call site so the wording stays identical
 * across every report — a reviewer scanning a queue should be able to recognise
 * "not in the panel" without reading the sentence each time.
 */
export function absentFieldWarning(field: CoaFieldName, profile: LabProfile): string {
  return `${profile.laboratory} (${profile.templateVersion}) does not report ${field} — absent from this laboratory's panel, not missing from the document`
}

// ─── Reconcile — the stage that can refuse ───────────────────────────────────
//
// coaExtraction.ts turns a reading into rows. coaIntegrity.ts and
// coaLabProfiles.ts hold the checks and the layout facts. This composes them,
// and it is the only place that decides a field should NOT be offered to a
// reviewer.
//
// It lives in its own module rather than inside coaExtraction.ts for one
// concrete reason: coaLabProfiles.ts imports CoaFieldName from coaExtraction.ts,
// so wiring the profile in there would put those two files in a cycle. A type
// import is erased at runtime and would not show up as a cycle in the
// import-graph boundary test — which is exactly why it is worth avoiding by
// structure rather than relying on a check that cannot see it.

import {
  buildExtractions,
  type ExtractionRow,
  type RawExtractedReport,
  type ReportExtraction,
  parseCoaDate,
} from './coaExtraction'
import { checkDateOrder, checkTotalThc, type CannabinoidReading, type TotalThcCheck } from './coaIntegrity'
import { absentFieldWarning, profileForReportNumber, type LabProfile } from './coaLabProfiles'

/** A report as read, plus the figures the integrity check needs. */
export interface RawReportWithCannabinoids extends RawExtractedReport {
  /**
   * d9-THC, THCA and the stated total.
   *
   * Carried separately from `fields` because the storable vocabulary is fixed by
   * migration 28 and contains `total_thc` but neither component. The components
   * are read to CHECK the total, not to store, so forcing them through the field
   * list would mean inventing field names the database rejects.
   */
  cannabinoids?: CannabinoidReading
}

export interface ReconciledReport extends ReportExtraction {
  /** Null when no profile matched — the document needs a person. */
  profileId: string | null
  totalThcCheck: TotalThcCheck | null
  /** Ordering problems, unmatched profile, and any other refusal to vouch. */
  integrityWarnings: string[]
}

/** Dates in the order the reporting process requires them to occur. */
const DATE_SEQUENCE: ReadonlyArray<{ field: 'received_date' | 'test_date'; label: string }> = [
  { field: 'received_date', label: 'sample received date' },
  { field: 'test_date', label: 'test date' },
]

function valueOf(rows: readonly ExtractionRow[], field: string): string | null {
  return rows.find((r) => r.field_name === field)?.field_value_text ?? null
}

/**
 * Builds the rows for a field this laboratory does not measure.
 *
 * A row, not an omission. Migration 28's
 * `CHECK (field_value_text IS NOT NULL OR extraction_warning IS NOT NULL)`
 * requires that an absent value carry a reason, and "this laboratory does not
 * measure it" is an answer a buyer can act on where a blank is not.
 *
 * Skipped when the reading already produced a row for the field, so a laboratory
 * that starts reporting water activity is not overwritten by a stale profile.
 */
function absentFieldRows(profile: LabProfile, existing: readonly ExtractionRow[]): ExtractionRow[] {
  const present = new Set(existing.map((r) => r.field_name))

  return profile.fieldsNotInPanel
    .filter((field) => !present.has(field))
    .map((field) => ({
      field_name: field,
      field_value_text: null,
      provenance: 'machine_extracted' as const,
      confidence: 0,
      extraction_warning: absentFieldWarning(field, profile),
      offerForAcceptance: false,
    }))
}

/**
 * Reads one report into rows, then checks whether the reading holds together.
 *
 * THE IMPORTANT BEHAVIOUR IS THE REFUSAL. When the stated total THC contradicts
 * its own components, the total is withdrawn from acceptance even though its
 * confidence may be high — because the disagreement is evidence that the reading
 * itself is wrong, and a model's confidence is a statement about its own
 * certainty, not about whether the value landed against the right label.
 *
 * A high-confidence wrong number is the failure this whole module exists for.
 */
export function reconcileReport(
  raw: RawReportWithCannabinoids,
  opts: { fileName?: string; threshold?: number; profile?: LabProfile | null } = {},
): ReconciledReport {
  const [extraction] = buildExtractions([raw], { fileName: opts.fileName, threshold: opts.threshold })

  const profile = opts.profile !== undefined ? opts.profile : profileForReportNumber(raw.report_number)
  const integrityWarnings: string[] = []

  if (!profile) {
    integrityWarnings.push(
      raw.report_number
        ? `no laboratory profile matches report number "${raw.report_number}" — a person must confirm the layout before these figures are trusted`
        : 'no report number was read, so no laboratory profile could be selected — a person must confirm the layout',
    )
  }

  const rows = profile ? [...extraction.rows, ...absentFieldRows(profile, extraction.rows)] : [...extraction.rows]

  // Dates are parsed under the PROFILE's format. Without a profile there is no
  // declared format, so there is nothing to validate against and guessing one
  // here would be the inference the design forbids.
  if (profile) {
    const ordered = DATE_SEQUENCE.map(({ field, label }) => {
      const text = valueOf(rows, field)
      return { label, iso: text ? parseCoaDate(text) : null }
    })
    integrityWarnings.push(...checkDateOrder(ordered))
  }

  const totalThcCheck = raw.cannabinoids ? checkTotalThc(raw.cannabinoids) : null

  if (totalThcCheck?.warning) integrityWarnings.push(totalThcCheck.warning)

  if (totalThcCheck?.verdict === 'inconsistent') {
    for (const row of rows) {
      if (row.field_name !== 'total_thc') continue
      row.offerForAcceptance = false
      row.extraction_warning = row.extraction_warning
        ? `${row.extraction_warning}; ${totalThcCheck.warning}`
        : totalThcCheck.warning
    }
  }

  return {
    ...extraction,
    rows,
    profileId: profile?.id ?? null,
    totalThcCheck,
    integrityWarnings,
  }
}

/** Every report in a document, reconciled independently. */
export function reconcileDocument(
  reports: readonly RawReportWithCannabinoids[],
  opts: { fileName?: string; threshold?: number } = {},
): ReconciledReport[] {
  return reports.map((report) => reconcileReport(report, opts))
}

/**
 * Whether a reconciled report is safe to put in front of a reviewer as fields
 * rather than as a document to read.
 *
 * Deliberately strict: any integrity warning means the answer is no. The value
 * of showing extracted fields is that the reviewer does not have to open the
 * PDF, and that value is negative the moment the fields might be wrong.
 */
export function isPresentableAsFields(report: ReconciledReport): boolean {
  return report.integrityWarnings.length === 0 && report.crossCheckWarnings.length === 0
}

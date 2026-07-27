// ─── Deterministic COA findings (Gate P0 — issue #77) ───────────────────────
//
// Turns an extraction into a stable list of factual observations about the
// DOCUMENT. Every rule here is mechanical and self-contained:
//
//   * same input -> byte-identical output (no clock, no randomness, no I/O)
//   * every finding cites the field/panel and PDF page it came from
//   * nothing external is consulted — no threshold, limit or legal text
//
// That last point is the important one. A finding says "the expiry date is
// before the manufacturing date" or "the pesticides panel was not reported" —
// facts readable from the document alone. It NEVER says a product passes,
// fails, is compliant, or is safe: that requires a retrieved authority source
// and a human decision, which live in coaSuggestionBinding.ts and the admin UI.
//
// A parsed COA is documented evidence, not proof of authenticity.

import type {
  CoaFieldKey,
  CoaPanelKey,
  TnrCoaExtraction,
} from './coaTnrAdapter.js'
import { fieldByKey } from './coaTnrAdapter.js'

export type CoaFindingCode =
  | 'unsupported_document'
  | 'missing_identifier'
  | 'malformed_date'
  | 'implausible_date_order'
  | 'missing_panel'
  | 'reported_failure'
  | 'malformed_value'
  | 'duplicate_document'
  | 'duplicate_report_number'

export type CoaFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface CoaFinding {
  code: CoaFindingCode
  severity: CoaFindingSeverity
  title: string
  /** Factual description. Contains no conclusion about compliance. */
  detail: string
  fieldKey: CoaFieldKey | null
  panelKey: CoaPanelKey | null
  /** 1-based PDF page the observation refers to, when it has one. */
  pageNumber: number | null
  /** Stable identity for de-duplication and idempotent re-runs. */
  fingerprint: string
}

/** A previously stored COA, used to detect document/report reuse. */
export interface KnownCoaDocument {
  coaDocumentId: string
  documentFingerprint: string
  reportNumber: string | null
}

export interface CoaFindingsInput {
  extraction: TnrCoaExtraction
  /** Documents already on file. Excludes the one being processed. */
  knownDocuments: KnownCoaDocument[]
}

/** Identifiers a usable report must carry. */
const REQUIRED_IDENTIFIERS: Array<{ key: CoaFieldKey; label: string }> = [
  { key: 'report_number', label: 'Report No.' },
  { key: 'sample_name', label: 'Sample Name' },
  { key: 'batch_number', label: 'Batch No.' },
  { key: 'sample_number', label: 'Sample No.' },
  { key: 'reported_on', label: 'Reported on' },
]

/** Panels the TNR three-page format is expected to report. */
const EXPECTED_PANELS: CoaPanelKey[] = [
  'physical_properties',
  'identification',
  'cannabinoid_groups',
  'terpenes',
  'heavy_metal',
  'mycotoxins',
  'pesticides',
  'microbial_enumeration',
  'specified_microorganisms',
]

/** Date pairs that must be ordered, by the document's own internal logic. */
const DATE_ORDER_RULES: Array<{ earlier: CoaFieldKey; later: CoaFieldKey; description: string }> = [
  { earlier: 'manufacturing_date', later: 'expiry_date', description: 'expiry date is not after the manufacturing date' },
  { earlier: 'testing_start_date', later: 'testing_end_date', description: 'testing end date is before the testing start date' },
  { earlier: 'sample_received_date', later: 'reported_on', description: 'report date is before the sample was received' },
]

function makeFingerprint(parts: Array<string | number | null>): string {
  return parts.map((p) => (p === null ? '~' : String(p))).join('|')
}

/**
 * Derive every deterministic finding for one extraction.
 *
 * Findings are emitted in a fixed rule order and then sorted by fingerprint, so
 * re-running against the same document yields an identical list — which is what
 * makes an idempotent retry safe to persist.
 */
export function deriveCoaFindings(input: CoaFindingsInput): CoaFinding[] {
  const { extraction, knownDocuments } = input
  const findings: CoaFinding[] = []

  // ── 0. Unsupported document short-circuits every content rule ─────────────
  if (!extraction.supported) {
    findings.push({
      code: 'unsupported_document',
      severity: 'high',
      title: 'Document format not supported',
      detail:
        extraction.unsupportedReason ??
        'The document does not match the supported TNR three-page report format.',
      fieldKey: null,
      panelKey: null,
      pageNumber: null,
      fingerprint: makeFingerprint(['unsupported_document', extraction.documentFingerprint]),
    })
    return findings
  }

  // ── 1. Missing identifiers ────────────────────────────────────────────────
  for (const required of REQUIRED_IDENTIFIERS) {
    const field = fieldByKey(extraction, required.key)
    const absent = !field || field.status === 'missing' || field.normalizedValue === null
    if (absent) {
      findings.push({
        code: 'missing_identifier',
        severity: 'high',
        title: `Missing identifier: ${required.label}`,
        detail:
          field && field.status !== 'missing'
            ? `"${required.label}" was located but could not be read (${field.warnings.join('; ') || 'no value'}).`
            : `"${required.label}" is not present in the report.`,
        fieldKey: required.key,
        panelKey: null,
        pageNumber: field?.pageNumber ?? null,
        fingerprint: makeFingerprint(['missing_identifier', required.key]),
      })
    }
  }

  // ── 2. Malformed or impossible dates ──────────────────────────────────────
  for (const field of extraction.fields) {
    const isDateField = field.key.endsWith('_date') || field.key === 'reported_on'
    if (!isDateField) continue
    if (field.status === 'unreadable' && field.rawValue !== null) {
      findings.push({
        code: 'malformed_date',
        severity: 'high',
        title: `Malformed date: ${field.label}`,
        detail: `"${field.label}" reads "${field.rawValue}", which is not a valid calendar date (${field.warnings.join('; ')}).`,
        fieldKey: field.key,
        panelKey: null,
        pageNumber: field.pageNumber,
        fingerprint: makeFingerprint(['malformed_date', field.key, field.rawValue]),
      })
    }
  }

  // ── 3. Internally inconsistent date ordering ──────────────────────────────
  for (const rule of DATE_ORDER_RULES) {
    const earlier = fieldByKey(extraction, rule.earlier)
    const later = fieldByKey(extraction, rule.later)
    if (!earlier?.normalizedValue || !later?.normalizedValue) continue
    // ISO YYYY-MM-DD compares correctly as a string.
    if (later.normalizedValue < earlier.normalizedValue) {
      findings.push({
        code: 'implausible_date_order',
        severity: 'high',
        title: `Inconsistent dates: ${earlier.label} / ${later.label}`,
        detail: `The ${rule.description} (${earlier.label} ${earlier.normalizedValue}, ${later.label} ${later.normalizedValue}).`,
        fieldKey: rule.later,
        panelKey: null,
        pageNumber: later.pageNumber,
        fingerprint: makeFingerprint(['implausible_date_order', rule.earlier, rule.later]),
      })
    }
  }

  // ── 4. Missing expected panels ────────────────────────────────────────────
  for (const panelKey of EXPECTED_PANELS) {
    const panel = extraction.panels.find((p) => p.key === panelKey)
    if (!panel || !panel.present) {
      findings.push({
        code: 'missing_panel',
        severity: 'high',
        title: `Panel not reported: ${panel?.label ?? panelKey}`,
        detail: `The report does not contain a "${panel?.label ?? panelKey}" section.`,
        fieldKey: null,
        panelKey,
        pageNumber: null,
        fingerprint: makeFingerprint(['missing_panel', panelKey]),
      })
      continue
    }
    if (panel.rowCount === 0) {
      findings.push({
        code: 'missing_panel',
        severity: 'medium',
        title: `Panel reported but empty: ${panel.label}`,
        detail: `The "${panel.label}" heading is present on page ${panel.pageNumber} but no result rows were readable beneath it.`,
        fieldKey: null,
        panelKey,
        pageNumber: panel.pageNumber,
        fingerprint: makeFingerprint(['missing_panel', panelKey, 'empty']),
      })
    }
  }

  // ── 5. Explicit failure reported by the laboratory ────────────────────────
  const failureTokens = /\b(fail(?:ed|ure)?|does not conform|not conform|out of specification|non-?compliant)\b/i
  for (const analyte of extraction.analytes) {
    if (failureTokens.test(analyte.rawResult) || failureTokens.test(analyte.name)) {
      findings.push({
        code: 'reported_failure',
        severity: 'critical',
        title: `Laboratory reported a failure: ${analyte.name}`,
        detail: `The report states "${analyte.rawResult}" for "${analyte.name}" on page ${analyte.pageNumber}.`,
        fieldKey: null,
        panelKey: analyte.panelKey,
        pageNumber: analyte.pageNumber,
        fingerprint: makeFingerprint(['reported_failure', analyte.panelKey, analyte.name]),
      })
    }
  }

  // ── 6. Malformed values / unrecognised units ──────────────────────────────
  for (const analyte of extraction.analytes) {
    if (analyte.resultKind === 'malformed') {
      findings.push({
        code: 'malformed_value',
        severity: 'medium',
        title: `Unreadable result: ${analyte.name}`,
        detail: `The result "${analyte.rawResult}" for "${analyte.name}" on page ${analyte.pageNumber} is neither numeric, "ND", nor a recognised qualitative result.`,
        fieldKey: null,
        panelKey: analyte.panelKey,
        pageNumber: analyte.pageNumber,
        fingerprint: makeFingerprint(['malformed_value', analyte.panelKey, analyte.name, analyte.rawResult]),
      })
    } else if (analyte.resultKind === 'numeric' && analyte.unit === null) {
      findings.push({
        code: 'malformed_value',
        severity: 'medium',
        title: `Numeric result without a recognised unit: ${analyte.name}`,
        detail: `"${analyte.name}" reports ${analyte.rawResult} on page ${analyte.pageNumber} with no unit this parser recognises.`,
        fieldKey: null,
        panelKey: analyte.panelKey,
        pageNumber: analyte.pageNumber,
        fingerprint: makeFingerprint(['malformed_value', 'unit', analyte.panelKey, analyte.name]),
      })
    }
  }

  // Fields that were located but unreadable are malformed values too.
  for (const field of extraction.fields) {
    const isDateField = field.key.endsWith('_date') || field.key === 'reported_on'
    if (isDateField) continue // already covered by rule 2
    if (field.status === 'unreadable') {
      findings.push({
        code: 'malformed_value',
        severity: 'medium',
        title: `Unreadable field: ${field.label}`,
        detail: `"${field.label}" is present on page ${field.pageNumber} but could not be read (${field.warnings.join('; ') || 'no reason recorded'}).`,
        fieldKey: field.key,
        panelKey: null,
        pageNumber: field.pageNumber,
        fingerprint: makeFingerprint(['malformed_value', 'field', field.key]),
      })
    }
  }

  // ── 7. Duplicate document / report reuse ──────────────────────────────────
  const reportNumber = fieldByKey(extraction, 'report_number')?.normalizedValue ?? null

  for (const known of knownDocuments) {
    if (known.documentFingerprint === extraction.documentFingerprint) {
      findings.push({
        code: 'duplicate_document',
        severity: 'high',
        title: 'Duplicate document',
        detail: `These exact PDF bytes were already processed as COA record ${known.coaDocumentId}.`,
        fieldKey: null,
        panelKey: null,
        pageNumber: null,
        fingerprint: makeFingerprint(['duplicate_document', known.documentFingerprint]),
      })
    } else if (reportNumber !== null && known.reportNumber === reportNumber) {
      // Same report number, different bytes — the stronger signal of reuse.
      findings.push({
        code: 'duplicate_report_number',
        severity: 'critical',
        title: `Report number reused: ${reportNumber}`,
        detail: `Report number ${reportNumber} is already on file as COA record ${known.coaDocumentId}, but the document bytes differ.`,
        fieldKey: 'report_number',
        panelKey: null,
        pageNumber: fieldByKey(extraction, 'report_number')?.pageNumber ?? null,
        fingerprint: makeFingerprint(['duplicate_report_number', reportNumber, known.coaDocumentId]),
      })
    }
  }

  // Stable ordering: severity first (most serious up top), then fingerprint.
  const severityRank: Record<CoaFindingSeverity, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  }
  return findings.sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity]
    if (bySeverity !== 0) return bySeverity
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0
  })
}

/** De-duplicate by fingerprint — used when re-running against a stored set. */
export function mergeCoaFindings(existing: CoaFinding[], incoming: CoaFinding[]): CoaFinding[] {
  const byFingerprint = new Map<string, CoaFinding>()
  for (const finding of existing) byFingerprint.set(finding.fingerprint, finding)
  for (const finding of incoming) byFingerprint.set(finding.fingerprint, finding)
  return Array.from(byFingerprint.values())
}

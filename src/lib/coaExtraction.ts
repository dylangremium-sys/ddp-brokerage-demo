// ─── COA field extraction — the pure core ────────────────────────────────────
//
// Turns a model's reading of a Certificate of Analysis into rows for
// public.document_field_extractions. No network, no Supabase, no PDF handling:
// those belong in the api adapter, exactly as serverAiSummary.ts splits from
// api/compliance/ai-summary.ts. Everything decided here is decided on evidence
// from real documents, and the reasoning is recorded because most of it is
// counter-intuitive.
//
// GROUNDED IN TWO REAL COAs, read 2026-08-03:
//   docs/… TNR Bioscience reports RP-E2602-0192/0193/0194/0196/0197 for
//   Calli Krush Co.,LTD — one 15-page pack of five reports, plus a single-report
//   PDF of RP-E2602-0197. Extraction of the shared report was IDENTICAL from
//   both, which is the evidence that this is worth automating at all.

/**
 * The field vocabulary.
 *
 * MUST match public.document_extraction_field_names() exactly — migration 28
 * enforces it with `CHECK (field_name = ANY (document_extraction_field_names()))`,
 * so anything outside this list is rejected by the database, not by us. Measured
 * against production 2026-08-03.
 */
export const COA_FIELD_NAMES = [
  'laboratory_name',
  'accreditation_reference',
  'report_number',
  'sample_name',
  'sample_id',
  'batch_reference',
  'test_date',
  'received_date',
  'total_thc',
  'total_cbd',
  'moisture_pct',
  'water_activity',
  'heavy_metals_result',
  'pesticides_result',
  'microbial_result',
  'mycotoxins_result',
  'residual_solvents_result',
  'foreign_matter_result',
  'other',
] as const

export type CoaFieldName = (typeof COA_FIELD_NAMES)[number]

/** Mirrors public.document_extraction_provenances(). */
export type ExtractionProvenance = 'reported' | 'operator_entered' | 'machine_extracted'

/**
 * THE FOUR RESULT FIELDS CANNOT BE EXTRACTED AS VERDICTS.
 *
 * Every "Specification" column on the real COAs reads N/A. The laboratory
 * reports MEASUREMENTS — arsenic 0.01 ppm, TAMC 20 CFU/g — and states no limit,
 * so the document contains no pass or fail. Asking a model for a verdict would
 * be asking it to invent an acceptance threshold, and it would confidently
 * produce one.
 *
 * These are therefore extracted as the measured text, and the VERDICT is
 * computed later against DDP's own limits (migration 41's destination_rulesets).
 * Extraction supplies evidence; the ruleset supplies judgement.
 */
export const MEASUREMENT_ONLY_FIELDS: readonly CoaFieldName[] = [
  'heavy_metals_result',
  'pesticides_result',
  'microbial_result',
  'mycotoxins_result',
  'residual_solvents_result',
  'foreign_matter_result',
]

/**
 * Below this, a field is recorded but NOT offered for acceptance.
 *
 * Owner decision, 2026-08-03. Tunable — deliberately a named constant rather
 * than a literal at the comparison site, so changing it is one edit and shows up
 * in a diff as a policy change.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7

/** One field as the model reported it, before validation. */
export interface RawExtractedField {
  field_name: string
  value: string | null
  confidence: number | null
  /** The model's note when it could not read a field. */
  note?: string | null
}

/** One report found in a document. A single PDF may contain several. */
export interface RawExtractedReport {
  report_number: string | null
  fields: RawExtractedField[]
}

/** A row destined for public.document_field_extractions. */
export interface ExtractionRow {
  field_name: CoaFieldName
  field_value_text: string | null
  provenance: ExtractionProvenance
  confidence: number | null
  extraction_warning: string | null
  /** False when confidence is below the threshold: record it, do not offer it. */
  offerForAcceptance: boolean
}

export interface ReportExtraction {
  reportNumber: string | null
  rows: ExtractionRow[]
  /** Populated when the document's filename disagrees with what was read. */
  crossCheckWarnings: string[]
}

function isCoaFieldName(v: string): v is CoaFieldName {
  return (COA_FIELD_NAMES as readonly string[]).includes(v)
}

/**
 * Normalises one reported field into a database-shaped row.
 *
 * TWO CONSTRAINTS FROM MIGRATION 28 SHAPE THIS ENTIRELY, and both are opinions
 * worth keeping:
 *
 *   dfe_confidence_provenance_check — `machine_extracted` REQUIRES a confidence
 *     in [0,1]; every other provenance FORBIDS one. You cannot record a machine
 *     guess without saying how sure it was.
 *
 *   dfe_absent_value_needs_warning_check — a row must carry a value OR a
 *     warning. "Found nothing" has to be recorded as a warning, never as
 *     silence. This is why an unreadable field still produces a row.
 */
export function toExtractionRow(
  raw: RawExtractedField,
  threshold = DEFAULT_CONFIDENCE_THRESHOLD,
): ExtractionRow | null {
  if (!isCoaFieldName(raw.field_name)) return null

  const value = raw.value != null && raw.value.trim() !== '' ? raw.value.trim() : null

  // A confidence outside [0,1] is not a low confidence — it is a broken reply,
  // and treating it as a number would smuggle a bad reading past the threshold.
  const c = raw.confidence
  const confidence = typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1 ? c : null

  if (value === null) {
    return {
      field_name: raw.field_name,
      field_value_text: null,
      // No value means nothing was machine-extracted, so the constraint forbids
      // a confidence here even if the model volunteered one.
      provenance: 'machine_extracted',
      confidence: 0,
      extraction_warning: raw.note?.trim() || 'not found in document',
      offerForAcceptance: false,
    }
  }

  if (confidence === null) {
    // A value with no usable confidence cannot be stored as machine_extracted —
    // the CHECK would reject it. Record the reading in the warning so it is not
    // lost, and leave the value null so a human enters it deliberately.
    return {
      field_name: raw.field_name,
      field_value_text: null,
      provenance: 'machine_extracted',
      confidence: 0,
      extraction_warning: `read as "${value}" but the model reported no usable confidence`,
      offerForAcceptance: false,
    }
  }

  return {
    field_name: raw.field_name,
    field_value_text: value,
    provenance: 'machine_extracted',
    confidence,
    extraction_warning:
      confidence < threshold ? `low confidence (${confidence.toFixed(2)}) — confirm against the document` : null,
    offerForAcceptance: confidence >= threshold,
  }
}

/**
 * Cross-checks the extracted report number against the filename.
 *
 * The laboratory embeds report number, sample number and customer in the file
 * name:
 *
 *   602918346421698884_RP-E2602-0197_EX26-0191_Calli Krush Co.,LTD (1).pdf
 *
 * That is an INDEPENDENT signal, free of charge, and it catches two different
 * failures: a mis-read of the report number, and a document filed against the
 * wrong batch. It never overrides the extraction — a disagreement is surfaced
 * for a human, because either side could be the wrong one.
 */
export function crossCheckAgainstFilename(
  fileName: string,
  extracted: { reportNumber?: string | null; sampleId?: string | null },
): string[] {
  const warnings: string[] = []
  const report = extracted.reportNumber?.trim()
  const sample = extracted.sampleId?.trim()

  if (report && !fileName.includes(report)) {
    warnings.push(`report number "${report}" does not appear in the file name`)
  }
  if (sample && !fileName.includes(sample)) {
    warnings.push(`sample id "${sample}" does not appear in the file name`)
  }
  return warnings
}

/**
 * Parses a date as the laboratory writes it: DD/MM/YYYY.
 *
 * `20/12/2025` is 20 December. Read as MM/DD it is not a date at all, and
 * `11/02/2026` silently becomes 2 November instead of 11 February — a date that
 * parses cleanly and is wrong by nine months. Returns null rather than guessing.
 */
export function parseCoaDate(value: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim())
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  // Round-trip guard: rejects 31/02/2026, which passes the range checks above.
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== day || d.getUTCMonth() + 1 !== month) return null
  return iso
}

/**
 * Turns a model reply into one extraction per report.
 *
 * A SINGLE PDF MAY CONTAIN SEVERAL COAs. The real pack held five — Mango,
 * Jell Breath, Red Dragon, Rainbow Crush, Purple Gelato — each its own report
 * number, sample number and batch. document_field_extractions ties its rows to
 * ONE document, so treating a pack as one COA would attach one sample's numbers
 * to another's batch, and nothing in the schema would catch it. The lab also
 * issues per-sample PDFs of the same reports, so both shapes arrive: detect,
 * never assume.
 */
export function buildExtractions(
  reports: RawExtractedReport[],
  opts: { fileName?: string; threshold?: number } = {},
): ReportExtraction[] {
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD

  return reports.map((report) => {
    const rows = report.fields
      .map((f) => toExtractionRow(f, threshold))
      .filter((r): r is ExtractionRow => r !== null)

    const sampleId = rows.find((r) => r.field_name === 'sample_id')?.field_value_text ?? null

    const crossCheckWarnings = opts.fileName
      ? crossCheckAgainstFilename(opts.fileName, { reportNumber: report.report_number, sampleId })
      : []

    return { reportNumber: report.report_number, rows, crossCheckWarnings }
  })
}

/** Fields a reviewer may accept without re-reading the document. */
export function acceptableFields(extraction: ReportExtraction): ExtractionRow[] {
  return extraction.rows.filter((r) => r.offerForAcceptance)
}

/** Fields that need a human to look at the PDF. */
export function needsReview(extraction: ReportExtraction): ExtractionRow[] {
  return extraction.rows.filter((r) => !r.offerForAcceptance)
}

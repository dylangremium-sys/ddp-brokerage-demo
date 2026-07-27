// ─── TNR Bioscience three-page COA adapter (Gate P0 — issue #77) ────────────
//
// A NARROW, format-specific adapter for the demonstrated TNR Bioscience Co.,
// Ltd. "LABORATORY TEST REPORT" layout (Document Code TNRB-QC-FM-59, Issue 03,
// three pages). It is deliberately not a general OCR or COA system: it accepts
// the per-page text of a PDF that has already been extracted server-side and
// turns it into fields carrying their own provenance.
//
// This module is PURE. It opens no socket, reads no file, touches no database,
// calls no AI provider, and reads no clock — `extractedAt` and the document
// fingerprint are supplied by the caller. That keeps every parsing rule unit
// testable against real COA text, and makes it impossible for extraction to
// acquire a side effect by accident.
//
// It NEVER hard-codes an acceptance value. Every value returned is read out of
// the supplied document text; the only literals here are structural (labels,
// panel headings, the issuer's own name and document code) — the vocabulary of
// the form, not the contents of any particular report.
//
// A field that cannot be read is reported as `missing`/`unreadable` with a
// warning. It is never silently defaulted, and never invented.

/** Bumped whenever a parsing rule changes; persisted with every extraction so
 *  a stored result can always be traced to the exact logic that produced it. */
export const TNR_PARSER_VERSION = 'tnr-coa-adapter/1.0.0'

/** The one document format this adapter claims to understand. */
export const TNR_FORMAT_ID = 'tnr-3page-v1'

/** Structural markers that identify the format. All must be present. */
const TNR_ISSUER_NAME = 'TNR BIOSCIENCE COMPANY LIMITED'
const TNR_REPORT_TITLE = 'LABORATORY TEST REPORT'
const TNR_DOCUMENT_CODE = 'TNRB-QC-FM-59'
const TNR_EXPECTED_PAGE_COUNT = 3

export type CoaExtractionStatus = 'extracted' | 'missing' | 'unreadable' | 'ambiguous'

export type CoaFieldKey =
  | 'report_number'
  | 'sample_received_date'
  | 'reported_on'
  | 'sample_name'
  | 'manufacturing_date'
  | 'expiry_date'
  | 'batch_number'
  | 'material_batch_number'
  | 'sample_number'
  | 'testing_start_date'
  | 'testing_end_date'
  | 'laboratory_name'
  | 'customer_name'
  | 'total_thc'
  | 'total_cbd'
  | 'document_code'

export interface CoaExtractedField {
  key: CoaFieldKey
  label: string
  /** Verbatim text as it appears in the PDF, before any cleaning. */
  rawValue: string | null
  /** Canonical form (ISO date, decimal string, trimmed text) or null. */
  normalizedValue: string | null
  /** 1-based PDF page the value was read from. Null only when not found. */
  pageNumber: number | null
  status: CoaExtractionStatus
  warnings: string[]
}

export type CoaPanelKey =
  | 'physical_properties'
  | 'identification'
  | 'cannabinoid_groups'
  | 'terpenes'
  | 'heavy_metal'
  | 'mycotoxins'
  | 'pesticides'
  | 'microbial_enumeration'
  | 'specified_microorganisms'

export interface CoaPanel {
  key: CoaPanelKey
  label: string
  present: boolean
  /** 1-based page the heading was found on, or null when absent. */
  pageNumber: number | null
  /** Number of result rows parsed beneath the heading. */
  rowCount: number
}

export interface CoaAnalyte {
  panelKey: CoaPanelKey
  name: string
  rawResult: string
  /** Numeric result when the cell is a number; null for ND/qualitative/unparseable. */
  numericResult: number | null
  resultKind: 'numeric' | 'not_detected' | 'below_limit' | 'qualitative' | 'malformed'
  unit: string | null
  pageNumber: number
}

export interface TnrCoaExtraction {
  parserVersion: string
  format: typeof TNR_FORMAT_ID
  /** False when the document does not match the TNR three-page layout. */
  supported: boolean
  /** Why the document was rejected, when `supported` is false. */
  unsupportedReason: string | null
  documentFingerprint: string
  pageCount: number
  extractedAt: string
  fields: CoaExtractedField[]
  panels: CoaPanel[]
  analytes: CoaAnalyte[]
  /** Document-level warnings (as opposed to per-field ones). */
  warnings: string[]
}

export interface TnrExtractionInput {
  /** Per-page plain text, index 0 = page 1. Produced server-side from PDF bytes. */
  pages: string[]
  /** SHA-256 (or equivalent) of the original PDF bytes. Supplied, never derived here. */
  documentFingerprint: string
  /** ISO timestamp supplied by the caller so this module stays clock-free. */
  extractedAt: string
}

// ─── Field definitions ───────────────────────────────────────────────────────
//
// Fields whose value sits on the SAME line as its label, e.g.
//   "Batch No. F4-122025"  ->  label "Batch No." value "F4-122025"
// The label text is the form's own wording and is matched at line start.

type InlineFieldSpec = {
  key: CoaFieldKey
  label: string
  /** Literal label as printed on the form. */
  marker: string
  kind: 'text' | 'date'
}

const INLINE_FIELDS: InlineFieldSpec[] = [
  { key: 'sample_name', label: 'Sample Name', marker: 'Sample Name', kind: 'text' },
  { key: 'manufacturing_date', label: 'Manufacturing Date', marker: 'Manufacturing Date', kind: 'date' },
  { key: 'expiry_date', label: 'Expiry Date', marker: 'Expiry Date', kind: 'date' },
  { key: 'batch_number', label: 'Batch No.', marker: 'Batch No.', kind: 'text' },
  { key: 'material_batch_number', label: 'Material Batch No.', marker: 'Material Batch No.', kind: 'text' },
  { key: 'sample_number', label: 'Sample No.', marker: 'Sample No.', kind: 'text' },
  { key: 'testing_start_date', label: 'Testing Start Date', marker: 'Testing Start Date', kind: 'date' },
  { key: 'testing_end_date', label: 'Testing End Date', marker: 'Testing End Date', kind: 'date' },
]

const PANEL_SPECS: Array<{ key: CoaPanelKey; label: string; heading: string }> = [
  { key: 'physical_properties', label: 'Physical Properties', heading: 'Physical Properties' },
  { key: 'identification', label: 'Identification', heading: 'Identification' },
  { key: 'cannabinoid_groups', label: 'Cannabinoid groups', heading: 'Cannabinoid groups' },
  { key: 'terpenes', label: 'Terpenes', heading: 'Terpenes' },
  { key: 'heavy_metal', label: 'Heavy Metal', heading: 'Heavy Metal' },
  { key: 'mycotoxins', label: 'Mycotoxins', heading: 'Mycotoxins' },
  { key: 'pesticides', label: 'Pesticides', heading: 'Pesticides' },
  { key: 'microbial_enumeration', label: 'Microbial Enumeration', heading: 'Microbial Enumeration' },
  { key: 'specified_microorganisms', label: 'Specified Microorganisms', heading: 'Specified Microorganisms' },
]

/**
 * The micro sign is encoded two different ways in the wild — U+00B5 MICRO SIGN
 * and U+03BC GREEK SMALL LETTER MU — and this form's PDF does not use the one a
 * source file typed as "µ" produces. Units are canonicalised before comparison
 * so "µg/kg" is recognised whichever codepoint the document carries.
 */
const MICRO_SIGN_VARIANTS = /[µμ]/g
const CANONICAL_MICRO = 'µ'

function canonicalUnit(unit: string): string {
  return unit.replace(MICRO_SIGN_VARIANTS, CANONICAL_MICRO)
}

/** Single-token units the form is known to print (canonical spelling). */
const KNOWN_UNITS = new Set(['%w/w', 'ppm', `${CANONICAL_MICRO}g/kg`, 'mg/kg', 'CFU/g'])

/**
 * Microbiology reports its basis as a multi-token unit, e.g. "Absent per 1 g"
 * or "Absent per 25 g", so the unit cannot be read as "the last token".
 */
const PER_QUANTITY_UNIT_RE = /\bper\s+\d+(?:\.\d+)?\s+\S+$/i

/** Verdict words that can stand alone as a result. */
const VERDICT_RESULT_RE = /^(conforms?|complies|absent|present|detected|not detected)\b/i

/** A result that is textual but well-formed (a verdict or a plain description). */
const DESCRIPTIVE_RESULT_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s()\-,./]*$/

/** "< 10" — reported below the limit of quantitation. */
const BELOW_LIMIT_RE = /^<\s*\d+(?:\.\d+)?$/

/** Tokens that indicate the laboratory itself reported a failure. */
const FAILURE_TOKENS = /\b(fail(?:ed|ure)?|does not conform|not conform|out of specification|non-?compliant)\b/i

// A TNR report number, e.g. "RP-E2602-0196". Matched by SHAPE, so no specific
// report number is ever baked in.
const REPORT_NUMBER_RE = /\bRP-[A-Z0-9]+-[A-Z0-9]+\b/
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/
const DOCUMENT_CODE_RE = /Document Code:\s*(\S+)/

// ─── Date handling ───────────────────────────────────────────────────────────

export interface NormalizedDate {
  iso: string | null
  valid: boolean
  reason: string | null
}

/**
 * Normalize the form's DD/MM/YYYY dates to ISO YYYY-MM-DD.
 *
 * Rejects impossible calendar dates (31/02, 30/02, month 13, day 0) by
 * round-tripping through UTC and checking the components survive — a string
 * like "31/02/2026" would otherwise silently roll forward into March.
 */
export function normalizeThaiDate(raw: string): NormalizedDate {
  const trimmed = raw.trim()
  if (!DATE_RE.test(trimmed)) {
    return { iso: null, valid: false, reason: `not DD/MM/YYYY: "${trimmed}"` }
  }
  const [dayStr, monthStr, yearStr] = trimmed.split('/')
  const day = Number(dayStr)
  const month = Number(monthStr)
  const year = Number(yearStr)

  if (month < 1 || month > 12) {
    return { iso: null, valid: false, reason: `impossible month ${month}` }
  }
  if (day < 1 || day > 31) {
    return { iso: null, valid: false, reason: `impossible day ${day}` }
  }

  const asUtc = new Date(Date.UTC(year, month - 1, day))
  const survives =
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  if (!survives) {
    return { iso: null, valid: false, reason: `impossible calendar date ${trimmed}` }
  }

  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { iso, valid: true, reason: null }
}

// ─── Line helpers ────────────────────────────────────────────────────────────

interface PageLine {
  text: string
  pageNumber: number
}

function toLines(pages: string[]): PageLine[] {
  const out: PageLine[] = []
  pages.forEach((page, index) => {
    for (const rawLine of page.split('\n')) {
      const text = rawLine.trim()
      if (text.length > 0) out.push({ text, pageNumber: index + 1 })
    }
  })
  return out
}

function missingField(key: CoaFieldKey, label: string, reason: string): CoaExtractedField {
  return {
    key,
    label,
    rawValue: null,
    normalizedValue: null,
    pageNumber: null,
    status: 'missing',
    warnings: [reason],
  }
}

/**
 * Read a `Label value` field.
 *
 * Longer markers are disambiguated by the caller's ordering: "Material Batch
 * No." is checked before "Batch No." would match it, because each line is
 * assigned to the LONGEST marker that prefixes it.
 */
function extractInlineField(lines: PageLine[], spec: InlineFieldSpec): CoaExtractedField {
  const matches = lines.filter((line) => {
    if (!line.text.startsWith(spec.marker)) return false
    // Ensure the longest competing marker doesn't own this line instead.
    const better = INLINE_FIELDS.find(
      (other) =>
        other.key !== spec.key &&
        other.marker.length > spec.marker.length &&
        line.text.startsWith(other.marker),
    )
    return !better
  })

  if (matches.length === 0) {
    return missingField(spec.key, spec.label, `label "${spec.marker}" not found`)
  }

  const line = matches[0]
  const raw = line.text.slice(spec.marker.length).trim()
  const warnings: string[] = []
  if (matches.length > 1) {
    warnings.push(`label "${spec.marker}" appeared ${matches.length} times; used the first (page ${line.pageNumber})`)
  }

  if (raw.length === 0) {
    return {
      key: spec.key, label: spec.label, rawValue: null, normalizedValue: null,
      pageNumber: line.pageNumber, status: 'unreadable',
      warnings: [...warnings, `label "${spec.marker}" present but no value followed it`],
    }
  }

  // "N/A" is a real, printed value meaning the lab supplied nothing.
  if (raw.toUpperCase() === 'N/A') {
    return {
      key: spec.key, label: spec.label, rawValue: raw, normalizedValue: null,
      pageNumber: line.pageNumber, status: 'missing',
      warnings: [...warnings, 'reported as N/A by the laboratory'],
    }
  }

  if (spec.kind === 'date') {
    const normalized = normalizeThaiDate(raw)
    return {
      key: spec.key, label: spec.label, rawValue: raw,
      normalizedValue: normalized.iso,
      pageNumber: line.pageNumber,
      status: normalized.valid ? 'extracted' : 'unreadable',
      warnings: normalized.valid ? warnings : [...warnings, `malformed date: ${normalized.reason}`],
    }
  }

  return {
    key: spec.key, label: spec.label, rawValue: raw, normalizedValue: raw,
    pageNumber: line.pageNumber, status: 'extracted', warnings,
  }
}

/**
 * The report header triplet.
 *
 * The form prints three stacked labels ("Report No. :", "Sample received date :",
 * "Reported on :") whose values are emitted separately in the PDF content
 * stream — on page 1 they land far from their labels. Rather than depend on
 * fragile positioning, the report number is located by shape and the next two
 * date-shaped lines are taken as received/reported, which holds on every page
 * of the format.
 */
function extractHeaderTriplet(lines: PageLine[]): CoaExtractedField[] {
  const anchorIndex = lines.findIndex((line) => REPORT_NUMBER_RE.test(line.text))

  if (anchorIndex === -1) {
    return [
      missingField('report_number', 'Report No.', 'no value matching the TNR report-number shape (RP-…-…) was found'),
      missingField('sample_received_date', 'Sample received date', 'not locatable without the report number anchor'),
      missingField('reported_on', 'Reported on', 'not locatable without the report number anchor'),
    ]
  }

  const anchor = lines[anchorIndex]
  const reportNumber = (anchor.text.match(REPORT_NUMBER_RE) as RegExpMatchArray)[0]

  const reportField: CoaExtractedField = {
    key: 'report_number', label: 'Report No.',
    rawValue: reportNumber, normalizedValue: reportNumber,
    pageNumber: anchor.pageNumber, status: 'extracted', warnings: [],
  }

  // The two date lines immediately following the anchor, on the same page.
  const following = lines
    .slice(anchorIndex + 1)
    .filter((line) => line.pageNumber === anchor.pageNumber)
    .filter((line) => DATE_RE.test(line.text))
    .slice(0, 2)

  const dateField = (
    key: CoaFieldKey,
    label: string,
    line: PageLine | undefined,
  ): CoaExtractedField => {
    if (!line) return missingField(key, label, 'no date line followed the report number')
    const normalized = normalizeThaiDate(line.text)
    return {
      key, label,
      rawValue: line.text,
      normalizedValue: normalized.iso,
      pageNumber: line.pageNumber,
      status: normalized.valid ? 'extracted' : 'unreadable',
      warnings: normalized.valid ? [] : [`malformed date: ${normalized.reason}`],
    }
  }

  return [
    reportField,
    dateField('sample_received_date', 'Sample received date', following[0]),
    dateField('reported_on', 'Reported on', following[1]),
  ]
}

/** The issuing laboratory, matched against the form's own printed name. */
function extractLaboratoryName(lines: PageLine[]): CoaExtractedField {
  const line = lines.find((l) => l.text.includes(TNR_ISSUER_NAME))
  if (!line) return missingField('laboratory_name', 'Laboratory', 'issuer name not printed on any page')
  return {
    key: 'laboratory_name', label: 'Laboratory',
    rawValue: line.text, normalizedValue: TNR_ISSUER_NAME,
    pageNumber: line.pageNumber, status: 'extracted', warnings: [],
  }
}

/**
 * Customer name and address.
 *
 * The form prints the caption "Customer Name" / "and Address" as a two-line
 * stacked cell; the value follows it in the content stream.
 */
function extractCustomerName(lines: PageLine[]): CoaExtractedField {
  const captionIndex = lines.findIndex((l) => l.text.startsWith('Customer Name'))
  if (captionIndex === -1) {
    return missingField('customer_name', 'Customer', 'caption "Customer Name" not found')
  }
  const caption = lines[captionIndex]

  // Same-line value, e.g. "Customer Name Foo Co." — otherwise take the next
  // line that is not the continuation caption "and Address".
  const inline = caption.text.slice('Customer Name'.length).trim()
  if (inline.length > 0 && !/^and Address$/i.test(inline)) {
    return {
      key: 'customer_name', label: 'Customer', rawValue: inline, normalizedValue: inline,
      pageNumber: caption.pageNumber, status: 'extracted', warnings: [],
    }
  }

  // The address is printed as a wrapped block. Collect its lines until the next
  // captioned cell begins, so the stored value is the address the form actually
  // shows rather than only its first line.
  const CUSTOMER_BLOCK_END = /^(Detail of Sample|ANALYTICAL RESULT|Specification\s+Result|Parameter\b|Sample Name\b)/

  const parts: string[] = []
  let pageNumber: number | null = null
  for (const line of lines.slice(captionIndex + 1)) {
    if (line.pageNumber !== caption.pageNumber) break
    if (/^and Address$/i.test(line.text)) continue
    if (CUSTOMER_BLOCK_END.test(line.text)) break
    parts.push(line.text)
    pageNumber ??= line.pageNumber
    if (parts.join(' ').length > 300) break
  }

  if (parts.length === 0) {
    return missingField('customer_name', 'Customer', 'caption present but no customer value followed it')
  }
  const value = parts.join(' ')
  return {
    key: 'customer_name', label: 'Customer',
    rawValue: value, normalizedValue: value,
    pageNumber, status: 'extracted', warnings: [],
  }
}

/** The form's own document code, e.g. "TNRB-QC-FM-59" — a format identity check. */
function extractDocumentCode(lines: PageLine[]): CoaExtractedField {
  for (const line of lines) {
    const match = line.text.match(DOCUMENT_CODE_RE)
    if (match) {
      return {
        key: 'document_code', label: 'Document Code',
        rawValue: match[0], normalizedValue: match[1],
        pageNumber: line.pageNumber, status: 'extracted', warnings: [],
      }
    }
  }
  return missingField('document_code', 'Document Code', 'no "Document Code:" marker found')
}

/**
 * Total cannabinoid rows from the cannabinoid table, e.g.
 *   "Total Tetrahydrocannabinol (THC) N/A 26.86 %w/w N/A"
 *
 * Read from the TABLE, not from the large "TOTAL THC" marketing callout, so the
 * value carries a unit and sits with the rest of the analytical result.
 */
function extractTotalCannabinoid(
  lines: PageLine[],
  key: 'total_thc' | 'total_cbd',
  label: string,
  rowPrefix: string,
): CoaExtractedField {
  const line = lines.find((l) => l.text.startsWith(rowPrefix))
  if (!line) return missingField(key, label, `row "${rowPrefix}" not found in the cannabinoid table`)

  const remainder = line.text.slice(rowPrefix.length).trim()
  // Layout: <specification> <result> <unit> <LOD>  e.g. "N/A 26.86 %w/w N/A"
  const match = remainder.match(/^(\S+)\s+(\S+)\s+(\S+)/)
  if (!match) {
    return {
      key, label, rawValue: remainder, normalizedValue: null,
      pageNumber: line.pageNumber, status: 'unreadable',
      warnings: [`could not read result/unit from "${remainder}"`],
    }
  }
  const [, , result, rawUnit] = match
  const unit = canonicalUnit(rawUnit)
  const warnings: string[] = []
  if (!KNOWN_UNITS.has(unit)) warnings.push(`unrecognised unit "${rawUnit}"`)

  if (/^nd$/i.test(result)) {
    return {
      key, label, rawValue: `${result} ${unit}`, normalizedValue: 'ND',
      pageNumber: line.pageNumber, status: 'extracted', warnings,
    }
  }
  const numeric = Number(result)
  if (!Number.isFinite(numeric)) {
    return {
      key, label, rawValue: `${result} ${unit}`, normalizedValue: null,
      pageNumber: line.pageNumber, status: 'unreadable',
      warnings: [...warnings, `non-numeric result "${result}"`],
    }
  }
  return {
    key, label, rawValue: `${result} ${unit}`, normalizedValue: `${numeric} ${unit}`,
    pageNumber: line.pageNumber, status: 'extracted', warnings,
  }
}

// ─── Panels and analyte rows ─────────────────────────────────────────────────

/**
 * Locate each expected panel heading and count the result rows beneath it.
 *
 * A "Pesticides" heading legitimately appears on more than one page because the
 * table continues; the FIRST occurrence is recorded as the panel's page and the
 * rows from every occurrence are counted.
 */
function extractPanelsAndAnalytes(lines: PageLine[]): { panels: CoaPanel[]; analytes: CoaAnalyte[] } {
  const headingIndexes = new Map<CoaPanelKey, number[]>()
  lines.forEach((line, index) => {
    for (const spec of PANEL_SPECS) {
      if (line.text === spec.heading) {
        const existing = headingIndexes.get(spec.key) ?? []
        existing.push(index)
        headingIndexes.set(spec.key, existing)
      }
    }
  })

  const allHeadingIndexes = new Set<number>()
  for (const indexes of headingIndexes.values()) for (const i of indexes) allHeadingIndexes.add(i)

  const analytes: CoaAnalyte[] = []
  const panels: CoaPanel[] = PANEL_SPECS.map((spec) => {
    const indexes = headingIndexes.get(spec.key)
    if (!indexes || indexes.length === 0) {
      return { key: spec.key, label: spec.label, present: false, pageNumber: null, rowCount: 0 }
    }

    let rowCount = 0
    for (const headingIndex of indexes) {
      // Lines the form wrapped are held here until the row they belong to
      // terminates, so a row split across three lines still yields one analyte
      // carrying the name text the document actually printed.
      let pendingName: string[] = []

      for (let i = headingIndex + 1; i < lines.length; i += 1) {
        if (allHeadingIndexes.has(i)) break // next panel begins

        const parsed = parseAnalyteRow(lines[i], spec.key, pendingName)
        if (parsed) {
          analytes.push(parsed)
          rowCount += 1
          pendingName = []
        } else if (isWrappedNameFragment(lines[i].text)) {
          pendingName.push(lines[i].text)
        }
      }
    }

    return {
      key: spec.key,
      label: spec.label,
      present: true,
      pageNumber: lines[indexes[0]].pageNumber,
      rowCount,
    }
  })

  return { panels, analytes }
}

/** Running headers/footers and method prose are never result rows. */
function isStructuralLine(text: string): boolean {
  return (
    /^Document Code:/.test(text) ||
    /^Specification\s+Result/.test(text) ||
    /^In-house method/i.test(text) ||
    /^(Head Office|Factory \/ QC Laboratory|LABORATORY TEST REPORT|ANALYTICAL RESULT|Parameter\b)/.test(text) ||
    /^Report No\.|^Sample received date|^Reported on/.test(text)
  )
}

/** A line that is plausibly the wrapped continuation of an analyte's name. */
function isWrappedNameFragment(text: string): boolean {
  if (isStructuralLine(text)) return false
  if (text.length === 0 || text.length > 160) return false
  return /[A-Za-zÀ-ÿ]/.test(text)
}

/**
 * Classify a result cell without inventing meaning.
 *
 * Anything that is not a number, "ND", a "< n" below-limit report, or ordinary
 * descriptive text is reported as `malformed` so the findings engine can raise
 * it rather than the parser quietly accepting it.
 */
function classifyResult(result: string): { kind: CoaAnalyte['resultKind']; numeric: number | null } {
  const trimmed = result.trim()
  if (/^nd$/i.test(trimmed)) return { kind: 'not_detected', numeric: null }
  if (BELOW_LIMIT_RE.test(trimmed)) return { kind: 'below_limit', numeric: null }
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
    return { kind: 'numeric', numeric: Number(trimmed) }
  }
  if (DESCRIPTIVE_RESULT_RE.test(trimmed)) return { kind: 'qualitative', numeric: null }
  return { kind: 'malformed', numeric: null }
}

/**
 * Parse one analytical result row.
 *
 * The form's column order is
 *   "<analyte name> <specification> <result> <unit> <LOD>"
 * but result and unit are BOTH variable width — "Absent per 1 g", "< 10 CFU/g",
 * "Dried cannabis flowers" — so a fixed token count cannot read it. Instead the
 * row is split on the specification cell (printed "N/A" throughout this form),
 * the LOD is taken off the end, and the unit is matched by shape.
 *
 * The Identification panel wraps each row over three lines and prints only a
 * verdict on the last one; `pendingName` supplies the name the form already
 * printed above it, so the row is attributed rather than dropped.
 */
function parseAnalyteRow(
  line: PageLine,
  panelKey: CoaPanelKey,
  pendingName: string[],
): CoaAnalyte | null {
  const text = line.text
  if (isStructuralLine(text)) return null

  // ── Wrapped verdict row, e.g. "Conforms N/A N/A" ──────────────────────────
  const verdictOnly = text.match(/^([A-Za-z][A-Za-z\s]*?)\s+N\/A\s+N\/A$/)
  if (verdictOnly && VERDICT_RESULT_RE.test(verdictOnly[1])) {
    const name = pendingName.join(' ').trim()
    if (name.length === 0) return null
    return {
      panelKey,
      name,
      rawResult: verdictOnly[1].trim(),
      numericResult: null,
      resultKind: 'qualitative',
      unit: null,
      pageNumber: line.pageNumber,
    }
  }

  // ── Standard row: split on the specification cell ─────────────────────────
  const separatorIndex = text.indexOf(' N/A ')
  if (separatorIndex === -1) return null

  const name = text.slice(0, separatorIndex).trim()
  if (name.length === 0) return null

  let remainder = text.slice(separatorIndex + ' N/A '.length).trim()

  // Drop the trailing LOD cell (a number, or "N/A" when not applicable).
  const lodMatch = remainder.match(/\s(\S+)$/)
  if (!lodMatch) return null
  const lodCandidate = lodMatch[1]
  if (lodCandidate.toUpperCase() === 'N/A' || Number.isFinite(Number(lodCandidate))) {
    remainder = remainder.slice(0, remainder.length - lodMatch[0].length).trim()
  }
  if (remainder.length === 0) return null

  // Pull the unit off the end: a multi-token "per N g", a known unit, or an
  // explicit "N/A" meaning the result is unitless.
  let unit: string | null = null
  const perMatch = remainder.match(PER_QUANTITY_UNIT_RE)
  if (perMatch) {
    unit = perMatch[0]
    remainder = remainder.slice(0, remainder.length - perMatch[0].length).trim()
  } else {
    const lastToken = remainder.split(/\s+/).pop() as string
    if (KNOWN_UNITS.has(canonicalUnit(lastToken))) {
      unit = canonicalUnit(lastToken)
      remainder = remainder.slice(0, remainder.length - lastToken.length).trim()
    } else if (lastToken.toUpperCase() === 'N/A') {
      unit = null
      remainder = remainder.slice(0, remainder.length - lastToken.length).trim()
    }
  }

  if (remainder.length === 0) return null

  const { kind, numeric } = classifyResult(remainder)

  return {
    panelKey,
    name,
    rawResult: remainder,
    numericResult: numeric,
    resultKind: kind,
    unit,
    pageNumber: line.pageNumber,
  }
}

/** Does the laboratory itself report a failure anywhere in the document? */
export function findReportedFailureLines(pages: string[]): Array<{ text: string; pageNumber: number }> {
  return toLines(pages)
    .filter((line) => FAILURE_TOKENS.test(line.text))
    // "does not conform" inside a method description is not a result; require
    // the line to look like a result row or an explicit result statement.
    .filter((line) => !/^In-house method/i.test(line.text))
    .map((line) => ({ text: line.text, pageNumber: line.pageNumber }))
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Confirm the document is the TNR three-page format before any field is trusted.
 * Returns null when supported, or a human-readable reason when not.
 */
export function checkTnrFormat(pages: string[]): string | null {
  if (pages.length === 0) return 'the document contains no extractable text pages'

  const joined = pages.join('\n')
  const hasText = joined.trim().length > 0
  if (!hasText) {
    return 'the document has no text layer (scanned or image-only PDFs are not supported by this adapter)'
  }
  if (!joined.includes(TNR_ISSUER_NAME)) {
    return `not a ${TNR_ISSUER_NAME} report (issuer name absent)`
  }
  if (!joined.includes(TNR_REPORT_TITLE)) {
    return `not a "${TNR_REPORT_TITLE}" (title absent)`
  }
  if (!joined.includes(TNR_DOCUMENT_CODE)) {
    return `unexpected form code (expected ${TNR_DOCUMENT_CODE})`
  }
  if (pages.length !== TNR_EXPECTED_PAGE_COUNT) {
    return `expected a ${TNR_EXPECTED_PAGE_COUNT}-page report, received ${pages.length} pages`
  }
  return null
}

export function extractTnrCoa(input: TnrExtractionInput): TnrCoaExtraction {
  const { pages, documentFingerprint, extractedAt } = input

  const unsupportedReason = checkTnrFormat(pages)
  if (unsupportedReason) {
    return {
      parserVersion: TNR_PARSER_VERSION,
      format: TNR_FORMAT_ID,
      supported: false,
      unsupportedReason,
      documentFingerprint,
      pageCount: pages.length,
      extractedAt,
      fields: [],
      panels: PANEL_SPECS.map((spec) => ({
        key: spec.key, label: spec.label, present: false, pageNumber: null, rowCount: 0,
      })),
      analytes: [],
      warnings: [`document rejected: ${unsupportedReason}`],
    }
  }

  const lines = toLines(pages)

  const fields: CoaExtractedField[] = [
    ...extractHeaderTriplet(lines),
    ...INLINE_FIELDS.map((spec) => extractInlineField(lines, spec)),
    extractLaboratoryName(lines),
    extractCustomerName(lines),
    extractTotalCannabinoid(lines, 'total_thc', 'Total THC', 'Total Tetrahydrocannabinol (THC)'),
    extractTotalCannabinoid(lines, 'total_cbd', 'Total CBD', 'Total Cannabidiol (CBD)'),
    extractDocumentCode(lines),
  ]

  const { panels, analytes } = extractPanelsAndAnalytes(lines)

  const warnings: string[] = []
  const unreadable = fields.filter((f) => f.status === 'unreadable')
  if (unreadable.length > 0) {
    warnings.push(`${unreadable.length} field(s) present but unreadable: ${unreadable.map((f) => f.key).join(', ')}`)
  }

  return {
    parserVersion: TNR_PARSER_VERSION,
    format: TNR_FORMAT_ID,
    supported: true,
    unsupportedReason: null,
    documentFingerprint,
    pageCount: pages.length,
    extractedAt,
    fields,
    panels,
    analytes,
    warnings,
  }
}

/** Convenience lookup used by the findings engine and the UI. */
export function fieldByKey(extraction: TnrCoaExtraction, key: CoaFieldKey): CoaExtractedField | null {
  return extraction.fields.find((f) => f.key === key) ?? null
}

// Unit tests for the deterministic COA findings engine.
//
// Runs on the synthetic TNR fixture — the supplied COAs are private evidence
// and are never committed. Each rule is driven by mutating the fixture, which
// also demonstrates that a clean report produces no findings at all.

import { describe, it, expect } from 'vitest'
import { extractTnrCoa, type TnrCoaExtraction } from './coaTnrAdapter'
import { deriveCoaFindings, mergeCoaFindings, type KnownCoaDocument } from './coaFindings'
import { makeTnrPages, type FixtureOptions } from './__fixtures__/tnrCoaFixture'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)

function extract(options: FixtureOptions = {}, fingerprint = FINGERPRINT_A): TnrCoaExtraction {
  return extractTnrCoa({
    pages: makeTnrPages(options),
    documentFingerprint: fingerprint,
    extractedAt: '2026-07-27T00:00:00.000Z',
  })
}

function findings(options: FixtureOptions = {}, knownDocuments: KnownCoaDocument[] = []) {
  return deriveCoaFindings({ extraction: extract(options), knownDocuments })
}

describe('deriveCoaFindings — clean report', () => {
  it('produces no findings for a complete, well-formed report', () => {
    expect(findings()).toEqual([])
  })

  it('is deterministic across repeated runs', () => {
    const a = findings({ expiryDate: '31/02/2026', omitPanels: ['Mycotoxins'] })
    const b = findings({ expiryDate: '31/02/2026', omitPanels: ['Mycotoxins'] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('deriveCoaFindings — unsupported documents', () => {
  it('short-circuits to a single finding and evaluates no content rules', () => {
    const extraction = extractTnrCoa({
      pages: ['not a COA', 'page two', 'page three'],
      documentFingerprint: FINGERPRINT_A,
      extractedAt: '2026-07-27T00:00:00.000Z',
    })
    const result = deriveCoaFindings({ extraction, knownDocuments: [] })
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('unsupported_document')
    expect(result[0].detail).toMatch(/issuer name absent/i)
  })
})

describe('deriveCoaFindings — missing identifiers', () => {
  it('reports an absent report number', () => {
    // Removing the report-number line also removes the anchor for the two
    // header dates, so those are reported missing too — which is correct.
    const extraction = extractTnrCoa({
      pages: makeTnrPages().map((p) => p.replace(/^RP-\S+$/m, '')),
      documentFingerprint: FINGERPRINT_A,
      extractedAt: '2026-07-27T00:00:00.000Z',
    })
    const result = deriveCoaFindings({ extraction, knownDocuments: [] })
    const missing = result.filter((f) => f.code === 'missing_identifier')
    expect(missing.map((f) => f.fieldKey)).toContain('report_number')
    expect(missing.every((f) => f.severity === 'high')).toBe(true)
  })

  it('does not report optional fields the laboratory marked N/A', () => {
    // Material Batch No. is printed "N/A" in the fixture and is not required.
    expect(findings().filter((f) => f.fieldKey === 'material_batch_number')).toEqual([])
  })
})

describe('deriveCoaFindings — dates', () => {
  it('reports an impossible calendar date', () => {
    const result = findings({ expiryDate: '31/02/2026' })
    const malformed = result.find((f) => f.code === 'malformed_date')
    expect(malformed).toBeDefined()
    expect(malformed?.fieldKey).toBe('expiry_date')
    expect(malformed?.detail).toContain('31/02/2026')
    expect(malformed?.pageNumber).toBe(1)
  })

  it('reports an expiry date that precedes manufacture', () => {
    const result = findings({ manufacturingDate: '20/12/2026', expiryDate: '20/12/2025' })
    const order = result.find((f) => f.code === 'implausible_date_order')
    expect(order).toBeDefined()
    expect(order?.detail).toMatch(/expiry date is not after the manufacturing date/i)
  })

  it('reports testing end before testing start', () => {
    const result = findings({ testingStart: '27/02/2026', testingEnd: '17/02/2026' })
    expect(result.some((f) => f.code === 'implausible_date_order')).toBe(true)
  })

  it('reports a report date preceding sample receipt', () => {
    const result = findings({ receivedDate: '27/02/2026', reportedOn: '11/02/2026' })
    expect(result.some((f) => f.code === 'implausible_date_order')).toBe(true)
  })

  it('does not raise an ordering finding when a date is unreadable', () => {
    // A malformed date cannot be compared; it is reported once, as malformed.
    const result = findings({ expiryDate: '31/02/2026' })
    expect(result.some((f) => f.code === 'implausible_date_order')).toBe(false)
  })
})

describe('deriveCoaFindings — panels', () => {
  it('reports an omitted panel', () => {
    const result = findings({ omitPanels: ['Pesticides'] })
    const missing = result.find((f) => f.code === 'missing_panel')
    expect(missing?.panelKey).toBe('pesticides')
    expect(missing?.severity).toBe('high')
  })

  it('reports each omitted panel separately', () => {
    const result = findings({ omitPanels: ['Pesticides', 'Mycotoxins', 'Terpenes'] })
    const panels = result.filter((f) => f.code === 'missing_panel').map((f) => f.panelKey)
    expect(panels).toHaveLength(3)
    expect(panels).toEqual(expect.arrayContaining(['pesticides', 'mycotoxins', 'terpenes']))
  })
})

describe('deriveCoaFindings — reported failures and malformed values', () => {
  it('escalates an explicit laboratory failure to critical', () => {
    const result = findings({ extraRows: ['Total Yeast N/A Fail CFU/g N/A'] })
    const failure = result.find((f) => f.code === 'reported_failure')
    expect(failure).toBeDefined()
    expect(failure?.severity).toBe('critical')
    expect(failure?.pageNumber).toBe(1)
  })

  it('reports an unreadable result value', () => {
    const result = findings({ extraRows: ['Weird analyte N/A 12.4.5.6 %w/w N/A'] })
    const malformed = result.find((f) => f.code === 'malformed_value')
    expect(malformed).toBeDefined()
    expect(malformed?.detail).toContain('12.4.5.6')
  })

  it('reports a field that was located but could not be read', () => {
    // A non-date field present with an unparseable total.
    const extraction = extract()
    const withUnreadable: TnrCoaExtraction = {
      ...extraction,
      fields: extraction.fields.map((f) =>
        f.key === 'total_thc'
          ? { ...f, status: 'unreadable' as const, normalizedValue: null, warnings: ['non-numeric result'] }
          : f,
      ),
    }
    const result = deriveCoaFindings({ extraction: withUnreadable, knownDocuments: [] })
    const malformed = result.find((f) => f.code === 'malformed_value' && f.fieldKey === 'total_thc')
    expect(malformed).toBeDefined()
  })
})

describe('deriveCoaFindings — duplicate detection', () => {
  const known: KnownCoaDocument[] = [
    { coaDocumentId: 'coa-001', documentFingerprint: FINGERPRINT_A, reportNumber: 'RP-E2602-0196' },
  ]

  it('detects the identical document by fingerprint', () => {
    const result = findings({}, known)
    const duplicate = result.find((f) => f.code === 'duplicate_document')
    expect(duplicate).toBeDefined()
    expect(duplicate?.detail).toContain('coa-001')
  })

  it('detects a reused report number carried by different bytes', () => {
    const extraction = extract({}, FINGERPRINT_B)
    const result = deriveCoaFindings({ extraction, knownDocuments: known })
    const reuse = result.find((f) => f.code === 'duplicate_report_number')
    expect(reuse).toBeDefined()
    expect(reuse?.severity).toBe('critical')
    expect(reuse?.fieldKey).toBe('report_number')
  })

  it('does not flag a genuinely new document', () => {
    const extraction = extract({ reportNumber: 'RP-E2602-9999' }, FINGERPRINT_B)
    const result = deriveCoaFindings({ extraction, knownDocuments: known })
    expect(result.filter((f) => f.code.startsWith('duplicate'))).toEqual([])
  })

  it('reports a duplicate exactly once per known document', () => {
    const result = findings({}, [...known, ...known])
    expect(result.filter((f) => f.code === 'duplicate_document')).toHaveLength(2)
    // …but the fingerprints collide, so merging collapses them — which is what
    // makes an idempotent retry safe.
    expect(mergeCoaFindings([], result).filter((f) => f.code === 'duplicate_document')).toHaveLength(1)
  })
})

describe('deriveCoaFindings — ordering and merging', () => {
  it('sorts the most severe findings first', () => {
    const result = findings(
      { omitPanels: ['Pesticides'], extraRows: ['Total Yeast N/A Fail CFU/g N/A'] },
      [{ coaDocumentId: 'coa-001', documentFingerprint: FINGERPRINT_A, reportNumber: null }],
    )
    const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const
    const ranks = result.map((f) => rank[f.severity])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('merges by fingerprint so re-running does not duplicate findings', () => {
    const first = findings({ omitPanels: ['Pesticides'] })
    const second = findings({ omitPanels: ['Pesticides'] })
    expect(mergeCoaFindings(first, second)).toHaveLength(first.length)
  })

  it('adds genuinely new findings on merge', () => {
    const first = findings({ omitPanels: ['Pesticides'] })
    const second = findings({ omitPanels: ['Pesticides', 'Mycotoxins'] })
    expect(mergeCoaFindings(first, second).length).toBeGreaterThan(first.length)
  })

  it('never emits a compliance conclusion in a finding', () => {
    const result = findings({
      omitPanels: ['Pesticides'],
      extraRows: ['Total Yeast N/A Fail CFU/g N/A'],
      expiryDate: '31/02/2026',
    })
    expect(result.length).toBeGreaterThan(0)
    for (const finding of result) {
      const text = `${finding.title} ${finding.detail}`.toLowerCase()
      expect(text).not.toMatch(/\b(is compliant|non-compliant|approved|rejected|safe to sell|passes|legal)\b/)
    }
  })

  it('cites a page for every finding that refers to document content', () => {
    const result = findings({ expiryDate: '31/02/2026', extraRows: ['Weird analyte N/A 12.4.5.6 %w/w N/A'] })
    const contentFindings = result.filter((f) => f.code === 'malformed_date' || f.code === 'malformed_value')
    expect(contentFindings.length).toBeGreaterThan(0)
    for (const finding of contentFindings) {
      expect(finding.pageNumber).toBeGreaterThanOrEqual(1)
    }
  })
})

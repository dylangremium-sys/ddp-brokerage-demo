// Unit tests for the TNR three-page COA adapter.
//
// These run on SYNTHETIC fixture text that reproduces the form's layout. The
// supplied COAs are private project evidence and are never committed, so no
// test here depends on them; the real documents are exercised separately by
// coaRealPdf.integration.test.ts, which is gated behind DDP_COA_PDF_PATH.
//
// Every fixture value is a parameter, and several tests deliberately vary them,
// which is what demonstrates the adapter reads the document rather than
// recognising a particular report.

import { describe, it, expect } from 'vitest'
import {
  extractTnrCoa,
  checkTnrFormat,
  normalizeThaiDate,
  fieldByKey,
  TNR_PARSER_VERSION,
  TNR_FORMAT_ID,
} from './coaTnrAdapter'

import { makeTnrPages, type FixtureOptions } from './__fixtures__/tnrCoaFixture'

function extract(options: FixtureOptions = {}) {
  return extractTnrCoa({
    pages: makeTnrPages(options),
    documentFingerprint: 'f'.repeat(64),
    extractedAt: '2026-07-27T00:00:00.000Z',
  })
}

describe('checkTnrFormat', () => {
  it('accepts the three-page TNR layout', () => {
    expect(checkTnrFormat(makeTnrPages())).toBeNull()
  })

  it('rejects a document with no text layer', () => {
    expect(checkTnrFormat(['', '', ''])).toMatch(/no text layer/i)
  })

  it('rejects an empty document', () => {
    expect(checkTnrFormat([])).toMatch(/no extractable text/i)
  })

  it('rejects a report from a different laboratory', () => {
    expect(checkTnrFormat(makeTnrPages({ issuer: 'SOME OTHER LAB LIMITED' }))).toMatch(/issuer name absent/i)
  })

  it('rejects an unexpected form code', () => {
    expect(checkTnrFormat(makeTnrPages({ documentCode: 'XX-QC-FM-01' }))).toMatch(/unexpected form code/i)
  })

  it('rejects a document with the wrong page count', () => {
    const pages = makeTnrPages()
    expect(checkTnrFormat([pages[0], pages[1]])).toMatch(/expected a 3-page report, received 2/i)
  })
})

describe('normalizeThaiDate', () => {
  it('converts DD/MM/YYYY to ISO', () => {
    expect(normalizeThaiDate('20/12/2025')).toEqual({ iso: '2025-12-20', valid: true, reason: null })
  })

  it('pads single-digit days and months', () => {
    expect(normalizeThaiDate('1/2/2026').iso).toBe('2026-02-01')
  })

  it.each([
    ['31/02/2026', /impossible calendar date/i],
    ['30/02/2026', /impossible calendar date/i],
    ['01/13/2026', /impossible month/i],
    ['00/01/2026', /impossible day/i],
    ['2026-02-01', /not DD\/MM\/YYYY/i],
    ['not a date', /not DD\/MM\/YYYY/i],
  ])('rejects %s', (input, expected) => {
    const result = normalizeThaiDate(input)
    expect(result.valid).toBe(false)
    expect(result.iso).toBeNull()
    expect(result.reason).toMatch(expected)
  })
})

describe('extractTnrCoa — field extraction', () => {
  it('records the parser version and format', () => {
    const result = extract()
    expect(result.parserVersion).toBe(TNR_PARSER_VERSION)
    expect(result.format).toBe(TNR_FORMAT_ID)
    expect(result.supported).toBe(true)
    expect(result.documentFingerprint).toBe('f'.repeat(64))
    expect(result.extractedAt).toBe('2026-07-27T00:00:00.000Z')
  })

  it('reads identifiers from the document, not from a fixed table', () => {
    const a = extract({ reportNumber: 'RP-E2602-0196', batchNumber: 'F4-122025', sampleName: 'Mango' })
    const b = extract({ reportNumber: 'RP-Z9901-0002', batchNumber: 'Q1-010199', sampleName: 'Другой' })

    expect(fieldByKey(a, 'report_number')?.normalizedValue).toBe('RP-E2602-0196')
    expect(fieldByKey(a, 'batch_number')?.normalizedValue).toBe('F4-122025')
    expect(fieldByKey(a, 'sample_name')?.normalizedValue).toBe('Mango')

    expect(fieldByKey(b, 'report_number')?.normalizedValue).toBe('RP-Z9901-0002')
    expect(fieldByKey(b, 'batch_number')?.normalizedValue).toBe('Q1-010199')
    expect(fieldByKey(b, 'sample_name')?.normalizedValue).toBe('Другой')
  })

  it('gives every extracted field a PDF page number', () => {
    const result = extract()
    const extracted = result.fields.filter((f) => f.status === 'extracted')
    expect(extracted.length).toBeGreaterThan(8)
    for (const field of extracted) {
      expect(field.pageNumber, `${field.key} must cite a page`).toBeGreaterThanOrEqual(1)
      expect(field.pageNumber).toBeLessThanOrEqual(3)
    }
  })

  it('keeps the raw value alongside the normalized one', () => {
    const reported = fieldByKey(extract({ reportedOn: '27/02/2026' }), 'reported_on')
    expect(reported?.rawValue).toBe('27/02/2026')
    expect(reported?.normalizedValue).toBe('2026-02-27')
  })

  it('marks a laboratory-supplied N/A as missing rather than inventing a value', () => {
    const field = fieldByKey(extract(), 'material_batch_number')
    expect(field?.status).toBe('missing')
    expect(field?.rawValue).toBe('N/A')
    expect(field?.normalizedValue).toBeNull()
    expect(field?.warnings.join(' ')).toMatch(/N\/A/i)
  })

  it('flags a malformed date as unreadable instead of guessing', () => {
    const field = fieldByKey(extract({ expiryDate: '31/02/2026' }), 'expiry_date')
    expect(field?.status).toBe('unreadable')
    expect(field?.rawValue).toBe('31/02/2026')
    expect(field?.normalizedValue).toBeNull()
    expect(field?.warnings.join(' ')).toMatch(/malformed date/i)
  })

  it('does not confuse "Batch No." with "Material Batch No."', () => {
    const result = extract({ batchNumber: 'F4-122025' })
    expect(fieldByKey(result, 'batch_number')?.normalizedValue).toBe('F4-122025')
    expect(fieldByKey(result, 'material_batch_number')?.rawValue).toBe('N/A')
  })

  it('reads total cannabinoids with their unit from the results table', () => {
    const result = extract({ totalThc: '19.49', totalCbd: '0.09' })
    expect(fieldByKey(result, 'total_thc')?.normalizedValue).toBe('19.49 %w/w')
    expect(fieldByKey(result, 'total_cbd')?.normalizedValue).toBe('0.09 %w/w')
    expect(fieldByKey(result, 'total_thc')?.pageNumber).toBe(1)
  })

  it('captures the wrapped customer address block', () => {
    const customer = fieldByKey(extract(), 'customer_name')
    expect(customer?.normalizedValue).toContain('Calli Krush')
    expect(customer?.normalizedValue).toContain('Buriram Province 31110')
    expect(customer?.normalizedValue).not.toContain('Detail of Sample')
  })

  it('returns an unsupported result, with no fields, for a foreign document', () => {
    const result = extractTnrCoa({
      pages: ['Some other document', 'page two', 'page three'],
      documentFingerprint: 'a'.repeat(64),
      extractedAt: '2026-07-27T00:00:00.000Z',
    })
    expect(result.supported).toBe(false)
    expect(result.unsupportedReason).toMatch(/issuer name absent/i)
    expect(result.fields).toEqual([])
    expect(result.analytes).toEqual([])
    expect(result.panels.every((p) => !p.present)).toBe(true)
  })
})

describe('extractTnrCoa — panels and analytes', () => {
  it('finds all nine panels and the pages they appear on', () => {
    const result = extract()
    expect(result.panels.filter((p) => !p.present)).toEqual([])
    const byKey = Object.fromEntries(result.panels.map((p) => [p.key, p.pageNumber]))
    expect(byKey.cannabinoid_groups).toBe(1)
    expect(byKey.heavy_metal).toBe(2)
    expect(byKey.specified_microorganisms).toBe(3)
  })

  it('reports a panel the laboratory omitted as absent', () => {
    const result = extract({ omitPanels: ['Mycotoxins'] })
    const mycotoxins = result.panels.find((p) => p.key === 'mycotoxins')
    expect(mycotoxins?.present).toBe(false)
    expect(mycotoxins?.pageNumber).toBeNull()
    expect(mycotoxins?.rowCount).toBe(0)
  })

  it('parses numeric, not-detected, below-limit and qualitative results', () => {
    const analytes = extract().analytes
    const find = (name: string) => analytes.find((a) => a.name === name)

    expect(find('Arsenic (As)')).toMatchObject({ resultKind: 'numeric', numericResult: 0.01, unit: 'ppm', pageNumber: 2 })
    expect(find('Aflatoxin B1')).toMatchObject({ resultKind: 'not_detected', unit: 'µg/kg', pageNumber: 2 })
    expect(find('Total Aerobic Microbial Count (TAMC)')).toMatchObject({ resultKind: 'below_limit', rawResult: '< 10', unit: 'CFU/g' })
    expect(find('Appearance')).toMatchObject({ resultKind: 'qualitative', rawResult: 'Dried cannabis flowers' })
  })

  it('reads multi-token microbiology units', () => {
    const analytes = extract().analytes
    expect(analytes.find((a) => a.name === 'Staphylococcus aureus')).toMatchObject({
      rawResult: 'Absent', unit: 'per 1 g', pageNumber: 3,
    })
    expect(analytes.find((a) => a.name === 'Salmonella spp.')).toMatchObject({
      rawResult: 'Absent', unit: 'per 25 g',
    })
  })

  it('attributes a row the form wrapped across three lines', () => {
    const identification = extract().analytes.filter((a) => a.panelKey === 'identification')
    expect(identification).toHaveLength(1)
    expect(identification[0].name).toContain('Macroscopic examination')
    expect(identification[0].name).toContain('with stigmas')
    expect(identification[0].rawResult).toBe('Conforms')
  })

  it('does not treat running headers or footers as results', () => {
    const names = extract().analytes.map((a) => a.name)
    expect(names.some((n) => n.startsWith('Document Code:'))).toBe(false)
    expect(names.some((n) => n.startsWith('Specification'))).toBe(false)
    expect(names).not.toContain('LABORATORY TEST REPORT')
  })

  it('flags an unparseable result as malformed rather than accepting it', () => {
    const result = extract({ extraRows: ['Weird analyte N/A 12.4.5.6 %w/w N/A'] })
    const weird = result.analytes.find((a) => a.name === 'Weird analyte')
    expect(weird?.resultKind).toBe('malformed')
  })

  it('is deterministic — identical input yields identical output', () => {
    expect(JSON.stringify(extract())).toBe(JSON.stringify(extract()))
  })
})

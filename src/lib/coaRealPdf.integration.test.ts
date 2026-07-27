// ─── Real-COA integration check (Gate P0 — issue #77) ───────────────────────
//
// Runs the FULL server pipeline — real PDF bytes -> unpdf -> TNR adapter ->
// deterministic findings — against a supplied COA on the operator's machine.
//
// It is skipped unless DDP_COA_PDF_PATH points at a real COA, because the
// supplied COAs are private project evidence and are never committed to Git.
// The assertions below are all STRUCTURAL: they check that fields were read,
// carry a page number, and normalise correctly. No potency figure, report
// number, batch code or date from any particular document is asserted, so this
// file hard-codes no acceptance value and reveals no evidence content.
//
//   DDP_COA_PDF_PATH="/path/to/COA.pdf" npm test -- coaRealPdf

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { extractPdfPages } from './serverCoaPdf'
import { unpdfTextExtractor } from './unpdfExtractor'
import { extractTnrCoa, fieldByKey } from './coaTnrAdapter'
import { deriveCoaFindings } from './coaFindings'

const pdfPath = process.env.DDP_COA_PDF_PATH

describe.skipIf(!pdfPath)('real supplied TNR COA — end-to-end extraction', () => {
  it('extracts identified fields with page provenance from actual PDF bytes', async () => {
    const bytes = new Uint8Array(await readFile(pdfPath as string))

    const pdf = await extractPdfPages(bytes, unpdfTextExtractor)
    expect(pdf.status).toBe('ok')
    expect(pdf.documentFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(pdf.pageCount).toBe(3)
    expect(pdf.pages).toHaveLength(3)

    const extraction = extractTnrCoa({
      pages: pdf.pages,
      documentFingerprint: pdf.documentFingerprint as string,
      extractedAt: new Date().toISOString(),
    })

    expect(extraction.supported).toBe(true)
    expect(extraction.unsupportedReason).toBeNull()

    // Core identifiers must all be readable from a genuine report.
    for (const key of ['report_number', 'batch_number', 'sample_number', 'sample_name'] as const) {
      const field = fieldByKey(extraction, key)
      expect(field, `field ${key} should exist`).not.toBeNull()
      expect(field?.status, `field ${key} should be extracted`).toBe('extracted')
      expect(field?.rawValue, `field ${key} should have a raw value`).toBeTruthy()
      expect(field?.pageNumber, `field ${key} must cite a page`).toBeGreaterThanOrEqual(1)
      expect(field?.pageNumber).toBeLessThanOrEqual(3)
    }

    // Every successfully extracted field must cite the page it came from —
    // this is the gate's "every displayed extracted value identifies its page".
    for (const field of extraction.fields) {
      if (field.status === 'extracted') {
        expect(field.pageNumber, `${field.key} must cite a page`).toBeGreaterThanOrEqual(1)
      }
    }

    // Dates must normalise to ISO.
    for (const key of ['reported_on', 'manufacturing_date', 'expiry_date'] as const) {
      const field = fieldByKey(extraction, key)
      if (field?.status === 'extracted') {
        expect(field.normalizedValue).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }

    // All nine expected panels are present, and they span all three pages.
    const missingPanels = extraction.panels.filter((p) => !p.present)
    expect(missingPanels.map((p) => p.key)).toEqual([])
    const panelPages = new Set(extraction.panels.map((p) => p.pageNumber))
    expect(panelPages).toContain(1)
    expect(panelPages).toContain(2)
    expect(panelPages).toContain(3)

    // Real analyte rows were parsed, and they are not all from one page.
    expect(extraction.analytes.length).toBeGreaterThan(50)
    expect(new Set(extraction.analytes.map((a) => a.pageNumber)).size).toBe(3)

    // A genuine, complete report produces no missing-identifier or
    // malformed-date findings.
    const findings = deriveCoaFindings({ extraction, knownDocuments: [] })
    const blocking = findings.filter(
      (f) => f.code === 'missing_identifier' || f.code === 'malformed_date' || f.code === 'missing_panel',
    )
    expect(blocking, `unexpected findings: ${JSON.stringify(blocking)}`).toEqual([])
  }, 30_000)
})

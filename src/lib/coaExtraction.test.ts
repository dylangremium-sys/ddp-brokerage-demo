import { describe, it, expect } from 'vitest'
import {
  COA_FIELD_NAMES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  MEASUREMENT_ONLY_FIELDS,
  buildExtractions,
  crossCheckAgainstFilename,
  parseCoaDate,
  toExtractionRow,
  acceptableFields,
  needsReview,
} from './coaExtraction'

// ─── Built from REAL documents, not invented fixtures ────────────────────────
//
// Every value below was read out of two genuine TNR Bioscience reports for
// Calli Krush Co.,LTD on 2026-08-03: a 15-page pack of five COAs, and a
// single-report PDF of RP-E2602-0197. Extraction of the shared report was
// identical from both, which is why these numbers can be asserted literally.
//
// Using the real ones matters. An invented COA would have a Specification column
// with limits in it, and the whole "the document contains no verdict" finding —
// the one that reshaped this design — would never have surfaced.

/** Red Dragon, RP-E2602-0197, as the laboratory printed it. */
const RED_DRAGON = [
  { field_name: 'laboratory_name', value: 'TNR BIOSCIENCE COMPANY LIMITED', confidence: 0.99 },
  { field_name: 'report_number', value: 'RP-E2602-0197', confidence: 0.99 },
  { field_name: 'sample_name', value: 'Red Dragon', confidence: 0.98 },
  { field_name: 'sample_id', value: 'EX26-0191', confidence: 0.99 },
  { field_name: 'batch_reference', value: 'E2-1012125', confidence: 0.97 },
  { field_name: 'received_date', value: '11/02/2026', confidence: 0.96 },
  { field_name: 'total_thc', value: '21.31', confidence: 0.99 },
  { field_name: 'total_cbd', value: '0.09', confidence: 0.98 },
  { field_name: 'moisture_pct', value: '12.05', confidence: 0.97 },
  { field_name: 'heavy_metals_result', value: 'As 0.01, Cd 0.02, Hg ND, Pb 0.03 ppm', confidence: 0.93 },
  { field_name: 'microbial_result', value: 'TAMC 20, TYMC 20 CFU/g; pathogens absent', confidence: 0.9 },
  // Genuinely absent from this laboratory's panel — see the assertions below.
  { field_name: 'water_activity', value: null, confidence: null, note: 'not in this panel; lab reports loss on drying' },
  { field_name: 'residual_solvents_result', value: null, confidence: null, note: 'not tested' },
  { field_name: 'accreditation_reference', value: null, confidence: null, note: 'no ISO 17025 reference on the report' },
]

const FILENAME = '602918346421698884_RP-E2602-0197_EX26-0191_Calli Krush Co.,LTD (1).pdf'

describe('the field vocabulary matches the database', () => {
  it('has exactly the 19 names migration 28 permits', () => {
    // A CHECK constraint enforces this list, so a name outside it is rejected by
    // Postgres at insert time. Measured against production 2026-08-03.
    expect(COA_FIELD_NAMES).toHaveLength(19)
    expect(COA_FIELD_NAMES).toContain('total_thc')
    expect(COA_FIELD_NAMES).toContain('water_activity')
    expect(COA_FIELD_NAMES).toContain('accreditation_reference')
  })

  it('drops a field the database would reject rather than passing it through', () => {
    expect(toExtractionRow({ field_name: 'total_terpenes', value: '1.16', confidence: 0.9 })).toBeNull()
  })
})

describe('confidence is mandatory for a machine reading', () => {
  it('accepts a value at or above the threshold', () => {
    const row = toExtractionRow({ field_name: 'total_thc', value: '21.31', confidence: 0.99 })!
    expect(row.field_value_text).toBe('21.31')
    expect(row.provenance).toBe('machine_extracted')
    expect(row.offerForAcceptance).toBe(true)
    expect(row.extraction_warning).toBeNull()
  })

  it('records a below-threshold value but does NOT offer it', () => {
    // The whole point of the threshold: a 30%-confident THC figure shown as fact
    // is worse than admitting it could not be read.
    const row = toExtractionRow({ field_name: 'total_thc', value: '21.31', confidence: 0.3 })!
    expect(row.field_value_text).toBe('21.31')
    expect(row.offerForAcceptance).toBe(false)
    expect(row.extraction_warning).toMatch(/low confidence/)
  })

  it('treats the threshold as inclusive', () => {
    const row = toExtractionRow({ field_name: 'total_cbd', value: '0.09', confidence: DEFAULT_CONFIDENCE_THRESHOLD })!
    expect(row.offerForAcceptance).toBe(true)
  })

  it('refuses a confidence outside [0,1] instead of treating it as high', () => {
    // A broken reply, not a confident one. Passing 1.5 through would smuggle an
    // unvalidated reading past the threshold.
    for (const bad of [1.5, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const row = toExtractionRow({ field_name: 'total_thc', value: '21.31', confidence: bad })!
      expect(row.offerForAcceptance).toBe(false)
      expect(row.field_value_text).toBeNull()
      expect(row.extraction_warning).toMatch(/no usable confidence/)
    }
  })
})

describe('an absent field is recorded, never silent', () => {
  it('produces a row with a warning when nothing was found', () => {
    // migration 28: CHECK (field_value_text IS NOT NULL OR extraction_warning IS NOT NULL).
    // "Not found" must be evidence, not absence of evidence.
    const row = toExtractionRow({ field_name: 'water_activity', value: null, confidence: null, note: 'not in this panel' })!
    expect(row.field_value_text).toBeNull()
    expect(row.extraction_warning).toBe('not in this panel')
    expect(row.offerForAcceptance).toBe(false)
  })

  it('every row satisfies the value-or-warning constraint', () => {
    const [ex] = buildExtractions([{ report_number: 'RP-E2602-0197', fields: RED_DRAGON }])
    for (const row of ex.rows) {
      expect(row.field_value_text !== null || row.extraction_warning !== null).toBe(true)
    }
  })
})

describe('dates are DD/MM/YYYY — the laboratory writes them that way', () => {
  it('reads 11/02/2026 as 11 February, not 2 November', () => {
    // The failure this prevents parses cleanly and is wrong by nine months.
    expect(parseCoaDate('11/02/2026')).toBe('2026-02-11')
    expect(parseCoaDate('20/12/2025')).toBe('2025-12-20')
  })

  it('returns null rather than guessing at anything else', () => {
    for (const bad of ['2026-02-11', 'Feb 11 2026', '31/02/2026', '', '11/13/2026']) {
      expect(parseCoaDate(bad)).toBeNull()
    }
  })
})

describe('the filename is a free cross-check', () => {
  it('is silent when the extraction agrees with the file name', () => {
    expect(crossCheckAgainstFilename(FILENAME, { reportNumber: 'RP-E2602-0197', sampleId: 'EX26-0191' })).toEqual([])
  })

  it('flags a report number that does not appear in the file name', () => {
    // Catches both a mis-read AND a document filed against the wrong batch.
    const w = crossCheckAgainstFilename(FILENAME, { reportNumber: 'RP-E2602-0192', sampleId: 'EX26-0191' })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/RP-E2602-0192/)
  })

  it('does not invent a warning when there is no file name to check', () => {
    const [ex] = buildExtractions([{ report_number: 'RP-E2602-0197', fields: RED_DRAGON }])
    expect(ex.crossCheckWarnings).toEqual([])
  })
})

describe('one PDF may hold several COAs', () => {
  it('keeps each report separate', () => {
    // The real pack held five. Merging them would attach one sample's numbers to
    // another's batch, and the schema could not detect it.
    const packs = buildExtractions([
      { report_number: 'RP-E2602-0196', fields: [{ field_name: 'total_thc', value: '26.86', confidence: 0.99 }] },
      { report_number: 'RP-E2602-0197', fields: [{ field_name: 'total_thc', value: '21.31', confidence: 0.99 }] },
    ])
    expect(packs).toHaveLength(2)
    expect(packs[0].rows[0].field_value_text).toBe('26.86')
    expect(packs[1].rows[0].field_value_text).toBe('21.31')
  })
})

describe('the real Red Dragon report, end to end', () => {
  const [ex] = buildExtractions([{ report_number: 'RP-E2602-0197', fields: RED_DRAGON }], { fileName: FILENAME })

  it('offers the readable fields and holds back the absent ones', () => {
    const ok = acceptableFields(ex).map((r) => r.field_name)
    const review = needsReview(ex).map((r) => r.field_name)

    expect(ok).toContain('total_thc')
    expect(ok).toContain('report_number')
    expect(ok).toContain('heavy_metals_result')

    // The three this laboratory does not test for. They must appear as needing
    // review, not vanish.
    expect(review).toContain('water_activity')
    expect(review).toContain('residual_solvents_result')
    expect(review).toContain('accreditation_reference')
  })

  it('carries the measured values through unchanged', () => {
    const byName = Object.fromEntries(ex.rows.map((r) => [r.field_name, r.field_value_text]))
    expect(byName.total_thc).toBe('21.31')
    expect(byName.total_cbd).toBe('0.09')
    expect(byName.moisture_pct).toBe('12.05')
    expect(byName.batch_reference).toBe('E2-1012125')
  })

  it('records contaminant panels as MEASUREMENTS, never as a verdict', () => {
    // Every Specification column on the real COAs reads N/A: the laboratory
    // states no limits, so the document contains no pass or fail. A verdict has
    // to come from DDP's own destination_rulesets (migration 41), not from here.
    const hm = ex.rows.find((r) => r.field_name === 'heavy_metals_result')!
    expect(hm.field_value_text).toBe('As 0.01, Cd 0.02, Hg ND, Pb 0.03 ppm')
    expect(hm.field_value_text).not.toMatch(/\b(pass|fail|compliant)\b/i)

    for (const f of MEASUREMENT_ONLY_FIELDS) {
      const row = ex.rows.find((r) => r.field_name === f)
      if (row?.field_value_text) {
        expect(row.field_value_text).not.toMatch(/\b(pass|fail|compliant)\b/i)
      }
    }
  })

  it('agrees with the file name', () => {
    expect(ex.crossCheckWarnings).toEqual([])
  })
})

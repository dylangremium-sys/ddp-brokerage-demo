import { describe, expect, it } from 'vitest'
import { isPresentableAsFields, reconcileDocument, reconcileReport } from './coaReconcile'
import type { RawReportWithCannabinoids } from './coaReconcile'
import { TNR_BIOSCIENCE_2026 } from './coaLabProfiles'

/** Report RP-E2602-0197, "Red Dragon", as actually printed. */
function realReport(overrides: Partial<RawReportWithCannabinoids> = {}): RawReportWithCannabinoids {
  return {
    report_number: 'RP-E2602-0197',
    fields: [
      { field_name: 'report_number', value: 'RP-E2602-0197', confidence: 0.99 },
      { field_name: 'sample_id', value: 'EX26-0191', confidence: 0.98 },
      { field_name: 'sample_name', value: 'Red Dragon', confidence: 0.97 },
      { field_name: 'batch_reference', value: 'E2-1012125', confidence: 0.96 },
      { field_name: 'received_date', value: '11/02/2026', confidence: 0.95 },
      { field_name: 'test_date', value: '17/02/2026', confidence: 0.95 },
      { field_name: 'total_thc', value: '21.31', confidence: 0.97 },
      { field_name: 'total_cbd', value: '0.09', confidence: 0.97 },
      { field_name: 'moisture_pct', value: '12.05', confidence: 0.94 },
    ],
    cannabinoids: { delta9ThcPct: 0.9, thcaPct: 23.27, statedTotalThcPct: 21.31 },
    ...overrides,
  }
}

describe('a report that holds together', () => {
  it('selects the right profile and raises nothing', () => {
    const report = reconcileReport(realReport())
    expect(report.profileId).toBe('tnr-bioscience-2026')
    expect(report.totalThcCheck?.verdict).toBe('consistent')
    expect(report.integrityWarnings).toEqual([])
  })

  it('is presentable as fields, which is the whole point of extracting it', () => {
    expect(isPresentableAsFields(reconcileReport(realReport()))).toBe(true)
  })

  it('still offers the total for acceptance', () => {
    const total = reconcileReport(realReport()).rows.find((r) => r.field_name === 'total_thc')
    expect(total?.offerForAcceptance).toBe(true)
  })
})

describe('the refusal', () => {
  /**
   * The measured page-13 mis-parse. The model is CONFIDENT — 0.97 — and it is
   * confidently wrong, because a confidence is a statement about the model's own
   * certainty, not about whether the value landed against the right label.
   */
  it('withdraws a high-confidence total when it contradicts its own components', () => {
    const report = reconcileReport(
      realReport({
        cannabinoids: { delta9ThcPct: 0.92, thcaPct: 0.05, statedTotalThcPct: 26.4 },
        fields: [
          ...realReport().fields.filter((f) => f.field_name !== 'total_thc'),
          { field_name: 'total_thc', value: '26.40', confidence: 0.97 },
        ],
      }),
    )

    const total = report.rows.find((r) => r.field_name === 'total_thc')
    expect(report.totalThcCheck?.verdict).toBe('inconsistent')
    expect(total?.confidence).toBe(0.97)
    expect(total?.offerForAcceptance).toBe(false)
    expect(total?.extraction_warning).toMatch(/disagrees with its components/)
    expect(isPresentableAsFields(report)).toBe(false)
  })

  it('refuses the whole report when the dates cannot have happened in that order', () => {
    const report = reconcileReport(
      realReport({
        fields: [
          ...realReport().fields.filter((f) => f.field_name !== 'received_date'),
          // 2 November — what reading 11/02/2026 as MM/DD would produce.
          { field_name: 'received_date', value: '02/11/2026', confidence: 0.95 },
        ],
      }),
    )
    expect(report.integrityWarnings.join(' ')).toMatch(/is before sample received date/)
    expect(isPresentableAsFields(report)).toBe(false)
  })

  it('refuses a report whose number matches no known laboratory template', () => {
    const report = reconcileReport(realReport({ report_number: 'CoA-2027-001' }))
    expect(report.profileId).toBeNull()
    expect(report.integrityWarnings.join(' ')).toMatch(/no laboratory profile matches/)
    expect(isPresentableAsFields(report)).toBe(false)
  })

  it('refuses a report with no number at all', () => {
    const report = reconcileReport(realReport({ report_number: null }))
    expect(report.profileId).toBeNull()
    expect(report.integrityWarnings.join(' ')).toMatch(/no report number was read/)
  })

  it('adds no absent-field rows when no profile matched — it does not know the panel', () => {
    const report = reconcileReport(realReport({ report_number: 'CoA-2027-001' }))
    expect(report.rows.some((r) => r.field_name === 'water_activity')).toBe(false)
  })
})

describe('fields this laboratory does not measure', () => {
  it('records them as warnings, never as blanks', () => {
    const rows = reconcileReport(realReport()).rows
    for (const field of TNR_BIOSCIENCE_2026.fieldsNotInPanel) {
      const row = rows.find((r) => r.field_name === field)
      expect(row, `expected a row for ${field}`).toBeDefined()
      expect(row?.field_value_text).toBeNull()
      expect(row?.extraction_warning).toMatch(/does not report/)
      expect(row?.offerForAcceptance).toBe(false)
    }
  })

  /**
   * Migration 28: CHECK (field_value_text IS NOT NULL OR extraction_warning IS
   * NOT NULL). A row satisfying neither is rejected by the database, so a row
   * that would be rejected is a bug here rather than there.
   */
  it('every row satisfies the database’s value-or-warning constraint', () => {
    for (const row of reconcileReport(realReport()).rows) {
      expect(row.field_value_text !== null || row.extraction_warning !== null).toBe(true)
    }
  })

  it('does not overwrite a value the laboratory has started reporting', () => {
    const report = reconcileReport(
      realReport({
        fields: [...realReport().fields, { field_name: 'water_activity', value: '0.55', confidence: 0.93 }],
      }),
    )
    const rows = report.rows.filter((r) => r.field_name === 'water_activity')
    expect(rows).toHaveLength(1)
    expect(rows[0].field_value_text).toBe('0.55')
  })
})

describe('a document holding several reports', () => {
  /**
   * One PDF may hold several certificates — the combined pack holds four across
   * five pages, one of them duplicated. Each is reconciled on its own evidence,
   * so one bad reading cannot condemn its neighbours and one good one cannot
   * vouch for them.
   */
  it('reconciles each report independently', () => {
    const reports = reconcileDocument([
      realReport(),
      realReport({
        report_number: '2025-A25080',
        cannabinoids: { delta9ThcPct: 1.57, thcaPct: 19.82, statedTotalThcPct: 18.95 },
      }),
      realReport({
        report_number: 'RP-E2602-0193',
        cannabinoids: { delta9ThcPct: 0.92, thcaPct: 0.05, statedTotalThcPct: 26.4 },
      }),
    ])

    expect(reports.map((r) => r.profileId)).toEqual([
      'tnr-bioscience-2026',
      'tnr-bioscience-2025',
      'tnr-bioscience-2026',
    ])
    expect(reports.map((r) => r.totalThcCheck?.verdict)).toEqual(['consistent', 'consistent', 'inconsistent'])
    expect(reports.map(isPresentableAsFields)).toEqual([true, true, false])
  })

  it('applies each report’s own profile, not the first one that matched', () => {
    const [, bienestar] = reconcileDocument([
      realReport(),
      realReport({
        report_number: '2025-A25080',
        cannabinoids: { delta9ThcPct: 1.57, thcaPct: 19.82, statedTotalThcPct: 18.95 },
      }),
    ])
    // The 2025 panel has no pesticide screen; the 2026 panel does.
    expect(bienestar.rows.some((r) => r.field_name === 'pesticides_result')).toBe(true)
    expect(bienestar.rows.find((r) => r.field_name === 'pesticides_result')?.extraction_warning).toMatch(
      /does not report/,
    )
  })
})

describe('a report with no total stated', () => {
  it('is not treated as suspect, but is not vouched for either', () => {
    const report = reconcileReport(
      realReport({ cannabinoids: { delta9ThcPct: 0.9, thcaPct: 23.27, statedTotalThcPct: null } }),
    )
    expect(report.totalThcCheck?.verdict).toBe('not_checkable')
    expect(report.totalThcCheck?.recomputedPct).toBeCloseTo(21.3078, 4)
    expect(isPresentableAsFields(report)).toBe(false)
  })
})

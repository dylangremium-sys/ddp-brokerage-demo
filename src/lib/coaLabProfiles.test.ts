import { describe, expect, it } from 'vitest'
import {
  LAB_PROFILES,
  TNR_BIOSCIENCE_2025,
  TNR_BIOSCIENCE_2026,
  absentFieldWarning,
  profileForReportNumber,
  statesNoLimit,
} from './coaLabProfiles'
import { COA_FIELD_NAMES } from './coaExtraction'

describe('profile selection', () => {
  it('recognises the 2026 template from a real report number', () => {
    for (const n of ['RP-E2602-0191', 'RP-E2602-0197']) {
      expect(profileForReportNumber(n)?.id).toBe('tnr-bioscience-2026')
    }
  })

  it('recognises the 2025 template from a real report number', () => {
    for (const n of ['2025-A25077', '2025-A25080']) {
      expect(profileForReportNumber(n)?.id).toBe('tnr-bioscience-2025')
    }
  })

  /**
   * The reason profiles are keyed on (laboratory, template version) rather than
   * on the laboratory alone: these are the SAME laboratory, and neither report
   * number pattern matches the other's reports.
   */
  it('the two templates are one laboratory and do not match each other', () => {
    expect(TNR_BIOSCIENCE_2026.laboratory).toBe(TNR_BIOSCIENCE_2025.laboratory)
    expect(TNR_BIOSCIENCE_2026.reportNumberPattern.test('2025-A25080')).toBe(false)
    expect(TNR_BIOSCIENCE_2025.reportNumberPattern.test('RP-E2602-0197')).toBe(false)
  })

  /**
   * A DEFAULT PROFILE IS THE BUG THIS MODULE EXISTS TO PREVENT. It would apply
   * one laboratory's date format, absent-field list and no-limit tokens to a
   * document from somewhere else — every one of them silently wrong.
   */
  it('returns null for an unknown report number rather than defaulting', () => {
    for (const n of ['CoA-2027-001', 'LAB/9912', '', '   ']) {
      expect(profileForReportNumber(n)).toBeNull()
    }
    expect(profileForReportNumber(null)).toBeNull()
    expect(profileForReportNumber(undefined)).toBeNull()
  })

  it('every profile fixes the date format and none infers it', () => {
    for (const profile of LAB_PROFILES) {
      expect(profile.dateFormat).toBe('DD/MM/YYYY')
    }
  })

  it('every profile has a distinct id', () => {
    const ids = LAB_PROFILES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('the specification column', () => {
  /**
   * The 2026 reports write `N/A`; the 2025 reports write `Nonspecific` eleven
   * times on page 11 of the pack. Both mean the laboratory stated no limit, and
   * code testing `=== 'N/A'` would read "Nonspecific" as a limit that HAD been
   * stated — an invented threshold, which is the one thing extraction must never
   * produce.
   */
  it('reads both templates’ "no limit" tokens as no limit', () => {
    expect(statesNoLimit('N/A', TNR_BIOSCIENCE_2026)).toBe(true)
    expect(statesNoLimit('Nonspecific', TNR_BIOSCIENCE_2025)).toBe(true)
    expect(statesNoLimit('N/A', TNR_BIOSCIENCE_2025)).toBe(true)
  })

  it('does not read the 2025 token as a limit under the 2026 profile', () => {
    // Not a licence to interpret it — only proof the profiles differ, which is
    // why the wrong profile must never be applied by default.
    expect(statesNoLimit('Nonspecific', TNR_BIOSCIENCE_2026)).toBe(false)
  })

  it('treats an empty cell as no limit stated', () => {
    expect(statesNoLimit('', TNR_BIOSCIENCE_2026)).toBe(true)
    expect(statesNoLimit(null, TNR_BIOSCIENCE_2026)).toBe(true)
    expect(statesNoLimit(undefined, TNR_BIOSCIENCE_2026)).toBe(true)
  })

  it('ignores case and surrounding space, which vary between reports', () => {
    expect(statesNoLimit('  n/a  ', TNR_BIOSCIENCE_2026)).toBe(true)
    expect(statesNoLimit('NONSPECIFIC', TNR_BIOSCIENCE_2025)).toBe(true)
  })

  it('an actual stated limit is not mistaken for an absent one', () => {
    expect(statesNoLimit('NMT 0.2 %w/w', TNR_BIOSCIENCE_2026)).toBe(false)
  })
})

describe('fields absent from a panel', () => {
  it('names only fields the database will accept', () => {
    for (const profile of LAB_PROFILES) {
      for (const field of profile.fieldsNotInPanel) {
        expect(COA_FIELD_NAMES).toContain(field)
      }
    }
  })

  /**
   * This laboratory reports LOSS ON DRYING, which is a different measurement
   * from water activity and must never be recorded as it.
   */
  it('both templates declare water activity absent', () => {
    for (const profile of LAB_PROFILES) {
      expect(profile.fieldsNotInPanel).toContain('water_activity')
    }
  })

  it('the narrower 2025 panel declares more absent, not fewer', () => {
    expect(TNR_BIOSCIENCE_2025.fieldsNotInPanel.length).toBeGreaterThan(TNR_BIOSCIENCE_2026.fieldsNotInPanel.length)
    expect(TNR_BIOSCIENCE_2025.fieldsNotInPanel).toContain('pesticides_result')
    expect(TNR_BIOSCIENCE_2026.fieldsNotInPanel).not.toContain('pesticides_result')
  })

  it('the warning says not-measured rather than not-found', () => {
    const warning = absentFieldWarning('water_activity', TNR_BIOSCIENCE_2026)
    expect(warning).toMatch(/does not report water_activity/)
    expect(warning).toMatch(/not missing from the document/)
  })
})

import { describe, it, expect } from 'vitest'
import { compareCoaFields, shouldBlockSubmission } from './coaFieldComparison'

describe('coaFieldComparison', () => {
  it('detects exact match on critical fields (sample_name)', () => {
    const comparison = compareCoaFields(
      { sample_name: 'Gelato', batch_reference: 'F4-122025' },
      { sample_name: 'Gelato', batch_reference: 'F4-122025' },
    )
    expect(comparison.criticalMismatches).toHaveLength(0)
    expect(comparison.hasMismatches).toBe(false)
  })

  it('detects strain name mismatch (Jell Breath vs Gelato)', () => {
    const comparison = compareCoaFields(
      { sample_name: 'Jell Breath', batch_reference: 'F4-122025' },
      { sample_name: 'Gelato', batch_reference: 'F4-122025' },
    )
    expect(comparison.criticalMismatches).toHaveLength(1)
    expect(comparison.criticalMismatches[0].fieldName).toBe('sample_name')
    expect(comparison.criticalMismatches[0].farmerValue).toBe('Jell Breath')
    expect(comparison.criticalMismatches[0].extractedValue).toBe('Gelato')
  })

  it('detects batch reference mismatch', () => {
    const comparison = compareCoaFields(
      { sample_name: 'Gelato', batch_reference: 'F4-122025' },
      { sample_name: 'Gelato', batch_reference: 'F5-122025' },
    )
    expect(comparison.criticalMismatches).toHaveLength(1)
    expect(comparison.criticalMismatches[0].fieldName).toBe('batch_reference')
  })

  it('allows THC tolerance within 0.1%', () => {
    const comparison = compareCoaFields(
      { total_thc: '26.85' },
      { total_thc: '26.95' },
    )
    // Values within 0.1% tolerance should NOT generate a warning
    expect(comparison.warnings.filter(w => w.fieldName === 'total_thc')).toHaveLength(0)
    expect(comparison.criticalMismatches).toHaveLength(0)
  })

  it('detects THC variance beyond tolerance', () => {
    const comparison = compareCoaFields(
      { total_thc: '26.0' },
      { total_thc: '26.5' },
    )
    expect(comparison.warnings).toHaveLength(1)
    expect(comparison.warnings[0].fieldName).toBe('total_thc')
  })

  it('allows moisture tolerance within 1.0%', () => {
    const comparison = compareCoaFields(
      { moisture_pct: '8.0' },
      { moisture_pct: '9.0' },
    )
    // Values within 1.0% tolerance should NOT generate a warning
    expect(comparison.warnings.filter(w => w.fieldName === 'moisture_pct')).toHaveLength(0)
  })

  it('handles whitespace trimming', () => {
    const comparison = compareCoaFields(
      { sample_name: '  Gelato  ', batch_reference: '  F4-122025  ' },
      { sample_name: 'Gelato', batch_reference: 'F4-122025' },
    )
    expect(comparison.criticalMismatches).toHaveLength(0)
  })

  it('blocks submission when critical mismatches exist', () => {
    const comparison = compareCoaFields(
      { sample_name: 'Jell Breath', batch_reference: 'F4-122025' },
      { sample_name: 'Gelato', batch_reference: 'F4-122025' },
    )
    expect(shouldBlockSubmission(comparison)).toBe(true)
  })

  it('allows submission when only warnings exist', () => {
    const comparison = compareCoaFields(
      { sample_name: 'Gelato', total_thc: '26.5' },
      { sample_name: 'Gelato', total_thc: '26.6' },
    )
    expect(shouldBlockSubmission(comparison)).toBe(false)
  })

  it('handles null/missing values correctly', () => {
    const comparison = compareCoaFields(
      { sample_name: 'Gelato', total_thc: null },
      { sample_name: 'Gelato', total_thc: '26.5' },
    )
    expect(comparison.hasMismatches).toBe(true)
  })

  it('treats both-null as match', () => {
    const comparison = compareCoaFields(
      { sample_name: null, total_thc: null },
      { sample_name: null, total_thc: null },
    )
    expect(comparison.hasMismatches).toBe(false)
  })
})

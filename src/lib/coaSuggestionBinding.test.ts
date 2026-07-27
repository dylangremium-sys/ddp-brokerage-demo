// Unit tests for source-bound preliminary suggestions.
//
// The rule under test is the gate's central one: a regulatory suggestion may
// exist only when bound to a source version that was actually retrieved and
// persisted. Everything else is rejected or quarantined.

import { describe, it, expect } from 'vitest'
import {
  bindSuggestionToSource,
  composePreliminarySuggestion,
  assertNoConclusion,
  isUsableSourceVersion,
  type PersistedSourceVersion,
} from './coaSuggestionBinding'
import type { CoaFinding } from './coaFindings'

const goodVersion: PersistedSourceVersion = {
  sourceVersionId: 'sv-001',
  authority: 'Thai Food and Drug Administration',
  jurisdiction: 'TH',
  url: 'https://www.fda.moph.go.th/cannabis',
  retrievalStatus: 'retrieved',
  contentFingerprint: 'c'.repeat(64),
  retrievedAt: '2026-07-27T10:00:00.000Z',
  section: 'Published requirements text.',
}

const draft = (overrides: Partial<Parameters<typeof bindSuggestionToSource>[0]> = {}) => ({
  coaDocumentId: 'coa-1',
  sourceVersionId: 'sv-001',
  text: 'Preliminary note: an administrator should compare the extracted results against the retrieved source.',
  ...overrides,
})

describe('bindSuggestionToSource — binding', () => {
  it('binds a cited suggestion to the retrieved source version', () => {
    const result = bindSuggestionToSource(draft(), [goodVersion])
    expect(result.state).toBe('bound')
    expect(result.reason).toBeNull()
    expect(result.suggestion).toMatchObject({
      sourceVersionId: 'sv-001',
      sourceContentFingerprint: goodVersion.contentFingerprint,
      sourceUrl: goodVersion.url,
      sourceAuthority: goodVersion.authority,
      sourceJurisdiction: 'TH',
      sourceRetrievedAt: goodVersion.retrievedAt,
    })
  })

  it('carries the exact source version fingerprint, not just the URL', () => {
    const result = bindSuggestionToSource(draft(), [goodVersion])
    // Binding to a URL alone would let the page change underneath the
    // suggestion; the fingerprint pins the retrieved version.
    expect(result.suggestion?.sourceContentFingerprint).toBe(goodVersion.contentFingerprint)
  })
})

describe('bindSuggestionToSource — rejection', () => {
  it('rejects an uncited suggestion', () => {
    const result = bindSuggestionToSource(draft({ sourceVersionId: null }), [goodVersion])
    expect(result.state).toBe('rejected')
    expect(result.suggestion).toBeNull()
    expect(result.reason).toMatch(/uncited/i)
  })

  it('rejects an empty suggestion', () => {
    const result = bindSuggestionToSource(draft({ text: '   ' }), [goodVersion])
    expect(result.state).toBe('rejected')
    expect(result.reason).toMatch(/empty/i)
  })

  it.each([
    'This batch is compliant with Thai law.',
    'The product is approved for sale.',
    'This COA is authentic.',
    'The sample is safe to sell.',
    'This batch passes all compliance checks.',
    'The product complies with the published limit.',
  ])('rejects text stating a conclusion: %s', (text) => {
    const result = bindSuggestionToSource(draft({ text }), [goodVersion])
    expect(result.state).toBe('rejected')
    expect(result.reason).toMatch(/conclusion/i)
    expect(result.suggestion).toBeNull()
  })
})

describe('bindSuggestionToSource — quarantine', () => {
  it('quarantines a suggestion citing an unknown source version', () => {
    const result = bindSuggestionToSource(draft({ sourceVersionId: 'sv-missing' }), [goodVersion])
    expect(result.state).toBe('quarantined')
    expect(result.suggestion).toBeNull()
    expect(result.reason).toMatch(/not on file/i)
  })

  it.each(['http_error', 'timeout', 'rejected_not_allowlisted', 'fetch_failed'] as const)(
    'quarantines when the cited source retrieval failed with %s',
    (status) => {
      const failed: PersistedSourceVersion = {
        ...goodVersion, retrievalStatus: status, contentFingerprint: null,
      }
      const result = bindSuggestionToSource(draft(), [failed])
      expect(result.state).toBe('quarantined')
      expect(result.suggestion).toBeNull()
      expect(result.reason).toMatch(/not successfully retrieved/i)
    },
  )

  it('quarantines a retrieved source that has no content fingerprint', () => {
    const noFingerprint: PersistedSourceVersion = { ...goodVersion, contentFingerprint: null }
    const result = bindSuggestionToSource(draft(), [noFingerprint])
    expect(result.state).toBe('quarantined')
    expect(result.reason).toMatch(/fingerprint/i)
  })

  it('never returns a displayable suggestion for any non-bound state', () => {
    const cases = [
      bindSuggestionToSource(draft({ sourceVersionId: null }), [goodVersion]),
      bindSuggestionToSource(draft({ sourceVersionId: 'nope' }), [goodVersion]),
      bindSuggestionToSource(draft(), [{ ...goodVersion, retrievalStatus: 'timeout', contentFingerprint: null }]),
      bindSuggestionToSource(draft(), []),
    ]
    for (const result of cases) {
      expect(result.state).not.toBe('bound')
      expect(result.suggestion).toBeNull()
      expect(result.reason).toBeTruthy()
    }
  })
})

describe('isUsableSourceVersion', () => {
  it('accepts only a retrieved, fingerprinted version', () => {
    expect(isUsableSourceVersion(goodVersion)).toBe(true)
    expect(isUsableSourceVersion({ ...goodVersion, retrievalStatus: 'http_error' })).toBe(false)
    expect(isUsableSourceVersion({ ...goodVersion, contentFingerprint: null })).toBe(false)
  })
})

describe('assertNoConclusion', () => {
  it('passes descriptive text', () => {
    expect(assertNoConclusion('Total THC was reported as 26.86 %w/w on page 1.')).toBeNull()
    expect(assertNoConclusion('An administrator should review the retrieved requirements.')).toBeNull()
  })

  it('catches conclusion language', () => {
    expect(assertNoConclusion('The batch is compliant.')).toBeTruthy()
    expect(assertNoConclusion('Cleared for export.')).toBeTruthy()
  })
})

describe('composePreliminarySuggestion', () => {
  const findings: CoaFinding[] = [
    {
      code: 'missing_panel', severity: 'high', title: 'Panel not reported: Pesticides',
      detail: 'The report does not contain a "Pesticides" section.',
      fieldKey: null, panelKey: 'pesticides', pageNumber: null, fingerprint: 'missing_panel|pesticides',
    },
  ]

  it('produces text that binds cleanly and states no conclusion', () => {
    const text = composePreliminarySuggestion({
      sampleName: 'Mango', reportNumber: 'RP-E2602-0196', findings, version: goodVersion,
    })

    expect(assertNoConclusion(text)).toBeNull()
    expect(text).toContain('not a compliance determination')
    expect(text).toContain(goodVersion.url)
    expect(text).toContain(goodVersion.authority)
    expect(text).toContain('Panel not reported: Pesticides')

    const bound = bindSuggestionToSource(draft({ text }), [goodVersion])
    expect(bound.state).toBe('bound')
  })

  it('states plainly when no findings were raised', () => {
    const text = composePreliminarySuggestion({
      sampleName: 'Mango', reportNumber: 'RP-E2602-0196', findings: [], version: goodVersion,
    })
    expect(text).toMatch(/raised no findings/i)
    expect(assertNoConclusion(text)).toBeNull()
  })

  it('is deterministic', () => {
    const args = { sampleName: 'Mango', reportNumber: 'RP-1', findings, version: goodVersion }
    expect(composePreliminarySuggestion(args)).toBe(composePreliminarySuggestion(args))
  })

  it('always defers the comparison to a human administrator', () => {
    const text = composePreliminarySuggestion({
      sampleName: null, reportNumber: null, findings, version: goodVersion,
    })
    expect(text).toMatch(/authorized administrator should compare/i)
    expect(text).toMatch(/has not evaluated the document against any legal threshold/i)
  })
})

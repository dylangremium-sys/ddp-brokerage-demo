import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import {
  decideRegulatorySourceWrite,
  deriveRegulatorySourceStatus,
  filterActiveRegulatorySources,
  validateRegulatorySource,
  type RegulatorySourceCandidate,
} from './complianceSourceRegistry'

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'source-1',
    name: 'Thai FDA — Narcotics Control Division',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/narcotics',
    isActive: true,
    lastCheckedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeCandidate(overrides: Partial<RegulatorySourceCandidate> = {}): RegulatorySourceCandidate {
  return {
    name: 'Thai FDA — Narcotics Control Division',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/narcotics',
    isActive: true,
    ...overrides,
  }
}

describe('validateRegulatorySource — valid source', () => {
  it('accepts a well-formed candidate with no existing sources', () => {
    const result = validateRegulatorySource(makeCandidate(), [])
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('accepts a well-formed candidate alongside unrelated existing sources', () => {
    const result = validateRegulatorySource(makeCandidate({ url: 'https://gov.cz/legal-updates' }), [makeSource()])
    expect(result.valid).toBe(true)
  })
})

describe('validateRegulatorySource — invalid URL', () => {
  it('rejects a non-URL string', () => {
    const result = validateRegulatorySource(makeCandidate({ url: 'not a url' }), [])
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('url'))).toBe(true)
  })

  it('rejects a non-http(s) protocol', () => {
    const result = validateRegulatorySource(makeCandidate({ url: 'ftp://example.gov/file' }), [])
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('url'))).toBe(true)
  })

  it('rejects an empty URL', () => {
    const result = validateRegulatorySource(makeCandidate({ url: '' }), [])
    expect(result.valid).toBe(false)
  })
})

describe('validateRegulatorySource — missing required fields', () => {
  it('rejects a missing/blank name', () => {
    const result = validateRegulatorySource(makeCandidate({ name: '   ' }), [])
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('name'))).toBe(true)
  })

  it('rejects a missing/blank jurisdiction', () => {
    const result = validateRegulatorySource(makeCandidate({ jurisdiction: '' }), [])
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('jurisdiction'))).toBe(true)
  })

  it('rejects an unsupported sourceType', () => {
    const result = validateRegulatorySource(makeCandidate({ sourceType: 'blog_post' }), [])
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('sourceType'))).toBe(true)
  })

  it('accepts every supported sourceType', () => {
    for (const sourceType of ['government_regulator', 'legal_database', 'industry_association', 'news_press_release', 'other']) {
      expect(validateRegulatorySource(makeCandidate({ sourceType }), []).valid).toBe(true)
    }
  })

  it('collects multiple errors at once rather than stopping at the first', () => {
    const result = validateRegulatorySource({ name: '', jurisdiction: '', sourceType: 'bogus', url: 'nope', isActive: true }, [])
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('validateRegulatorySource — duplicate URL', () => {
  it('rejects a URL that already exists in the registry', () => {
    const existing = [makeSource({ url: 'https://www.fda.moph.go.th/narcotics' })]
    const result = validateRegulatorySource(makeCandidate({ url: 'https://www.fda.moph.go.th/narcotics' }), existing)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('duplicate'))).toBe(true)
  })

  it('treats duplicate detection as case-insensitive and trim-insensitive', () => {
    const existing = [makeSource({ url: 'https://www.fda.moph.go.th/narcotics' })]
    const result = validateRegulatorySource(makeCandidate({ url: '  HTTPS://WWW.FDA.MOPH.GO.TH/narcotics  ' }), existing)
    expect(result.valid).toBe(false)
  })

  // Semantic-equivalence duplicates the old trim+lowercase key let through.
  it.each([
    ['trailing slash', 'https://www.fda.moph.go.th/narcotics/'],
    ['default https port', 'https://www.fda.moph.go.th:443/narcotics'],
    ['hash fragment', 'https://www.fda.moph.go.th/narcotics#latest'],
  ])('flags a canonically-equivalent URL as a duplicate (%s)', (_label, candidateUrl) => {
    const existing = [makeSource({ url: 'https://www.fda.moph.go.th/narcotics' })]
    const result = validateRegulatorySource(makeCandidate({ url: candidateUrl }), existing)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('duplicate'))).toBe(true)
  })

  it('does NOT flag genuinely different paths as duplicates', () => {
    const existing = [makeSource({ url: 'https://www.fda.moph.go.th/narcotics' })]
    const result = validateRegulatorySource(makeCandidate({ url: 'https://www.fda.moph.go.th/cosmetics' }), existing)
    expect(result.valid).toBe(true)
  })

  it('does not flag a duplicate against itself when excludeId matches', () => {
    const existing = [makeSource({ id: 'source-1', url: 'https://www.fda.moph.go.th/narcotics' })]
    const result = validateRegulatorySource(makeCandidate({ url: 'https://www.fda.moph.go.th/narcotics' }), existing, 'source-1')
    expect(result.valid).toBe(true)
  })

  it('still flags a duplicate against a different existing source when excludeId is set', () => {
    const existing = [
      makeSource({ id: 'source-1', url: 'https://a.example.gov' }),
      makeSource({ id: 'source-2', url: 'https://b.example.gov' }),
    ]
    const result = validateRegulatorySource(makeCandidate({ url: 'https://b.example.gov' }), existing, 'source-1')
    expect(result.valid).toBe(false)
  })
})

describe('filterActiveRegulatorySources — inactive filtering', () => {
  it('keeps only active sources', () => {
    const sources = [
      makeSource({ id: 'a', isActive: true }),
      makeSource({ id: 'b', isActive: false }),
      makeSource({ id: 'c', isActive: true }),
    ]
    const active = filterActiveRegulatorySources(sources)
    expect(active.map(s => s.id)).toEqual(['a', 'c'])
  })

  it('returns an empty array when none are active', () => {
    expect(filterActiveRegulatorySources([makeSource({ isActive: false })])).toEqual([])
  })
})

describe('decideRegulatorySourceWrite — validation blocks repository writes', () => {
  it('returns action: "write" with a payload for a valid candidate', () => {
    const decision = decideRegulatorySourceWrite(makeCandidate(), [])
    expect(decision.action).toBe('write')
    expect(decision.payload).toBeDefined()
    expect(decision.errors).toEqual([])
  })

  it('returns action: "reject" with no payload for an invalid candidate — nothing is available to pass to the repository', () => {
    const decision = decideRegulatorySourceWrite(makeCandidate({ url: 'not a url' }), [])
    expect(decision.action).toBe('reject')
    expect(decision.payload).toBeUndefined()
    expect(decision.errors.length).toBeGreaterThan(0)
  })

  it('rejects a duplicate URL the same way as any other validation failure', () => {
    const existing = [makeSource()]
    const decision = decideRegulatorySourceWrite(makeCandidate(), existing)
    expect(decision.action).toBe('reject')
    expect(decision.payload).toBeUndefined()
  })
})

describe('repository compatibility', () => {
  it('the write-decision payload has exactly the fields insertRegulatorySource/updateRegulatorySource expect (RegulatorySourceCandidate shape)', () => {
    const decision = decideRegulatorySourceWrite(makeCandidate(), [])
    expect(decision.action).toBe('write')
    const payload = decision.payload!
    expect(Object.keys(payload).sort()).toEqual(['isActive', 'jurisdiction', 'name', 'sourceType', 'url'].sort())
    expect(typeof payload.name).toBe('string')
    expect(typeof payload.jurisdiction).toBe('string')
    expect(typeof payload.sourceType).toBe('string')
    expect(typeof payload.url).toBe('string')
    expect(typeof payload.isActive).toBe('boolean')
  })
})

describe('deriveRegulatorySourceStatus — application-level status model', () => {
  it('derives ACTIVE for an active, non-test source', () => {
    expect(deriveRegulatorySourceStatus(makeSource({ isActive: true }))).toBe('ACTIVE')
  })

  it('derives DISABLED for an inactive, non-test source', () => {
    expect(deriveRegulatorySourceStatus(makeSource({ isActive: false }))).toBe('DISABLED')
  })

  it('derives TEST when "test" appears as a whole word in the name, regardless of isActive', () => {
    expect(deriveRegulatorySourceStatus(makeSource({ name: 'Test Source — do not use', isActive: true }))).toBe('TEST')
    expect(deriveRegulatorySourceStatus(makeSource({ name: 'Test Source — do not use', isActive: false }))).toBe('TEST')
  })

  it('derives TEST when "test" appears as a whole word in the URL', () => {
    expect(deriveRegulatorySourceStatus(makeSource({ url: 'https://example.gov/test' }))).toBe('TEST')
  })

  it('does not false-positive on substrings like "latest" or "contest"', () => {
    expect(deriveRegulatorySourceStatus(makeSource({ name: 'Latest Regulatory Contest Board', isActive: true }))).toBe('ACTIVE')
  })

  it('never derives ARCHIVED — not reliably derivable from existing fields, documented as a future field instead', () => {
    const allSources = [
      makeSource({ isActive: true }),
      makeSource({ isActive: false }),
      makeSource({ name: 'Test x', isActive: false }),
    ]
    for (const source of allSources) {
      expect(deriveRegulatorySourceStatus(source)).not.toBe('ARCHIVED')
    }
  })
})

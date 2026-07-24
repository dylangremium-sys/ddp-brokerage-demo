import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import { WATCHTOWER_STARTER_SOURCES, listMissingStarterSources } from './watchtowerStarterSources'

describe('listMissingStarterSources', () => {
  it('returns the full curated source pack when the registry is empty', () => {
    expect(listMissingStarterSources([])).toEqual(WATCHTOWER_STARTER_SOURCES)
  })

  it('skips any starter source already linked by URL case-insensitively', () => {
    const existing: RegulatorySource[] = [
      {
        id: 'source-1',
        name: 'Thai FDA existing',
        jurisdiction: 'Thailand',
        sourceType: 'government_regulator',
        url: 'HTTPS://WWW.FDA.MOPH.GO.TH/',
        isActive: true,
        lastCheckedAt: null,
        tier: 1,
        authorityType: 'primary_regulator',
        category: 'pharmaceutical',
        monitoringMethod: 'html',
        priority: 5,
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      },
    ]

    const missing = listMissingStarterSources(existing)
    expect(missing).toHaveLength(WATCHTOWER_STARTER_SOURCES.length - 1)
    expect(missing.some(source => source.url === 'https://www.fda.moph.go.th/')).toBe(false)
  })

  // Regression: the previous trim+lowercase key treated these as DIFFERENT
  // URLs, so an already-linked source in an equivalent form let the starter
  // source be re-inserted as a duplicate.
  it.each([
    ['trailing slash', 'https://www.fda.moph.go.th'],            // starter has the slash
    ['default port', 'https://www.fda.moph.go.th:443/'],
    ['hash fragment', 'https://www.fda.moph.go.th/#section'],
  ])('does not re-list a starter source already linked in an equivalent URL form (%s)', (_label, existingUrl) => {
    const existing: RegulatorySource[] = [
      {
        id: 'source-1',
        name: 'Thai FDA existing',
        jurisdiction: 'Thailand',
        sourceType: 'government_regulator',
        url: existingUrl,
        isActive: true,
        lastCheckedAt: null,
        tier: 1,
        authorityType: 'primary_regulator',
        category: 'pharmaceutical',
        monitoringMethod: 'html',
        priority: 5,
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      },
    ]

    const missing = listMissingStarterSources(existing)
    expect(missing).toHaveLength(WATCHTOWER_STARTER_SOURCES.length - 1)
    expect(missing.some(source => source.url === 'https://www.fda.moph.go.th/')).toBe(false)
  })
})

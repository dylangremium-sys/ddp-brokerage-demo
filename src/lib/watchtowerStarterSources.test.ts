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
})

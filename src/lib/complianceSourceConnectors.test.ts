import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import {
  createConnector,
  inferConnectorKind,
  selectConnectorForSource,
  SUPPORTED_CONNECTOR_KINDS,
  type ConnectorKind,
} from './complianceSourceConnectors'

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

// The connector module's own source, imported raw (via Vite) for the
// static-safety assertions below (no fetch, no AI reference). Using
// import.meta.glob keeps this typed by vite/client and avoids node:fs, which
// the app tsconfig does not type.
const RAW_MODULES = import.meta.glob('./complianceSourceConnectors.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const MODULE_SOURCE = Object.values(RAW_MODULES)[0] ?? ''

describe('inferConnectorKind / selectConnectorForSource — kind selection', () => {
  it('selects rss for an RSS feed URL', () => {
    const source = makeSource({ url: 'https://www.dft.go.th/announcements/rss.xml' })
    expect(inferConnectorKind(source)).toBe('rss')

    const selection = selectConnectorForSource(source)
    expect(selection.supported).toBe(true)
    expect(selection.kind).toBe('rss')
    expect(selection.connector?.kind).toBe('rss')
  })

  it('selects atom for an Atom feed URL', () => {
    const source = makeSource({ url: 'https://www.dft.go.th/announcements/atom.xml' })
    expect(inferConnectorKind(source)).toBe('atom')

    const selection = selectConnectorForSource(source)
    expect(selection.supported).toBe(true)
    expect(selection.kind).toBe('atom')
    expect(selection.connector?.kind).toBe('atom')
  })

  it('selects html for a plain HTML page URL', () => {
    const source = makeSource({ url: 'https://www.fda.moph.go.th/narcotics/notices' })
    expect(inferConnectorKind(source)).toBe('html')

    const selection = selectConnectorForSource(source)
    expect(selection.supported).toBe(true)
    expect(selection.kind).toBe('html')
    expect(selection.connector?.kind).toBe('html')
  })

  it('selects pdf for a PDF document URL', () => {
    const source = makeSource({ url: 'https://www.dld.go.th/notices/2026-export-notice.pdf' })
    expect(inferConnectorKind(source)).toBe('pdf')

    const selection = selectConnectorForSource(source)
    expect(selection.supported).toBe(true)
    expect(selection.kind).toBe('pdf')
    expect(selection.connector?.kind).toBe('pdf')
  })

  it('selects government_api for an api host / json endpoint', () => {
    const source = makeSource({ url: 'https://api.dft.go.th/v1/notices.json' })
    expect(inferConnectorKind(source)).toBe('government_api')

    const selection = selectConnectorForSource(source)
    expect(selection.supported).toBe(true)
    expect(selection.kind).toBe('government_api')
  })
})

describe('selectConnectorForSource — rejection', () => {
  it('rejects a source whose sourceType is not supported', () => {
    const source = makeSource({ sourceType: 'twitter_rumor' })
    const selection = selectConnectorForSource(source)
    expect(selection.supported).toBe(false)
    expect(selection.kind).toBe('unsupported')
    expect(selection.connector).toBeUndefined()
    expect(selection.reason).toContain('unsupported sourceType')
  })

  it('rejects a source with an unparseable / non-http(s) URL', () => {
    const nonHttp = makeSource({ url: 'ftp://example.gov/notices' })
    const nonHttpSelection = selectConnectorForSource(nonHttp)
    expect(inferConnectorKind(nonHttp)).toBe('unsupported')
    expect(nonHttpSelection.supported).toBe(false)
    expect(nonHttpSelection.connector).toBeUndefined()

    const empty = makeSource({ url: '' })
    expect(inferConnectorKind(empty)).toBe('unsupported')
    expect(selectConnectorForSource(empty).supported).toBe(false)
  })
})

describe('connector safety guarantees', () => {
  it('no connector performs network calls (static + flag checks)', () => {
    // Static: the module contains no network-call syntax and no network libs.
    expect(MODULE_SOURCE).not.toMatch(/\bfetch\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/XMLHttpRequest/)
    expect(MODULE_SOURCE).not.toMatch(/\baxios\b/)
    expect(MODULE_SOURCE).not.toMatch(/node-fetch/)
    expect(MODULE_SOURCE).not.toMatch(/require\(\s*['"](?:node:)?https?['"]\s*\)/)

    // Flags: every kind's descriptor and plan declares performsNetwork === false.
    for (const kind of [...SUPPORTED_CONNECTOR_KINDS, 'unsupported'] as ConnectorKind[]) {
      const connector = createConnector(kind)
      expect(connector.describe().performsNetwork).toBe(false)
      expect(connector.planFetch(makeSource()).performsNetwork).toBe(false)
      expect(connector.planFetch(makeSource()).httpMethod).toBe('GET')
    }
  })

  it('connector output cannot create legal updates or rules', () => {
    const forbiddenKeys = ['status', 'ruleCode', 'ruleId', 'legalUpdate', 'legalUpdateId', 'approved']
    for (const kind of [...SUPPORTED_CONNECTOR_KINDS, 'unsupported'] as ConnectorKind[]) {
      const connector = createConnector(kind)
      const plan = connector.planFetch(makeSource())
      const descriptor = connector.describe()

      expect(plan.canCreateLegalUpdate).toBe(false)
      expect(plan.canCreateRule).toBe(false)
      expect(descriptor.canCreateLegalUpdate).toBe(false)
      expect(descriptor.canCreateRule).toBe(false)

      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(plan, key)).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(descriptor, key)).toBe(false)
      }
    }
  })

  it('does not import or reference an AI provider', () => {
    // No import of the AI provider/guard modules, and no AI-vendor references.
    expect(MODULE_SOURCE).not.toMatch(/aiCompliance/)
    expect(MODULE_SOURCE).not.toMatch(/anthropic/i)
    expect(MODULE_SOURCE).not.toMatch(/openai/i)
    expect(MODULE_SOURCE).not.toMatch(/ComplianceAIProvider/)

    // And the capability flag is declared false on every kind.
    for (const kind of [...SUPPORTED_CONNECTOR_KINDS, 'unsupported'] as ConnectorKind[]) {
      const connector = createConnector(kind)
      expect(connector.describe().canCallAI).toBe(false)
      expect(connector.planFetch(makeSource()).canCallAI).toBe(false)
    }
  })
})

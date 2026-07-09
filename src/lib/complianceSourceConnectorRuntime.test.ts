import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import {
  normalizeConnectorHost,
  isHttpsRegulatoryUrl,
  validateConnectorAllowlist,
  validateConnectorUrlSafety,
  buildConnectorRunPlan,
  type ConnectorRuntimeStatus,
} from './complianceSourceConnectorRuntime'

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'source-1',
    name: 'Thai FDA — Narcotics Control Division',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/narcotics/notices',
    isActive: true,
    lastCheckedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const ALLOWED = ['www.fda.moph.go.th', 'api.dft.go.th', 'www.dld.go.th']

// The runtime module's own source, imported raw for the static-safety
// assertions (no network-call syntax, no AI reference). Same approach as the
// Phase 2A.5 contract test — vite/client typed, no node:fs.
const RAW_MODULES = import.meta.glob('./complianceSourceConnectorRuntime.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const MODULE_SOURCE = Object.values(RAW_MODULES)[0] ?? ''

function planStatus(source: RegulatorySource, allowedHosts = ALLOWED, allowedPorts: number[] = []): ConnectorRuntimeStatus {
  return buildConnectorRunPlan(source, allowedHosts, allowedPorts).status
}

describe('buildConnectorRunPlan — happy path', () => {
  it('accepts an official HTTPS allowlisted regulator host', () => {
    const result = buildConnectorRunPlan(makeSource(), ALLOWED)
    expect(result.status).toBe('ready')
    expect(result.plan).toBeDefined()
    expect(result.plan?.connectorKind).toBe('html')
    expect(result.plan?.normalizedHost).toBe('www.fda.moph.go.th')
    expect(result.plan?.httpMethod).toBe('GET')
    expect(result.plan?.redirectsValidated).toBe(false)
  })

  it('accepts a default HTTPS port (implicit 443 and explicit :443)', () => {
    expect(planStatus(makeSource({ url: 'https://www.fda.moph.go.th/x' }))).toBe('ready')
    expect(planStatus(makeSource({ url: 'https://www.fda.moph.go.th:443/x' }))).toBe('ready')
  })
})

describe('buildConnectorRunPlan — scheme + URL validity', () => {
  it('rejects non-HTTPS (http) sources', () => {
    expect(isHttpsRegulatoryUrl('http://www.fda.moph.go.th/x')).toBe(false)
    expect(planStatus(makeSource({ url: 'http://www.fda.moph.go.th/x' }))).toBe('rejected_not_https')
  })

  it('rejects an unparseable / empty URL', () => {
    expect(planStatus(makeSource({ url: '' }))).toBe('rejected_invalid_url')
    expect(planStatus(makeSource({ url: 'not a url' }))).toBe('rejected_invalid_url')
  })
})

describe('buildConnectorRunPlan — SSRF guard (private / loopback / link-local / metadata)', () => {
  // These hosts are allowlisted on purpose to prove the SSRF guard rejects
  // them regardless of allowlist membership.
  function withHost(host: string) {
    return { source: makeSource({ url: `https://${host}/x` }), allowed: [host.replace(/^\[|\]$/g, '')] }
  }

  it('rejects localhost by name', () => {
    const { source, allowed } = withHost('localhost')
    expect(planStatus(source, allowed)).toBe('rejected_private_network')
  })

  it('rejects 127.0.0.1 loopback', () => {
    const { source, allowed } = withHost('127.0.0.1')
    expect(planStatus(source, allowed)).toBe('rejected_private_network')
  })

  it('rejects RFC1918 private ranges: 10.x, 172.16-31.x, 192.168.x', () => {
    for (const host of ['10.0.0.5', '172.16.4.9', '172.31.255.1', '192.168.1.1']) {
      const { source, allowed } = withHost(host)
      expect(planStatus(source, allowed)).toBe('rejected_private_network')
    }
    // A public-looking 172 outside the private block is NOT rejected by SSRF.
    expect(validateConnectorUrlSafety(makeSource({ url: 'https://172.32.0.1/x' })).safe).toBe(true)
    expect(validateConnectorUrlSafety(makeSource({ url: 'https://172.15.0.1/x' })).safe).toBe(true)
  })

  it('rejects 169.254.x link-local', () => {
    const { source, allowed } = withHost('169.254.10.20')
    expect(planStatus(source, allowed)).toBe('rejected_private_network')
  })

  it('rejects the 169.254.169.254 cloud metadata IP', () => {
    const { source, allowed } = withHost('169.254.169.254')
    expect(planStatus(source, allowed)).toBe('rejected_private_network')
    expect(validateConnectorUrlSafety(makeSource({ url: 'https://169.254.169.254/latest/meta-data/' })).status)
      .toBe('private_network')
  })

  it('rejects IPv6 loopback and link-local', () => {
    for (const host of ['[::1]', '[fe80::1]', '[fd00:ec2::254]']) {
      const { source, allowed } = withHost(host)
      expect(planStatus(source, allowed)).toBe('rejected_private_network')
    }
  })
})

describe('buildConnectorRunPlan — allowlist (deny by default, case-insensitive)', () => {
  it('rejects an off-allowlist HTTPS host', () => {
    expect(planStatus(makeSource({ url: 'https://evil.example.com/x' }))).toBe('rejected_not_allowlisted')
  })

  it('rejects everything when the allowlist is empty (deny by default)', () => {
    expect(planStatus(makeSource(), [])).toBe('rejected_not_allowlisted')
  })

  it('compares allowed hosts case-insensitively', () => {
    const source = makeSource({ url: 'https://WWW.FDA.MOPH.GO.TH/x' })
    expect(validateConnectorAllowlist(source, ['www.fda.moph.go.th']).allowed).toBe(true)
    expect(planStatus(source, ['WWW.Fda.Moph.Go.TH'])).toBe('ready')
  })

  it('does not suffix-match (evil-www.fda.moph.go.th is not allowlisted)', () => {
    expect(validateConnectorAllowlist(makeSource({ url: 'https://evil-www.fda.moph.go.th/x' }), ALLOWED).allowed)
      .toBe(false)
  })
})

describe('buildConnectorRunPlan — ports', () => {
  it('rejects a non-standard port by default', () => {
    expect(planStatus(makeSource({ url: 'https://www.fda.moph.go.th:8443/x' }))).toBe('rejected_private_network')
  })

  it('accepts a non-standard port only when explicitly allowed', () => {
    expect(planStatus(makeSource({ url: 'https://www.fda.moph.go.th:8443/x' }), ALLOWED, [8443])).toBe('ready')
  })
})

describe('buildConnectorRunPlan — unsupported connector', () => {
  it('rejects a source whose sourceType is unsupported (even if https + allowlisted)', () => {
    const source = makeSource({ url: 'https://www.dld.go.th/notices', sourceType: 'twitter_rumor' })
    expect(planStatus(source, ['www.dld.go.th'])).toBe('rejected_unsupported_connector')
  })
})

describe('normalizeConnectorHost', () => {
  it('lowercases and strips IPv6 brackets, and returns null for junk', () => {
    expect(normalizeConnectorHost('https://WWW.Example.GOV/a')).toBe('www.example.gov')
    expect(normalizeConnectorHost('https://[FE80::1]/a')).toBe('fe80::1')
    expect(normalizeConnectorHost('')).toBeNull()
    expect(normalizeConnectorHost('nonsense')).toBeNull()
  })
})

describe('runtime output carries no fetch / network / write / legal_update / rule / AI capability', () => {
  it('has no network-call syntax and no AI reference in the module source', () => {
    expect(MODULE_SOURCE).not.toMatch(/\bfetch\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/XMLHttpRequest/)
    expect(MODULE_SOURCE).not.toMatch(/\baxios\b/)
    expect(MODULE_SOURCE).not.toMatch(/node-fetch/)
    expect(MODULE_SOURCE).not.toMatch(/require\(\s*['"](?:node:)?https?['"]\s*\)/)
    expect(MODULE_SOURCE).not.toMatch(/aiCompliance/)
    expect(MODULE_SOURCE).not.toMatch(/anthropic/i)
    expect(MODULE_SOURCE).not.toMatch(/openai/i)
  })

  it('every result and ready plan declares all capability flags false and exposes no write/rule/legal_update keys', () => {
    const forbiddenKeys = ['legalUpdate', 'legalUpdateId', 'proposedLegalUpdate', 'ruleCode', 'ruleId', 'rawContent', 'approved']

    // A ready result (with a plan) and a rejected result both must be inert.
    const ready = buildConnectorRunPlan(makeSource(), ALLOWED)
    const rejected = buildConnectorRunPlan(makeSource({ url: 'http://x/y' }), ALLOWED)

    for (const result of [ready, rejected]) {
      expect(result.performsNetwork).toBe(false)
      expect(result.canCreateLegalUpdate).toBe(false)
      expect(result.canCreateRule).toBe(false)
      expect(result.canCallAI).toBe(false)
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(false)
      }
    }

    const plan = ready.plan
    expect(plan).toBeDefined()
    expect(plan?.performsNetwork).toBe(false)
    expect(plan?.canCreateLegalUpdate).toBe(false)
    expect(plan?.canCreateRule).toBe(false)
    expect(plan?.canCallAI).toBe(false)
    expect(plan?.redirectsValidated).toBe(false)
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(plan, key)).toBe(false)
    }
  })
})

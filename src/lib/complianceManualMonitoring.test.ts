import { describe, expect, it, vi } from 'vitest'
import type { RegulatorySource } from '../types'
import {
  evaluateManualMonitoringEligibility,
  canStartManualRun,
  runManualRssMonitoring,
  runPastedMonitoringDecision,
  evaluatePastedMonitoringGate,
  DEFAULT_MANUAL_MONITORING_USER_AGENT,
} from './complianceManualMonitoring'
import type { RssFetchImpl, RssFetchResponse } from './complianceRssConnector'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Thai FDA Notices</title>
  <item><title>Notice A</title><link>https://www.fda.moph.go.th/a</link><guid>guid-a</guid><description>Body A</description><pubDate>Wed, 09 Jul 2026 10:00:00 GMT</pubDate></item>
  <item><title>ประกาศ B</title><link>https://www.fda.moph.go.th/b</link><guid>guid-b</guid><description>เนื้อหาภาษาไทย</description><pubDate>Wed, 09 Jul 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`

const RSS_XML_CHANGED = RSS_XML.replace('<description>Body A</description>', '<description>Body A — amended</description>')

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>DFT Atom</title>
  <entry><title>Entry A</title><link href="https://api.dft.go.th/a" rel="alternate"/><id>atom-a</id><summary>Summary A</summary><updated>2026-07-09T10:00:00Z</updated></entry>
</feed>`

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'source-rss-1',
    name: 'Thai FDA',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/rss.xml',
    isActive: true,
    lastCheckedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface MockState { calls: number }
function mockFetch(body: string, state: MockState, contentType = 'application/rss+xml'): RssFetchImpl {
  return async () => {
    state.calls++
    const resp: RssFetchResponse = {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
    }
    return resp
  }
}

const NOW = () => '2026-07-10T00:00:00.000Z'

const RAW_MODULE = (import.meta.glob('./complianceManualMonitoring.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const MODULE_SOURCE = Object.values(RAW_MODULE)[0] ?? ''

// ─── Eligibility (pure) ──────────────────────────────────────────────────────

describe('evaluateManualMonitoringEligibility', () => {
  it('accepts an active RSS source and an active Atom source', () => {
    expect(evaluateManualMonitoringEligibility(makeSource()).eligible).toBe(true)
    expect(evaluateManualMonitoringEligibility(makeSource()).connectorKind).toBe('rss')
    const atom = makeSource({ url: 'https://api.dft.go.th/atom.xml' })
    expect(evaluateManualMonitoringEligibility(atom).eligible).toBe(true)
    expect(evaluateManualMonitoringEligibility(atom).connectorKind).toBe('atom')
  })

  it('rejects inactive, non-feed, and invalid-URL sources', () => {
    expect(evaluateManualMonitoringEligibility(makeSource({ isActive: false })).code).toBe('inactive_source')
    expect(evaluateManualMonitoringEligibility(makeSource({ url: 'https://www.fda.moph.go.th/notices' })).code).toBe('unsupported_connector')
    expect(evaluateManualMonitoringEligibility(makeSource({ url: 'not-a-url' })).code).toBe('invalid_url')
  })
})

describe('canStartManualRun (duplicate-click guard)', () => {
  it('allows a run only when not already running', () => {
    expect(canStartManualRun(false)).toBe(true)
    expect(canStartManualRun(true)).toBe(false)
  })
})

// ─── Manual invocation (fully mocked fetch) ──────────────────────────────────

describe('runManualRssMonitoring', () => {
  it('manually invokes and parses an RSS source', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, state), { now: NOW })
    expect(result.ok).toBe(true)
    expect(result.feedKind).toBe('rss')
    expect(result.itemCount).toBe(2)
    expect(result.items).toHaveLength(2)
    expect(result.items[0].itemTitle).toBe('Notice A')
    expect(result.items[0].itemUrl).toBe('https://www.fda.moph.go.th/a')
    expect(result.items[0].checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(state.calls).toBe(1)
  })

  it('manually invokes and parses an Atom source', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource({ url: 'https://api.dft.go.th/atom.xml' }), mockFetch(ATOM_XML, state, 'application/atom+xml'), { now: NOW })
    expect(result.ok).toBe(true)
    expect(result.feedKind).toBe('atom')
    expect(result.itemCount).toBe(1)
    expect(state.calls).toBe(1)
  })

  it('does NOT fetch until runManualRssMonitoring is explicitly called', () => {
    const state = { calls: 0 }
    // Creating the mock and evaluating eligibility perform no fetch.
    mockFetch(RSS_XML, state)
    evaluateManualMonitoringEligibility(makeSource())
    expect(state.calls).toBe(0)
  })

  it('does NOT fetch for an unsupported (non-RSS/Atom) source', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource({ url: 'https://www.fda.moph.go.th/notices' }), mockFetch(RSS_XML, state), { now: NOW })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('unsupported_connector')
    expect(state.calls).toBe(0)
  })

  it('does NOT fetch for an inactive source', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource({ isActive: false }), mockFetch(RSS_XML, state), { now: NOW })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('inactive_source')
    expect(state.calls).toBe(0)
  })

  it('does NOT fetch a non-HTTPS source (connector safety gate)', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource({ url: 'http://www.fda.moph.go.th/rss.xml' }), mockFetch(RSS_XML, state), { now: NOW })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_https')
    expect(state.calls).toBe(0) // rejected before any fetch
  })

  it('reports first-seen items as changed_pending_review (intent only)', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, state), { now: NOW })
    expect(result.items.every(i => i.decisionKind === 'changed_pending_review')).toBe(true)
    expect(result.items[0].proposesLegalUpdateDraft).toBe(true)
    // Intent only — nothing is created.
    expect(result.canCreateLegalUpdate).toBe(false)
    expect(result.performsPersistence).toBe(false)
  })

  it('reports unchanged on a repeat check with the same content (no update created)', async () => {
    const first = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, { calls: 0 }), { now: NOW })
    const second = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, { calls: 0 }), { now: NOW, previousSnapshots: first.updatedSnapshots })
    expect(second.items.every(i => i.decisionKind === 'unchanged')).toBe(true)
    expect(second.canCreateLegalUpdate).toBe(false)
    expect(second.performsPersistence).toBe(false)
  })

  it('reports changed_pending_review when a known item content changes', async () => {
    const first = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, { calls: 0 }), { now: NOW })
    const second = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML_CHANGED, { calls: 0 }), { now: NOW, previousSnapshots: first.updatedSnapshots })
    expect(second.items[0].decisionKind).toBe('changed_pending_review')
  })

  it('surfaces connector errors safely (malformed feed) with a diagnostic code', async () => {
    const state = { calls: 0 }
    const result = await runManualRssMonitoring(makeSource(), mockFetch('<rss><channel><item><title>x</title></item>', state, 'application/xml'), { now: NOW })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('malformed_feed')
    expect(typeof result.reason).toBe('string')
  })

  it('uses a default descriptive User-Agent and returns transient snapshots (a Map)', async () => {
    expect(DEFAULT_MANUAL_MONITORING_USER_AGENT).toMatch(/read-only/i)
    const result = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, { calls: 0 }), { now: NOW })
    expect(result.updatedSnapshots).toBeInstanceOf(Map)
  })
})

// ─── Capability + no-network / no-write / no-AI guarantees (static) ──────────

describe('safety guarantees', () => {
  it('run results carry no persistence/enforcement/legal_update/rule/AI capability', async () => {
    const forbiddenKeys = ['legalUpdate', 'proposedLegalUpdate', 'ruleCode', 'ruleId', 'approved', 'persist']
    const ok = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML, { calls: 0 }), { now: NOW })
    const bad = await runManualRssMonitoring(makeSource({ isActive: false }), mockFetch(RSS_XML, { calls: 0 }), { now: NOW })
    for (const r of [ok, bad]) {
      expect(r.performsPersistence).toBe(false)
      expect(r.performsEnforcement).toBe(false)
      expect(r.canCreateLegalUpdate).toBe(false)
      expect(r.canCreateRule).toBe(false)
      expect(r.canCallAI).toBe(false)
      for (const key of forbiddenKeys) expect(Object.prototype.hasOwnProperty.call(r, key)).toBe(false)
    }
  })

  it('the orchestration module references no global fetch, Supabase, AI, or scheduler', () => {
    expect(MODULE_SOURCE).not.toMatch(/\bfetch\s*\(/) // depends only on the injected fetchImpl
    expect(MODULE_SOURCE).not.toMatch(/XMLHttpRequest|globalThis\.fetch|window\.fetch/)
    // Actual Supabase/persistence client usage (not the word "Supabase" in a comment).
    expect(MODULE_SOURCE).not.toMatch(/supabase\.\w|\.from\(|\brepo\.|\.insert\(|\.upsert\(/)
    expect(MODULE_SOURCE).not.toMatch(/aiCompliance|anthropic|openai/i)
    expect(MODULE_SOURCE).not.toMatch(/insertLegalUpdate|insertRule|createRule|approveRule|enforceRule/)
    expect(MODULE_SOURCE).not.toMatch(/setInterval|setTimeout|cron|\bschedule\b|localStorage|sessionStorage/)
  })
})

// ─── Pasted Monitoring Queue — Cannamonitor gate (P1 pasted-content fix) ─────
//
// Synthetic fixtures only; no live Cannamonitor request. Proves a selected
// Cannamonitor source cannot let pasted body text reach normalization, a
// checksum, a monitoring decision, a draft intake, or persistence — while
// non-Cannamonitor sources behave exactly as before.
describe('Pasted Monitoring Queue — Cannamonitor gate', () => {
  const MARKER = 'PASTED_CANNAMONITOR_BODY_MARKER_MUST_NOT_BE_INGESTED'

  function cannamonitorSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
    return makeSource({
      id: 'src-cm',
      name: 'Cannamonitor',
      sourceType: 'other',
      url: 'https://cannamonitor.com/cannabis-consulting-services/',
      ...overrides,
    })
  }

  // A decision-builder spy that FAILS if invoked — proves the checksum/decision
  // construction is never reached on a denial.
  function failBuilder() {
    return vi.fn(async () => {
      throw new Error('buildDecision must not be called for a denied Cannamonitor source')
    })
  }

  it('A: denies pasted content for a selected Cannamonitor source before any decision/checksum', async () => {
    const spy = failBuilder()
    const res = await runPastedMonitoringDecision(cannamonitorSource(), 'src-cm', MARKER, null, [], spy)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('cannamonitor_permission_unverified')
    expect(spy).not.toHaveBeenCalled()                 // checksum / rawText / decision never reached
    expect(JSON.stringify(res)).not.toContain(MARKER)  // marker never enters any returned value
  })

  it('A: the pure gate classifies a Cannamonitor source as denied (permission unverified)', () => {
    const g = evaluatePastedMonitoringGate(cannamonitorSource())
    expect(g.action).toBe('deny')
    if (g.action === 'deny') expect(g.code).toBe('cannamonitor_permission_unverified')
  })

  it('B: a direct call cannot bypass the gate (no React component involved)', async () => {
    const spy = failBuilder()
    const res = await runPastedMonitoringDecision({ url: 'https://www.cannamonitor.com/brief/x' }, 'k', MARKER, null, [], spy)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('cannamonitor_permission_unverified')
    expect(spy).not.toHaveBeenCalled()
  })

  it('D: a government source with pasted text still produces the ordinary decision (checksum IS computed)', async () => {
    const res = await runPastedMonitoringDecision(makeSource(), 'source-rss-1', 'Some official notice text', null, [])
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.decision.kind).toBe('changed_pending_review')
      expect(res.decision.snapshot?.checksum).toBeTruthy()
    }
  })

  it('D: an unrelated commercial source is not blocked', async () => {
    const res = await runPastedMonitoringDecision(makeSource({ url: 'https://unrelated.example.com/feed' }), 'k', 'text', null, [])
    expect(res.ok).toBe(true)
  })

  it('D: a blank or unrelated source URL is not falsely blocked (documented attribution limitation)', async () => {
    expect(evaluatePastedMonitoringGate({ url: '' }).action).toBe('proceed')
    expect(evaluatePastedMonitoringGate(null).action).toBe('proceed')
    const res = await runPastedMonitoringDecision({ url: '' }, 'k', 'pasted text with no attribution', null, [])
    expect(res.ok).toBe(true)
  })

  it('E: on denial nothing persistable is produced (no decision, no snapshot; real builder never runs)', async () => {
    const spy = failBuilder()
    const res = await runPastedMonitoringDecision(cannamonitorSource(), 'src-cm', MARKER, null, [], spy)
    expect(res.ok).toBe(false)
    expect('decision' in res).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

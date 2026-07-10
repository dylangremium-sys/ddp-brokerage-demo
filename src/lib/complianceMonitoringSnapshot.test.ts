import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import { runManualRssMonitoring } from './complianceManualMonitoring'
import type { RssFetchImpl, RssFetchResponse } from './complianceRssConnector'
import {
  isValidBaseline,
  baselineToPreviousSnapshots,
  buildBaselineCandidate,
  decideBaselineSave,
  nextBaselineVersion,
  type MonitoringBaseline,
} from './complianceMonitoringSnapshot'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Thai FDA Notices</title>
  <item><title>Notice A</title><link>https://www.fda.moph.go.th/a</link><guid>guid-a</guid><description>Body A</description><pubDate>Wed, 09 Jul 2026 10:00:00 GMT</pubDate></item>
  <item><title>ประกาศ B</title><link>https://www.fda.moph.go.th/b</link><guid>guid-b</guid><description>เนื้อหาภาษาไทย</description><pubDate>Wed, 09 Jul 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`
const RSS_XML_CHANGED = RSS_XML.replace('<description>Body A</description>', '<description>Body A — amended</description>')
const RSS_XML_NEW_ITEM = RSS_XML.replace('</channel>', '<item><title>Notice C</title><link>https://www.fda.moph.go.th/c</link><guid>guid-c</guid><description>Body C</description></item></channel>')
const RSS_XML_EMPTY = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'source-rss-1', name: 'Thai FDA', jurisdiction: 'Thailand', sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/rss.xml', isActive: true, lastCheckedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}
function mockFetch(body: string): RssFetchImpl {
  return async () => ({
    ok: true, status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/rss+xml' : null) },
    text: async () => body,
  } as RssFetchResponse)
}
const NOW = () => '2026-07-10T00:00:00.000Z'

const RAW_MODULE = import.meta.glob('./complianceMonitoringSnapshot.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const MODULE_SOURCE = Object.values(RAW_MODULE)[0] ?? ''

// ─── Baseline build + comparison integration ─────────────────────────────────

describe('technical baseline build + comparison', () => {
  it('a first run has no baseline and returns changed_pending_review for every item', async () => {
    const run = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW })
    expect(run.items.every(i => i.decisionKind === 'changed_pending_review')).toBe(true)
  })

  it('builds a saveable baseline from a completed run (technical evidence, Thai preserved)', () => {
    return runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW }).then(run => {
      const baseline = buildBaselineCandidate(makeSource(), run, 'bl-1', NOW(), 1)
      expect(baseline.sourceId).toBe('source-rss-1')
      expect(baseline.connectorKind).toBe('rss')
      expect(baseline.itemCount).toBe(2)
      expect(baseline.items[1].itemTitle).toBe('ประกาศ B') // Unicode preserved
      expect(baseline.items[0].checksum).toMatch(/^[0-9a-f]{64}$/)
      // Technical-only: no legal/compliance/approval fields anywhere.
      expect(JSON.stringify(baseline)).not.toMatch(/approved|compliant|certified|reviewed|legalUpdate|ruleId|enforce/i)
    })
  })

  it('re-running identical content against the saved baseline returns unchanged', async () => {
    const run1 = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW })
    const baseline = buildBaselineCandidate(makeSource(), run1, 'bl-1', NOW(), 1)
    const run2 = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW, previousSnapshots: baselineToPreviousSnapshots(baseline) })
    expect(run2.items.every(i => i.decisionKind === 'unchanged')).toBe(true)
  })

  it('changed content returns changed_pending_review against the baseline', async () => {
    const run1 = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW })
    const baseline = buildBaselineCandidate(makeSource(), run1, 'bl-1', NOW(), 1)
    const run2 = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML_CHANGED), { now: NOW, previousSnapshots: baselineToPreviousSnapshots(baseline) })
    expect(run2.items[0].decisionKind).toBe('changed_pending_review')
  })

  it('a first-seen new item returns changed_pending_review while known items stay unchanged', async () => {
    const run1 = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW })
    const baseline = buildBaselineCandidate(makeSource(), run1, 'bl-1', NOW(), 1)
    const run2 = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML_NEW_ITEM), { now: NOW, previousSnapshots: baselineToPreviousSnapshots(baseline) })
    const newItem = run2.items.find(i => i.itemTitle === 'Notice C')
    expect(newItem?.decisionKind).toBe('changed_pending_review')
    expect(run2.items.find(i => i.itemTitle === 'Notice A')?.decisionKind).toBe('unchanged')
  })
})

// ─── decideBaselineSave (pure gate) ──────────────────────────────────────────

describe('decideBaselineSave', () => {
  it('accepts a completed successful result for the matching source', async () => {
    const run = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW })
    expect(decideBaselineSave(run, 'source-rss-1', false).action).toBe('save')
  })

  it('rejects: no result, unsuccessful run, source mismatch, empty snapshots, and save-in-progress', async () => {
    expect(decideBaselineSave(null, 'source-rss-1', false)).toMatchObject({ action: 'reject', code: 'no_result' })

    const bad = await runManualRssMonitoring(makeSource({ isActive: false }), mockFetch(RSS_XML), { now: NOW })
    expect(decideBaselineSave(bad, 'source-rss-1', false)).toMatchObject({ action: 'reject', code: 'run_unsuccessful' })

    const run = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML), { now: NOW })
    expect(decideBaselineSave(run, 'a-different-source', false)).toMatchObject({ action: 'reject', code: 'source_mismatch' })
    expect(decideBaselineSave(run, null, false)).toMatchObject({ action: 'reject', code: 'source_mismatch' })

    const empty = await runManualRssMonitoring(makeSource(), mockFetch(RSS_XML_EMPTY), { now: NOW })
    expect(decideBaselineSave(empty, 'source-rss-1', false)).toMatchObject({ action: 'reject', code: 'no_valid_snapshots' })

    expect(decideBaselineSave(run, 'source-rss-1', true)).toMatchObject({ action: 'reject', code: 'save_in_progress' })
  })
})

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('nextBaselineVersion increments past the highest', () => {
    expect(nextBaselineVersion([])).toBe(1)
    expect(nextBaselineVersion([{ baselineVersion: 3 } as MonitoringBaseline, { baselineVersion: 1 } as MonitoringBaseline])).toBe(4)
  })

  it('baselineToPreviousSnapshots keys by stable id with the stored checksum', () => {
    const baseline: MonitoringBaseline = {
      id: 'b', sourceId: 's', connectorKind: 'rss', feedTitle: 't', feedUrl: 'https://x/rss.xml',
      capturedAt: NOW(), baselineVersion: 1, itemCount: 1,
      items: [{ stableId: 's::guid-a', itemTitle: 'A', itemUrl: null, publishedAt: null, checksum: 'abc' }],
    }
    const map = baselineToPreviousSnapshots(baseline)
    expect(map.get('s::guid-a')?.checksum).toBe('abc')
    expect(map.get('s::guid-a')?.sourceId).toBe('s::guid-a')
    expect(baselineToPreviousSnapshots(null).size).toBe(0)
  })

  it('isValidBaseline accepts a well-formed baseline and rejects corrupt shapes', () => {
    const good: MonitoringBaseline = {
      id: 'b', sourceId: 's', connectorKind: 'atom', feedTitle: null, feedUrl: 'https://x',
      capturedAt: NOW(), baselineVersion: 1, itemCount: 0, items: [],
    }
    expect(isValidBaseline(good)).toBe(true)
    expect(isValidBaseline(null)).toBe(false)
    expect(isValidBaseline({ id: 'b' })).toBe(false)
    expect(isValidBaseline({ ...good, connectorKind: 'html' })).toBe(false)
    expect(isValidBaseline({ ...good, items: [{ stableId: 1 }] })).toBe(false)
    expect(isValidBaseline({ ...good, baselineVersion: 'x' })).toBe(false)
  })
})

// ─── Static safety ───────────────────────────────────────────────────────────

describe('safety', () => {
  it('the model module has no network/AI/Supabase/legal-write/scheduler capability', () => {
    expect(MODULE_SOURCE).not.toMatch(/\bfetch\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/aiCompliance|anthropic|openai/i)
    expect(MODULE_SOURCE).not.toMatch(/supabase\.\w|\.from\(|\brepo\.|\.insert\(|\.upsert\(/)
    expect(MODULE_SOURCE).not.toMatch(/insertLegalUpdate|createRule|approveRule|enforceRule/)
    expect(MODULE_SOURCE).not.toMatch(/setInterval|setTimeout|\bcron\b|localStorage\.|sessionStorage\./)
  })
})

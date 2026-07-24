import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import type { MonitoringDecision, SourceContentSnapshot } from './complianceSourceMonitoring'
import type { ParsedFeed, ParsedFeedItem, RssConnectorResult } from './complianceRssConnector'
import type {
  CandidateLegalUpdateInput,
  CandidateLegalUpdateResult,
  CloseIngestionRunInput,
  InsertIngestionItemInput,
  OpenIngestionRunInput,
} from './complianceRepository'
import {
  mapConnectorErrorToRunReason,
  runIngestionBatch,
  runIngestionForSource,
  summarizeBatch,
  type IngestionDeps,
  type MutableKnownRecordIndex,
} from './watchtowerIngestionService'

// ─── In-memory harness (no Supabase, no network) ─────────────────────────────

interface Recorder {
  runs: Array<{ id: string; open: OpenIngestionRunInput; close?: CloseIngestionRunInput }>
  items: InsertIngestionItemInput[]
  candidates: CandidateLegalUpdateInput[]
}

interface HarnessOptions {
  connectorResults: Record<string, RssConnectorResult | (() => Promise<RssConnectorResult>)>
  knownContentHashes?: string[]
  knownSourceExternalIds?: string[]
  /** Force insertCandidate to report a duplicate for these content hashes. */
  duplicateHashes?: string[]
  /** Force insertCandidate to hard-fail for these content hashes. */
  failCandidateHashes?: string[]
  failOpenRun?: boolean
}

function makeDeps(rec: Recorder, opts: HarnessOptions): IngestionDeps {
  let seq = 0
  return {
    trigger: 'manual',
    actorType: 'admin',
    actorId: null,
    now: () => '2026-01-01T00:00:00.000Z',
    runConnector: async (source) => {
      const r = opts.connectorResults[source.id]
      if (!r) throw new Error(`no connector fixture for ${source.id}`)
      return typeof r === 'function' ? r() : r
    },
    fetchKnownIdentity: async () => ({
      contentHashes: opts.knownContentHashes ?? [],
      sourceExternalIds: opts.knownSourceExternalIds ?? [],
    }),
    openRun: async (input) => {
      if (opts.failOpenRun) throw new Error('open failed')
      seq += 1
      const id = `run-${seq}`
      rec.runs.push({ id, open: input })
      return { id }
    },
    closeRun: async (id, input) => {
      const run = rec.runs.find(r => r.id === id)
      if (run) run.close = input
    },
    insertItem: async (input) => {
      rec.items.push(input)
    },
    insertCandidate: async (input): Promise<CandidateLegalUpdateResult> => {
      rec.candidates.push(input)
      if (opts.duplicateHashes?.includes(input.contentHash)) return { ok: false, duplicate: true }
      if (opts.failCandidateHashes?.includes(input.contentHash)) return { ok: false, error: 'insert boom' }
      return { ok: true, legalUpdate: { id: `lu-${input.contentHash}` } as never }
    },
  }
}

function source(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'src-1', name: 'Thai FDA', jurisdiction: 'TH', sourceType: 'government_regulator',
    url: 'https://feeds.example.gov/rss.xml', isActive: true,
    tier: 1, authorityType: 'primary_regulator', category: 'export_import', monitoringMethod: 'rss', priority: 5,
    lastCheckedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides,
  }
}

function feedItem(id: string, overrides: Partial<ParsedFeedItem> = {}): ParsedFeedItem {
  return { title: `notice ${id}`, link: `https://gov/${id}`, id, summary: null, content: null, published: null, rawText: `body-${id}`, ...overrides }
}

function snap(sourceId: string, checksum: string): SourceContentSnapshot {
  return { sourceId, normalizedContent: `n-${checksum}`, checksum, retrievedAt: '2026-01-01T00:00:00Z' }
}

function changed(sourceId: string, checksum: string): MonitoringDecision {
  return { kind: 'changed_pending_review', sourceId, reason: 'changed', snapshot: snap(sourceId, checksum), proposedLegalUpdate: { status: 'new', sourceId, rawContent: 'raw', normalizedContent: `n-${checksum}`, checksum, retrievedAt: '2026-01-01T00:00:00Z' } }
}

function connectorOk(items: ParsedFeedItem[], decisions: MonitoringDecision[]): RssConnectorResult {
  const feed: ParsedFeed = { kind: 'rss', title: 'feed', items }
  return { ok: true, sourceId: 'src-1', feedKind: 'rss', itemCount: items.length, decisions, feed, reason: 'ok', performsPersistence: false, canCreateLegalUpdate: false, canCreateRule: false, canCallAI: false }
}

function connectorFail(errorCode: RssConnectorResult['errorCode'], reason = 'boom'): RssConnectorResult {
  return { ok: false, sourceId: 'src-1', itemCount: 0, decisions: [], errorCode, reason, performsPersistence: false, canCreateLegalUpdate: false, canCreateRule: false, canCallAI: false }
}

function freshIndex(hashes: string[] = [], extIds: string[] = []): MutableKnownRecordIndex {
  return { contentHashes: new Set(hashes), sourceExternalIds: new Set(extIds) }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runIngestionForSource — happy path', () => {
  it('creates a draft candidate for a new item and closes the run succeeded', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const it0 = feedItem('DOC-1')
    const deps = makeDeps(rec, { connectorResults: { 'src-1': connectorOk([it0], [changed('src-1::DOC-1', 'h1')]) } })

    const result = await runIngestionForSource(source(), deps, freshIndex())

    expect(result.summary.status).toBe('succeeded')
    expect(rec.candidates).toHaveLength(1)
    // The candidate input carries no caller-settable status: the repository
    // hardcodes 'new', so a non-draft candidate is structurally unexpressible.
    expect('status' in rec.candidates[0]).toBe(false)
    expect(rec.candidates[0].sourceTier).toBe(1)
    expect(rec.candidates[0].ingestionRunId).toBe('run-1')  // provenance linked
    expect(rec.items).toHaveLength(1)
    expect(rec.items[0].dedupDecision).toBe('new')
    expect(rec.items[0].legalUpdateId).toBe('lu-h1')
    expect(rec.runs[0].close?.status).toBe('succeeded')
    expect(rec.runs[0].close?.itemsNew).toBe(1)
  })
})

describe('runIngestionForSource — dedup behaviour', () => {
  it('does NOT create a candidate when the content hash is already known', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, {
      connectorResults: { 'src-1': connectorOk([feedItem('DOC-1')], [changed('src-1::DOC-1', 'h1')]) },
      knownContentHashes: ['h1'],
    })

    const result = await runIngestionForSource(source(), deps, freshIndex(['h1']))

    expect(rec.candidates).toHaveLength(0)                       // no unintended write
    expect(rec.items[0].dedupDecision).toBe('duplicate_content_hash')
    expect(result.summary.status).toBe('succeeded')             // a duplicate is not a failure
    expect(result.summary.counters.itemsDuplicate).toBe(1)
  })

  it('reclassifies a lost dedup race (unique violation) as a duplicate, not a failure', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, {
      connectorResults: { 'src-1': connectorOk([feedItem('DOC-1')], [changed('src-1::DOC-1', 'h1')]) },
      duplicateHashes: ['h1'],
    })

    const result = await runIngestionForSource(source(), deps, freshIndex())

    expect(rec.candidates).toHaveLength(1)                      // it tried
    expect(rec.items[0].dedupDecision).toBe('duplicate_content_hash')
    expect(rec.items[0].legalUpdateId).toBeNull()
    expect(result.summary.status).toBe('succeeded')            // race ≠ failure
  })

  it('deduplicates the same notice mirrored twice within one feed', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, {
      connectorResults: { 'src-1': connectorOk([feedItem('DOC-1'), feedItem('DOC-1')], [changed('src-1::DOC-1', 'h1'), changed('src-1::DOC-1', 'h1')]) },
    })

    await runIngestionForSource(source(), deps, freshIndex())

    expect(rec.candidates).toHaveLength(1)                      // only one draft
    expect(rec.items.map(i => i.dedupDecision)).toEqual(['new', 'duplicate_content_hash'])
  })
})

describe('runIngestionForSource — failure states (fail-conservative)', () => {
  it('records an unavailable source as a FAILED run, never a zero-change success', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: { 'src-1': connectorFail('fetch_failed', 'host down') } })

    const result = await runIngestionForSource(source(), deps, freshIndex())

    expect(result.summary.status).toBe('failed')
    expect(result.summary.failureReason).toBe('source_unavailable')
    expect(rec.items).toHaveLength(0)
    expect(rec.candidates).toHaveLength(0)
    expect(rec.runs[0].close?.status).toBe('failed')
    expect(rec.runs[0].close?.failureReason).toBe('source_unavailable')
  })

  it('maps an off-allowlist connector rejection to a failed run with that reason', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: { 'src-1': connectorFail('off_allowlist') } })
    const result = await runIngestionForSource(source(), deps, freshIndex())
    expect(result.summary.failureReason).toBe('off_allowlist')
  })

  it('treats a connector that throws as source_unavailable, still recording the run', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: { 'src-1': async () => { throw new Error('network') } } })
    const result = await runIngestionForSource(source(), deps, freshIndex())
    expect(result.summary.status).toBe('failed')
    expect(rec.runs[0].close?.status).toBe('failed')
  })

  it('marks the run partial (never succeeded) when a candidate insert hard-fails', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, {
      connectorResults: { 'src-1': connectorOk([feedItem('DOC-1')], [changed('src-1::DOC-1', 'h1')]) },
      failCandidateHashes: ['h1'],
    })
    const result = await runIngestionForSource(source(), deps, freshIndex())
    expect(result.summary.status).toBe('partial')
    expect(rec.items[0].dedupDecision).toBe('error')
    expect(rec.items[0].failureReason).toBe('persistence_failed')
  })

  it('records a skipped run for a manual-method source and fetches nothing', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: {} }) // no connector fixture needed
    const result = await runIngestionForSource(source({ monitoringMethod: 'manual' }), deps, freshIndex())
    expect(result.summary.status).toBe('skipped')
    expect(result.summary.failureReason).toBe('source_disabled')
    expect(rec.items).toHaveLength(0)
    expect(rec.candidates).toHaveLength(0)
  })

  it('records a skipped run for a disabled source', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: {} })
    const result = await runIngestionForSource(source({ isActive: false }), deps, freshIndex())
    expect(result.summary.status).toBe('skipped')
  })

  it('reports aborted (no state) when even opening the run fails', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: { 'src-1': connectorOk([], []) }, failOpenRun: true })
    const result = await runIngestionForSource(source(), deps, freshIndex())
    expect(result.aborted).toBe(true)
    expect(result.runId).toBeNull()
    expect(rec.items).toHaveLength(0)
  })
})

describe('runIngestionForSource — no unintended state mutation', () => {
  it('only ever writes draft candidates, ingestion items and run rows — nothing else', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const deps = makeDeps(rec, { connectorResults: { 'src-1': connectorOk([feedItem('DOC-1')], [changed('src-1::DOC-1', 'h1')]) } })
    await runIngestionForSource(source(), deps, freshIndex())
    // The candidate input type has no status field to set, and there is no
    // rule/alert/entity-status sink in the deps at all, so the runner
    // structurally cannot enforce a rule or mutate a business record.
    expect(rec.candidates.every(c => !('status' in c))).toBe(true)
  })
})

describe('runIngestionBatch', () => {
  it('processes sources most-authoritative first and dedups across sources in one batch', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const t3 = source({ id: 'src-3', tier: 3, authorityType: 'news_media', url: 'https://feeds.example.gov/t3.xml' })
    const t1 = source({ id: 'src-1', tier: 1, url: 'https://feeds.example.gov/t1.xml' })
    // Both feeds carry the SAME content hash h-dup: whoever runs first wins.
    const deps = makeDeps(rec, {
      connectorResults: {
        'src-1': connectorOk([feedItem('A')], [changed('src-1::A', 'h-dup')]),
        'src-3': connectorOk([feedItem('B')], [changed('src-3::B', 'h-dup')]),
      },
    })

    const report = await runIngestionBatch([t3, t1], deps)

    // Tier 1 ran first (authoritative order), created the only candidate; the
    // Tier 3 source saw the same content as an already-known duplicate.
    expect(rec.candidates).toHaveLength(1)
    expect(rec.candidates[0].sourceId).toBe('src-1')
    expect(report.succeeded).toBe(2)
    expect(report.newCandidates).toBe(1)
    expect(report.duplicates).toBe(1)
  })

  it('one source failing does not abort the batch', async () => {
    const rec: Recorder = { runs: [], items: [], candidates: [] }
    const good = source({ id: 'src-1', url: 'https://feeds.example.gov/g.xml' })
    const bad = source({ id: 'src-2', tier: 2, url: 'https://feeds.example.gov/b.xml' })
    const deps = makeDeps(rec, {
      connectorResults: {
        'src-1': connectorOk([feedItem('A')], [changed('src-1::A', 'h1')]),
        'src-2': connectorFail('timeout'),
      },
    })
    const report = await runIngestionBatch([good, bad], deps)
    expect(report.totalSources).toBe(2)
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(1)
  })
})

describe('mapConnectorErrorToRunReason', () => {
  it('maps a bare fetch failure to source_unavailable and undefined to source_unavailable', () => {
    expect(mapConnectorErrorToRunReason('fetch_failed')).toBe('source_unavailable')
    expect(mapConnectorErrorToRunReason(undefined)).toBe('source_unavailable')
    expect(mapConnectorErrorToRunReason('not_a_feed')).toBe('not_a_feed')
  })
})

describe('summarizeBatch', () => {
  it('counts aborted results separately from status buckets', () => {
    const report = summarizeBatch(2, [
      { sourceId: 'a', runId: null, summary: { status: 'failed', failureReason: 'persistence_failed', counters: { itemsSeen: 0, itemsNew: 0, itemsDuplicate: 0, itemsUnchanged: 0, itemsFailed: 0 } }, aborted: true },
      { sourceId: 'b', runId: 'r', summary: { status: 'succeeded', failureReason: null, counters: { itemsSeen: 1, itemsNew: 1, itemsDuplicate: 0, itemsUnchanged: 0, itemsFailed: 0 } } },
    ])
    expect(report.aborted).toBe(1)
    expect(report.succeeded).toBe(1)
    expect(report.newCandidates).toBe(1)
  })
})

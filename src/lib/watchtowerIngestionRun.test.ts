import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import type { MonitoringDecision, SourceContentSnapshot } from './complianceSourceMonitoring'
import type { ParsedFeedItem } from './complianceRssConnector'
import {
  classifyIngestionItem,
  detectStaleSources,
  emptyKnownRecordIndex,
  failedRunSummary,
  skippedRunSummary,
  summarizeRun,
  tallyOutcomes,
  type IngestionItemOutcome,
} from './watchtowerIngestionRun'

const SOURCE: Pick<RegulatorySource, 'id' | 'tier'> = { id: 'src-1', tier: 1 }

function item(overrides: Partial<ParsedFeedItem> = {}): ParsedFeedItem {
  return { title: 'A notice', link: 'https://gov/n/1', id: 'DOC-1', summary: null, content: null, published: '2026-01-01T00:00:00Z', rawText: 'body', ...overrides }
}

function snapshot(checksum: string): SourceContentSnapshot {
  return { sourceId: 'src-1::DOC-1', normalizedContent: 'body', checksum, retrievedAt: '2026-01-01T00:00:00Z' }
}

function changeDecision(checksum: string): MonitoringDecision {
  return {
    kind: 'changed_pending_review',
    sourceId: 'src-1::DOC-1',
    reason: 'changed',
    snapshot: snapshot(checksum),
    proposedLegalUpdate: { status: 'new', sourceId: 'src-1::DOC-1', rawContent: 'body', normalizedContent: 'body', checksum, retrievedAt: '2026-01-01T00:00:00Z' },
  }
}

function freshSeen() {
  return { contentHashes: new Set<string>(), sourceExternalIds: new Set<string>() }
}

describe('classifyIngestionItem', () => {
  it('classifies a genuinely new change as new with a proposed draft', () => {
    const out = classifyIngestionItem(SOURCE, item(), changeDecision('h1'), emptyKnownRecordIndex(), freshSeen())
    expect(out.dedupDecision).toBe('new')
    expect(out.proposedDraft?.status).toBe('new')
    expect(out.proposedDraft?.contentHash).toBe('h1')
    expect(out.proposedDraft?.sourceTier).toBe(1)
    expect(out.externalDocumentId).toBe('DOC-1')
  })

  it('dedups against a content hash already persisted', () => {
    const known = { contentHashes: new Set(['h1']), sourceExternalIds: new Set<string>() }
    const out = classifyIngestionItem(SOURCE, item(), changeDecision('h1'), known, freshSeen())
    expect(out.dedupDecision).toBe('duplicate_content_hash')
    expect(out.proposedDraft).toBeNull()
  })

  it('dedups against a persisted (source, external id) even with different content', () => {
    const known = { contentHashes: new Set<string>(), sourceExternalIds: new Set(['src-1::DOC-1']) }
    const out = classifyIngestionItem(SOURCE, item(), changeDecision('h-new'), known, freshSeen())
    expect(out.dedupDecision).toBe('duplicate_external_id')
  })

  it('dedups a notice mirrored twice within the same run', () => {
    const seen = freshSeen()
    const first = classifyIngestionItem(SOURCE, item(), changeDecision('h1'), emptyKnownRecordIndex(), seen)
    const second = classifyIngestionItem(SOURCE, item(), changeDecision('h1'), emptyKnownRecordIndex(), seen)
    expect(first.dedupDecision).toBe('new')
    expect(second.dedupDecision).toBe('duplicate_content_hash')
  })

  it('maps an unchanged decision to unchanged with no draft', () => {
    const dec: MonitoringDecision = { kind: 'unchanged', sourceId: 'src-1::DOC-1', reason: 'same', snapshot: snapshot('h1') }
    const out = classifyIngestionItem(SOURCE, item(), dec, emptyKnownRecordIndex(), freshSeen())
    expect(out.dedupDecision).toBe('unchanged')
    expect(out.proposedDraft).toBeNull()
  })

  it('maps an invalid_source decision to invalid with a reason', () => {
    const dec: MonitoringDecision = { kind: 'invalid_source', sourceId: 'src-1::DOC-1', reason: 'empty after normalization' }
    const out = classifyIngestionItem(SOURCE, item(), dec, emptyKnownRecordIndex(), freshSeen())
    expect(out.dedupDecision).toBe('invalid')
    expect(out.failureReason).toBe('empty_content')
    expect(out.contentHash).toBeNull()
  })

  it('fails safe when a change decision carries no snapshot', () => {
    const dec = { kind: 'changed_pending_review', sourceId: 'src-1::DOC-1', reason: 'changed' } as MonitoringDecision
    const out = classifyIngestionItem(SOURCE, item(), dec, emptyKnownRecordIndex(), freshSeen())
    expect(out.dedupDecision).toBe('error')
    expect(out.failureReason).toBe('hash_failed')
  })

  it('carries a null tier through to the draft for an unclassified source', () => {
    const out = classifyIngestionItem({ id: 'src-1', tier: null }, item(), changeDecision('h1'), emptyKnownRecordIndex(), freshSeen())
    expect(out.proposedDraft?.sourceTier).toBeNull()
  })
})

describe('tallyOutcomes / summarizeRun', () => {
  function outcome(decision: IngestionItemOutcome['dedupDecision']): IngestionItemOutcome {
    return { itemKey: 'k', externalDocumentId: null, canonicalUrl: null, title: 't', publishedAt: null, contentHash: decision === 'invalid' ? null : 'h', normalizedLength: 1, dedupDecision: decision, dedupMatchedLegalUpdateId: null, legalUpdateId: null, failureReason: null, errorDetail: null, proposedDraft: null }
  }

  it('tallies each decision into the right bucket and balances to itemsSeen', () => {
    const outcomes = [outcome('new'), outcome('unchanged'), outcome('duplicate_content_hash'), outcome('error')]
    const c = tallyOutcomes(outcomes)
    expect(c).toEqual({ itemsSeen: 4, itemsNew: 1, itemsUnchanged: 1, itemsDuplicate: 1, itemsFailed: 1 })
    expect(c.itemsNew + c.itemsUnchanged + c.itemsDuplicate + c.itemsFailed).toBe(c.itemsSeen)
  })

  it('reports succeeded only when zero items failed', () => {
    const clean = summarizeRun([outcome('new'), outcome('unchanged'), outcome('duplicate_content_hash')])
    expect(clean.status).toBe('succeeded')
    expect(clean.failureReason).toBeNull()
  })

  it('reports partial (never succeeded) when any item failed', () => {
    const dirty = summarizeRun([outcome('new'), outcome('error')])
    expect(dirty.status).toBe('partial')
    expect(dirty.failureReason).toBe('partial_item_failure')
  })
})

describe('failed / skipped run summaries', () => {
  it('a failed run has zero item counters and an explicit reason', () => {
    const s = failedRunSummary('source_unavailable')
    expect(s.status).toBe('failed')
    expect(s.failureReason).toBe('source_unavailable')
    expect(s.counters.itemsSeen).toBe(0)
  })

  it('a skipped run is explicit, not silent', () => {
    const s = skippedRunSummary('source_disabled')
    expect(s.status).toBe('skipped')
    expect(s.failureReason).toBe('source_disabled')
  })
})

describe('detectStaleSources', () => {
  const now = '2026-01-10T00:00:00Z'

  it('flags a source that never succeeded', () => {
    expect(detectStaleSources([{ sourceId: 'a', lastSuccessfulRunAt: null }], 24, now)).toEqual(['a'])
  })

  it('flags a source whose last success is older than the window', () => {
    const stale = detectStaleSources([{ sourceId: 'a', lastSuccessfulRunAt: '2026-01-01T00:00:00Z' }], 24, now)
    expect(stale).toEqual(['a'])
  })

  it('does not flag a recently-succeeded source', () => {
    const fresh = detectStaleSources([{ sourceId: 'a', lastSuccessfulRunAt: '2026-01-09T18:00:00Z' }], 24, now)
    expect(fresh).toEqual([])
  })

  it('flags an unparseable timestamp as stale (fail closed)', () => {
    expect(detectStaleSources([{ sourceId: 'a', lastSuccessfulRunAt: 'not-a-date' }], 24, now)).toEqual(['a'])
  })
})

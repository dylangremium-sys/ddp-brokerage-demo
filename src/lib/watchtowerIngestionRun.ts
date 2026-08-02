import type { RegulatorySource } from '../types.js'
import type { MonitoringDecision } from './complianceSourceMonitoring.js'
import type { ParsedFeedItem, RssConnectorErrorCode } from './complianceRssConnector.js'

// ─── Watchtower ingestion run — pure orchestration core (Phase C) ────────────
//
// Turns the connector's per-item monitoring DECISIONS into (a) a set of
// ingestion-item outcome records and (b) a fail-conservative run summary. This
// module is pure and side-effect free: it fetches nothing, persists nothing,
// calls no AI, and creates no legal_update itself. It decides WHAT should be
// recorded; watchtowerIngestionService.ts performs the actual writes.
//
// Two things make this the trustworthy heart of Phase C:
//   1. The final run status is derived, never asserted — computeRunStatus()
//      cannot return 'succeeded' if any item failed or the source was
//      unavailable. "Source unavailable ⇒ monitoring failed" is enforced here
//      in code AND again by the migration-25 CHECK constraints at write time.
//   2. Cross-run dedup is decided here against already-known content hashes and
//      external document ids, so a notice already turned into a legal_update is
//      never turned into a second one.

// ─── Item outcome ────────────────────────────────────────────────────────────

export type IngestionDedupDecision =
  | 'new'
  | 'unchanged'
  | 'duplicate_content_hash'
  | 'duplicate_external_id'
  | 'duplicate_canonical_url'
  | 'invalid'
  | 'error'

export type IngestionItemFailureReason =
  | 'empty_content'
  | 'invalid_metadata'
  | 'oversized_item'
  | 'hash_failed'
  | 'persistence_failed'
  | 'governance_rejected'
  | 'internal_error'

/** Everything needed to persist one watchtower_ingestion_items row, plus the
 *  proposed draft (present only for a 'new' decision). Carries no capability to
 *  approve, enforce, summarise, or call AI. */
export interface IngestionItemOutcome {
  itemKey: string
  externalDocumentId: string | null
  canonicalUrl: string | null
  title: string
  publishedAt: string | null
  contentHash: string | null
  normalizedLength: number | null
  dedupDecision: IngestionDedupDecision
  dedupMatchedLegalUpdateId: string | null
  /** The candidate legal_update this item created, once persisted. Only ever set
   *  for a 'new' outcome; null until the service records the created row. */
  legalUpdateId: string | null
  failureReason: IngestionItemFailureReason | null
  errorDetail: string | null
  /** Present only when dedupDecision === 'new': the draft to create (status new). */
  proposedDraft: ProposedCandidateDraft | null
}

/** The candidate legal_update a 'new' item would create. `status` is the literal
 *  'new' — structurally impossible to propose an approved/active record, the
 *  same guarantee ProposedLegalUpdateIntent already makes. */
export interface ProposedCandidateDraft {
  status: 'new'
  sourceId: string
  title: string
  rawText: string
  contentHash: string
  canonicalUrl: string | null
  externalDocumentId: string | null
  publishedAt: string | null
  sourceTier: 1 | 2 | 3 | null
  itemKey: string
}

// ─── Known-record context for dedup ──────────────────────────────────────────

/** The already-persisted identity a run deduplicates against. Read once at the
 *  start of a run from legal_updates; passed in so this module stays pure. */
export interface KnownRecordIndex {
  contentHashes: ReadonlySet<string>
  /** `${sourceId}::${externalDocumentId}` for every persisted record that has one. */
  sourceExternalIds: ReadonlySet<string>
}

export function emptyKnownRecordIndex(): KnownRecordIndex {
  return { contentHashes: new Set(), sourceExternalIds: new Set() }
}

// ─── Per-item classification (pure) ──────────────────────────────────────────

/**
 * Classifies ONE feed item + its monitoring decision into an ingestion outcome,
 * given what is already known. `seenThisRun` accumulates identities within the
 * current run so a notice mirrored twice in one feed is caught even before it
 * reaches the DB unique index.
 *
 * Decision mapping:
 *   - decision.kind 'invalid_source'  → 'invalid'  (empty/unusable content)
 *   - decision.kind 'error'           → 'error'
 *   - decision.kind 'duplicate'/'unchanged' → 'unchanged'
 *   - decision.kind 'changed_pending_review':
 *       collides on content hash (known or this-run)  → 'duplicate_content_hash'
 *       collides on (source, external id)             → 'duplicate_external_id'
 *       otherwise                                     → 'new' (+ proposed draft)
 */
export function classifyIngestionItem(
  source: Pick<RegulatorySource, 'id' | 'tier'>,
  item: ParsedFeedItem,
  decision: MonitoringDecision,
  known: KnownRecordIndex,
  seenThisRun: {
    contentHashes: Set<string>
    sourceExternalIds: Set<string>
  },
): IngestionItemOutcome {
  const itemKey = decision.sourceId
  const externalDocumentId = normalizeExternalId(item.id)
  const canonicalUrl = normalizeUrl(item.link)
  const title = (item.title ?? '').slice(0, 1024)
  const publishedAt = item.published ?? null

  const base: Omit<IngestionItemOutcome, 'dedupDecision' | 'proposedDraft'> = {
    itemKey,
    externalDocumentId,
    canonicalUrl,
    title,
    publishedAt,
    contentHash: decision.snapshot?.checksum ?? null,
    normalizedLength: decision.snapshot?.normalizedContent.length ?? null,
    dedupMatchedLegalUpdateId: null,
    legalUpdateId: null,
    failureReason: null,
    errorDetail: null,
  }

  if (decision.kind === 'invalid_source') {
    return { ...base, contentHash: null, dedupDecision: 'invalid', failureReason: 'empty_content', errorDetail: decision.reason.slice(0, 2000), proposedDraft: null }
  }
  if (decision.kind === 'error') {
    return { ...base, dedupDecision: 'error', failureReason: 'internal_error', errorDetail: decision.reason.slice(0, 2000), proposedDraft: null }
  }
  if (decision.kind === 'unchanged' || decision.kind === 'duplicate') {
    return { ...base, dedupDecision: 'unchanged', proposedDraft: null }
  }

  // decision.kind === 'changed_pending_review' — a genuine candidate. Dedup it
  // against everything already known and everything seen so far this run.
  const hash = decision.snapshot?.checksum ?? null
  if (!hash) {
    // A change decision with no snapshot is internally inconsistent; fail safe.
    return { ...base, dedupDecision: 'error', failureReason: 'hash_failed', errorDetail: 'change decision carried no content snapshot', proposedDraft: null }
  }

  if (known.contentHashes.has(hash) || seenThisRun.contentHashes.has(hash)) {
    return { ...base, dedupDecision: 'duplicate_content_hash', proposedDraft: null }
  }

  if (externalDocumentId) {
    const extKey = `${source.id}::${externalDocumentId}`
    if (known.sourceExternalIds.has(extKey) || seenThisRun.sourceExternalIds.has(extKey)) {
      return { ...base, dedupDecision: 'duplicate_external_id', proposedDraft: null }
    }
    seenThisRun.sourceExternalIds.add(extKey)
  }
  seenThisRun.contentHashes.add(hash)

  const proposedDraft: ProposedCandidateDraft = {
    status: 'new',
    sourceId: source.id,
    title: title || `Source change detected: ${source.id}`,
    rawText: decision.proposedLegalUpdate?.rawContent ?? '',
    contentHash: hash,
    canonicalUrl,
    externalDocumentId,
    publishedAt,
    sourceTier: (source.tier ?? null) as ProposedCandidateDraft['sourceTier'],
    itemKey,
  }

  return { ...base, contentHash: hash, dedupDecision: 'new', proposedDraft }
}

function normalizeExternalId(id: string | null): string | null {
  if (!id) return null
  const trimmed = id.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 512)
}

function normalizeUrl(url: string | null): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 2048)
}

// ─── Run summary (pure, fail-conservative) ───────────────────────────────────

export type IngestionRunStatus = 'succeeded' | 'partial' | 'failed' | 'skipped'

export type IngestionRunFailureReason =
  | 'source_unavailable'
  | RssConnectorErrorCode
  | 'source_disabled'
  | 'governance_rejected'
  | 'persistence_failed'
  | 'partial_item_failure'
  | 'internal_error'

export interface IngestionRunCounters {
  itemsSeen: number
  itemsNew: number
  itemsDuplicate: number
  itemsUnchanged: number
  itemsFailed: number
}

export interface IngestionRunSummary {
  status: IngestionRunStatus
  failureReason: IngestionRunFailureReason | null
  counters: IngestionRunCounters
}

export function tallyOutcomes(outcomes: IngestionItemOutcome[]): IngestionRunCounters {
  const counters: IngestionRunCounters = {
    itemsSeen: outcomes.length,
    itemsNew: 0,
    itemsDuplicate: 0,
    itemsUnchanged: 0,
    itemsFailed: 0,
  }
  for (const o of outcomes) {
    switch (o.dedupDecision) {
      case 'new':
        counters.itemsNew += 1
        break
      case 'unchanged':
        counters.itemsUnchanged += 1
        break
      case 'duplicate_content_hash':
      case 'duplicate_external_id':
      case 'duplicate_canonical_url':
        counters.itemsDuplicate += 1
        break
      case 'invalid':
      case 'error':
        counters.itemsFailed += 1
        break
    }
  }
  return counters
}

/**
 * Derives the final run status from item outcomes. This is the fail-conservative
 * core: a run is 'succeeded' ONLY when every item was accounted for with zero
 * failures. Any failed item makes it 'partial'. It never returns 'succeeded'
 * for a run that saw a failure — the caller cannot override this by asserting a
 * status, because the caller does not choose the status at all.
 */
export function summarizeRun(outcomes: IngestionItemOutcome[]): IngestionRunSummary {
  const counters = tallyOutcomes(outcomes)
  if (counters.itemsFailed > 0) {
    return { status: 'partial', failureReason: 'partial_item_failure', counters }
  }
  return { status: 'succeeded', failureReason: null, counters }
}

/**
 * The run summary for a source whose connector never produced a usable result —
 * an unavailable source, an off-allowlist host, a malformed feed, etc. There are
 * NO item outcomes, and the status is 'failed' with an explicit reason. This is
 * the codified form of "source unavailable means monitoring failed, never no
 * changes": a failed fetch can only ever become a failed run, never a silent
 * zero-change success.
 */
export function failedRunSummary(reason: IngestionRunFailureReason): IngestionRunSummary {
  return {
    status: 'failed',
    failureReason: reason,
    counters: { itemsSeen: 0, itemsNew: 0, itemsDuplicate: 0, itemsUnchanged: 0, itemsFailed: 0 },
  }
}

/** A source that is disabled/skipped before any fetch — recorded explicitly, not
 *  omitted, so an operator can see it was deliberately not checked. */
export function skippedRunSummary(reason: IngestionRunFailureReason): IngestionRunSummary {
  return {
    status: 'skipped',
    failureReason: reason,
    counters: { itemsSeen: 0, itemsNew: 0, itemsDuplicate: 0, itemsUnchanged: 0, itemsFailed: 0 },
  }
}

// ─── Stale-source detection (pure) ───────────────────────────────────────────

export interface StaleSourceInput {
  sourceId: string
  lastSuccessfulRunAt: string | null
}

/**
 * Flags enabled sources that have not had a SUCCESSFUL run within `maxAgeHours`.
 * A source that has never succeeded (null) is always stale. Pure; the caller
 * supplies `nowIso` so this is deterministic in tests.
 */
export function detectStaleSources(
  sources: StaleSourceInput[],
  maxAgeHours: number,
  nowIso: string,
): string[] {
  const now = Date.parse(nowIso)
  const maxAgeMs = maxAgeHours * 3_600_000
  const stale: string[] = []
  for (const s of sources) {
    if (!s.lastSuccessfulRunAt) {
      stale.push(s.sourceId)
      continue
    }
    const last = Date.parse(s.lastSuccessfulRunAt)
    if (Number.isNaN(last) || now - last > maxAgeMs) {
      stale.push(s.sourceId)
    }
  }
  return stale
}

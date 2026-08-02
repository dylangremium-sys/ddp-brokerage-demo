import type { RegulatorySource } from '../types'
import {
  inferConnectorKind,
} from './complianceSourceConnectors'
import { executeRssConnector, type RssConnectorResult, type RssConnectorErrorCode } from './complianceRssConnector'
import { createServerProxyRssFetch } from './serverProxyRssFetch'
import { compareSourcesForMonitoring } from './complianceSourceGovernance'
import {
  classifyIngestionItem,
  failedRunSummary,
  skippedRunSummary,
  summarizeRun,
  type IngestionItemOutcome,
  type IngestionRunFailureReason,
  type IngestionRunSummary,
} from './watchtowerIngestionRun'
import * as repo from './complianceRepository'

// ─── Watchtower ingestion service — orchestration (Phase C) ──────────────────
//
// The triggerable ingestion runner. It loads enabled sources, retrieves each
// through the EXISTING connector architecture (executeRssConnector + injected
// fetch — no new transport), normalizes/hashes/deduplicates via the pure Phase-C
// core, creates candidate legal_updates in draft/new status ONLY, and records
// run + item evidence in the migration-25 tables.
//
// What it deliberately does NOT do (Phase D and later): rule enforcement, any
// business-record mutation, AI of any kind, alert generation. The only rows it
// creates outside the evidence tables are draft legal_updates with status
// 'new', which still pass through the same human Review Queue as a manual paste.
//
// Fail-conservative by construction: a source that cannot be retrieved becomes a
// FAILED run with an explicit reason, never a silent zero-change success. The
// run status is computed by the pure core, then re-validated by the migration-25
// CHECK constraints at write time — two independent guarantees.
//
// Every external dependency is injected (see IngestionDeps), so the whole runner
// is unit-testable with in-memory fakes and no Supabase/network.

// ─── Injected dependencies ───────────────────────────────────────────────────

export interface IngestionDeps {
  /** Retrieve + parse a source into a connector result. Real impl wraps
   *  executeRssConnector with the browser fetch adapter + host allowlist. */
  runConnector: (source: RegulatorySource) => Promise<RssConnectorResult>
  fetchKnownIdentity: () => Promise<{ contentHashes: string[]; sourceExternalIds: string[] }>
  openRun: (input: repo.OpenIngestionRunInput) => Promise<{ id: string }>
  closeRun: (id: string, input: repo.CloseIngestionRunInput) => Promise<unknown>
  insertItem: (input: repo.InsertIngestionItemInput) => Promise<void>
  insertCandidate: (input: repo.CandidateLegalUpdateInput) => Promise<repo.CandidateLegalUpdateResult>
  now: () => string
  trigger: 'scheduled' | 'manual' | 'backfill'
  actorType: 'admin' | 'system' | 'scheduler'
  actorId: string | null
}

export interface SourceIngestionResult {
  sourceId: string
  runId: string | null
  summary: IngestionRunSummary
  /** True when nothing was persisted because opening the run itself failed. */
  aborted?: boolean
  abortReason?: string
}

// ─── Connector-error → run-failure-reason mapping (pure) ─────────────────────

const CONNECTOR_ERROR_TO_RUN_REASON: Record<RssConnectorErrorCode, IngestionRunFailureReason> = {
  not_https: 'not_https',
  off_allowlist: 'off_allowlist',
  url_unsafe: 'url_unsafe',
  unsupported_connector: 'unsupported_connector',
  timeout: 'timeout',
  oversized_response: 'oversized_response',
  invalid_content_type: 'invalid_content_type',
  redirect_blocked: 'redirect_blocked',
  fetch_failed: 'source_unavailable',
  malformed_feed: 'malformed_feed',
  not_a_feed: 'not_a_feed',
  source_policy_denied: 'source_policy_denied',
}

export function mapConnectorErrorToRunReason(code: RssConnectorErrorCode | undefined): IngestionRunFailureReason {
  if (!code) return 'source_unavailable'
  return CONNECTOR_ERROR_TO_RUN_REASON[code] ?? 'source_unavailable'
}

// ─── Single-source ingestion ─────────────────────────────────────────────────

function connectorKindForSource(source: RegulatorySource): string {
  // Prefer the operator's declared monitoring method (migration 26); fall back
  // to inference from the URL. 'manual' sources are handled by the caller.
  if (source.monitoringMethod && source.monitoringMethod !== 'manual') {
    return source.monitoringMethod
  }
  return inferConnectorKind(source)
}

/**
 * Runs ingestion for ONE source end to end. Opens a run, retrieves + classifies,
 * persists candidate drafts + item evidence, then closes the run with a computed
 * status. Never throws for an ordinary failure (unavailable source, parse error,
 * a single item failing to persist) — those become recorded run/item states. It
 * only reports `aborted` if it could not even open the run to record anything.
 */
/** Mutable known-index used within a batch so a candidate created for one source
 *  is immediately visible as "known" to every later source in the same batch. */
export interface MutableKnownRecordIndex {
  contentHashes: Set<string>
  sourceExternalIds: Set<string>
}

export async function runIngestionForSource(
  source: RegulatorySource,
  deps: IngestionDeps,
  knownIndex: MutableKnownRecordIndex,
): Promise<SourceIngestionResult> {
  // A manual-method source is never auto-fetched: record an explicit skipped run
  // so the operator sees it was intentionally not checked, not silently ignored.
  if (source.monitoringMethod === 'manual') {
    return await recordUnfetchedRun(source, deps, skippedRunSummary('source_disabled'), 'manual monitoring method — not auto-fetched')
  }
  if (!source.isActive) {
    return await recordUnfetchedRun(source, deps, skippedRunSummary('source_disabled'), 'source is disabled')
  }

  const connectorKind = connectorKindForSource(source)

  let runId: string
  try {
    const run = await deps.openRun({
      sourceId: source.id,
      sourceNameSnapshot: source.name,
      sourceUrlSnapshot: source.url,
      sourceTierSnapshot: source.tier ?? null,
      connectorKind,
      triggerType: deps.trigger,
      actorType: deps.actorType,
      actorId: deps.actorId,
    })
    runId = run.id
  } catch (err) {
    return {
      sourceId: source.id,
      runId: null,
      summary: failedRunSummary('persistence_failed'),
      aborted: true,
      abortReason: err instanceof Error ? err.message : 'could not open ingestion run',
    }
  }

  // Retrieve. A connector failure is a FAILED run, never a zero-change success.
  let connectorResult: RssConnectorResult
  try {
    connectorResult = await deps.runConnector(source)
  } catch (err) {
    const summary = failedRunSummary('source_unavailable')
    await safeCloseRun(deps, runId, summary, err instanceof Error ? err.message : 'connector threw')
    return { sourceId: source.id, runId, summary }
  }

  if (!connectorResult.ok) {
    const summary = failedRunSummary(mapConnectorErrorToRunReason(connectorResult.errorCode))
    await safeCloseRun(deps, runId, summary, connectorResult.reason)
    return { sourceId: source.id, runId, summary }
  }

  // Classify every (item, decision) pair. feed.items align 1:1 with decisions.
  const items = connectorResult.feed?.items ?? []
  const decisions = connectorResult.decisions
  const seenThisRun = { contentHashes: new Set<string>(), sourceExternalIds: new Set<string>() }
  const outcomes: IngestionItemOutcome[] = []

  for (let i = 0; i < decisions.length; i += 1) {
    const decision = decisions[i]
    const item = items[i] ?? { title: null, link: null, id: null, summary: null, content: null, published: null, rawText: '' }
    let outcome = classifyIngestionItem(source, item, decision, knownIndex, seenThisRun)

    // Persist a candidate draft for a genuinely new item. A lost dedup race
    // (unique violation) reclassifies to duplicate; a hard error marks the item
    // failed so the run cannot report success.
    if (outcome.dedupDecision === 'new' && outcome.proposedDraft) {
      const draft = outcome.proposedDraft
      try {
        const result = await deps.insertCandidate({
          sourceId: draft.sourceId,
          sourceName: source.name,
          sourceUrl: source.url,
          jurisdiction: source.jurisdiction,
          title: draft.title,
          rawText: draft.rawText,
          contentHash: draft.contentHash,
          canonicalUrl: draft.canonicalUrl,
          externalDocumentId: draft.externalDocumentId,
          sourceTier: draft.sourceTier,
          ingestionRunId: runId,
          ingestionItemKey: draft.itemKey,
          publishedAt: draft.publishedAt,
        })
        if (result.ok && result.legalUpdate) {
          outcome = { ...outcome, legalUpdateId: result.legalUpdate.id }
          // Register the just-created identity so no later item in this batch —
          // this source or a subsequent one — creates a second copy.
          knownIndex.contentHashes.add(draft.contentHash)
          if (draft.externalDocumentId) {
            knownIndex.sourceExternalIds.add(`${draft.sourceId}::${draft.externalDocumentId}`)
          }
        } else if (result.duplicate) {
          outcome = { ...outcome, dedupDecision: 'duplicate_content_hash', proposedDraft: null }
        } else {
          outcome = { ...outcome, dedupDecision: 'error', failureReason: 'persistence_failed', errorDetail: (result.error ?? 'candidate insert failed').slice(0, 2000), proposedDraft: null }
        }
      } catch (err) {
        outcome = { ...outcome, dedupDecision: 'error', failureReason: 'persistence_failed', errorDetail: err instanceof Error ? err.message.slice(0, 2000) : 'candidate insert threw', proposedDraft: null }
      }
    }

    // Record the item evidence. If evidence itself cannot be written, count the
    // item as failed so the run is at best 'partial' — never a clean success.
    try {
      await deps.insertItem({
        runId,
        sourceId: source.id,
        itemKey: outcome.itemKey,
        externalDocumentId: outcome.externalDocumentId,
        canonicalUrl: outcome.canonicalUrl,
        title: outcome.title,
        publishedAt: outcome.publishedAt,
        contentHash: outcome.contentHash,
        normalizedLength: outcome.normalizedLength,
        dedupDecision: outcome.dedupDecision,
        dedupMatchedLegalUpdateId: outcome.dedupMatchedLegalUpdateId,
        legalUpdateId: outcome.legalUpdateId ?? null,
        failureReason: outcome.failureReason,
        errorDetail: outcome.errorDetail,
      })
    } catch (err) {
      outcome = {
        ...outcome,
        dedupDecision: outcome.dedupDecision === 'new' ? 'error' : outcome.dedupDecision,
        failureReason: 'persistence_failed',
        errorDetail: err instanceof Error ? err.message.slice(0, 2000) : 'item insert threw',
      }
    }

    outcomes.push(outcome)
  }

  const summary = summarizeRun(outcomes)
  await safeCloseRun(deps, runId, summary, summary.status === 'partial' ? 'one or more items failed' : null)
  return { sourceId: source.id, runId, summary }
}

async function recordUnfetchedRun(
  source: RegulatorySource,
  deps: IngestionDeps,
  summary: IngestionRunSummary,
  detail: string,
): Promise<SourceIngestionResult> {
  try {
    const run = await deps.openRun({
      sourceId: source.id,
      sourceNameSnapshot: source.name,
      sourceUrlSnapshot: source.url,
      sourceTierSnapshot: source.tier ?? null,
      connectorKind: 'manual',
      triggerType: deps.trigger,
      actorType: deps.actorType,
      actorId: deps.actorId,
    })
    await safeCloseRun(deps, run.id, summary, detail)
    return { sourceId: source.id, runId: run.id, summary }
  } catch (err) {
    return {
      sourceId: source.id,
      runId: null,
      summary,
      aborted: true,
      abortReason: err instanceof Error ? err.message : 'could not record skipped run',
    }
  }
}

async function safeCloseRun(
  deps: IngestionDeps,
  runId: string,
  summary: IngestionRunSummary,
  errorDetail: string | null,
): Promise<void> {
  try {
    await deps.closeRun(runId, {
      status: summary.status,
      failureReason: summary.failureReason,
      errorDetail: errorDetail ? errorDetail.slice(0, 2000) : null,
      itemsSeen: summary.counters.itemsSeen,
      itemsNew: summary.counters.itemsNew,
      itemsDuplicate: summary.counters.itemsDuplicate,
      itemsUnchanged: summary.counters.itemsUnchanged,
      itemsFailed: summary.counters.itemsFailed,
      finishedAt: deps.now(),
    })
  } catch {
    // The run stays 'running' if closing fails; stuck-run detection (the
    // in-flight index from migration 25) surfaces it. We never throw here — a
    // failure to close must not mask the ingestion outcome for other sources.
  }
}

// ─── Batch ingestion over enabled sources ────────────────────────────────────

export interface BatchIngestionReport {
  totalSources: number
  succeeded: number
  partial: number
  failed: number
  skipped: number
  aborted: number
  newCandidates: number
  duplicates: number
  results: SourceIngestionResult[]
}

/**
 * Runs ingestion across the supplied enabled sources, most-authoritative first
 * (Tier 1 → 3, then priority) via compareSourcesForMonitoring. Known-identity is
 * read ONCE up front and threaded through all sources so cross-source dedup
 * holds within a single batch. One source failing never aborts the batch.
 */
export async function runIngestionBatch(
  sources: RegulatorySource[],
  deps: IngestionDeps,
): Promise<BatchIngestionReport> {
  const known = await deps.fetchKnownIdentity()
  const knownIndex: MutableKnownRecordIndex = {
    contentHashes: new Set(known.contentHashes),
    sourceExternalIds: new Set(known.sourceExternalIds),
  }

  const ordered = [...sources].sort(compareSourcesForMonitoring)
  const results: SourceIngestionResult[] = []
  // Deliberately sequential: a shared known-identity index makes concurrent
  // runs race on dedup, so one source is fully processed before the next.
  for (const source of ordered) {
    const result = await runIngestionForSource(source, deps, knownIndex)
    results.push(result)
  }

  return summarizeBatch(sources.length, results)
}

export function summarizeBatch(totalSources: number, results: SourceIngestionResult[]): BatchIngestionReport {
  const report: BatchIngestionReport = {
    totalSources,
    succeeded: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    aborted: 0,
    newCandidates: 0,
    duplicates: 0,
    results,
  }
  for (const r of results) {
    if (r.aborted) report.aborted += 1
    switch (r.summary.status) {
      case 'succeeded': report.succeeded += 1; break
      case 'partial': report.partial += 1; break
      case 'failed': report.failed += 1; break
      case 'skipped': report.skipped += 1; break
    }
    report.newCandidates += r.summary.counters.itemsNew
    report.duplicates += r.summary.counters.itemsDuplicate
  }
  return report
}

// ─── Default (real) dependency wiring ────────────────────────────────────────

export interface DefaultIngestionDepsConfig {
  allowedHosts: string[]
  userAgent: string
  trigger?: 'scheduled' | 'manual' | 'backfill'
  actorType?: 'admin' | 'system' | 'scheduler'
  actorId?: string | null
  timeoutMs?: number
  maxResponseBytes?: number
  /**
   * Returns the caller's Supabase access token for the server retrieval call.
   *
   * REQUIRED rather than defaulted. A default would let a call site forget it
   * and get an ingestion run that fails every source with "no active session" —
   * a failure that looks like eight unreachable regulators rather than one
   * missing argument.
   */
  getAccessToken: () => Promise<string | null>
}

/**
 * Wires the real repository + the existing RSS/Atom connector, retrieving
 * through the SERVER (api/compliance/feed-retrieve) rather than from the
 * browser. The host allowlist is REQUIRED and deny-by-default — the connector
 * refuses any source whose host is not listed. Only the RSS/Atom/feed modality
 * is auto-fetched today; other kinds surface as an 'unsupported_connector'
 * failed run, which is the correct fail-closed behaviour.
 *
 * The transport changed here on purpose and the connector did not. Browser
 * retrieval never worked and could not be made to work: the deployed CSP
 * refuses `connect-src` to any regulator, and both registered feeds send no
 * CORS header either (docs/CSP_FEED_RETRIEVAL_DECISION.md). Every "Run
 * ingestion now" before this change was guaranteed to record a failed run.
 *
 * The fetch implementation is built PER SOURCE because the server endpoint
 * takes a source ID, not a URL — see createServerProxyRssFetch for why that
 * asymmetry is load-bearing rather than accidental.
 */
export function createDefaultIngestionDeps(config: DefaultIngestionDepsConfig): IngestionDeps {
  return {
    runConnector: (source) =>
      executeRssConnector(source, config.allowedHosts, createServerProxyRssFetch(source.id, {
        getAccessToken: config.getAccessToken,
      }), {
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
      }),
    fetchKnownIdentity: () => repo.fetchKnownLegalUpdateIdentity(),
    openRun: (input) => repo.openIngestionRun(input),
    closeRun: (id, input) => repo.closeIngestionRun(id, input),
    insertItem: (input) => repo.insertIngestionItem(input),
    insertCandidate: (input) => repo.insertCandidateLegalUpdate(input),
    now: () => new Date().toISOString(),
    trigger: config.trigger ?? 'manual',
    actorType: config.actorType ?? 'admin',
    actorId: config.actorId ?? null,
  }
}

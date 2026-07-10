import type { RegulatorySource } from '../types'
import type { SourceContentSnapshot } from './complianceSourceMonitoring'
import type { ManualMonitoringRunResult } from './complianceManualMonitoring'

// ─── Manual monitoring technical snapshot baselines — model + pure helpers ──
// ─── (Phase 2E) ─────────────────────────────────────────────────────────────
//
// A "technical baseline" is a saved set of feed-item checksums plus minimal
// display evidence, captured from a completed manual RSS/Atom check. It is
// MONITORING EVIDENCE ONLY. It never represents legal approval, legal review,
// regulatory confirmation, compliance certification, rule approval, or
// enforceable policy — and this model has no field capable of expressing any
// of those. Nothing here persists, fetches, calls AI, or writes a legal
// update / rule. Every export is pure.
//
// Storage lives behind MonitoringSnapshotRepository (interface) with a
// localStorage implementation; this file owns only the data shape and the
// pure logic for building, validating, comparing-input, and deciding saves.

export interface MonitoringSnapshotItem {
  /** Stable per-item id the checksum is compared under (guid/atom-id/link). */
  stableId: string
  itemTitle: string | null
  itemUrl: string | null
  publishedAt: string | null
  checksum: string
}

export interface MonitoringBaseline {
  id: string
  sourceId: string
  connectorKind: 'rss' | 'atom'
  feedTitle: string | null
  feedUrl: string
  capturedAt: string
  baselineVersion: number
  itemCount: number
  items: MonitoringSnapshotItem[]
}

// ─── Validation of persisted data (corruption-safe) ──────────────────────────

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

function isSnapshotItem(v: unknown): v is MonitoringSnapshotItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.stableId === 'string' &&
    typeof o.checksum === 'string' &&
    isStringOrNull(o.itemTitle) &&
    isStringOrNull(o.itemUrl) &&
    isStringOrNull(o.publishedAt)
  )
}

/** True only for a well-formed baseline. Anything else is treated as corrupt
 *  and must be rejected/ignored by the repository, never trusted. */
export function isValidBaseline(v: unknown): v is MonitoringBaseline {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.sourceId === 'string' &&
    (o.connectorKind === 'rss' || o.connectorKind === 'atom') &&
    isStringOrNull(o.feedTitle) &&
    typeof o.feedUrl === 'string' &&
    typeof o.capturedAt === 'string' &&
    typeof o.baselineVersion === 'number' && Number.isFinite(o.baselineVersion) &&
    typeof o.itemCount === 'number' &&
    Array.isArray(o.items) &&
    o.items.every(isSnapshotItem)
  )
}

// ─── Baseline → previous-snapshots (for the next comparison) ─────────────────

/**
 * Rebuilds the Map the connector expects as `previousSnapshots`, keyed by the
 * item's stable id. Only the checksum is needed for change detection, so
 * normalizedContent is intentionally left empty (it is never compared). Pure.
 */
export function baselineToPreviousSnapshots(baseline: MonitoringBaseline | null): Map<string, SourceContentSnapshot> {
  const map = new Map<string, SourceContentSnapshot>()
  if (!baseline) return map
  for (const item of baseline.items) {
    map.set(item.stableId, {
      sourceId: item.stableId,
      normalizedContent: '',
      checksum: item.checksum,
      retrievedAt: baseline.capturedAt,
    })
  }
  return map
}

// ─── Building a baseline from a completed run (pure) ──────────────────────────

/** Next version number = one past the highest in history (1 if empty). */
export function nextBaselineVersion(history: MonitoringBaseline[]): number {
  return history.reduce((max, b) => Math.max(max, b.baselineVersion), 0) + 1
}

/**
 * Converts a completed successful run into a saveable baseline. Only items
 * that produced a valid checksum are included (invalid_source items carry no
 * snapshot and are skipped). `id` and `capturedAt` are passed in so this stays
 * pure and deterministic under test.
 */
export function buildBaselineCandidate(
  source: RegulatorySource,
  runResult: ManualMonitoringRunResult,
  id: string,
  capturedAt: string,
  baselineVersion: number,
): MonitoringBaseline {
  const items: MonitoringSnapshotItem[] = runResult.items
    .filter(v => typeof v.checksum === 'string' && v.checksum.length > 0)
    .map(v => ({
      stableId: v.stableId,
      itemTitle: v.itemTitle,
      itemUrl: v.itemUrl,
      publishedAt: v.publishedAt,
      checksum: v.checksum as string,
    }))
  return {
    id,
    sourceId: source.id,
    connectorKind: runResult.connectorKind === 'atom' ? 'atom' : 'rss',
    feedTitle: runResult.feedTitle,
    feedUrl: source.url,
    capturedAt,
    baselineVersion,
    itemCount: items.length,
    items,
  }
}

// ─── Save gate (pure) ────────────────────────────────────────────────────────

export type BaselineSaveRejectionCode =
  | 'no_result'
  | 'run_unsuccessful'
  | 'source_mismatch'
  | 'no_valid_snapshots'
  | 'save_in_progress'

export type BaselineSaveDecision =
  | { action: 'save' }
  | { action: 'reject'; code: BaselineSaveRejectionCode; reason: string }

/**
 * Decides whether the current result may be saved as a baseline for
 * `selectedSourceId`. Rejects when: no result, the run did not succeed, the
 * result belongs to a different source (stale after switching sources), the
 * result has no valid snapshots, or a save is already running. Pure — the
 * caller performs the actual (explicit, human-initiated) write only on 'save'.
 */
export function decideBaselineSave(
  runResult: ManualMonitoringRunResult | null,
  selectedSourceId: string | null,
  saveInProgress: boolean,
): BaselineSaveDecision {
  if (saveInProgress) {
    return { action: 'reject', code: 'save_in_progress', reason: 'A baseline save is already in progress.' }
  }
  if (!runResult) {
    return { action: 'reject', code: 'no_result', reason: 'Run a feed check before saving a baseline.' }
  }
  if (!runResult.ok) {
    return { action: 'reject', code: 'run_unsuccessful', reason: 'The last feed check did not complete successfully.' }
  }
  if (!selectedSourceId || runResult.sourceId !== selectedSourceId) {
    return { action: 'reject', code: 'source_mismatch', reason: 'The displayed result is for a different source. Re-run the check for this source.' }
  }
  const hasValidSnapshot = runResult.items.some(v => typeof v.checksum === 'string' && v.checksum.length > 0)
  if (!hasValidSnapshot) {
    return { action: 'reject', code: 'no_valid_snapshots', reason: 'The feed produced no valid item snapshots to save.' }
  }
  return { action: 'save' }
}

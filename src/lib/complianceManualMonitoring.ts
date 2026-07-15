import type { RegulatorySource } from '../types'
import { selectConnectorForSource } from './complianceSourceConnectors'
import { normalizeConnectorHost } from './complianceSourceConnectorRuntime'
import {
  executeRssConnector,
  type ParsedFeedItem,
  type RssConnectorErrorCode,
  type RssConnectorResult,
  type RssFetchImpl,
} from './complianceRssConnector'
import type { MonitoringDecision, SourceContentSnapshot } from './complianceSourceMonitoring'
import { evaluateCannamonitorPolicy } from './complianceCannamonitorPolicy'

// ─── Manual Watchtower RSS monitoring — orchestration (Phase 2D) ────────────
//
// The bridge between a registered RegulatorySource and the Phase 2C RSS
// connector, for a MANUAL, human-initiated check. Everything here is pure or
// depends only on an injected fetch implementation — this module never
// references the global fetch, never persists, never writes to Supabase,
// never creates or approves a legal_update or rule, never calls AI, and never
// schedules anything. Its output is display-only evidence plus the connector's
// existing monitoring decisions, whose legal meaning is unchanged.
//
// It does not bypass any connector safety: it calls executeRssConnector, which
// runs buildConnectorRunPlan (HTTPS-only + deny-by-default allowlist + SSRF
// guard + kind check), rejects redirects, enforces timeout / max size /
// content-type, omits credentials, and sends only the supplied User-Agent.
//
// The allowlist for a manual run is the source's OWN host: a human explicitly
// chose this registered source, so we permit fetching exactly that host and
// nothing it might redirect to (the connector re-validates any final URL and
// blocks off-host redirects). This still exercises validateConnectorAllowlist —
// it is a per-source allowlist, not a bypass.

export const DEFAULT_MANUAL_MONITORING_USER_AGENT =
  'DDP-Compliance-Watchtower/1.0 (+manual read-only regulatory feed check)'

export type ManualMonitoringIneligibleCode =
  | 'inactive_source'
  | 'invalid_url'
  | 'unsupported_connector'
  /** A source-specific policy (today: Cannamonitor) denies retrieval. */
  | 'source_policy_denied'

export interface ManualMonitoringEligibility {
  eligible: boolean
  connectorKind?: 'rss' | 'atom'
  reason: string
  code?: ManualMonitoringIneligibleCode
}

/**
 * Pure pre-check that decides whether a source may be manually checked at all,
 * used both to gate the run and to enable/disable the UI action. A source is
 * eligible only when it is active, has a parseable host, and its registered
 * connector kind (per the existing contract, selectConnectorForSource) is RSS
 * or Atom. Unsupported kinds are never silently redirected to another
 * connector — they are reported as ineligible.
 */
export function evaluateManualMonitoringEligibility(source: RegulatorySource): ManualMonitoringEligibility {
  if (!source.isActive) {
    return { eligible: false, reason: 'Source is inactive.', code: 'inactive_source' }
  }

  // Source-specific policy gate. Checked here — ahead of any connector call —
  // so the UI can disable the action with an honest reason AND no fetch is
  // attempted. Evaluated even though `isActive` is already true: an active
  // Cannamonitor source is still denied while its commercial permission is
  // unverified, so marking a source active can never, on its own, enable
  // retrieval. The connector re-checks the same policy independently, so this
  // is a UX gate layered on top of an enforced one, not a substitute.
  const sourcePolicy = evaluateCannamonitorPolicy(source)
  if (sourcePolicy.matched && !sourcePolicy.monitoringAllowed) {
    return { eligible: false, reason: sourcePolicy.reason, code: 'source_policy_denied' }
  }

  if (!normalizeConnectorHost(source.url)) {
    return { eligible: false, reason: 'Source URL is missing or not a valid http(s) URL.', code: 'invalid_url' }
  }
  const selection = selectConnectorForSource(source)
  if (!selection.supported || (selection.kind !== 'rss' && selection.kind !== 'atom')) {
    return {
      eligible: false,
      reason: `This source is not an RSS/Atom feed (detected connector kind: ${selection.kind}).`,
      code: 'unsupported_connector',
    }
  }
  return { eligible: true, connectorKind: selection.kind, reason: `Eligible ${selection.kind} feed.` }
}

/**
 * Pure guard preventing concurrent runs from repeated clicks: a manual run may
 * start only when one is not already in progress.
 */
export function canStartManualRun(isRunning: boolean): boolean {
  return !isRunning
}

export interface ManualMonitoringItemView {
  /** Stable per-item identifier (guid/atom-id/link-derived) — the key a
   *  technical baseline snapshot is stored and compared under. */
  stableId: string
  decisionKind: MonitoringDecision['kind']
  reason: string
  itemTitle: string | null
  itemUrl: string | null
  publishedAt: string | null
  checksum: string | null
  /** True only for a changed/first-seen item that proposes a legal_update
   *  DRAFT (status 'new') — intent only; this phase creates nothing. */
  proposesLegalUpdateDraft: boolean
}

export interface ManualMonitoringRunResult {
  ok: boolean
  sourceId: string
  connectorKind?: 'rss' | 'atom'
  feedKind?: 'rss' | 'atom'
  feedTitle: string | null
  itemCount: number
  items: ManualMonitoringItemView[]
  decisions: MonitoringDecision[]
  errorCode?: RssConnectorErrorCode | ManualMonitoringIneligibleCode
  reason: string
  /** New per-item snapshots for repeat checks. TRANSIENT — the caller holds
   *  these in memory only; nothing here persists them. */
  updatedSnapshots: Map<string, SourceContentSnapshot>
  // Capability guarantees (literal false), mirroring the other connector layers.
  performsPersistence: false
  performsEnforcement: false
  canCreateLegalUpdate: false
  canCreateRule: false
  canCallAI: false
}

export interface ManualMonitoringRunOptions {
  /** Prior per-item snapshots (transient, from the caller's session state). */
  previousSnapshots?: Map<string, SourceContentSnapshot>
  userAgent?: string
  now?: () => string
  timeoutMs?: number
  maxResponseBytes?: number
}

function base(sourceId: string): Pick<
  ManualMonitoringRunResult,
  'performsPersistence' | 'performsEnforcement' | 'canCreateLegalUpdate' | 'canCreateRule' | 'canCallAI' | 'sourceId'
> {
  return {
    sourceId,
    performsPersistence: false,
    performsEnforcement: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }
}

function ineligibleResult(source: RegulatorySource, eligibility: ManualMonitoringEligibility): ManualMonitoringRunResult {
  return {
    ...base(source.id),
    ok: false,
    feedTitle: null,
    itemCount: 0,
    items: [],
    decisions: [],
    errorCode: eligibility.code,
    reason: eligibility.reason,
    updatedSnapshots: new Map(),
  }
}

function toItemView(decision: MonitoringDecision, item: ParsedFeedItem | undefined): ManualMonitoringItemView {
  return {
    stableId: decision.sourceId,
    decisionKind: decision.kind,
    reason: decision.reason,
    itemTitle: item?.title ?? null,
    itemUrl: item?.link ?? null,
    publishedAt: item?.published ?? null,
    checksum: decision.snapshot?.checksum ?? null,
    proposesLegalUpdateDraft: decision.kind === 'changed_pending_review' && !!decision.proposedLegalUpdate,
  }
}

function mapConnectorResult(
  source: RegulatorySource,
  connectorKind: 'rss' | 'atom' | undefined,
  result: RssConnectorResult,
  previousSnapshots: Map<string, SourceContentSnapshot>,
): ManualMonitoringRunResult {
  const items = result.feed?.items ?? []
  const itemViews = result.decisions.map((decision, i) => toItemView(decision, items[i]))

  // Transient snapshot accumulation for repeat checks — a copy, never persisted.
  const updatedSnapshots = new Map(previousSnapshots)
  for (const decision of result.decisions) {
    if (decision.snapshot) updatedSnapshots.set(decision.sourceId, decision.snapshot)
  }

  return {
    ...base(source.id),
    ok: result.ok,
    connectorKind,
    feedKind: result.feedKind,
    feedTitle: result.feed?.title ?? null,
    itemCount: result.itemCount,
    items: itemViews,
    decisions: result.decisions,
    errorCode: result.errorCode,
    reason: result.reason,
    updatedSnapshots,
  }
}

/**
 * Runs a MANUAL RSS/Atom monitoring check for one source through the injected
 * fetch implementation. Returns display-only evidence + the connector's
 * monitoring decisions. Fetches nothing when the source is ineligible
 * (inactive / invalid URL / non-RSS-Atom). Performs no persistence, no
 * legal_update or rule creation, no AI call, and no scheduling.
 */
export async function runManualRssMonitoring(
  source: RegulatorySource,
  fetchImpl: RssFetchImpl,
  options: ManualMonitoringRunOptions = {},
): Promise<ManualMonitoringRunResult> {
  const eligibility = evaluateManualMonitoringEligibility(source)
  if (!eligibility.eligible) {
    return ineligibleResult(source, eligibility)
  }

  const host = normalizeConnectorHost(source.url)
  const allowedHosts = host ? [host] : []
  const previousSnapshots = options.previousSnapshots ?? new Map<string, SourceContentSnapshot>()

  const result = await executeRssConnector(source, allowedHosts, fetchImpl, {
    userAgent: options.userAgent ?? DEFAULT_MANUAL_MONITORING_USER_AGENT,
    previousSnapshots,
    now: options.now,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  })

  return mapConnectorResult(source, eligibility.connectorKind, result, previousSnapshots)
}

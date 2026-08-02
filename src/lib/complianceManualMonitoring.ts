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
import { buildMonitoringDecision, type MonitoringDecision, type SourceContentSnapshot } from './complianceSourceMonitoring'
import {
  evaluateCannamonitorPolicy,
  CANNAMONITOR_PERMISSION_STATUS,
  type CannamonitorPermissionStatus,
} from './complianceCannamonitorPolicy'

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
  feedKind?: 'rss' | 'atom' | 'html'
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

// ─── Pasted Monitoring Queue gate (pasted-content ingestion path) ───────────
//
// A SECOND ingestion path exists beside the RSS connector: an admin can paste
// arbitrary article text into the Monitoring Queue for a SELECTED registered
// source. That path never goes through the RSS metadata projection, so a
// Cannamonitor source must be denied HERE — before the pasted content is
// normalized, hashed, or turned into a monitoring decision. Attribution is by
// the SELECTED source's canonical URL only; the pasted text is never inspected
// or classified (no content-sniffing). The documented limitation stands: text
// pasted against a blank / false / unrelated source cannot be identified.

export type PastedMonitoringDenialCode = 'cannamonitor_permission_unverified'

export type PastedMonitoringGateDecision =
  | { action: 'proceed' }
  | { action: 'deny'; code: PastedMonitoringDenialCode; reason: string }

/**
 * Pure source-policy gate for the pasted Monitoring Queue path. Denies ANY
 * matched Cannamonitor source — not merely when monitoring is currently
 * disallowed. Pasted content is arbitrary body text with NO metadata-only
 * projection (unlike the RSS path), so it must never be accepted for a
 * Cannamonitor source even under a (hypothetical) verified permission with an
 * active registry source. Reuses the single existing policy
 * (evaluateCannamonitorPolicy) — no second matcher, no host logic here.
 * Non-Cannamonitor sources proceed unchanged. Attribution is by the selected
 * source URL only (no content-sniffing).
 *
 * `permission` defaults to the module constant, so every production caller is
 * fail-closed; the parameter exists ONLY so tests can prove that a hypothetical
 * verified permission with an active source is STILL denied here.
 */
export function evaluatePastedMonitoringGate(
  source: (Pick<RegulatorySource, 'url'> & Partial<Pick<RegulatorySource, 'isActive'>>) | null | undefined,
  permission: CannamonitorPermissionStatus = CANNAMONITOR_PERMISSION_STATUS,
): PastedMonitoringGateDecision {
  const policy = evaluateCannamonitorPolicy({ url: source?.url ?? '', isActive: source?.isActive }, permission)
  if (policy.matched) {
    return {
      action: 'deny',
      code: 'cannamonitor_permission_unverified',
      reason:
        'Cannamonitor pasted content is not accepted: arbitrary pasted article text is not metadata-only, so it may not be ingested for a Cannamonitor source.',
    }
  }
  return { action: 'proceed' }
}

export type PastedMonitoringResult =
  | { ok: true; decision: MonitoringDecision }
  | { ok: false; code: PastedMonitoringDenialCode; reason: string }

/**
 * Injectable decision builder — defaults to the real buildMonitoringDecision.
 * Exists so a test can prove the builder (and therefore normalization + checksum
 * construction) is NEVER reached on a denial.
 */
export type PastedMonitoringDecisionBuilder = (
  sourceId: string,
  rawContent: string,
  previousSnapshot: SourceContentSnapshot | null,
  knownChecksums: string[],
) => Promise<MonitoringDecision>

/**
 * The authoritative shared entry point for a PASTED Monitoring Queue check.
 * Runs the Cannamonitor gate FIRST; on denial it returns before the decision
 * builder is invoked, so the pasted content never reaches normalization,
 * checksum construction, `rawText`, a monitoring decision, a draft intake, or
 * persistence. On `proceed` it builds the ordinary monitoring decision, so
 * non-Cannamonitor behaviour is byte-for-byte unchanged. This function creates
 * nothing, persists nothing, calls no AI, and schedules nothing.
 */
export async function runPastedMonitoringDecision(
  source: Pick<RegulatorySource, 'url'> | null | undefined,
  sourceKey: string,
  pastedContent: string,
  previousSnapshot: SourceContentSnapshot | null,
  knownChecksums: string[] = [],
  buildDecision: PastedMonitoringDecisionBuilder = buildMonitoringDecision,
): Promise<PastedMonitoringResult> {
  const gate = evaluatePastedMonitoringGate(source)
  if (gate.action === 'deny') {
    return { ok: false, code: gate.code, reason: gate.reason }
  }
  const decision = await buildDecision(sourceKey, pastedContent, previousSnapshot, knownChecksums)
  return { ok: true, decision }
}

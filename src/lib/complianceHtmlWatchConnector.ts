import type { RegulatorySource } from '../types'
import type { RssFetchImpl, RssFetchResponse, ParsedFeed, ParsedFeedItem, RssConnectorResult, RssConnectorErrorCode } from './complianceRssConnector'
import { buildMonitoringDecision, type MonitoringDecision, type SourceContentSnapshot } from './complianceSourceMonitoring'
import { evaluateCannamonitorPolicy } from './complianceCannamonitorPolicy'
import { buildConnectorRunPlan, type ConnectorRuntimeStatus } from './complianceSourceConnectorRuntime'
import { selectRelevantSection } from './serverSourceRetrieval'

// ─── HTML page-change watcher ────────────────────────────────────────────────
//
// The connector for `monitoringMethod: 'html'` sources. It exists because six
// of the eight registered regulatory sources — Thai FDA, the Ministry of Public
// Health, ONCB, Thai Customs, the Department of Agriculture and the Royal Thai
// Government Gazette — publish no feed at all. Before this, every one of them
// was recorded as `unsupported_connector` on every run, which meant DDP
// monitored the Czech and EU regulators and none of the Thai ones. For a Thai
// cannabis export business that is the wrong half.
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
// It answers one question: "has the part of this page we care about changed
// since we last looked?" It does NOT parse individual announcements out of a
// page. Per-site scraping would mean six bespoke parsers against sites that
// already answered 403 to three of six probes on 2026-07-28, each one breaking
// silently on the next redesign. A change notice a human then checks is worth
// more than a parser that is confidently wrong.
//
// WHY IT WATCHES A RELEVANCE WINDOW AND NOT THE WHOLE PAGE
// This is the difference between a usable watcher and an unusable one. A
// ministry homepage carries rotating banners, visitor counters, "last updated"
// stamps and news tickers, so its whole-page fingerprint changes on virtually
// every fetch. A watcher that cries change every run trains its operator to
// ignore it, which is strictly worse than no watcher. So when a page exceeds
// the window size, the fingerprint is taken over a verbatim excerpt selected
// around cannabis/export terminology (selectRelevantSection, already used by
// the retrieval layer and already guaranteed not to fabricate text).
//
// The consequence is stated rather than hidden: a change far away from any
// watched term, on a long page, will not be noticed. That is the accepted cost
// of the alarm being meaningful when it does fire.

/**
 * Terms that define the relevance window, in English and Thai.
 *
 * Deliberately broad. A false positive costs an operator one page visit; a
 * false negative is a missed regulatory change, which is the failure this
 * whole subsystem exists to prevent.
 */
export const HTML_WATCH_TERMS = [
  'cannabis',
  'hemp',
  'cannabinoid',
  'cbd',
  'thc',
  'narcotic',
  'export',
  'import',
  'licence',
  'license',
  'permit',
  'notification',
  'regulation',
  'announcement',
  // Thai. The registered Thai sources publish primarily in Thai, so an
  // English-only term list would select an irrelevant window on exactly the
  // six sources this connector was built for.
  'กัญชา',
  'กัญชง',
  'ยาเสพติด',
  'ส่งออก',
  'นำเข้า',
  'ใบอนุญาต',
  'ประกาศ',
  'กฎกระทรวง',
]

/**
 * Characters of page text carried into a candidate legal update.
 *
 * Matched to DEFAULT_MAX_EVIDENCE_CHARS in complianceAiSummarisation, so a
 * candidate this connector creates is within the AI draft summariser's evidence
 * bound. Any larger and the "Generate AI Draft Summary" button would be offered
 * on the resulting update and fail every time with `oversized_evidence` — the
 * exact enabled-but-guaranteed-to-fail dead end that PR #104 had to remove from
 * the source-URL path.
 */
export const HTML_WATCH_WINDOW_CHARS = 20_000

export interface HtmlWatchOptions {
  userAgent: string
  timeoutMs?: number
  maxResponseBytes?: number
  allowedPorts?: number[]
  previousSnapshots?: Map<string, SourceContentSnapshot>
  now?: () => string
}

/** The synthetic item id for a page. Stable per source, so the previous
 *  snapshot for a page is found on every subsequent run. */
export function htmlWatchItemId(source: RegulatorySource): string {
  return `${source.id}::page`
}

const HTML_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8'

/** Content types this connector will read. A feed served here is a registry
 *  mistake (the source should be `rss`), so it is refused rather than silently
 *  fingerprinted as prose. */
const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain']

/** Mirrors the RSS connector's mapping so a rejection means the same thing
 *  whichever modality produced it. */
const RUNTIME_STATUS_TO_ERROR: Partial<Record<ConnectorRuntimeStatus, RssConnectorErrorCode>> = {
  rejected_not_https: 'not_https',
  rejected_not_allowlisted: 'off_allowlist',
  rejected_private_network: 'url_unsafe',
  rejected_invalid_url: 'url_unsafe',
  rejected_unsupported_connector: 'unsupported_connector',
  error: 'fetch_failed',
}

function fail(sourceId: string, errorCode: RssConnectorErrorCode, reason: string): RssConnectorResult {
  return {
    ok: false,
    sourceId,
    itemCount: 0,
    decisions: [],
    errorCode,
    reason,
    performsPersistence: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }
}

/**
 * Retrieves an HTML source and reports whether its watched content changed.
 *
 * Mirrors executeRssConnector's gate order exactly — source policy, URL safety,
 * allowlist, fetch, content type, size — so the two connectors cannot drift
 * into having different safety properties. It returns the SAME result shape, so
 * watchtowerIngestionService needs no special case: an item whose content is
 * unchanged dedups through the ordinary content-hash path, which is what makes
 * change detection fall out of the existing machinery rather than being a
 * second, parallel implementation of it.
 */
export async function executeHtmlWatchConnector(
  source: RegulatorySource,
  allowedHosts: string[],
  fetchImpl: RssFetchImpl,
  options: HtmlWatchOptions,
): Promise<RssConnectorResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxBytes = options.maxResponseBytes ?? 5_000_000
  const allowedPorts = options.allowedPorts ?? []

  // 0) Source-specific policy gate, FIRST and before any network call — same
  //    position as in executeRssConnector, so a policy-denied source (today:
  //    Cannamonitor, whose commercial permission is unverified) never reaches
  //    fetchImpl through this connector either. A gate that guards only one of
  //    two transports is not a gate, and adding a second transport without
  //    re-applying it is exactly how such a gate silently stops holding.
  const sourcePolicy = evaluateCannamonitorPolicy(source)
  if (sourcePolicy.matched && !sourcePolicy.monitoringAllowed) {
    return fail(source.id, 'source_policy_denied', sourcePolicy.reason)
  }

  // 1) Pre-fetch safety gate — the SAME shared plan builder the RSS connector
  //    uses (HTTPS-only + allowlist + SSRF + kind), not a re-implementation.
  const plan = buildConnectorRunPlan(source, allowedHosts, allowedPorts)
  if (plan.status !== 'ready') {
    return fail(source.id, RUNTIME_STATUS_TO_ERROR[plan.status] ?? 'fetch_failed', plan.reason)
  }
  if (plan.plan?.connectorKind !== 'html') {
    return fail(source.id, 'unsupported_connector', `connector kind "${plan.plan?.connectorKind}" is not an HTML page`)
  }

  // 2) Fetch.
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  let resp: RssFetchResponse
  try {
    resp = await fetchImpl(source.url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
      headers: { 'User-Agent': options.userAgent, Accept: HTML_ACCEPT },
    })
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
    return fail(source.id, aborted ? 'timeout' : 'fetch_failed', err instanceof Error ? err.message : 'fetch failed')
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (!resp.ok) {
    // Expected steady state for some of these sources rather than an anomaly:
    // three of the six Thai hosts answered 403 when measured on 2026-07-28. A
    // recorded failed run is the correct outcome — visible, attributable, and
    // not mistaken for "nothing was published".
    return fail(source.id, 'fetch_failed', `non-ok response (status ${resp.status})`)
  }

  const contentType = (resp.headers.get('content-type') ?? '').toLowerCase()
  const mediaType = contentType.split(';')[0].trim()
  if (!HTML_CONTENT_TYPES.includes(mediaType)) {
    return fail(source.id, 'invalid_content_type', `unsupported content-type "${contentType || '(none)'}" for an html-monitored source`)
  }

  const declared = Number(resp.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(source.id, 'oversized_response', `declared length ${declared} exceeds max ${maxBytes} bytes`)
  }
  const body = await resp.text()
  if (new TextEncoder().encode(body).length > maxBytes) {
    return fail(source.id, 'oversized_response', `response body exceeds max ${maxBytes} bytes`)
  }

  // 3) Reduce the page to the watched window. The retrieval layer has already
  //    converted HTML to text; this narrows it to the part worth alarming on.
  const pageText = body.trim()
  if (pageText.length === 0) {
    return fail(source.id, 'fetch_failed', 'the source returned an empty document')
  }
  const watched = pageText.length > HTML_WATCH_WINDOW_CHARS
    ? selectRelevantSection(pageText, HTML_WATCH_TERMS, HTML_WATCH_WINDOW_CHARS).section
    : pageText

  // 4) Change detection, through the SAME primitive the RSS path uses — so
  //    whitespace reflow is already discounted and the checksum algorithm
  //    cannot diverge between the two modalities.
  const itemId = htmlWatchItemId(source)
  const previous = options.previousSnapshots?.get(itemId) ?? null
  const decision: MonitoringDecision = await buildMonitoringDecision(itemId, watched, previous, [], now())

  const item: ParsedFeedItem = {
    // Titled as an observation, never as a finding. This row reaches the Review
    // Queue as a draft legal update, and its title is the first thing a
    // reviewer reads; it must not assert that a law changed, only that a page did.
    title: `${source.name} — watched page content changed`,
    link: source.url,
    id: itemId,
    summary: null,
    content: null,
    published: null,
    rawText: watched,
  }
  const feed: ParsedFeed = { kind: 'html', title: source.name, items: [item] }

  return {
    ok: true,
    sourceId: source.id,
    feedKind: 'html',
    itemCount: 1,
    decisions: [decision],
    feed,
    reason: `checked html source (${watched.length} watched chars of ${pageText.length})`,
    performsPersistence: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }
}

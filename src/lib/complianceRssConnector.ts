import type { RegulatorySource } from '../types'
import {
  buildConnectorRunPlan,
  validateConnectorAllowlist,
  validateConnectorUrlSafety,
  type ConnectorRuntimeStatus,
} from './complianceSourceConnectorRuntime'
import {
  buildMonitoringDecision,
  normalizeSourceContent,
  computeSourceChecksum,
  type MonitoringDecision,
  type SourceContentSnapshot,
} from './complianceSourceMonitoring'
import { evaluateCannamonitorPolicy } from './complianceCannamonitorPolicy'

// ─── Read-only RSS / Atom compliance connector (Phase 2C) ───────────────────
//
// The first connector that actually retrieves a regulatory source — but ONLY
// through an injected fetch implementation. This module never references the
// global `fetch`, never opens a socket itself, never schedules anything,
// never persists, never calls Supabase, never calls an AI provider, never
// writes a legal_update, and never creates a rule. Its output is a list of
// monitoring *decisions* (intent only), each produced by the existing
// buildMonitoringDecision — which can propose at most a legal_update draft
// with status 'new' that still goes through the human Review Queue.
//
// Safety is not re-implemented here. The pre-fetch gate is buildConnectorRunPlan
// (which itself composes validateConnectorUrlSafety + validateConnectorAllowlist
// + the connector-kind contract), so HTTPS-only, deny-by-default allowlist, and
// the SSRF guard are all reused. The redirect guard re-runs
// validateConnectorUrlSafety + validateConnectorAllowlist against any final URL
// the transport reports, then rejects regardless — this phase never follows a
// redirect (that requires manual validation, which is out of scope here).
//
// There is NO XML dependency and no DOMParser in this project's node test
// environment, so the feed parser is a deliberately small, tolerant,
// string/regex reader for RSS 2.0 `<item>` and Atom `<entry>` — enough to
// extract the standard fields, preserve original text, and reject anything
// that is not a feed. It is not a general-purpose XML parser and does not try
// to be.

// ─── Error codes + option/response contract types ────────────────────────────

export type RssConnectorErrorCode =
  | 'not_https'
  | 'off_allowlist'
  | 'url_unsafe'
  | 'unsupported_connector'
  | 'timeout'
  | 'oversized_response'
  | 'invalid_content_type'
  | 'redirect_blocked'
  | 'fetch_failed'
  | 'malformed_feed'
  | 'not_a_feed'
  /** A source-specific policy (today: Cannamonitor) denied retrieval before any fetch. */
  | 'source_policy_denied'

export interface RssConnectorOptions {
  /** Descriptive User-Agent. Required: this connector supplies no default UA. */
  userAgent: string
  timeoutMs?: number
  maxResponseBytes?: number
  allowedPorts?: number[]
  /** Prior per-item snapshots, keyed by feedItemSourceId(source, item). */
  previousSnapshots?: Map<string, SourceContentSnapshot>
  /** Injectable clock for deterministic tests; defaults to Date.now ISO. */
  now?: () => string
}

/** Init passed to the injected fetch. `redirect: 'error'` + `credentials: 'omit'`
 *  encode "never follow a redirect" and "never send credentials". */
export interface RssFetchInit {
  method: 'GET'
  headers: Record<string, string>
  signal: AbortSignal
  redirect: 'error'
  credentials: 'omit'
}

/** Minimal subset of the Fetch Response this connector needs. The global
 *  `fetch`'s Response satisfies it, but this module never calls that global —
 *  a caller (or a test) must inject the implementation. */
export interface RssFetchResponse {
  ok: boolean
  status: number
  url?: string
  redirected?: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type RssFetchImpl = (url: string, init: RssFetchInit) => Promise<RssFetchResponse>

// ─── Parsed feed model ───────────────────────────────────────────────────────

export interface ParsedFeedItem {
  title: string | null
  link: string | null
  id: string | null
  summary: string | null
  content: string | null
  published: string | null
  /** Canonical concatenation of the ORIGINAL (decoded) field values — the
   *  content basis for checksum/change detection. Never re-normalized here. */
  rawText: string
}

export interface ParsedFeed {
  kind: 'rss' | 'atom'
  title: string | null
  items: ParsedFeedItem[]
}

export type FeedParseErrorCode = 'malformed_feed' | 'not_a_feed'

export class FeedParseError extends Error {
  code: FeedParseErrorCode
  constructor(code: FeedParseErrorCode, message: string) {
    super(message)
    this.name = 'FeedParseError'
    this.code = code
  }
}

export interface FeedItemSnapshot {
  rawText: string
  normalizedContent: string
  checksum: string
}

export interface RssConnectorResult {
  ok: boolean
  sourceId: string
  feedKind?: 'rss' | 'atom'
  itemCount: number
  decisions: MonitoringDecision[]
  /** The parsed feed on success (items align 1:1 with `decisions`). Present so
   *  callers can surface per-item evidence (title/link/date) alongside each
   *  decision without re-parsing. Additive only — carries no capability. */
  feed?: ParsedFeed
  errorCode?: RssConnectorErrorCode
  reason: string
  // Capability guarantees (literal false), mirroring the other connector layers.
  performsPersistence: false
  canCreateLegalUpdate: false
  canCreateRule: false
  canCallAI: false
}

// ─── XML text helpers (pure) ─────────────────────────────────────────────────

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** Decodes the handful of XML/HTML entities feeds use, including numeric ones
 *  (so Thai/Unicode numeric entities round-trip). Raw UTF-8 passes untouched.
 *  `&amp;` is decoded last to avoid double-decoding. */
function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

/** Unwraps CDATA, decodes entities, trims. Returns null when empty. */
function cleanText(raw: string): string | null {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const decoded = decodeEntities(unwrapped).trim()
  return decoded.length > 0 ? decoded : null
}

/** First `<tag ...>inner</tag>` inner text within `block`, cleaned. */
function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(block)
  return m ? cleanText(m[1]) : null
}

/** Atom `<link href="…"/>`, preferring rel="alternate" or a rel-less link. */
function atomLink(block: string): string | null {
  const tags = block.match(/<link\b[^>]*>/gi) ?? []
  let fallback: string | null = null
  for (const tag of tags) {
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (!href) continue
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase()
    if (!rel || rel === 'alternate') return decodeEntities(href).trim() || null
    if (!fallback) fallback = decodeEntities(href).trim() || null
  }
  return fallback
}

// ─── Item assembly (pure) ────────────────────────────────────────────────────

export interface FeedItemFields {
  title: string | null
  link: string | null
  id: string | null
  summary: string | null
  content: string | null
  published: string | null
}

/**
 * A source-specific content-minimisation hook, applied to the parsed FIELDS of
 * a feed item *before* `rawText` is assembled from them.
 *
 * The ordering is the whole point and is not an implementation detail. A policy
 * that ran after finalizeItem() would have to scrub prohibited text back out of
 * an already-built string, which means the prohibited text would have existed
 * in a retained value — briefly present in the checksum basis and one refactor
 * away from being persisted. Projecting the fields first means prohibited
 * content is never concatenated at all, so it cannot reach the checksum, the
 * monitoring decision, a proposed draft, the repository, or an AI provider.
 *
 * Default (no policy) is identity: every existing source behaves exactly as
 * before.
 */
export interface FeedItemFieldPolicy {
  policyId: string
  projectFields(fields: FeedItemFields): FeedItemFields
}

function finalizeItem(fields: FeedItemFields, policy?: FeedItemFieldPolicy | null): ParsedFeedItem {
  const projected = policy ? policy.projectFields(fields) : fields
  const rawText = [projected.title, projected.link, projected.id, projected.published, projected.summary, projected.content]
    .map(v => v ?? '')
    .join('\n')
  return { ...projected, rawText }
}

export function extractRssItems(xml: string, policy?: FeedItemFieldPolicy | null): ParsedFeedItem[] {
  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m => m[1])
  return blocks.map(block => {
    const description = firstTag(block, 'description')
    return finalizeItem({
      title: firstTag(block, 'title'),
      link: firstTag(block, 'link'),
      id: firstTag(block, 'guid'),
      summary: description,
      content: description,
      published: firstTag(block, 'pubDate'),
    }, policy)
  })
}

export function extractAtomItems(xml: string, policy?: FeedItemFieldPolicy | null): ParsedFeedItem[] {
  const blocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map(m => m[1])
  return blocks.map(block => {
    const summary = firstTag(block, 'summary')
    const content = firstTag(block, 'content')
    return finalizeItem({
      title: firstTag(block, 'title'),
      link: atomLink(block),
      id: firstTag(block, 'id'),
      summary,
      content: content ?? summary,
      published: firstTag(block, 'published') ?? firstTag(block, 'updated'),
    }, policy)
  })
}

/** Feed-level title, taken from before the first item/entry so it is not the
 *  first item's title. */
function feedTitle(xml: string, itemTag: string): string | null {
  const idx = xml.search(new RegExp(`<${itemTag}\\b`, 'i'))
  return firstTag(idx >= 0 ? xml.slice(0, idx) : xml, 'title')
}

/**
 * Detects RSS vs Atom and extracts title + items. Throws FeedParseError with
 * `not_a_feed` when the document is neither, and `malformed_feed` when the
 * detected root element is not terminated (a cheap well-formedness signal,
 * since there is no real XML parser available). Pure.
 */
export function parseRssOrAtomFeed(xml: string, policy?: FeedItemFieldPolicy | null): ParsedFeed {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new FeedParseError('not_a_feed', 'empty or non-string document')
  }

  const isRss = /<rss\b/i.test(xml) || /<rdf:RDF\b/i.test(xml)
  const isAtom = /<feed\b/i.test(xml) && (/xmlns[^>]*atom/i.test(xml) || /<entry\b/i.test(xml))

  if (isRss) {
    if (!/<\/rss>/i.test(xml) && !/<\/rdf:RDF>/i.test(xml)) {
      throw new FeedParseError('malformed_feed', 'unterminated <rss> document')
    }
    return { kind: 'rss', title: feedTitle(xml, 'item'), items: extractRssItems(xml, policy) }
  }

  if (isAtom) {
    if (!/<\/feed>/i.test(xml)) {
      throw new FeedParseError('malformed_feed', 'unterminated <feed> document')
    }
    return { kind: 'atom', title: feedTitle(xml, 'entry'), items: extractAtomItems(xml, policy) }
  }

  throw new FeedParseError('not_a_feed', 'document is neither RSS nor Atom')
}

// ─── Checksum + per-item identity (pure / reuses monitoring) ─────────────────

/** Normalized content + SHA-256 checksum for one item. Reuses the existing
 *  normalizeSourceContent + computeSourceChecksum. */
export async function buildFeedItemSnapshot(item: ParsedFeedItem): Promise<FeedItemSnapshot> {
  const normalizedContent = normalizeSourceContent(item.rawText)
  const checksum = await computeSourceChecksum(normalizedContent)
  return { rawText: item.rawText, normalizedContent, checksum }
}

/** Small synchronous FNV-1a, used only to key anonymous items (no guid/id/link)
 *  by content. Not security-sensitive — change detection still uses SHA-256. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Stable per-item source id, so a previous-snapshot map can be keyed to match.
 *  Prefers the feed's own stable identity (guid / atom id / link); falls back
 *  to a content hash when none is present (then a change reads as first-seen). */
export function feedItemSourceId(source: RegulatorySource, item: ParsedFeedItem): string {
  const identity =
    (item.id && item.id.trim()) ||
    (item.link && item.link.trim()) ||
    `anon:${fnv1a(item.rawText)}`
  return `${source.id}::${identity}`
}

// ─── Monitoring decisions (reuses buildMonitoringDecision; intent only) ──────

/**
 * One monitoring decision per feed item, via the existing
 * buildMonitoringDecision. Accumulates checksums across the feed so a notice
 * mirrored twice in the same feed is reported as `duplicate`. Produces intent
 * only — never persists, never writes a legal_update, never creates a rule.
 */
export async function buildRssMonitoringDecisions(
  source: RegulatorySource,
  feed: ParsedFeed,
  previousSnapshots: Map<string, SourceContentSnapshot> = new Map(),
  retrievedAt: string = new Date().toISOString(),
): Promise<MonitoringDecision[]> {
  const decisions: MonitoringDecision[] = []
  const knownChecksums: string[] = []
  for (const item of feed.items) {
    const itemId = feedItemSourceId(source, item)
    const previous = previousSnapshots.get(itemId) ?? null
    const decision = await buildMonitoringDecision(itemId, item.rawText, previous, knownChecksums, retrievedAt)
    if (decision.snapshot) knownChecksums.push(decision.snapshot.checksum)
    decisions.push(decision)
  }
  return decisions
}

// ─── Execution (injected fetch only) ─────────────────────────────────────────

const RUNTIME_STATUS_TO_ERROR: Partial<Record<ConnectorRuntimeStatus, RssConnectorErrorCode>> = {
  rejected_not_https: 'not_https',
  rejected_not_allowlisted: 'off_allowlist',
  rejected_private_network: 'url_unsafe',
  rejected_invalid_url: 'url_unsafe',
  rejected_unsupported_connector: 'unsupported_connector',
  error: 'fetch_failed',
}

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'

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
 * Runs the RSS/Atom connector for a source using ONLY the injected fetchImpl.
 * Gate → fetch → redirect guard → content-type/size checks → parse → monitoring
 * decisions. Returns intent only; performs no persistence, no legal_update
 * write, no rule creation, and no AI call.
 */
export async function executeRssConnector(
  source: RegulatorySource,
  allowedHosts: string[],
  fetchImpl: RssFetchImpl,
  options: RssConnectorOptions,
): Promise<RssConnectorResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxBytes = options.maxResponseBytes ?? 5_000_000
  const allowedPorts = options.allowedPorts ?? []

  // 0) Source-specific policy gate. Evaluated FIRST and BEFORE any network call,
  //    so a policy-denied source (today: Cannamonitor, whose commercial
  //    permission is unverified) never reaches fetchImpl at all. This gate lives
  //    inside the connector rather than only in the caller so it cannot be
  //    bypassed by calling executeRssConnector directly. Unmatched sources are
  //    unaffected: `fieldPolicy` is null and behaviour is identical to before.
  const sourcePolicy = evaluateCannamonitorPolicy(source)
  if (sourcePolicy.matched && !sourcePolicy.monitoringAllowed) {
    return fail(source.id, 'source_policy_denied', sourcePolicy.reason)
  }
  const fieldPolicy = sourcePolicy.fieldPolicy

  // 1) Pre-fetch safety gate — reuses HTTPS-only + allowlist + SSRF + kind.
  const plan = buildConnectorRunPlan(source, allowedHosts, allowedPorts)
  if (plan.status !== 'ready') {
    return fail(source.id, RUNTIME_STATUS_TO_ERROR[plan.status] ?? 'fetch_failed', plan.reason)
  }
  const kind = plan.plan?.connectorKind
  if (kind !== 'rss' && kind !== 'atom') {
    return fail(source.id, 'unsupported_connector', `connector kind "${kind}" is not an RSS/Atom feed`)
  }

  // 2) Fetch through the injected implementation only. Timeout via
  //    AbortController; never follow redirects; never send credentials.
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  let resp: RssFetchResponse
  try {
    resp = await fetchImpl(source.url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
      headers: { 'User-Agent': options.userAgent, Accept: FEED_ACCEPT },
    })
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
    return fail(source.id, aborted ? 'timeout' : 'fetch_failed', err instanceof Error ? err.message : 'fetch failed')
  } finally {
    if (timer) clearTimeout(timer)
  }

  // 3) Redirect guard. This phase never follows redirects. If the transport
  //    reports one, re-validate the final URL (reusing the safety + allowlist
  //    checks) for diagnostics, then reject regardless.
  const finalUrl = resp.url && resp.url !== source.url ? resp.url : null
  if (resp.redirected === true || (resp.status >= 300 && resp.status < 400) || finalUrl) {
    let detail = `status ${resp.status}`
    if (finalUrl) {
      const finalSource: RegulatorySource = { ...source, url: finalUrl }
      const safe = validateConnectorUrlSafety(finalSource, allowedPorts)
      const allow = validateConnectorAllowlist(finalSource, allowedHosts)
      detail = `redirected to ${finalUrl} (urlSafe=${safe.safe}, allowlisted=${allow.allowed})`
    }
    return fail(source.id, 'redirect_blocked', `redirect not followed: ${detail}`)
  }

  if (!resp.ok) {
    return fail(source.id, 'fetch_failed', `non-ok response (status ${resp.status})`)
  }

  // 4) Content-type must be an RSS/Atom XML type; reject HTML/binary.
  const contentType = (resp.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('html') || !/(rss|atom|xml)/.test(contentType)) {
    return fail(source.id, 'invalid_content_type', `unsupported content-type "${contentType || '(none)'}"`)
  }

  // 5) Size limit — check a declared Content-Length first, then the body.
  const declared = Number(resp.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(source.id, 'oversized_response', `declared length ${declared} exceeds max ${maxBytes} bytes`)
  }
  const body = await resp.text()
  if (new TextEncoder().encode(body).length > maxBytes) {
    return fail(source.id, 'oversized_response', `response body exceeds max ${maxBytes} bytes`)
  }

  // 6) Parse. The source policy's field projection (if any) is applied during
  //    parsing, so prohibited content is discarded before rawText is assembled
  //    — it is never concatenated, hashed, or carried into a decision.
  let feed: ParsedFeed
  try {
    feed = parseRssOrAtomFeed(body, fieldPolicy)
  } catch (err) {
    if (err instanceof FeedParseError) return fail(source.id, err.code, err.message)
    return fail(source.id, 'malformed_feed', err instanceof Error ? err.message : 'failed to parse feed')
  }

  // 7) Monitoring decisions — intent only, via buildMonitoringDecision.
  const decisions = await buildRssMonitoringDecisions(source, feed, options.previousSnapshots ?? new Map(), now())

  return {
    ok: true,
    sourceId: source.id,
    feedKind: feed.kind,
    itemCount: feed.items.length,
    decisions,
    feed,
    reason: `parsed ${feed.kind} feed with ${feed.items.length} item(s)`,
    performsPersistence: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }
}

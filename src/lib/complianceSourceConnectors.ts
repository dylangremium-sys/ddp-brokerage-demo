import type { RegulatorySource } from '../types'
import { SUPPORTED_SOURCE_TYPES, type RegulatorySourceType } from './complianceSourceRegistry'

// ─── Compliance Source Connectors — contract layer (Phase 2A.5) ─────────────
//
// Defines *what a connector is* and *which connector a source needs* — and
// nothing else. There is no fetching, no scheduling, no Supabase, no AI, and
// no write of any kind anywhere in this file. Every export is either a type
// or a pure, synchronous function. A "connector" here is a declarative
// descriptor: it can describe the plan a future fetcher would follow, but it
// holds no live fetcher and can execute nothing.
//
// The capability flags on every descriptor/plan (`performsNetwork`,
// `canCreateLegalUpdate`, `canCreateRule`, `canCallAI`) are deliberately
// typed as the literal `false` — the same structural-guarantee idiom already
// used in complianceSourceMonitoring.ts, where ProposedLegalUpdateIntent's
// `status` is typed as the literal 'new'. This makes it a compile error, not
// merely a convention, for any code in this layer to ever claim a connector
// fetches, writes a legal_update, creates a rule, or calls an AI provider.
//
// Connector *kind* (how content is retrieved/parsed: rss/atom/html/pdf/
// government_api) is orthogonal to a source's `sourceType` (who publishes
// it: government_regulator/legal_database/…, owned by
// complianceSourceRegistry.ts). Selection validates the sourceType against
// that registry's SUPPORTED_SOURCE_TYPES rather than re-listing them here.

// ─── Connector kinds ────────────────────────────────────────────────────────

export type ConnectorKind = 'rss' | 'atom' | 'html' | 'pdf' | 'government_api' | 'unsupported'

/** All non-`unsupported` kinds a real fetcher could eventually implement. */
export const SUPPORTED_CONNECTOR_KINDS: Exclude<ConnectorKind, 'unsupported'>[] = [
  'rss',
  'atom',
  'html',
  'pdf',
  'government_api',
]

// ─── Result / content contract types ────────────────────────────────────────
//
// These describe the *shape* a future fetcher's output would take. They are
// intentionally free of any field that could propose a legal_update status,
// a rule, an alert, or an AI-derived value — a connector result carries raw
// extracted content and transport metadata only. Turning content into a
// legal_update remains the job of buildMonitoringDecision (which itself only
// ever proposes status 'new') followed by the human Review Queue.

export interface ExtractedSourceContent {
  /** The raw text a future fetcher would hand, unmodified, to buildMonitoringDecision. */
  rawText: string
  /** Optional human-facing title a parser may surface. Never a compliance claim. */
  title?: string
  /** Optional publication timestamp if the source exposes one; null when unknown. */
  publishedAt?: string | null
  /** Transport content-type as reported by the source, for diagnostics only. */
  contentType?: string
}

export interface SourceFetchResult {
  ok: boolean
  sourceId: string
  connectorKind: ConnectorKind
  /** Present only on a successful, real fetch — always absent in this phase. */
  httpStatus?: number
  extracted?: ExtractedSourceContent
  error?: string
}

// ─── The connector descriptor ────────────────────────────────────────────────

export interface ConnectorDescriptor {
  kind: ConnectorKind
  label: string
  /** true for rss/atom/government_api (structured), false for html/pdf/unsupported. */
  parsesStructuredFeed: boolean
  performsNetwork: false
  canCreateLegalUpdate: false
  canCreateRule: false
  canCallAI: false
}

/**
 * A declarative description of the request a future fetcher would make for a
 * given source. Building one performs no I/O. `httpMethod` is the literal
 * 'GET' — this layer models read-only retrieval only. The four capability
 * flags are literal `false`, so a plan can never assert the connector will
 * fetch, write a legal_update, create a rule, or call an AI provider.
 */
export interface ConnectorFetchPlan {
  sourceId: string
  connectorKind: ConnectorKind
  requestUrl: string
  httpMethod: 'GET'
  expectedContentKind: ConnectorKind
  performsNetwork: false
  canCreateLegalUpdate: false
  canCreateRule: false
  canCallAI: false
}

export interface ComplianceSourceConnector {
  readonly kind: ConnectorKind
  /** Pure predicate: true when this connector is the correct modality for the source. No I/O. */
  supportsSource(source: RegulatorySource): boolean
  /** Pure, declarative plan of what a future fetcher would do. Executes nothing. */
  planFetch(source: RegulatorySource): ConnectorFetchPlan
  /** Pure metadata describing this connector kind's capabilities. */
  describe(): ConnectorDescriptor
}

export interface ConnectorSelectionResult {
  supported: boolean
  kind: ConnectorKind
  /** Present only when `supported` is true. */
  connector?: ComplianceSourceConnector
  reason: string
}

// ─── URL classification (pure) ───────────────────────────────────────────────

interface ParsedSourceUrl {
  pathname: string
  hostname: string
  search: string
}

/**
 * Parses a source URL into lowercased parts, or returns null when the URL is
 * absent, unparseable, or not http(s). Non-http(s) schemes (ftp:, file:,
 * data:, …) are treated as unparseable here on purpose — this layer only
 * ever models read-only http(s) retrieval.
 */
function parseSourceUrl(url: string): ParsedSourceUrl | null {
  if (!url || !url.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return {
    pathname: parsed.pathname.toLowerCase(),
    hostname: parsed.hostname.toLowerCase(),
    search: parsed.search.toLowerCase(),
  }
}

function looksLikeApi(parts: ParsedSourceUrl): boolean {
  return (
    parts.hostname.startsWith('api.') ||
    parts.pathname === '/api' ||
    parts.pathname.startsWith('/api/') ||
    parts.pathname.includes('/api/') ||
    parts.pathname.endsWith('.json')
  )
}

/**
 * Infers the connector kind from the source URL alone (with the hostname as a
 * secondary signal for government_api). Pure and deterministic.
 *
 * Order matters and is deliberate:
 *   1. unparseable / non-http(s)      → unsupported
 *   2. path ends .pdf                  → pdf
 *   3. path names atom explicitly      → atom   (checked before rss so 'atom' wins)
 *   4. path names rss explicitly       → rss
 *   5. api host / /api path / .json    → government_api
 *   6. generic feed marker or .xml     → rss    (default feed dialect)
 *   7. otherwise                       → html
 */
export function inferConnectorKind(source: RegulatorySource): ConnectorKind {
  const parts = parseSourceUrl(source.url)
  if (!parts) return 'unsupported'

  const { pathname } = parts

  if (pathname.endsWith('.pdf')) return 'pdf'
  if (pathname.endsWith('.atom') || pathname.includes('atom')) return 'atom'
  if (pathname.endsWith('.rss') || pathname.includes('rss')) return 'rss'
  if (looksLikeApi(parts)) return 'government_api'
  if (pathname.includes('feed') || pathname.endsWith('.xml')) return 'rss'
  return 'html'
}

// ─── Connector factory (metadata / intent only) ──────────────────────────────

const STRUCTURED_FEED_KINDS: ReadonlySet<ConnectorKind> = new Set<ConnectorKind>([
  'rss',
  'atom',
  'government_api',
])

const CONNECTOR_LABELS: Record<ConnectorKind, string> = {
  rss: 'RSS feed connector',
  atom: 'Atom feed connector',
  html: 'HTML page connector',
  pdf: 'PDF document connector',
  government_api: 'Government API connector',
  unsupported: 'Unsupported source',
}

/**
 * Returns a connector descriptor for the given kind. The returned object is
 * pure metadata plus pure planning: it holds no live fetcher and performs no
 * I/O. This is a factory of *intent*, not of runnable fetchers.
 */
export function createConnector(kind: ConnectorKind): ComplianceSourceConnector {
  const descriptor: ConnectorDescriptor = {
    kind,
    label: CONNECTOR_LABELS[kind],
    parsesStructuredFeed: STRUCTURED_FEED_KINDS.has(kind),
    performsNetwork: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }

  return {
    kind,
    supportsSource(source: RegulatorySource): boolean {
      return inferConnectorKind(source) === kind
    },
    planFetch(source: RegulatorySource): ConnectorFetchPlan {
      return {
        sourceId: source.id,
        connectorKind: kind,
        requestUrl: source.url,
        httpMethod: 'GET',
        expectedContentKind: kind,
        performsNetwork: false,
        canCreateLegalUpdate: false,
        canCreateRule: false,
        canCallAI: false,
      }
    },
    describe(): ConnectorDescriptor {
      return { ...descriptor }
    },
  }
}

// ─── Source type validation ──────────────────────────────────────────────────

function isSupportedSourceType(sourceType: string): sourceType is RegulatorySourceType {
  return SUPPORTED_SOURCE_TYPES.includes(sourceType as RegulatorySourceType)
}

// ─── Selection (pure) ────────────────────────────────────────────────────────

/**
 * Chooses the connector for a source, or rejects it. Pure and side-effect
 * free — no fetch, no schedule, no persistence. A source is rejected when its
 * `sourceType` is not one the registry supports, or when its URL cannot be
 * classified into a real connector kind (absent/unparseable/non-http(s)).
 * On success, `connector` is a metadata/intent descriptor only.
 */
export function selectConnectorForSource(source: RegulatorySource): ConnectorSelectionResult {
  if (!isSupportedSourceType(source.sourceType)) {
    return {
      supported: false,
      kind: 'unsupported',
      reason: `unsupported sourceType "${source.sourceType}"; must be one of: ${SUPPORTED_SOURCE_TYPES.join(', ')}`,
    }
  }

  const kind = inferConnectorKind(source)
  if (kind === 'unsupported') {
    return {
      supported: false,
      kind: 'unsupported',
      reason: 'source url is absent, unparseable, or not an http(s) URL — no connector applies',
    }
  }

  return {
    supported: true,
    kind,
    connector: createConnector(kind),
    reason: `selected ${kind} connector`,
  }
}

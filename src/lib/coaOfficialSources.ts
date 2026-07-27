// ─── The fixed official source for COA review (Gate P0 — issue #77) ─────────
//
// ONE connector, ONE authority. The gate asks for a single directly relevant,
// reachable, official HTTPS authority source — not a crawler and not a source
// registry — so this module is deliberately a constant rather than a lookup.
//
// Why the Thai FDA: the demonstrated COAs are issued by a Thai laboratory for a
// Thai producer, so the national competent authority for cannabis product
// control is the jurisdiction-matching authority. It is reachable server-side
// over HTTPS without redirects or bot blocking, which the alternatives are not
// — notably EDQM (publisher of the Ph.Eur. methods the COA cites) answers
// non-browser clients with HTTP 403 and therefore cannot satisfy "freshly
// retrieved server-side".
//
// The allowlist is deny-by-default: only the hosts named here can ever be
// fetched, on any hop of any redirect chain.

import type { SourceRetrievalPolicy } from './serverSourceRetrieval.js'

export interface OfficialSourceDefinition {
  /** Stable key persisted with every retrieval. */
  key: string
  authority: string
  jurisdiction: string
  /** ISO-3166 alpha-2, stored alongside the human-readable jurisdiction. */
  jurisdictionCode: string
  url: string
  /** Governance tier, matching migration 26: 1 = primary regulator. */
  tier: 1 | 2 | 3
  authorityType: 'primary_regulator' | 'ministry' | 'official_gazette' | 'standards_body'
}

export const THAI_FDA_SOURCE: OfficialSourceDefinition = {
  key: 'th-fda',
  authority: 'Thai Food and Drug Administration',
  jurisdiction: 'Thailand',
  jurisdictionCode: 'TH',
  url: 'https://www.fda.moph.go.th/',
  tier: 1,
  authorityType: 'primary_regulator',
}

/**
 * Hosts the retriever may contact. Kept to the single configured authority —
 * adding a host here is the only way to widen the connector's reach, which is
 * what makes the boundary auditable.
 */
export const COA_SOURCE_ALLOWED_HOSTS = ['www.fda.moph.go.th']

export const COA_SOURCE_POLICY: SourceRetrievalPolicy = {
  allowedHosts: COA_SOURCE_ALLOWED_HOSTS,
  allowedPorts: [],
  maxRedirects: 3,
  timeoutMs: 12_000,
  maxBytes: 2 * 1024 * 1024,
  allowedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'],
}

/**
 * Terms used to pick the passage of the retrieved page to store.
 *
 * Selection is extractive only — these terms choose WHICH verbatim lines are
 * kept, never what they say. An unmatched page is still stored, flagged as
 * unmatched, so the operator sees exactly what was served.
 */
export const COA_RELEVANCE_TERMS = [
  'cannabis',
  'กัญชา',
  'hemp',
  'ยา',
  'สมุนไพร',
  'herbal',
  'narcotic',
  'ประกาศ',
]

export function officialSourceByKey(key: string): OfficialSourceDefinition | null {
  return key === THAI_FDA_SOURCE.key ? THAI_FDA_SOURCE : null
}

import type { RegulatorySource } from '../types.js'
import type { RssFetchImpl, RssFetchResponse } from './complianceRssConnector.js'
import { normalizeConnectorHost } from './complianceSourceUrlSafety.js'
import { rssResponseFromRetrieval } from './retrievalRssResponse.js'
import type { SourceRetrievalRecord } from './serverSourceRetrieval.js'

// ─── Direct server-side transport for the connectors ────────────────────────
//
// The scheduled path's `RssFetchImpl`. Where createServerProxyRssFetch goes
// browser → /api/compliance/feed-retrieve → retriever, this one IS already
// running on the server, so it calls the retriever directly.
//
// WHY THE CRON DOES NOT REUSE THE HTTP ENDPOINT
// feed-retrieve authenticates a `ddp_admin` bearer token and reads the source
// row under that admin's RLS. A scheduled job has no admin and no session. The
// alternatives were to mint a service account token, or to let the endpoint
// accept a shared secret as an alternative principal — both of which would add
// a second way to reach an outbound-fetch primitive, and the second would put a
// non-RLS bypass inside an endpoint whose safety argument is that every read is
// RLS-bound. Calling the retriever in-process keeps the endpoint's contract
// exactly as narrow as it is today.
//
// The SAFETY GATE IS UNCHANGED: the same retrieveOfficialSource, with the same
// one-host allowlist derived from the source's own stored URL, the same
// per-hop redirect revalidation, the same SSRF and transport limits. Only the
// hop between the browser and the server disappears.

export interface DirectRssFetchDeps {
  /** The guarded retriever, injected so this module opens no socket in tests. */
  retrieve: (input: { url: string; allowedHosts: string[]; retrievedAt: string }) => Promise<SourceRetrievalRecord>
  now: () => string
}

/**
 * Creates an `RssFetchImpl` bound to one source.
 *
 * A retrieval that the guard REFUSED is surfaced as a throw carrying the
 * refusal code. The connector turns a throw into a recorded `fetch_failed` run,
 * so a refusal is visible in the ingestion evidence rather than looking like a
 * source that published nothing — the distinction that matters when three of
 * the six Thai hosts answer 403 as their steady state.
 */
export function createDirectSourceRssFetch(
  source: RegulatorySource,
  deps: DirectRssFetchDeps,
): RssFetchImpl {
  return async (url): Promise<RssFetchResponse> => {
    const host = normalizeConnectorHost(source.url)
    if (!host) throw new Error('the registered source URL is not a valid URL')

    // Deny-by-default in its strongest form: the allowlist is this source's own
    // host and nothing else, rebuilt per call from the stored row.
    const record = await deps.retrieve({ url: source.url, allowedHosts: [host], retrievedAt: deps.now() })

    if (record.status !== 'retrieved') {
      throw new Error(`${record.status}: ${record.reason ?? 'retrieval refused'}`)
    }
    if (record.requestedUrl !== url) {
      throw new Error('retrieved a different URL than the connector requested')
    }
    return rssResponseFromRetrieval(url, record)
  }
}
